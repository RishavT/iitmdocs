"""Query rewrite — port of worker.js rewriteQueryWithSource.

Sanitize -> reject if injection emptied it -> synonym fast-path -> LLM rewrite
(gpt-4o-mini). Returns {"query": str|None, "source": "rejected"|"original"|"synonym"|"llm"}.
"""
from __future__ import annotations

import re
import time

from ..business import find_synonym_match, remove_stop_words, sanitize_query
from ..prompts import build_rewrite_system_prompt
from .llm import chat_completion_async, token_usage
from .logs import log_duration

_LANG_TAG_RE = re.compile(r"\[LANG:\w+\]", re.IGNORECASE)


async def rewrite_query_with_source_async(client, query):
    """Rewrite one query without blocking the ASGI event loop.

    Example: a configured synonym for ``"fees"`` returns the original query
    plus that synonym with ``source="synonym"``.
    """
    original_query = query
    query = sanitize_query(query)
    if not query and original_query and str(original_query).strip():
        return {"query": None, "source": "rejected", "tokens": None}
    if not query:
        return {"query": "", "source": "original", "tokens": None}
    synonym_start_time = time.monotonic()
    synonym_match = find_synonym_match(query)
    if synonym_match:
        log_duration(
            "query_rewrite_synonym",
            int((time.monotonic() - synonym_start_time) * 1000),
        )
        return {"query": f"{query} {synonym_match}", "source": "synonym", "tokens": None}
    try:
        rewrite_start_time = time.monotonic()
        response = await chat_completion_async(
            client,
            [
                {"role": "system", "content": build_rewrite_system_prompt()},
                {"role": "user", "content": remove_stop_words(query)},
            ],
            model="gpt-4o-mini",
            temperature=0,
            max_tokens=100,
            timeout=60,
        )
        log_duration(
            "query_rewrite_chat_api",
            int((time.monotonic() - rewrite_start_time) * 1000),
        )
        if not response.is_success:
            return {"query": query, "source": "original", "tokens": None}
        result = response.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content")
        rewritten = content.strip() if isinstance(content, str) and content.strip() else query
        language = _LANG_TAG_RE.search(rewritten)
        tag = language.group(0) if language else "[LANG:english]"
        return {
            "query": f"{query} {_LANG_TAG_RE.sub('', rewritten).strip()} {tag}",
            "source": "llm",
            "tokens": token_usage(result),
        }
    except Exception:
        return {"query": query, "source": "original", "tokens": None}
