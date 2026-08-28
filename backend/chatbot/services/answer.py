"""Answer generation + fact-check — port of worker.js generateAnswer / checkResponse.

generate_answer returns a plain dict (final text + flags); the pipeline turns it into
SSE. This keeps the fact-check / RAAHAT / cannot-answer logic identical to the Worker.
"""
from __future__ import annotations

import datetime
import json
import time

from .. import appconfig
from ..business import (
    STANDARD_RAAHAT_MESSAGE,
    count_statements,
    format_db_faq_suggestions,
    get_cannot_answer_message,
    is_cannot_answer_response,
    split_raahat_content,
)
from ..prompts import (
    FACTCHECK_SYSTEM_PROMPT,
    build_answer_system_prompt,
    build_factcheck_user_prompt,
)
from .llm import chat_completion, token_usage
from .logs import log_duration

RELEVANCE_THRESHOLD = 0.05
MAX_MESSAGE_LENGTH = 10000
MAX_HISTORY_MESSAGES = 10
MAX_FACT_CHECK_REASONS = 5
MAX_FACT_CHECK_REASON_LENGTH = 500

RAAHAT_INFO = """<document filename="RAAHAT_Support.md">
RAAHAT is the Mental Health & Wellness Society for IIT Madras BS students.
Contact: wellness.society@study.iitm.ac.in
Instagram: @wellness.society_iitmbs
RAAHAT provides support for emotional, psychological, interpersonal, and financial distress.
</document>"""


def _current_date() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def _relevance(doc) -> float:
    # Weaviate returns _additional.score as a *string* (e.g. "0.64786047"). worker.js
    # compares it numerically via JS string->number coercion; Python needs an explicit
    # float() (a non-numeric/absent value coerces to 0.0, matching JS `NaN > x` -> false).
    try:
        return float(doc.get("relevance"))
    except (TypeError, ValueError):
        return 0.0


def _validate_history(history):
    if not isinstance(history, list):
        return []
    validated = []
    for msg in history[:MAX_HISTORY_MESSAGES]:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content")
        if not role or not content or not isinstance(content, str):
            continue
        if role not in ("user", "assistant"):
            continue
        if len(content) > MAX_MESSAGE_LENGTH:
            continue
        validated.append({"role": role, "content": content})
    return validated


def _bounded_incorrect_reasons(value):
    """Return safe, bounded fact-check reasons for structured logs.

    Called after a JSON fact-check response is parsed. Non-string items are
    ignored and long strings are shortened so model output cannot create an
    unbounded log record.

    Example: ``_bounded_incorrect_reasons([" unsupported "])`` returns
    ``["unsupported"]``.
    """
    if not isinstance(value, list):
        return []

    reasons = []
    for item in value:
        if not isinstance(item, str):
            continue
        reason = item.strip()
        if not reason:
            continue
        reasons.append(reason[:MAX_FACT_CHECK_REASON_LENGTH])
        if len(reasons) == MAX_FACT_CHECK_REASONS:
            break
    return reasons


