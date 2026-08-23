"""Query rewrite — port of worker.js rewriteQueryWithSource.

Sanitize -> reject if injection emptied it -> synonym fast-path -> LLM rewrite
(gpt-4o-mini). Returns {"query": str|None, "source": "rejected"|"original"|"synonym"|"llm"}.
"""
from __future__ import annotations

import re

from ..business import find_synonym_match, remove_stop_words, sanitize_query
from ..prompts import build_rewrite_system_prompt
from .llm import chat_completion, token_usage

_LANG_TAG_RE = re.compile(r"\[LANG:\w+\]", re.IGNORECASE)


def rewrite_query_with_source(query):
    original_query = query
    query = sanitize_query(query)

    if not query and original_query and str(original_query).strip():
        # Had content but sanitization removed everything -> likely injection.
        return {"query": None, "source": "rejected", "tokens": None}
    if not query:
        return {"query": "", "source": "original", "tokens": None}

    synonym_match = find_synonym_match(query)
    if synonym_match:
        return {"query": f"{query} {synonym_match}", "source": "synonym", "tokens": None}

    query_for_llm = remove_stop_words(query)
    system_prompt = build_rewrite_system_prompt()

    try:
        resp = chat_completion(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query_for_llm},
            ],
            model="gpt-4o-mini",
            temperature=0,
            max_tokens=100,
            timeout=60,
        )
        if not resp.ok:
            return {"query": query, "source": "original", "tokens": None}

        result = resp.json()
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            content = None
        llm_rewrite = (content.strip() if isinstance(content, str) else "") or query

        lang_match = _LANG_TAG_RE.search(llm_rewrite)
        lang_tag = lang_match.group(0) if lang_match else "[LANG:english]"
        keywords_only = _LANG_TAG_RE.sub("", llm_rewrite).strip()
        augmented_query = f"{query} {keywords_only} {lang_tag}"
        return {"query": augmented_query, "source": "llm", "tokens": token_usage(result)}
    except Exception:
        return {"query": query, "source": "original", "tokens": None}
