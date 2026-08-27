"""Request pipeline — port of worker.js answer() + handleDirectFAQIdLookup.

Flow: prepare the conversation log -> process and yield SSE records -> finalize
the log after completion, failure, or client disconnect. The finalization path
ensures the BigQuery sink receives exactly one ``conversation_turn`` event for
every generator that starts processing.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
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
from .logs import log_duration, log_error, structured_log
from .rewrite import rewrite_query_with_source
from .sse import sse_content, sse_document_records, sse_error
from .weaviate import search_weaviate

_LANG_TAG_RE = re.compile(r"\[LANG:\w+\]", re.IGNORECASE)


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def search_context_issues(document_result, faq_result):
    """Describe empty or failed retrieval sources before answer generation.

    Example: a successful FAQ result plus no documents returns
    ``["weaviate_documents_empty"]``.
    """
    documents = (document_result or {}).get("items") or []
    db_faqs = (faq_result or {}).get("items") or []
    reasons = []

    if (document_result or {}).get("error"):
        reasons.append(document_result["error"])
    elif not documents:
        reasons.append("weaviate_documents_empty")

    if (faq_result or {}).get("error"):
        reasons.append(faq_result["error"])
    elif not db_faqs:
        reasons.append("pg_faqs_empty")

    return reasons


def retrieve_context(query, num_docs):
    """Run independent document and FAQ searches at the same time.

    Called once per accepted question. Both results are collected before any
    references or answer text are emitted, so public SSE ordering is unchanged.

    Example: ``retrieve_context("fee structure", 2)`` returns two result
    envelopes: first Weaviate, then FAQ search.
    """
    # ASSUMPTION: each FAQ search creates its own database session, so it is safe
    # to run beside the independent Weaviate HTTP request.
    with ThreadPoolExecutor(max_workers=2) as executor:
        document_future = executor.submit(search_weaviate, query, num_docs)
        faq_future = executor.submit(faq.search_result, query, 5)
        return document_future.result(), faq_future.result()


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
        "db_faqs": [],
        "response": None,
        "fact_check_passed": None,
        "contains_raahat": False,
        "history_length": len(history) if isinstance(history, list) else 0,
        "latency_ms": None,
        "error": None,
        "stream_status": "processing",
        "original_answer": None,
        "tokens": {
            "query_rewrite_input": 0,
            "query_rewrite_output": 0,
            "answer_generation_input": 0,
            "answer_generation_output": 0,
            "fact_check_input": 0,
            "fact_check_output": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
        },
    }
    log_severity = "INFO"

    try:
        rewrite = rewrite_query_with_source(question)
        search_query = rewrite["query"]
        query_source = rewrite["source"]
        log_ctx["rewritten_query"] = search_query
        log_ctx["query_source"] = query_source
        rewrite_tokens = rewrite.get("tokens") or {}
        log_ctx["tokens"]["query_rewrite_input"] = rewrite_tokens.get("input", 0)
        log_ctx["tokens"]["query_rewrite_output"] = rewrite_tokens.get("output", 0)

        # Rejected query (suspected prompt injection).
        if query_source == "rejected":
            log_ctx["rejection_reason"] = "prompt_injection"
            log_ctx["detected_language"] = "english"
            log_ctx["fact_check_passed"] = False
            reject_message = get_cannot_answer_message("english")
            db_faqs = faq.search_result(question, 5).get("items") or []
            log_ctx["db_faqs"] = [
                {
                    "id": item.get("id"),
                    "cosine_similarity": item.get("cosine_similarity"),
                    "question": item.get("question"),
                    "answer": item.get("answer"),
                }
                for item in db_faqs
            ]
            reject_message += format_db_faq_suggestions(db_faqs, "english")
            log_ctx["response"] = reject_message
            yield sse_content(reject_message, rejected=True)
            log_ctx["stream_status"] = "completed"
            return

        detected_language = extract_language(search_query)
        clean_query = _LANG_TAG_RE.sub("", search_query).strip()
        log_ctx["detected_language"] = detected_language

        document_result, faq_result = retrieve_context(clean_query, num_docs)
        documents = document_result.get("items") or []
        db_faqs = faq_result.get("items") or []

        log_ctx["documents"] = [
            {"filename": d.get("filename"), "relevance": d.get("relevance")} for d in (documents or [])
        ]
        log_ctx["db_faqs"] = [
            {
                "id": item.get("id"),
                "cosine_similarity": item.get("cosine_similarity"),
                "question": item.get("question"),
                "answer": item.get("answer"),
            }
            for item in db_faqs
        ]

        search_issues = search_context_issues(document_result, faq_result)
        if search_issues:
            log_ctx["search_result_causes"] = search_issues
            log_ctx["error"] = "; ".join(search_issues)
            log_severity = "CRITICAL"

        if not documents and not db_faqs:
            message = get_cannot_answer_message(detected_language)
            log_ctx["rejection_reason"] = "no_search_results"
            log_ctx["response"] = message
            log_ctx["error"] = "; ".join(search_issues) or "no_search_results"
            yield sse_content(message, rejected=True)
            log_ctx["stream_status"] = "completed"
            log_duration("total_query", _elapsed_ms(start_time))
            return

        # Stream document records first.
        if documents:
            yield sse_document_records(documents)

        gen = generate_answer(question, documents, db_faqs, history, detected_language)
        log_ctx["response"] = gen["final_answer"]
        log_ctx["fact_check_passed"] = gen["fact_check_passed"]
        log_ctx["contains_raahat"] = gen["contains_raahat"]
        log_ctx["original_answer"] = gen.get("original_answer")
        generated_tokens = gen.get("tokens") or {}
        for key in (
            "answer_generation_input",
            "answer_generation_output",
            "fact_check_input",
            "fact_check_output",
        ):
            log_ctx["tokens"][key] = generated_tokens.get(key, 0)
        log_ctx["tokens"]["total_input_tokens"] = (
            log_ctx["tokens"]["query_rewrite_input"]
            + log_ctx["tokens"]["answer_generation_input"]
            + log_ctx["tokens"]["fact_check_input"]
        )
        log_ctx["tokens"]["total_output_tokens"] = (
            log_ctx["tokens"]["query_rewrite_output"]
            + log_ctx["tokens"]["answer_generation_output"]
            + log_ctx["tokens"]["fact_check_output"]
        )
        if gen["rejection_reason"] is not None:
            log_ctx["rejection_reason"] = gen["rejection_reason"]

        yield sse_content(gen["final_answer"], rejected=gen["rejected"])
        log_ctx["stream_status"] = "completed"
        log_duration("total_query", _elapsed_ms(start_time))

    except Exception as error:  # noqa: BLE001
        log_ctx["error"] = str(error)
        log_severity = "INFO"
        log_error(
            "conversation_error",
            error,
            session_id=session_id,
            conversation_id=conversation_id,
            question=question,
        )
        yield sse_error(str(error) or "An error occurred while processing your request")
        log_ctx["stream_status"] = "failed"
    finally:
        if log_ctx["stream_status"] == "processing":
            log_ctx["stream_status"] = "disconnected"
            if log_ctx["error"]:
                log_ctx["error"] += "; client_disconnected"
            else:
                log_ctx["error"] = "client_disconnected"

        log_ctx["latency_ms"] = _elapsed_ms(start_time)
        structured_log(log_severity, "conversation_turn", **log_ctx)


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
        lookup_start_time = time.monotonic()
        row = faq.get_faq(faq_id)
        log_duration("pg_faq_direct_lookup", _elapsed_ms(lookup_start_time))
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