def check_response(response: str, context: str, history=None):
    """Fact-check a response and return approval plus optional token counts.

    The fact-check still fails open: service or parsing errors approve the
    response, matching the existing public behavior.
    """
    history = history or []
    user_prompt = build_factcheck_user_prompt(context, history, response)
    try:
        start_time = time.monotonic()
        resp = chat_completion(
            [
                {"role": "system", "content": FACTCHECK_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            model="gpt-4o-mini",
            temperature=0,
            max_tokens=500,
            response_format={"type": "json_object"},
            timeout=60,
        )
        log_duration("fact_check_chat_api", int((time.monotonic() - start_time) * 1000))
        if not resp.ok:
            return {
                "approved": True,
                "incorrect": [],
                "outcome": "http_fail_open",
                "tokens": None,
            }

        result = resp.json()
        tokens = token_usage(result)
        try:
            raw_answer = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raw_answer = None
        raw_answer = raw_answer.strip() if isinstance(raw_answer, str) else raw_answer

        try:
            fact_check_result = json.loads(raw_answer)
            approved = fact_check_result.get("approved")
            return {
                "approved": isinstance(approved, str) and approved.upper() == "YES",
                "incorrect": _bounded_incorrect_reasons(fact_check_result.get("incorrect")),
                "outcome": "json",
                "tokens": tokens,
            }
        except Exception:
            return {
                "approved": isinstance(raw_answer, str) and raw_answer.upper() == "YES",
                "incorrect": [],
                "outcome": "strict_text",
                "tokens": tokens,
            }
    except Exception:
        return {
            "approved": True,
            "incorrect": [],
            "outcome": "exception_fail_open",
            "tokens": None,
        }


def generate_answer(question, documents, db_faqs, history, language: str = "english") -> dict:
    """Returns {final_answer, rejected, fact_check_passed, contains_raahat, rejection_reason}."""
    relevant_docs = [d for d in (documents or []) if _relevance(d) > RELEVANCE_THRESHOLD]

    doc_context = "\n\n".join(
        f'<document filename="{d["filename"]}">{d["content"]}</document>' for d in relevant_docs
    )
    faq_context = "\n\n".join(
        f'<faq id="{f["id"]}">\nQ: {f["question"]}\nA: {f["answer"]}\n</faq>' for f in (db_faqs or [])
    )
    context = "\n\n".join(part for part in [doc_context, faq_context, RAAHAT_INFO] if part)

    system_prompt = build_answer_system_prompt(language, _current_date())
    validated_history = _validate_history(history)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "assistant", "content": context},
        *validated_history,
        {"role": "user", "content": question},
    ]

    start_time = time.monotonic()
    resp = chat_completion(messages, model=appconfig.chat_model(), temperature=0.1, timeout=120)
    log_duration("answer_chat_api", int((time.monotonic() - start_time) * 1000))
    if not resp.ok:
        raise RuntimeError(f"Chat API error: {resp.status_code} {resp.reason}")

    result = resp.json()
    answer_tokens = token_usage(result)
    try:
        answer_text = result["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        answer_text = ""

    split = split_raahat_content(answer_text)
    has_raahat = split["has_raahat"]
    other_chunk = split["other_chunk"]

    final_answer = None
    fact_check_passed = None
    rejected_for_history = False
    rejection_reason = None
    tokens = {
        "answer_generation_input": (answer_tokens or {}).get("input", 0),
        "answer_generation_output": (answer_tokens or {}).get("output", 0),
        "fact_check_input": 0,
        "fact_check_output": 0,
    }
    fact_checks = []

    def add_fact_check_tokens(fact_check_result):
        """Add one fact-check call's usage, including retry calls."""
        usage = fact_check_result.get("tokens") or {}
        tokens["fact_check_input"] += usage.get("input", 0)
        tokens["fact_check_output"] += usage.get("output", 0)

    def record_fact_check(scope, used_history, fact_check_result):
        """Keep one bounded summary for each fact-check attempt."""
        fact_checks.append(
            {
                "scope": scope,
                "history_used": used_history,
                "approved": fact_check_result["approved"],
                "incorrect": fact_check_result.get("incorrect") or [],
                "outcome": fact_check_result.get("outcome") or "unknown",
            }
        )

    if has_raahat: # If the answer contains RAAHAT content
        other_statement_count = count_statements(other_chunk) # count of non-RAAHAT statements in the generated answer
        if other_statement_count > 2:
            fact_check_result = check_response(other_chunk, context, validated_history)
            add_fact_check_tokens(fact_check_result)
            record_fact_check("raahat_other", bool(validated_history), fact_check_result)
            is_other_valid = fact_check_result["approved"]
            if not is_other_valid and len(validated_history) > 0: # If fact-checking fails when conversation history is included, try again without history
                fact_check_result = check_response(other_chunk, context, [])
                add_fact_check_tokens(fact_check_result)
                record_fact_check("raahat_other", False, fact_check_result)
                is_other_valid = fact_check_result["approved"]
            fact_check_passed = is_other_valid

            if is_other_valid: # If the other chunk is valid, we can include it in the final answer along with the standard RAAHAT message.
                final_answer = other_chunk + "\n\n---\n\n" + STANDARD_RAAHAT_MESSAGE

            else: # If the other chunk is not valid, we still want to provide the RAAHAT message, but we don't want to include the invalid content.
                final_answer = STANDARD_RAAHAT_MESSAGE
                # TODO: Set rejection_reason to "fact_check_failed" here.

        else: # If there are two or fewer non-RAAHAT statements, skip fact-checking and return only the standard RAAHAT message.
            final_answer = STANDARD_RAAHAT_MESSAGE
            fact_check_passed = True

    else: # If the answer does not contain RAAHAT content
        fact_check_result = check_response(answer_text, context, validated_history)
        add_fact_check_tokens(fact_check_result)
        record_fact_check("answer", bool(validated_history), fact_check_result)
        is_correct = fact_check_result["approved"]
        if not is_correct and len(validated_history) > 0: # If fact-checking fails when conversation history is included, try again without history
            fact_check_result = check_response(answer_text, context, [])
            add_fact_check_tokens(fact_check_result)
            record_fact_check("answer", False, fact_check_result)
            is_correct = fact_check_result["approved"]
        fact_check_passed = is_correct

        if is_correct:
            final_answer = answer_text
            if is_cannot_answer_response(answer_text):
                final_answer += format_db_faq_suggestions(db_faqs, language)
                rejected_for_history = True
                rejection_reason = "cannot_answer"
        else:
            final_answer = get_cannot_answer_message(language)
            final_answer += format_db_faq_suggestions(db_faqs, language)
            rejected_for_history = True
            rejection_reason = "fact_check_failed"

    rejected = rejected_for_history or (not fact_check_passed)
    return {
        "final_answer": final_answer,
        "rejected": rejected,
        "fact_check_passed": fact_check_passed,
        "contains_raahat": has_raahat,
        "rejection_reason": rejection_reason,
        "original_answer": answer_text,
        "tokens": tokens,
        "fact_checks": fact_checks,
    }
