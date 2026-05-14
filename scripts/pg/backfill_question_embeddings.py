#!/usr/bin/env python3
"""
Backfill NULL FAQ embeddings in Postgres using Ollama.

Confirmed behavior for this repository:
- Embed question text only
- Use model bge-m3
- Write to faqs.embedding (vector(1024))
- Only update rows where embedding IS NULL
- Process rows in batches

This script runs on the host and talks to Postgres through `docker exec ... psql`,
so it does not require a local Postgres client installation or Python DB driver.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable, List, Sequence


@dataclass(frozen=True)
class FAQRow:
    """Minimal FAQ payload needed for question-only embedding backfill."""

    faq_id: int
    question: str


def run_command(cmd: Sequence[str], *, stdin_text: str | None = None) -> str:
    """Run a subprocess and return stdout, raising a detailed error on failure."""

    result = subprocess.run(
        cmd,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result.stdout


def fetch_null_embedding_rows(container: str, db_user: str, db_name: str, batch_size: int) -> List[FAQRow]:
    """Fetch a batch of FAQ rows whose embeddings have not been backfilled yet."""

    sql = (
        "COPY ("
        "SELECT id, question "
        "FROM faqs "
        "WHERE embedding IS NULL "
        "ORDER BY id "
        f"LIMIT {batch_size}"
        ") TO STDOUT WITH CSV"
    )
    stdout = run_command(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-U",
            db_user,
            "-d",
            db_name,
            "-q",
            "-c",
            sql,
        ]
    )

    rows: List[FAQRow] = []
    # CSV output keeps parsing predictable even if question text contains commas.
    reader = csv.reader(io.StringIO(stdout))
    for line in reader:
        if not line:
            continue
        rows.append(FAQRow(faq_id=int(line[0]), question=line[1]))
    return rows


def request_embedding(question: str, ollama_url: str, model: str) -> List[float]:
    """Request a single embedding vector from the Ollama HTTP API."""

    payload = json.dumps({"model": model, "prompt": question}).encode("utf-8")
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

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from Ollama: {body[:500]}") from exc

    embedding = parsed.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError(f"Ollama returned invalid embedding payload: {body[:500]}")

    return [float(value) for value in embedding]


def vector_literal(values: Iterable[float]) -> str:
    """Convert numeric embedding values to pgvector text literal format."""

    # Limit float precision to keep SQL payloads smaller while preserving enough accuracy.
    return "[" + ",".join(format(value, ".12g") for value in values) + "]"


def emit_update_sql(rows_with_embeddings: Sequence[tuple[int, List[float]]], expected_dimension: int) -> str:
    """Build a transactional SQL script that writes one batch of embeddings."""

    statements = ["BEGIN;"]
    for faq_id, embedding in rows_with_embeddings:
        if len(embedding) != expected_dimension:
            raise RuntimeError(
                f"Embedding dimension mismatch for faq id {faq_id}: "
                f"expected {expected_dimension}, got {len(embedding)}"
            )
        statements.append(
            f"UPDATE faqs SET embedding = '{vector_literal(embedding)}'::vector WHERE id = {faq_id};"
        )
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n"


def apply_updates(container: str, db_user: str, db_name: str, sql: str) -> None:
    """Apply a batch of embedding updates inside the running Postgres container."""

    run_command(
        ["docker", "exec", "-i", container, "psql", "-U", db_user, "-d", db_name],
        stdin_text=sql,
    )


def count_null_embeddings(container: str, db_user: str, db_name: str) -> int:
    """Return the number of FAQ rows that still need embeddings."""

    stdout = run_command(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-U",
            db_user,
            "-d",
            db_name,
            "-t",
            "-A",
            "-c",
            "SELECT COUNT(*) FROM faqs WHERE embedding IS NULL;",
        ]
    )
    return int(stdout.strip() or "0")


def main(argv: Sequence[str]) -> int:
    """Parse CLI args and backfill question embeddings until the target set is exhausted."""

    parser = argparse.ArgumentParser(description="Backfill NULL FAQ embeddings from Ollama into Postgres.")
    parser.add_argument("--container", default="iitm-postgres", help="Docker container name for Postgres")
    parser.add_argument("--db-user", default="faq_user", help="Postgres user")
    parser.add_argument("--db-name", default="faqdb", help="Postgres database name")
    parser.add_argument("--ollama-url", default="http://localhost:11434", help="Ollama HTTP URL")
    parser.add_argument("--model", default="bge-m3", help="Ollama embedding model")
    parser.add_argument("--dimension", type=int, default=1024, help="Expected embedding dimension")
    parser.add_argument("--batch-size", type=int, default=25, help="Rows per batch")
    parser.add_argument("--max-batches", type=int, default=0, help="Stop after N batches (0 = run until done)")
    args = parser.parse_args(list(argv))

    if args.batch_size < 1:
        print("ERROR: --batch-size must be >= 1", file=sys.stderr)
        return 2
    if args.max_batches < 0:
        print("ERROR: --max-batches must be >= 0", file=sys.stderr)
        return 2

    total_updated = 0
    batch_num = 0

    while True:
        if args.max_batches and batch_num >= args.max_batches:
            break

        rows = fetch_null_embedding_rows(args.container, args.db_user, args.db_name, args.batch_size)
        if not rows:
            break

        batch_num += 1
        print(f"[pg-backfill] Batch {batch_num}: fetched {len(rows)} rows with NULL embeddings.", file=sys.stderr)

        updates: List[tuple[int, List[float]]] = []
        for row in rows:
            # Embedding only the question is a deliberate design choice for FAQ intent matching.
            embedding = request_embedding(row.question, args.ollama_url, args.model)
            updates.append((row.faq_id, embedding))

        sql = emit_update_sql(updates, args.dimension)
        apply_updates(args.container, args.db_user, args.db_name, sql)

        total_updated += len(updates)
        # Recount after each committed batch so progress logs reflect the actual DB state.
        remaining = count_null_embeddings(args.container, args.db_user, args.db_name)
        print(
            f"[pg-backfill] Batch {batch_num}: updated {len(updates)} rows. "
            f"Remaining NULL embeddings: {remaining}.",
            file=sys.stderr,
        )

    print(f"[pg-backfill] Completed. Total updated rows: {total_updated}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
