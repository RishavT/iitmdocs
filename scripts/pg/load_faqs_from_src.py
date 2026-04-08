#!/usr/bin/env python3
"""
Extract FAQ Q/A pairs from src/*.md and emit SQL to load them into Postgres.

Matches worker.js extractFAQs() behavior:
- FAQ format: "**Question**: <text>\n**Answer**: <text>"
- Only considers content before the last "<!-- end of faqs -->" marker (if present).
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


END_MARKER = "<!-- end of faqs -->"


@dataclass(frozen=True)
class FAQRow:
    topic_filename: str
    question: str
    answer: str


def _sql_literal(value: str) -> str:
    # Standard SQL string literal escaping: single-quote doubled.
    return "'" + value.replace("'", "''") + "'"


def _search_content(full_content: str) -> str:
    idx = full_content.rfind(END_MARKER)
    return full_content[:idx] if idx != -1 else full_content


def extract_faqs_from_content(content: str) -> List[Tuple[str, str]]:
    if not content:
        return []

    search = _search_content(content)
    parts = __import__("re").split(r"\*\*Question\*\*:\s*", search)
    faqs: List[Tuple[str, str]] = []

    for part in parts[1:]:
        answer_split = __import__("re").split(r"\*\*Answer\*\*:\s*", part, maxsplit=1)
        if len(answer_split) >= 2:
            question = answer_split[0].strip()
            answer = answer_split[1].strip()
            if question:
                faqs.append((question, answer))
    return faqs


def iter_md_files(src_dir: Path) -> Iterable[Path]:
    # Keep it simple and predictable: recurse for *.md files.
    for path_str in glob.glob(str(src_dir / "**" / "*.md"), recursive=True):
        p = Path(path_str)
        if p.is_file():
            yield p


def load_rows(src_dir: Path) -> List[FAQRow]:
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

    # De-dupe exact duplicates (helps if a file accidentally repeats blocks).
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
    out_lines: List[str] = []
    out_lines.append("BEGIN;")
    if truncate:
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
    print(
        f"[pg-load-faqs] Extracted {len(rows)} FAQ rows from {src_dir} ({len(list(iter_md_files(src_dir)))} .md files).",
        file=sys.stderr,
    )

    sys.stdout.write(emit_sql(rows, truncate=args.truncate, chunk_size=max(1, args.chunk_size)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

