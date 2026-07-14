"""FAQ semantic search — replaces the FastAPI PG FAQ API by reusing its data layer.

This ports the thin HTTP wrapper from pg/faq_api/main.py (Ollama embedding, the
BoundedSemaphore concurrency guard, and the 429/502/500 error mapping) but calls
the EXISTING pg.faq_api.repository / orm functions directly — the same code path
embed.py uses. No separate service, no HTTP hop, one pgvector implementation.
"""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

from .. import appconfig

OLLAMA_TIMEOUT_SECONDS = 60

_lock = threading.Lock()
_session_factory = None
_semaphore = None


class FaqTooManyConcurrent(Exception):
    """Search-slot semaphore exhausted (-> HTTP 429)."""


class FaqEmbeddingError(Exception):
    """Ollama embedding failed (-> HTTP 502)."""


class FaqDatabaseError(Exception):
    """Postgres query failed (-> HTTP 500)."""


def _get_session_factory():
    global _session_factory
    if _session_factory is None:
        with _lock:
            if _session_factory is None:
                # Lazy import + connect so unrelated code (unit tests) needn't reach Postgres.
                from pg.faq_api.orm import create_pg_engine, create_session_factory

                _session_factory = create_session_factory(create_pg_engine())
    return _session_factory


def _get_semaphore():
    global _semaphore
    if _semaphore is None:
        with _lock:
            if _semaphore is None:
                _semaphore = threading.BoundedSemaphore(appconfig.faq_search_max_concurrent())
    return _semaphore


def request_embedding(text: str, ollama_url: str, model: str):
    """Port of pg/faq_api/main.py request_embedding (urllib, dimension-checked)."""
    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach Ollama at {ollama_url}: {exc}") from exc

    parsed = json.loads(body)
    embedding = parsed.get("embedding")
    dimension = appconfig.embedding_dimension()
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama returned invalid embedding payload")
    if len(embedding) != dimension:
        raise RuntimeError(
            f"Ollama embedding dimension mismatch: expected {dimension}, got {len(embedding)}"
        )
    return [float(v) for v in embedding]


def search(q: str, k: int):
    """Semantic FAQ search (was POST /search). Raises the mapped Faq* exceptions."""
    from pg.faq_api.orm import session_scope
    from pg.faq_api.repository import search_faqs_by_embedding

    semaphore = _get_semaphore()
    if not semaphore.acquire(blocking=False):
        raise FaqTooManyConcurrent("Too many concurrent searches")
    try:
        try:
            query_vec = request_embedding(q, appconfig.faq_ollama_url(), appconfig.ollama_model())
        except Exception as exc:  # noqa: BLE001
            raise FaqEmbeddingError("Embedding service failed") from exc

        try:
            with session_scope(_get_session_factory()) as session:
                rows = search_faqs_by_embedding(session, query_vec, k)
        except Exception as exc:  # noqa: BLE001
            raise FaqDatabaseError("Internal error") from exc

        return [
            {
                "id": row.id,
                "question": row.question,
                "answer": row.answer,
                "cosine_similarity": row.cosine_similarity,
            }
            for row in rows
        ]
    finally:
        semaphore.release()


def get_faq(faq_id: int):
    """Direct FAQ lookup (was GET /faq/{id}). Returns dict or None (404)."""
    from pg.faq_api.orm import session_scope
    from pg.faq_api.repository import get_faq_by_id

    try:
        with session_scope(_get_session_factory()) as session:
            row = get_faq_by_id(session, faq_id)
    except Exception as exc:  # noqa: BLE001
        raise FaqDatabaseError("Internal error") from exc

    if not row:
        return None
    return {
        "id": row.id,
        "question": row.question,
        "answer": row.answer,
        "cosine_similarity": row.cosine_similarity,
    }


def search_soft(q: str, k: int):
    """Worker fetchPgFaqs equivalent: never raises — returns [] on any failure."""
    try:
        return search(q, k)
    except Exception:  # noqa: BLE001
        return []
