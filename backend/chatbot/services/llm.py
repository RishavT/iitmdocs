"""Chat-completions primitive (OpenAI-compatible) shared by rewrite/answer/fact-check."""
from __future__ import annotations

import requests

from .. import appconfig


def chat_completion(messages, *, model, temperature, max_tokens=None, response_format=None, timeout=60):
    """POST to the chat endpoint (stream:false). Returns the requests.Response.

    Callers inspect `.ok` / `.json()` themselves — matching the Worker's per-call
    handling (rewrite falls back, generate_answer raises, check_response approves).
    Network errors raise (callers wrap in try/except like the Worker's fetch).
    """
    endpoint = appconfig.chat_endpoint()
    api_key = appconfig.chat_api_key()
    body = {"model": model, "messages": messages, "temperature": temperature, "stream": False}
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if response_format is not None:
        body["response_format"] = response_format
    return requests.post(
        endpoint,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=timeout,
    )
