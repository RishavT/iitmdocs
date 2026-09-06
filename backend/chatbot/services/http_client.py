"""Shared outbound HTTP client for the async Django request flow.

Flow: chat reuses an OpenAI-only client -> Ollama and Weaviate reuse a separate
client -> ASGI shutdown closes both pools.
"""
import httpx


_client = None
_openai_client = None


def get_async_http_client():
    """Return the process-wide client for Ollama and Weaviate."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient()
    return _client


def get_openai_http_client():
    """Reuse chat connections across retrieval (e.g. rewrite then answer).

    ASSUMPTION: this experiment targets at most 25 concurrent chatbot users.
    The 120-second idle lifetime spans the observed retrieval waits.
    """
    global _openai_client
    if _openai_client is None or _openai_client.is_closed:
        limits = httpx.Limits(
            max_connections=25,
            max_keepalive_connections=25,
            keepalive_expiry=120.0,
        )
        _openai_client = httpx.AsyncClient(http2=False, limits=limits)
    return _openai_client


async def close_async_http_client():
    """Close both process-wide clients during ASGI shutdown."""
    global _client, _openai_client
    try:
        if _client is not None and not _client.is_closed:
            await _client.aclose()
    finally:
        _client = None
        try:
            if _openai_client is not None and not _openai_client.is_closed:
                await _openai_client.aclose()
        finally:
            _openai_client = None
