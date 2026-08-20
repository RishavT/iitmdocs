from __future__ import annotations

"""
FastAPI HTTP service for Postgres-backed FAQ search.

This file answers: "How does `worker.js` talk to the FAQ database over HTTP?"

The service exposes two runtime endpoints:
- `POST /search`: embed the user's query, search FAQ embeddings in Postgres, and return the closest FAQ question/answer rows
- `GET /faq/{id}`: return one exact FAQ row when the user clicks a "Did you mean?" suggestion

This file should stay focused on HTTP concerns: request/response models,
environment settings, Ollama embedding calls, error handling, and converting repository results into API responses.

It should not contain raw SQL or low-level table logic. Database operations belong in `repository.py`; table/session definitions belong in `orm.py`.
"""

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from pg.faq_api.orm import create_pg_engine, create_session_factory, required_pg_env, session_scope
from pg.faq_api.repository import FaqSearchRow, get_faq_by_id, search_faqs_by_embedding


logger = logging.getLogger(__name__)
OLLAMA_TIMEOUT_SECONDS = 60

# Environment configuration (read once at startup)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "bge-m3")
try:
    EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "1024"))
except ValueError as exc:
    raise RuntimeError("EMBEDDING_DIMENSION must be an integer") from exc

app = FastAPI(title="PG FAQ API", version="0.1.0")
SessionFactory = create_session_factory(create_pg_engine()) # create engine once at startup, reuse sessions per request


class SearchRequest(BaseModel):
    """Request payload for semantic FAQ search."""

    q: str = Field(..., min_length=1, description="User query text to embed and search with.")
    k: int = Field(5, ge=1, le=20, description="Number of FAQ rows to return.")


class SearchResult(BaseModel):
    """One FAQ result row plus similarity score."""

    id: int
    question: str
    answer: str
    cosine_similarity: float


class SearchResponse(BaseModel):
    """Response payload for semantic FAQ search."""

    results: List[SearchResult]


def request_embedding(text: str, ollama_url: str, model: str) -> List[float]:
    """Get the embedding vector of a text string by making a request to the Ollama embeddings API. Returns a list of floats representing the embedding vector."""

    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        # Bound upstream waits so one stuck Ollama call cannot hold a worker forever.
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach Ollama at {ollama_url}: {exc}") from exc

    parsed = json.loads(body)
    embedding = parsed.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama returned invalid embedding payload")
    if len(embedding) != EMBEDDING_DIMENSION:
        raise RuntimeError(
            f"Ollama embedding dimension mismatch: expected {EMBEDDING_DIMENSION}, got {len(embedding)}"
        )
    return [float(v) for v in embedding]


def to_search_result(row: FaqSearchRow) -> SearchResult:
    """Convert a repository FAQ row to the public API response model."""

    return SearchResult(
        id=row.id,
        question=row.question,
        answer=row.answer,
        cosine_similarity=row.cosine_similarity,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    """Basic health check endpoint."""

    return {"ok": True}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    """
    Exact semantic search over FAQs using cosine similarity.

    Design choices:
    - question_only embeddings (embed req.q only)
    - exact search (no HNSW index) because FAQ table is small
    """

    try:
        query_vec = request_embedding(req.q, OLLAMA_URL, OLLAMA_MODEL)
    except Exception as exc:
        logger.exception("Ollama embedding request failed")
        raise HTTPException(status_code=502, detail="Embedding service failed") from exc

    try:
        with session_scope(SessionFactory) as session:
            rows = search_faqs_by_embedding(session, query_vec, req.k)
    except Exception as exc:
        logger.exception("Postgres FAQ search failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc

    return SearchResponse(results=[to_search_result(row) for row in rows])


@app.get("/faq/{faq_id}", response_model=SearchResult)
def get_faq(faq_id: int) -> SearchResult:
    """Fetch a single FAQ row by id (direct lookup for UI clickthrough)."""
    try:
        with session_scope(SessionFactory) as session:
            row = get_faq_by_id(session, faq_id)
    except Exception as exc:
        logger.exception("Postgres FAQ lookup failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc

    if not row:
        raise HTTPException(status_code=404, detail="FAQ not found")

    return to_search_result(row)
