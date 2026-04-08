from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, List, Optional

import psycopg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


app = FastAPI(title="PG FAQ API", version="0.1.0")


@dataclass(frozen=True)
class Settings:
    """Runtime configuration loaded from environment variables."""

    pg_host: str
    pg_port: int
    pg_db: str
    pg_user: str
    pg_password: str
    ollama_url: str
    ollama_model: str
    embedding_dimension: int


def get_settings() -> Settings:
    """Read environment variables and return validated service settings."""

    try:
        pg_port = int(os.getenv("PGPORT", "5432"))
    except ValueError as exc:
        raise RuntimeError("PGPORT must be an integer") from exc

    try:
        embedding_dimension = int(os.getenv("EMBEDDING_DIMENSION", "1024"))
    except ValueError as exc:
        raise RuntimeError("EMBEDDING_DIMENSION must be an integer") from exc

    return Settings(
        pg_host=os.getenv("PGHOST", "postgres"),
        pg_port=pg_port,
        pg_db=os.getenv("PGDATABASE", "faqdb"),
        pg_user=os.getenv("PGUSER", "faq_user"),
        pg_password=os.getenv("PGPASSWORD", "faq_password"),
        ollama_url=os.getenv("OLLAMA_URL", "http://ollama:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "bge-m3"),
        embedding_dimension=embedding_dimension,
    )


class SearchRequest(BaseModel):
    """Request payload for semantic FAQ search."""

    q: str = Field(..., min_length=1, description="User query text to embed and search with.")
    k: int = Field(5, ge=1, le=20, description="Number of FAQ rows to return.")


class SearchResult(BaseModel):
    """One FAQ result row plus similarity score."""

    id: int
    topic_filename: Optional[str]
    question: str
    answer: str
    cosine_similarity: float


class SearchResponse(BaseModel):
    """Response payload for semantic FAQ search."""

    results: List[SearchResult]


def request_embedding(text: str, ollama_url: str, model: str) -> List[float]:
    """Call Ollama embeddings API and return a vector."""

    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as response:
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
    return [float(v) for v in embedding]


def vector_literal(values: List[float]) -> str:
    """Format a vector as pgvector text literal, for casting to vector."""

    return "[" + ",".join(format(v, ".12g") for v in values) + "]"


def open_pg_connection(s: Settings) -> psycopg.Connection:
    """Open a Postgres connection using settings."""

    # For this small local service, a per-request connection is sufficient.
    return psycopg.connect(
        host=s.pg_host,
        port=s.pg_port,
        dbname=s.pg_db,
        user=s.pg_user,
        password=s.pg_password,
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

    s = get_settings()

    try:
        query_vec = request_embedding(req.q, s.ollama_url, s.ollama_model)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if len(query_vec) != s.embedding_dimension:
        raise HTTPException(
            status_code=500,
            detail=f"Embedding dimension mismatch: expected {s.embedding_dimension}, got {len(query_vec)}",
        )

    vec_str = vector_literal(query_vec)

    sql = """
    SELECT
      id,
      topic_filename,
      question,
      answer,
      1 - (embedding <=> %s::vector) AS cosine_similarity
    FROM faqs
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> %s::vector
    LIMIT %s;
    """

    try:
        with open_pg_connection(s) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (vec_str, vec_str, req.k))
                rows = cur.fetchall()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Postgres query failed: {exc}") from exc

    results: List[SearchResult] = []
    for row in rows:
        results.append(
            SearchResult(
                id=int(row[0]),
                topic_filename=row[1],
                question=row[2],
                answer=row[3],
                cosine_similarity=float(row[4]),
            )
        )

    return SearchResponse(results=results)

