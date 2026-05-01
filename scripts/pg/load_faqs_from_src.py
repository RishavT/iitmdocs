#!/usr/bin/env python3
"""
Extract FAQ Q/A pairs from `src/*.md` and emit SQL to load them into Postgres.

## What this script is for

This repository used to keep FAQs inside the markdown files under `src/`.
We later moved FAQs into Postgres (one FAQ per row). This script is the
"loader": it reads markdown files, extracts FAQ blocks, and prints SQL `INSERT`
statements to stdout.

You typically run it like this:

```bash
python3 scripts/pg/load_faqs_from_src.py --src src --truncate \
  | docker exec -i iitm-postgres psql -U faq_user -d faqdb
```

The important idea is: **this script does not connect to Postgres**. It just
generates SQL. The pipe (`|`) sends that SQL into `psql` which executes it.

## Extraction rules (must match the app)

This script intentionally matches the FAQ parsing behavior used by the app
(`worker.js`), so what you load here is the same as what the chatbot expects.

- FAQ format (markdown):
  - `**Question**: <text>`
  - `**Answer**: <text>`
- Only considers content *before* the last `<!-- end of faqs -->` marker
  (if present). This prevents accidentally ingesting non-FAQ content below
  the FAQ section.

## Output format

- Emits a single SQL transaction: `BEGIN; ... COMMIT;`
- Optionally emits `TRUNCATE TABLE faqs;` first (when `--truncate` is set).
"""

from __future__ import annotations

import argparse
import glob
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


END_MARKER = "<!-- end of faqs -->"


@dataclass(frozen=True)
class FAQRow:
    """One row to insert into the `faqs` table."""

    topic_filename: str
    question: str
    answer: str


def _sql_literal(value: str) -> str:
    """
    Convert a Python string into a single-quoted SQL literal.

    Notes:
    - We only escape single quotes by doubling them, which is standard SQL.
    - This is good enough for our use because we feed the SQL into `psql`,
      and Postgres defaults to standard-conforming strings.
    """

    return "'" + value.replace("'", "''") + "'"


def _search_content(full_content: str) -> str:
    """
    Return only the portion of a markdown file that should be searched for FAQs.

    Convention: anything after the last `<!-- end of faqs -->` marker is ignored.
    This mirrors the app-side parsing rules and protects against loading
    non-FAQ content by mistake.
    """

    idx = full_content.rfind(END_MARKER)
    return full_content[:idx] if idx != -1 else full_content


def extract_faqs_from_content(content: str) -> List[Tuple[str, str]]:
    """
    Extract `(question, answer)` pairs from markdown content.

    Expected format (repeated blocks):
    - `**Question**: ...`
    - `**Answer**: ...`

    Returns:
    - List of `(question, answer)` tuples in the order they appear.
    - If the file contains no FAQs (or content is empty), returns `[]`.
    """

    if not content:
        return []

    search = _search_content(content)
    # Split on "**Question**:" headers. The first part is "preamble" content
    # before the first question; we ignore it.
    parts = re.split(r"\*\*Question\*\*:\s*", search)
    faqs: List[Tuple[str, str]] = []

    for part in parts[1:]:
        # For each question block, split once on "**Answer**:".
        answer_split = re.split(r"\*\*Answer\*\*:\s*", part, maxsplit=1)
        if len(answer_split) >= 2:
            question = answer_split[0].strip()
            answer = answer_split[1].strip()
            # We require a question; answer may be empty but we still load it
            # because the DB schema requires `answer NOT NULL` (empty string is ok).
            if question:
                faqs.append((question, answer))
    return faqs


def iter_md_files(src_dir: Path) -> Iterable[Path]:
    """
    Yield markdown files under `src_dir` recursively.

    We intentionally use `glob` to keep behavior predictable across platforms.
    """

    # Keep it simple and predictable: recurse for *.md files.
    for path_str in glob.glob(str(src_dir / "**" / "*.md"), recursive=True):
        p = Path(path_str)
        if p.is_file():
            yield p


def load_rows(src_dir: Path) -> List[FAQRow]:
    """
    Read all markdown files and produce a de-duplicated list of FAQRow objects.

    De-duplication is exact-match on:
    - topic_filename
    - question
    - answer
    """

    rows: List[FAQRow] = []
    for md_path in sorted(iter_md_files(src_dir)):
        try:
            content = md_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as e:
            raise SystemExit(f"ERROR: {md_path} is not valid UTF-8: {e}") from e

        faqs = extract_faqs_from_content(content)
        for q, a in faqs:
            rows.append(
                FAQRow(
                    topic_filename=md_path.name,
                    question=q,
                    answer=a,
                )
            )

    # De-dupe exact duplicates (helps if a file accidentally repeats FAQ blocks).
    deduped: List[FAQRow] = []
    seen = set()
    for r in rows:
        key = (r.topic_filename, r.question, r.answer)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped


def emit_sql(rows: Sequence[FAQRow], truncate: bool, chunk_size: int) -> str:
    """
    Convert FAQRow objects into executable SQL.

    Why we chunk:
    - Very large single INSERT statements can be slow to parse and hard to debug.
    - Chunking keeps statements readable and avoids huge payloads.

    Example return value (shape), assuming `truncate=True` and one row:

    ```sql
    BEGIN;
    TRUNCATE TABLE faqs;
    INSERT INTO faqs (topic_filename, question, answer) VALUES
    ('fees_and_payments.md', 'What is X?', 'X is ...');
    COMMIT;
    ```
    """

    out_lines: List[str] = []
    out_lines.append("BEGIN;")
    if truncate:
        # Used for development/iteration: re-run safely without accumulating duplicates.
        out_lines.append("TRUNCATE TABLE faqs;")

    if not rows:
        out_lines.append("-- No FAQs found in src/*.md")
        out_lines.append("COMMIT;")
        return "\n".join(out_lines) + "\n"

    cols = "(topic_filename, question, answer)"
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        out_lines.append(f"INSERT INTO faqs {cols} VALUES")
        values_lines = []
        for r in chunk:
            # We generate SQL literals directly to keep the script dependency-free.
            values_lines.append(
                "("
                + ", ".join(
                    [
                        _sql_literal(r.topic_filename),
                        _sql_literal(r.question),
                        _sql_literal(r.answer),
                    ]
                )
                + ")"
            )
        out_lines.append(",\n".join(values_lines) + ";")

    out_lines.append("COMMIT;")
    return "\n".join(out_lines) + "\n"


def main(argv: Sequence[str]) -> int:
    """CLI entrypoint. Parses args, extracts rows, and prints SQL to stdout."""

    parser = argparse.ArgumentParser(description="Extract FAQs from src/*.md and emit SQL for Postgres.")
    parser.add_argument("--src", default="src", help="Source directory containing markdown files (default: src)")
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Emit TRUNCATE TABLE faqs; before inserts (recommended for first load)",
    )
    parser.add_argument("--chunk-size", type=int, default=200, help="Rows per INSERT statement (default: 200)")
    args = parser.parse_args(list(argv))

    src_dir = Path(args.src)
    if not src_dir.exists() or not src_dir.is_dir():
        print(f"ERROR: --src must be a directory: {src_dir}", file=sys.stderr)
        return 2

    rows = load_rows(src_dir)
    # Progress goes to stderr so stdout stays clean SQL (safe for piping into psql).
    print(
        f"[pg-load-faqs] Extracted {len(rows)} FAQ rows from {src_dir} ({len(list(iter_md_files(src_dir)))} .md files).",
        file=sys.stderr,
    )

    sys.stdout.write(emit_sql(rows, truncate=args.truncate, chunk_size=max(1, args.chunk_size)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
