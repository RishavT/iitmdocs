"""Async FAQ semantic search for Django's request path.

Flow: request an Ollama embedding -> execute the existing pgvector expression
against the shared FAQ model -> convert rows to the existing JSON shape. The
synchronous bootstrap and FastAPI paths in ``pg/faq_api`` remain unchanged.
"""
from __future__ import annotations


from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .. import appconfig
from .logs import measure_duration

OLLAMA_TIMEOUT_SECONDS = 60

_async_session_factory = None


class FaqEmbeddingError(Exception):
    """Ollama embedding failed (-> HTTP 502)."""


class FaqDatabaseError(Exception):
    """Postgres query failed (-> HTTP 500)."""

def _get_async_session_factory():
    """Return the process-wide creator for short-lived async FAQ sessions."""
    global _async_session_factory
    if _async_session_factory is None:
        from pg.faq_api.orm import database_url_from_env

        engine = create_async_engine(database_url_from_env(), pool_pre_ping=True)
        _async_session_factory = async_sessionmaker(
            engine,
            autoflush=False,
            expire_on_commit=False,
        )
    return _async_session_factory


async def request_embedding_async(client, text, ollama_url, model):
    """Get one validated FAQ embedding without blocking the event loop.

    Example: an expected dimension of 2 accepts ``[0.1, 0.2]`` and returns
    those values as floats. This is called before every async FAQ search.
    """
    response = await client.post(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        json={"model": model, "prompt": text},
        headers={"Content-Type": "application/json"},
        timeout=OLLAMA_TIMEOUT_SECONDS,
    )
    if not response.is_success:
        raise RuntimeError(f"Ollama HTTP {response.status_code}")

    embedding = response.json().get("embedding")
    dimension = appconfig.embedding_dimension()
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama returned invalid embedding payload")
    if len(embedding) != dimension:
        raise RuntimeError(
            f"Ollama embedding dimension mismatch: expected {dimension}, got {len(embedding)}"
        )
    return [float(value) for value in embedding]


async def search_async(client, q, k):
    """Return the closest FAQ rows using async Ollama and PostgreSQL calls."""
    from pg.faq_api.orm import Faq

    try:
        query_vector = await request_embedding_async(
            client,
            q,
            appconfig.faq_ollama_url(),
            appconfig.ollama_model(),
        )
    except Exception as exc:  # noqa: BLE001
        raise FaqEmbeddingError("Embedding service failed") from exc

    try:
        distance = Faq.embedding.cosine_distance(query_vector)
        similarity = (1 - distance).label("cosine_similarity")
        statement = (
            select(Faq, similarity)
            .where(Faq.embedding.is_not(None))
            .order_by(distance)
            .limit(k)
        )
        async with _get_async_session_factory()() as session:
            rows = (await session.execute(statement)).all()
    except Exception as exc:  # noqa: BLE001
        raise FaqDatabaseError("Internal error") from exc

    return [
        {
            "id": int(row.id),
            "question": row.question,
            "answer": row.answer,
            "cosine_similarity": float(score),
        }
        for row, score in rows
    ]


async def search_result_async(client, q, k):
    """Return async FAQ matches plus the existing pipeline error category."""
    try:
        with measure_duration("pg_faq_search"):
            items = await search_async(client, q, k)
        return {"items": items, "error": None}
    except FaqEmbeddingError:
        return {"items": [], "error": "pg_faq_embedding_error"}
    except FaqDatabaseError:
        return {"items": [], "error": "pg_faq_database_error"}
    except Exception:  # noqa: BLE001
        return {"items": [], "error": "pg_faq_search_error"}


async def get_faq_async(faq_id):
    """Look up one FAQ through Django's async PostgreSQL read engine.

    Example: an existing id ``42`` returns its question and answer with a
    direct-lookup similarity of ``1.0``.
    """
    from pg.faq_api.orm import Faq

    try:
        async with _get_async_session_factory()() as session:
            row = await session.get(Faq, faq_id)
    except Exception as exc:
        raise FaqDatabaseError("Internal error") from exc
    if row is None:
        return None
    return {
        "id": int(row.id),
        "question": row.question,
        "answer": row.answer,
        "cosine_similarity": 1.0,
    }


async def close_async_faq_engine():
    """Dispose the process-wide async PostgreSQL pool during ASGI shutdown."""
    global _async_session_factory
    if _async_session_factory is None:
        return
    engine = _async_session_factory.kw["bind"]
    _async_session_factory = None
    await engine.dispose()
