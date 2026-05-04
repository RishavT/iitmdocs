#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "weaviate-client>=4.4.0",
#     "python-dotenv>=1.0.0",
#     "psycopg[binary]>=3.1.0",
#     "SQLAlchemy>=2.0.0",
#     "pgvector>=0.3.0",
# ]
# ///

# TODO: The file is now too large. Consider splitting into multiple modules (e.g. `weaviate_utils.py`, `pg_bootstrap.py`) for better organization and maintainability. We can also just move the helper functions to seperate files and keep the main embedding logic in `embed.py` to keep it as the single entry point for the embedding process.
"""
Script to embed all files from src/ directory into Weaviate.
Supports local (Ollama) and gce (remote Ollama) modes via EMBEDDING_MODE env var.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import socket
import time
import urllib.error
import urllib.request
import weaviate
from dotenv import load_dotenv
from pathlib import Path
from weaviate.classes.config import Configure, Property, DataType
from weaviate.classes.init import AdditionalConfig, Timeout
from weaviate.classes.query import Filter

from pg.faq_api.orm import create_pg_engine, create_session_factory, session_scope
from pg.faq_api.repository import (
    count_faqs,
    count_faqs_missing_embeddings,
    get_faqs_missing_embeddings,
    replace_seed_faqs,
    update_faq_embedding,
)

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def clear_collection(weaviate_client):
    """Delete the Document collection if it exists"""
    if weaviate_client.collections.exists("Document"):
        logger.warning("CLEAR_DB=true: Deleting existing Document collection...")
        weaviate_client.collections.delete("Document")
        logger.info("Document collection deleted. Will recreate with fresh embeddings.")
    else:
        logger.info("No existing Document collection to clear.")


def create_schema(weaviate_client, embedding_mode="local", embedding_model=None, ollama_endpoint=None):
    """Create or update the Document class schema in Weaviate"""
    # Configure vectorizer based on mode and provider
    logger.debug(f"EMBEDDING MODE: {embedding_mode}")
    if embedding_mode == "local":
        model = embedding_model or "bge-m3"
        logger.warning(f"EMBEDDING_MODEL: {embedding_model}")
        vectorizer_config = Configure.Vectorizer.text2vec_ollama(
            model=model,
            api_endpoint="http://ollama:11434"
        )
        expected_vectorizer = "text2vec-ollama"
    elif embedding_mode == "gce":
        # GCE mode: connect to remote Ollama on GCE VM
        model = embedding_model or "bge-m3"
        ollama_url = ollama_endpoint or os.getenv("GCE_OLLAMA_URL", "http://localhost:11434")
        vectorizer_config = Configure.Vectorizer.text2vec_ollama(
            model=model,
            api_endpoint=ollama_url
        )
        expected_vectorizer = "text2vec-ollama"
    else:
        raise ValueError(
            f"Unsupported EMBEDDING_MODE='{embedding_mode}'. Supported values: local, gce."
        )

    # Check if collection exists and validate vectorizer configuration
    if weaviate_client.collections.exists("Document"):
        try:
            collection = weaviate_client.collections.get("Document")
            existing_vectorizer = collection.config.get().vectorizer.value if hasattr(collection.config.get().vectorizer, 'value') else str(collection.config.get().vectorizer)

            # Only delete if vectorizer has changed
            if existing_vectorizer != expected_vectorizer:
                logger.warning(
                    f"Vectorizer mismatch! Existing: {existing_vectorizer}, Expected: {expected_vectorizer}. "
                    f"Deleting and recreating collection with {embedding_mode} embeddings. "
                    f"ALL EXISTING EMBEDDINGS WILL BE LOST."
                )
                weaviate_client.collections.delete("Document")
            else:
                logger.info(f"Collection exists with correct vectorizer ({expected_vectorizer}). Reusing existing collection.")
                return collection
        except Exception as e:
            logger.warning(f"Could not validate existing collection config: {e}. Recreating collection.")
            weaviate_client.collections.delete("Document")

    properties = [
        Property(name="filename", data_type=DataType.TEXT, description="Name of the source file"),
        Property(name="filepath", data_type=DataType.TEXT, description="Full path to the source"),
        Property(name="content", data_type=DataType.TEXT, description="Content of the document"),
        Property(name="file_size", data_type=DataType.INT, description="File size in bytes"),
        Property(name="content_hash", data_type=DataType.TEXT, description="SHA256 of the content"),
        Property(name="file_extension", data_type=DataType.TEXT, description="File extension"),
    ]

    logger.info(f"Creating new Document collection with {embedding_mode} mode, {expected_vectorizer} (model: {model})")
    return weaviate_client.collections.create(
        name="Document",
        vectorizer_config=vectorizer_config,
        properties=properties,
    )


# Files to exclude from embedding (used for internal purposes, not for search)
EXCLUDED_FILES = [
    "_knowledge_base_summary.md",  # Query rewriting context - not for vector search
]


def _is_true(value: str | None) -> bool:
    """Return True if the string represents a truthy value (env-var friendly)."""
    return (value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _split_sql_statements(sql_text: str) -> list[str]:
    """
    Split SQL text into executable statements.

    We cannot naively split on ';' because PL/pgSQL functions contain semicolons
    inside dollar-quoted blocks (e.g. `$$ ... $$`).
    """

    statements: list[str] = []
    buf: list[str] = []

    in_single = False
    in_double = False
    dollar_tag: str | None = None

    i = 0
    n = len(sql_text)

    def flush() -> None:
        s = "".join(buf).strip()
        if s:
            statements.append(s)
        buf.clear()

    while i < n:
        ch = sql_text[i]
        nxt = sql_text[i + 1] if i + 1 < n else ""

        if dollar_tag is None and not in_single and not in_double:
            if ch == "-" and nxt == "-":
                # Line comment: consume until newline.
                while i < n and sql_text[i] != "\n":
                    i += 1
                continue
            if ch == "/" and nxt == "*":
                # Block comment: consume until closing */.
                i += 2
                while i + 1 < n and not (sql_text[i] == "*" and sql_text[i + 1] == "/"):
                    i += 1
                i += 2
                continue

        if dollar_tag is None and not in_double and ch == "'" and not in_single:
            in_single = True
            buf.append(ch)
            i += 1
            continue
        if dollar_tag is None and in_single:
            buf.append(ch)
            if ch == "'" and nxt == "'":
                buf.append(nxt)
                i += 2
                continue
            if ch == "'":
                in_single = False
            i += 1
            continue

        if dollar_tag is None and not in_single and ch == '"':
            in_double = not in_double
            buf.append(ch)
            i += 1
            continue

        if dollar_tag is None and not in_single and not in_double and ch == "$":
            # Dollar-quote: $tag$ ... $tag$
            j = i + 1
            while j < n and (sql_text[j].isalnum() or sql_text[j] == "_"):
                j += 1
            if j < n and sql_text[j] == "$":
                dollar_tag = sql_text[i : j + 1]
                buf.append(dollar_tag)
                i = j + 1
                continue

        if dollar_tag is not None:
            if sql_text.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
                continue
            buf.append(ch)
            i += 1
            continue

        if not in_single and not in_double and dollar_tag is None and ch == ";":
            flush()
            i += 1
            continue

        buf.append(ch)
        i += 1

    flush()
    return statements


def _log_pg_env_summary() -> None:
    # Log presence only (never values for secrets).
    keys = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE"]
    summary = {k: ("set" if os.getenv(k) else "unset") for k in keys}
    logger.info(f"[pg-bootstrap] PG env summary: {summary}")


def _create_pg_bootstrap_engine():
    """Create a SQLAlchemy engine after validating bootstrap Postgres env vars."""

    host = os.getenv("PGHOST")
    port = int(os.getenv("PGPORT", "5432"))
    db = os.getenv("PGDATABASE")
    user = os.getenv("PGUSER")
    password = os.getenv("PGPASSWORD")
    sslmode = os.getenv("PGSSLMODE")
    connect_timeout = int(os.getenv("PGCONNECT_TIMEOUT", "10"))

    missing = [k for k, v in [("PGHOST", host), ("PGDATABASE", db), ("PGUSER", user), ("PGPASSWORD", password)] if not v]
    if missing:
        _log_pg_env_summary()
        raise ValueError(f"Missing required Postgres env vars: {', '.join(missing)}")

    logger.info(f"[pg-bootstrap] Connecting to Postgres: host={host} port={port} db={db} user={user} sslmode={sslmode or '<default>'} timeout={connect_timeout}s")

    # DNS resolution logging is extremely helpful for debugging Cloud SQL private IP / VPC issues.
    try:
        addrs = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        uniq = sorted({a[4][0] for a in addrs})
        logger.info(f"[pg-bootstrap] PGHOST resolved to: {uniq}")
    except Exception as exc:
        logger.warning(f"[pg-bootstrap] Could not resolve PGHOST={host}: {exc}")

    try:
        engine = create_pg_engine()
    except Exception:
        logger.exception("[pg-bootstrap] Failed to create SQLAlchemy engine.")
        raise

    # Emit a lightweight "we are really connected" banner without leaking anything sensitive.
    try:
        with engine.connect() as conn:
            conn.close()
        logger.info(f"[pg-bootstrap] Connected. current_database={db!r} current_user={user!r}")
    except Exception as exc:
        logger.warning(f"[pg-bootstrap] Engine created but connection check failed: {exc}")

    return engine


def _pg_apply_sql_file(engine, path: str) -> None:
    """Execute a SQL file by splitting it into statements safely."""

    t0 = time.monotonic()
    with open(path, "r", encoding="utf-8") as f:
        sql_text = f.read()

    statements = _split_sql_statements(sql_text)
    if not statements:
        logger.info(f"[pg-bootstrap] SQL file is empty, skipping: {path}")
        return

    logger.info(f"[pg-bootstrap] Applying SQL: {path} (statements={len(statements)})")
    with engine.begin() as conn:
        for idx, stmt in enumerate(statements, 1):
            try:
                conn.exec_driver_sql(stmt)
            except Exception:
                snippet = stmt.strip().replace("\n", " ")
                if len(snippet) > 220:
                    snippet = snippet[:220] + "…"
                logger.exception(f"[pg-bootstrap] SQL failed in {path} at statement {idx}/{len(statements)}: {snippet}")
                raise
    logger.info(f"[pg-bootstrap] Applied SQL OK: {path} (elapsed_ms={int((time.monotonic() - t0) * 1000)})")


def _load_seed_faqs(path: str) -> list[dict]:
    """Load `pg/seed/faqs.json` and validate minimal shape."""

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"Seed file must be a JSON array: {path}")

    for i, row in enumerate(data):
        if not isinstance(row, dict):
            raise ValueError(f"Seed row {i} must be an object")
        for key in ("topic_filename", "question", "answer"):
            if not (row.get(key) or "").strip():
                raise ValueError(f"Seed row {i} missing/empty {key}")
    return data


def _request_ollama_embedding(text: str, ollama_url: str, model: str) -> list[float]:
    """
    Request a single embedding vector from Ollama for the given text.

    Calls `POST {ollama_url}/api/embeddings` with JSON payload:
    `{"model": <model>, "prompt": <text>}` and returns the `embedding` list.
    """
    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {err}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach Ollama at {ollama_url}: {exc}") from exc

    parsed = json.loads(body)
    embedding = parsed.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama returned invalid embedding payload")
    return [float(v) for v in embedding]


def _pg_backfill_faq_embeddings(
    session_factory,
    *,
    ollama_url: str,
    model: str,
    dimension: int,
    batch_size: int,
) -> int:
    """
    Backfill missing FAQ embeddings in Postgres in small batches.

    This function looks for rows in the `faqs` table where `embedding` is NULL,
    requests an embedding vector for each row's `question` from Ollama, and then
    writes the vector back to Postgres (as a `vector` column, via pgvector).

    It repeats until no rows remain with NULL embeddings.

    Parameters
    ----------
    session_factory:
        SQLAlchemy session factory connected to the target Postgres database.
    ollama_url:
        Base URL of the Ollama server (e.g. `http://ollama:11434`).
    model:
        Ollama embedding model name (e.g. `bge-m3`).
    dimension:
        Expected embedding vector length. If Ollama returns a different length,
        the function fails fast to avoid mixing incompatible vector sizes.
    batch_size:
        Maximum number of FAQ rows to embed per iteration.

    Returns
    -------
    int
        Total number of FAQ rows updated with embeddings.
    """
    updated = 0
    batch_num = 0
    while True:
        with session_factory() as session:
            rows = get_faqs_missing_embeddings(session, batch_size)

        if not rows:
            break

        batch_num += 1
        embedded_rows: list[tuple[int, list[float]]] = []
        for row in rows:
            # Ask Ollama for the embedding for this FAQ's question text.
            emb = _request_ollama_embedding(row.question, ollama_url, model)
            # pgvector columns require consistent dimensions across all rows.
            if len(emb) != dimension:
                raise RuntimeError(
                    f"Embedding dimension mismatch for id={row.id}: expected {dimension}, got {len(emb)}"
                )
            embedded_rows.append((row.id, emb))

        with session_scope(session_factory) as session:
            for faq_id, emb in embedded_rows:
                update_faq_embedding(session, faq_id, emb)

        updated += len(embedded_rows)
        logger.info(f"[pg-bootstrap] Backfill batch {batch_num}: embedded {len(embedded_rows)} rows (total updated: {updated})")
    return updated


def maybe_bootstrap_cloudsql_faq_db(embedding_mode: str) -> None:
    """
    Optional Cloud SQL bootstrap for Postgres-backed FAQ search.

    This is opt-in so local and GCE mode keep behaving the same unless explicitly enabled.
    """

    if not _is_true(os.getenv("ENABLE_PG_FAQ_BOOTSTRAP")):
        logger.info("PG FAQ bootstrap disabled (ENABLE_PG_FAQ_BOOTSTRAP not set to true).")
        return

    seed_path = os.getenv("FAQ_SEED_PATH", "pg/seed/faqs.json")
    schema_dir = os.getenv("FAQ_SQL_DIR", "pg/init")

    model = os.getenv("OLLAMA_MODEL", "bge-m3")
    dimension = int(os.getenv("FAQ_EMBEDDING_DIMENSION", os.getenv("EMBEDDING_DIMENSION", "1024")))
    batch_size = int(os.getenv("FAQ_EMBEDDING_BATCH_SIZE", "50"))

    if embedding_mode == "gce":
        ollama_url = os.getenv("OLLAMA_URL") or os.getenv("GCE_OLLAMA_URL")
    else:
        ollama_url = os.getenv("OLLAMA_URL") or "http://ollama:11434"

    if not ollama_url:
        raise ValueError("Ollama URL missing: set OLLAMA_URL (or GCE_OLLAMA_URL for EMBEDDING_MODE=gce)")

    logger.info("[pg-bootstrap] Starting Cloud SQL FAQ bootstrap...")
    logger.info(f"[pg-bootstrap] Seed: {seed_path}")
    logger.info(f"[pg-bootstrap] SQL dir: {schema_dir}")
    logger.info(f"[pg-bootstrap] Embedding: model={model}, dim={dimension}, batch={batch_size}, ollama_url={ollama_url}")

    t_all = time.monotonic()

    # Step 1: load seed.
    try:
        t0 = time.monotonic()
        rows = _load_seed_faqs(seed_path)
        logger.info(f"[pg-bootstrap] Loaded seed FAQs: rows={len(rows)} (elapsed_ms={int((time.monotonic() - t0) * 1000)})")
    except Exception:
        logger.exception(f"[pg-bootstrap] Failed to load seed file: {seed_path}")
        raise

    # Step 2: quick Ollama health check before touching the DB.
    try:
        t0 = time.monotonic()
        req = urllib.request.Request(f"{ollama_url.rstrip('/')}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            _ = resp.read(256)
        logger.info(f"[pg-bootstrap] Ollama reachable at {ollama_url} (elapsed_ms={int((time.monotonic() - t0) * 1000)})")
    except Exception:
        logger.exception(f"[pg-bootstrap] Ollama is not reachable at {ollama_url}. Aborting PG bootstrap.")
        raise

    # Step 3: connect + migrate + replace seed rows + backfill.
    engine = _create_pg_bootstrap_engine()
    try:
        # Existing schema SQL in the repo (idempotent; safe to re-run).
        _pg_apply_sql_file(engine, os.path.join(schema_dir, "001_faq_schema.sql"))
        _pg_apply_sql_file(engine, os.path.join(schema_dir, "002_add_faq_embedding.sql"))
        # TODO: After this cleanup has run successfully across all deployed environments, consider renaming/removing this legacy cleanup SQL file. If that happens, update every code/deployment reference to `004_faq_upsert_contract.sql` at the same time.
        _pg_apply_sql_file(engine, os.path.join(schema_dir, "004_faq_upsert_contract.sql"))

        session_factory = create_session_factory(engine)

        try:
            with session_scope(session_factory) as session:
                before_total = count_faqs(session)
                before_null = count_faqs_missing_embeddings(session)
            logger.info(f"[pg-bootstrap] DB state before replace/backfill: faqs_total={before_total} faqs_embedding_null={before_null}")
        except Exception as exc:
            logger.warning(f"[pg-bootstrap] Could not read pre-replace counts: {exc}")

        with session_scope(session_factory) as session:
            inserted = replace_seed_faqs(session, rows)
        logger.info(f"[pg-bootstrap] Replaced FAQ table with {inserted} seed rows.")

        try:
            with session_scope(session_factory) as session:
                after_total = count_faqs(session)
                after_null = count_faqs_missing_embeddings(session)
            logger.info(f"[pg-bootstrap] DB state after replace (before backfill): faqs_total={after_total} faqs_embedding_null={after_null}")
        except Exception as exc:
            logger.warning(f"[pg-bootstrap] Could not read post-replace counts: {exc}")

        backfilled = _pg_backfill_faq_embeddings(
            session_factory,
            ollama_url=ollama_url,
            model=model,
            dimension=dimension,
            batch_size=batch_size,
        )
        logger.info(f"[pg-bootstrap] Backfill complete. Newly embedded rows: {backfilled}.")

        try:
            with session_scope(session_factory) as session:
                final_null = count_faqs_missing_embeddings(session)
            logger.info(f"[pg-bootstrap] Final DB state: faqs_embedding_null={final_null}")
        except Exception as exc:
            logger.warning(f"[pg-bootstrap] Could not read final counts: {exc}")
    finally:
        engine.dispose()

    logger.info(f"[pg-bootstrap] Cloud SQL FAQ bootstrap finished OK (elapsed_ms={int((time.monotonic() - t_all) * 1000)})")


def embed_documents(weaviate_client, src_directory: str, embedding_mode="local", embedding_model=None, ollama_endpoint=None) -> bool:
    """Embed all documents from the src directory into Weaviate"""
    collection = create_schema(weaviate_client, embedding_mode, embedding_model, ollama_endpoint)
    src_path = Path(src_directory)

    # Exclude internal files that shouldn't be in vector search
    files = [f for f in src_path.glob("**/*") if f.is_file() and f.name not in EXCLUDED_FILES]
    total_files = len(files)
    logger.info(f"Processing {total_files} files from {src_path.absolute()}")

    successful_embeds = 0
    skipped = 0
    failed = 0

    for idx, file_path in enumerate(files, 1):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except (UnicodeDecodeError, IOError) as e:
            logger.warning(f"[{idx}/{total_files}] Skipping {file_path.name}: {e}")
            skipped += 1
            continue

        try:
            doc_data = {
                "filename": file_path.name,
                "filepath": str(file_path),
                "content": content,
                "file_size": file_path.stat().st_size,
                "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "file_extension": file_path.suffix,
            }

            existing = collection.query.fetch_objects(
                filters=Filter.by_property("filepath").equal(doc_data["filepath"]), limit=1
            )

            # Log character length for tracking (success path will log later)
            content_char_length = len(content)
            logger.info(f"[{idx}/{total_files}] Processing: {file_path.name} ({content_char_length} chars)")

            if existing.objects:
                existing_doc = existing.objects[0]
                if existing_doc.properties["content_hash"] == doc_data["content_hash"]:
                    logger.info(f"[{idx}/{total_files}] Unchanged: {file_path.name}")
                    skipped += 1
                    continue
                collection.data.update(uuid=existing_doc.uuid, properties=doc_data)
                logger.info(f"[{idx}/{total_files}] Updated: {file_path.name}")
            else:
                collection.data.insert(doc_data)
                logger.info(f"[{idx}/{total_files}] Embedded: {file_path.name}")

            successful_embeds += 1
        except Exception as e:
            # LOG FULL PAYLOAD ONLY WHEN EMBEDDING FAILS
            logger.error(f"[{idx}/{total_files}] EMBEDDING FAILED for {file_path.name}")
            logger.error(f"[{idx}/{total_files}] Failed payload had {len(content)} characters")
            # logger.error(f"[{idx}/{total_files}] FULL PAYLOAD TEXT START >>>")
            # logger.error(content)
            # logger.error(f"[{idx}/{total_files}] FULL PAYLOAD TEXT END <<<")
            logger.error(f"[{idx}/{total_files}] Error: {e}")
            failed += 1
            continue

    logger.info(f"Completed: {successful_embeds} embedded, {skipped} skipped, {failed} failed (total: {total_files})")
    return True


def main():
    """Main function to run the embedding process"""
    load_dotenv()

    # Clear existing embeddings before re-embedding (default: true)
    # Set CLEAR_DB=false to keep existing embeddings and only update changed files
    clear_db = os.getenv("CLEAR_DB", "true").lower() == "true"

    # Determine embedding mode: 'local' or 'gce'
    embedding_mode = os.getenv("EMBEDDING_MODE", "local").lower()
    logger.info(f"Embedding mode: {embedding_mode}")

    supported_modes = {"local", "gce"}
    if embedding_mode not in supported_modes:
        raise ValueError(
            f"Unsupported EMBEDDING_MODE='{embedding_mode}'. Supported values: local, gce."
        )

    # Optional: bootstrap managed Postgres FAQ DB during deploy (Cloud SQL).
    # Opt-in so local/GCE runs keep behaving the same unless explicitly enabled.
    maybe_bootstrap_cloudsql_faq_db(embedding_mode)

    if clear_db:
        logger.info("Will clear existing embeddings before re-embedding (set CLEAR_DB=false to disable)")
    else:
        logger.info("CLEAR_DB=false: Keeping existing embeddings, only updating changed files")

    if embedding_mode == "local":
        # Local mode: connect to local Weaviate (no auth needed)
        weaviate_url = os.getenv("LOCAL_WEAVIATE_URL", "http://weaviate:8080")
        embedding_model = os.getenv("OLLAMA_MODEL", "bge-m3")

        logger.info(f"Connecting to local Weaviate at {weaviate_url}")
        client = weaviate.connect_to_local(
            host=weaviate_url.replace("http://", "").split(":")[0],
            port=int(weaviate_url.split(":")[-1]) if ":" in weaviate_url.split("//")[-1] else 8080,
            additional_config=AdditionalConfig(timeout=Timeout(init=600, query=600, insert=600))
        )
        if clear_db:
            clear_collection(client)
        embed_documents(client, "src", embedding_mode, embedding_model)
        client.close()
    elif embedding_mode == "gce":
        # GCE mode: connect to remote Weaviate on GCE VM (no auth needed)
        weaviate_url = os.getenv("GCE_WEAVIATE_URL")
        ollama_url = os.getenv("GCE_OLLAMA_URL")
        embedding_model = os.getenv("OLLAMA_MODEL", "bge-m3")

        if not weaviate_url:
            raise ValueError("GCE_WEAVIATE_URL is required for GCE mode")
        if not ollama_url:
            raise ValueError("GCE_OLLAMA_URL is required for GCE mode")

        logger.info(f"Connecting to GCE Weaviate at {weaviate_url}")
        logger.info(f"Using GCE Ollama at {ollama_url}")

        # Parse the URL to get host and port
        url_parts = weaviate_url.replace("http://", "").replace("https://", "")
        host = url_parts.split(":")[0]
        port = int(url_parts.split(":")[1]) if ":" in url_parts else 8080

        # Use connect_to_custom with skip_init_checks to use REST instead of gRPC
        client = weaviate.connect_to_custom(
            http_host=host,
            http_port=port,
            http_secure=False,
            grpc_host=host,
            grpc_port=50051,
            grpc_secure=False,
            skip_init_checks=True,
            additional_config=AdditionalConfig(timeout=Timeout(init=600, query=600, insert=600))
        )
        if clear_db:
            clear_collection(client)
        embed_documents(client, "src", embedding_mode, embedding_model, ollama_url)
        client.close()


if __name__ == "__main__":
    main()
