"""FAQ semantic search — replaces the FastAPI PG FAQ API by reusing its data layer.

This ports the thin HTTP wrapper from pg/faq_api/main.py (Ollama embedding and
the 502/500 error mapping) but calls
the EXISTING pg.faq_api.repository / orm functions directly — the same code path
embed.py uses. No separate service, no HTTP hop, one pgvector implementation.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

from .. import appconfig
from .logs import log_duration

OLLAMA_TIMEOUT_SECONDS = 60

_lock = threading.Lock() # protects the lazy creation of the database session factory
_session_factory = None


class FaqEmbeddingError(Exception):
    """Ollama embedding failed (-> HTTP 502)."""


class FaqDatabaseError(Exception):
    """Postgres query failed (-> HTTP 500)."""


def _get_session_factory():
    global _session_factory 
    # A session_factory is a reusable session creator for the database
    # A database session is a temporary connection/context used to:

    # 1. Connect to PostgreSQL.
    # 2. Run queries.
    # 3. Commit or roll back changes.
    # 4. Close the connection safely.

    if _session_factory is None:
        # Without the lock, two requests arriving at the same time could both see _session_factory is None and create two separate engines/factories.
        with _lock:
            if _session_factory is None:
                # Lazy import + connect so unrelated code (unit tests) needn't reach Postgres.
                from pg.faq_api.orm import create_pg_engine, create_session_factory

                _session_factory = create_session_factory(create_pg_engine())
    return _session_factory


def request_embedding(text: str, ollama_url: str, model: str):
    """Get embedding from Ollama for the given text."""
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
    """
    Search the FAQ database for the k most relevant entries to the query q.
    Returns a list of dicts with keys: id, question, answer, cosine_similarity.
    """
    from pg.faq_api.orm import session_scope
    from pg.faq_api.repository import search_faqs_by_embedding

    try:
        query_vec = request_embedding(q, appconfig.faq_ollama_url(), appconfig.ollama_model())
    except Exception as exc:  # noqa: BLE001
        raise FaqEmbeddingError("Embedding service failed") from exc

    try:
        
        with session_scope(_get_session_factory()) as session:
            rows = search_faqs_by_embedding(session, query_vec, k)
            # Meaning: Create a database session
            # → run the FAQ search
            # → close the session safely
            # The factory itself is not one active database session. It is a reusable session-making tool.
    except Exception as exc:
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


def get_faq(faq_id: int):
    """
    Returns the FAQ entry with the given ID, or None if not found.
    Returns a dict with keys: id, question, answer, cosine_similarity. NOTE that cosine_similarity is always 1.0 for a direct lookup by ID.
    """
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


def search_result(q: str, k: int):
    """Return FAQ matches and preserve the reason when search fails.

    The answer pipeline calls this after query rewriting. It lets the pipeline
    continue when Weaviate still has usable context while retaining a concise
    failure cause for the conversation log.

    Example: ``{"items": [], "error": "pg_faq_embedding_error"}``.
    """
    try:
        start_time = time.monotonic()
        items = search(q, k)
        log_duration("pg_faq_search", int((time.monotonic() - start_time) * 1000))
        return {"items": items, "error": None}
    except FaqEmbeddingError:
        return {"items": [], "error": "pg_faq_embedding_error"}
    except FaqDatabaseError:
        return {"items": [], "error": "pg_faq_database_error"}
    except Exception:  # noqa: BLE001
        return {"items": [], "error": "pg_faq_search_error"}
