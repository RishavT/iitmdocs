"""Request pipeline — port of worker.js answer() + handleDirectFAQIdLookup.

Each function is a generator that yields SSE strings and emits the exact
`conversation_turn` structured log the BigQuery sink expects.
"""
from __future__ import annotations

import re
import time

from ..business import (
    extract_language,
    format_db_faq_suggestions,
    generate_uuid,
    get_cannot_answer_message,
)
from . import faq
from .answer import generate_answer
from .logs import log_error, structured_log
from .rewrite import rewrite_query_with_source
from .sse import sse_content, sse_document_records, sse_error
from .weaviate import search_weaviate

_LANG_TAG_RE = re.compile(r"\[LANG:\w+\]", re.IGNORECASE)


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def answer_events(question, num_docs, history, session_id, message_id, username):
    """Main /answer pipeline (non-faq_id path)."""
    start_time = time.monotonic()
    conversation_id = generate_uuid()

    log_ctx = {
        "session_id": session_id or "anonymous",
        "conversation_id": conversation_id,
        "message_id": message_id or None,
        "username": username or None,
        "question": question,
        "rewritten_query": None,
        "query_source": "original",
        "rejection_reason": None,
        "documents": [],
        "response": None,
        "fact_check_passed": None,
        "contains_raahat": False,
        "history_length": len(history) if isinstance(history, list) else 0,
        "latency_ms": None,
        "error": None,
    }

    try:
        rewrite = rewrite_query_with_source(question)
        search_query = rewrite["query"]
        query_source = rewrite["source"]
        log_ctx["rewritten_query"] = search_query
        log_ctx["query_source"] = query_source

        # Rejected query (suspected prompt injection).
        if query_source == "rejected":
            log_ctx["rejection_reason"] = "prompt_injection"
            log_ctx["detected_language"] = "english"
            log_ctx["fact_check_passed"] = False
            reject_message = get_cannot_answer_message("english")
            db_faqs = faq.search_soft(question, 5)
            reject_message += format_db_faq_suggestions(db_faqs, "english")
            log_ctx["response"] = reject_message
            yield sse_content(reject_message, rejected=True)
            log_ctx["latency_ms"] = _elapsed_ms(start_time)
            structured_log("INFO", "conversation_turn", **log_ctx)
            return

        detected_language = extract_language(search_query)
        clean_query = _LANG_TAG_RE.sub("", search_query).strip()
        log_ctx["detected_language"] = detected_language

        documents = search_weaviate(clean_query, num_docs)
        db_faqs = faq.search_soft(clean_query, 5)

        log_ctx["documents"] = [
            {"filename": d.get("filename"), "relevance": d.get("relevance")} for d in (documents or [])
        ]
        log_ctx["db_faqs"] = [
            {"id": f.get("id"), "cosine_similarity": f.get("cosine_similarity")} for f in (db_faqs or [])
        ]

        # Stream document records first.
        if documents:
            yield sse_document_records(documents)

        gen = generate_answer(question, documents, db_faqs, history, detected_language)
        log_ctx["response"] = gen["final_answer"]
        log_ctx["fact_check_passed"] = gen["fact_check_passed"]
        log_ctx["contains_raahat"] = gen["contains_raahat"]
        if gen["rejection_reason"] is not None:
            log_ctx["rejection_reason"] = gen["rejection_reason"]

        yield sse_content(gen["final_answer"], rejected=gen["rejected"])
        log_ctx["latency_ms"] = _elapsed_ms(start_time)
        structured_log("INFO", "conversation_turn", **log_ctx)

    except Exception as error:  # noqa: BLE001
        log_ctx["latency_ms"] = _elapsed_ms(start_time)
        log_ctx["error"] = str(error)
        log_error(
            "conversation_error",
            error,
            session_id=session_id,
            conversation_id=conversation_id,
            question=question,
        )
        structured_log("INFO", "conversation_turn", **log_ctx)
        yield sse_error(str(error) or "An error occurred while processing your request")


def direct_faq_events(faq_id, question, session_id, message_id, username):
    """faq_id short-circuit — direct FAQ lookup (port of handleDirectFAQIdLookup)."""
    start_time = time.monotonic()
    conversation_id = generate_uuid()

    log_ctx = {
        "session_id": session_id or "anonymous",
        "conversation_id": conversation_id,
        "message_id": message_id or None,
        "username": username or None,
        "question": question,
        "rewritten_query": None,
        "query_source": "faq_direct_id",
        "rejection_reason": None,
        "documents": [{"id": str(faq_id), "relevance": "1"}],
        "response": None,
        "fact_check_passed": True,
        "contains_raahat": False,
        "history_length": 0,
        "latency_ms": None,
        "error": None,
        "detected_language": "english",
    }

    cannot_answer = get_cannot_answer_message("english")
    try:
        row = faq.get_faq(faq_id)
        if row is None:
            log_ctx["error"] = "PG FAQ lookup failed: 404"
            log_ctx["response"] = cannot_answer
            log_ctx["latency_ms"] = _elapsed_ms(start_time)
            structured_log("INFO", "conversation_turn", **log_ctx)
            yield sse_content(cannot_answer, rejected=True)
            return

        formatted = f"### {row['question']}\n\n{row['answer']}"
        log_ctx["response"] = formatted
        log_ctx["latency_ms"] = _elapsed_ms(start_time)
        structured_log("INFO", "conversation_turn", **log_ctx)
        yield sse_content(formatted)
    except Exception as error:  # noqa: BLE001
        log_ctx["error"] = str(error)
        log_ctx["response"] = cannot_answer
        log_ctx["latency_ms"] = _elapsed_ms(start_time)
        structured_log("ERROR", "conversation_turn", **log_ctx)
        yield sse_content(cannot_answer, rejected=True)
