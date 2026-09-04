"""Shared outbound HTTP client for the async Django request flow.

Flow: the first data-heavy request creates one client -> chat, Ollama, and
Weaviate reuse its connection pools -> ASGI shutdown closes it.
"""
import httpx


_client = None


def get_async_http_client():
    """Return the one reusable HTTPX client owned by this app process."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient()
    return _client


async def close_async_http_client():
    """Close the process-wide HTTP client during ASGI shutdown."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
