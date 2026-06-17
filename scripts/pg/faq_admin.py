#!/usr/bin/env python3
"""
Interactive admin helper for adding FAQ seed rows.

This MVP edits the git-tracked seed file only. It does not write to Postgres.
Semantic duplicate checks use the deployed test PG FAQ API, and the normal
deploy/bootstrap path remains responsible for refreshing test/prod databases.
"""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence


DEFAULT_SEED_PATH = "pg/seed/faqs.json"
DEFAULT_API_URL = "https://iitm-pg-faq-api-d2k7gd2v6q-el.a.run.app"
DEFAULT_SIMILARITY_THRESHOLD = 0.65
DEFAULT_SIMILARITY_K = 5
DEFAULT_TIMEOUT_SECONDS = 60

PROGRAM_CHOICES = ("ds", "ae", "es", "mg", "common", "diff_ans")
MVP_ENABLED_PROGRAM = "ds"


def normalize_question(question: str) -> str:
    """Normalize a question for exact duplicate checks."""

    return " ".join(question.lower().split())


def load_seed(path: Path) -> list[dict[str, Any]]:
    """Load and minimally validate the FAQ seed JSON file."""

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as exc:
        raise SystemExit(f"ERROR: Seed file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: Seed file is not valid JSON: {path}: {exc}") from exc

    if not isinstance(data, list):
        raise SystemExit(f"ERROR: Seed file must contain a JSON array: {path}")

    for idx, row in enumerate(data):
        if not isinstance(row, dict):
            raise SystemExit(f"ERROR: Seed row {idx} must be an object")
        if not str(row.get("question", "")).strip():
            raise SystemExit(f"ERROR: Seed row {idx} is missing question")
        if not str(row.get("answer", "")).strip():
            raise SystemExit(f"ERROR: Seed row {idx} is missing answer")

    return data


def write_seed(path: Path, rows: list[dict[str, Any]]) -> None:
    """Write the FAQ seed file in a stable, readable format."""

    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def find_exact_duplicate(rows: Sequence[dict[str, Any]], question: str) -> int | None:
    """Return the first duplicate seed row index for a normalized question."""

    needle = normalize_question(question)
    for idx, row in enumerate(rows):
        if normalize_question(str(row.get("question", ""))) == needle:
            return idx
    return None


def prompt_non_empty(label: str) -> str:
    """Prompt until the user enters a non-empty single-line value."""

    while True:
        value = input(label).strip()
        if value:
            return value
        print("Please enter a non-empty value.")


def prompt_answer() -> str:
    """Read a multiline answer, terminated by a line containing only END."""

    print("Answer:")
    print("  Enter one or more lines. Finish with a line containing only END.")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == "END":
            break
        lines.append(line.rstrip())

    answer = "\n".join(lines).strip()
    if not answer:
        print("Please enter a non-empty answer.")
        return prompt_answer()
    return answer


def prompt_program() -> str:
    """Ask for the FAQ program/category and enforce the MVP gate."""

    choices = "/".join(PROGRAM_CHOICES)
    selected = prompt_non_empty(f"Program/category ({choices}): ").lower()
    if selected not in PROGRAM_CHOICES:
        raise SystemExit(f"ERROR: Unknown program/category: {selected}")
    if selected != MVP_ENABLED_PROGRAM:
        raise SystemExit(
            "ERROR: This MVP is intentionally enabled only for ds. "
            f"Selected '{selected}' is reserved for the future 4-program flow."
        )
    return selected


def search_similar_faqs(api_url: str, question: str, k: int, timeout: int) -> list[dict[str, Any]]:
    """Call PG FAQ API /search and return result rows."""

    payload = json.dumps({"q": question, "k": k}).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}/search",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"FAQ API HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach FAQ API at {api_url}: {exc}") from exc
    except TimeoutError as exc:
        raise RuntimeError(f"FAQ API request timed out after {timeout}s") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("FAQ API returned invalid JSON") from exc

    results = parsed.get("results")
    if not isinstance(results, list):
        raise RuntimeError("FAQ API response is missing results list")
    return [row for row in results if isinstance(row, dict)]


def print_similar_matches(matches: Sequence[dict[str, Any]], threshold: float) -> None:
    """Print similar FAQ matches for human review."""

    print()
    print(f"Similar FAQs found (threshold >= {threshold:.2f}):")
    for idx, row in enumerate(matches, 1):
        score = row.get("cosine_similarity")
        try:
            score_text = f"{float(score):.3f}"
        except (TypeError, ValueError):
            score_text = "unknown"

        question = str(row.get("question", "")).strip()
        answer = str(row.get("answer", "")).strip()
        answer_preview = " ".join(answer.split())
        if len(answer_preview) > 220:
            answer_preview = answer_preview[:217] + "..."

        # print(f"{idx}. [{score_text}] {question}")
        print(f"{idx}. {question}")
        if answer_preview:
            print(textwrap.indent(f"Answer: {answer_preview}", "   "))
    print("\n\n")


def confirm_after_similarity(matches: Sequence[dict[str, Any]], threshold: float) -> str:
    """Return add/edit/cancel after showing similar matches."""

    print_similar_matches(matches, threshold)
    while True:
        action = input("Choose: [a]dd anyway, [e]dit question, [c]ancel: ").strip().lower()
        if action in {"a", "add"}:
            return "add"
        if action in {"e", "edit"}:
            return "edit"
        if action in {"c", "cancel"}:
            return "cancel"
        print("Please enter a, e, or c.")


def collect_question_with_checks(
    rows: Sequence[dict[str, Any]],
    *,
    api_url: str,
    similarity_k: int,
    similarity_threshold: float,
    skip_similarity_check: bool,
    timeout: int,
) -> str:
    """Prompt for a question, enforce exact duplicates, and run similarity review."""

    while True:
        question = prompt_non_empty("Question: ")
        duplicate_idx = find_exact_duplicate(rows, question)
        if duplicate_idx is not None:
            existing = rows[duplicate_idx]
            print()
            print(f"ERROR: Exact duplicate question already exists at seed row {duplicate_idx}:")
            print(str(existing.get("question", "")).strip())
            print("Edit the question or cancel with Ctrl+C.")
            print()
            continue

        if skip_similarity_check:
            return question

        try:
            results = search_similar_faqs(api_url, question, similarity_k, timeout)
        except RuntimeError as exc:
            raise SystemExit(
                f"ERROR: Similarity check failed: {exc}\n"
                "Re-run with --skip-similarity-check only if you intentionally want to bypass this review."
            ) from exc

        matches = [
            row
            for row in results
            if isinstance(row.get("cosine_similarity"), (int, float))
            and float(row["cosine_similarity"]) >= similarity_threshold
        ]
        if not matches:
            return question

        action = confirm_after_similarity(matches, similarity_threshold)
        if action == "add":
            return question
        if action == "cancel":
            raise SystemExit("Cancelled. Seed file was not changed.")


def add_faq(args: argparse.Namespace) -> int:
    """Interactive add command."""

    seed_path = Path(args.seed_path)
    rows = load_seed(seed_path)

    print("FAQ admin MVP")
    print(f"Seed file: {seed_path}")
    print(f"Similarity API: {args.api_url}")
    print()

    # Captured now to keep the future 4-program UX visible while the MVP stays
    # intentionally scoped to Data Science.
    _program = prompt_program()
    question = collect_question_with_checks(
        rows,
        api_url=args.api_url,
        similarity_k=args.similarity_k,
        similarity_threshold=args.similarity_threshold,
        skip_similarity_check=args.skip_similarity_check,
        timeout=args.timeout,
    )
    answer = prompt_answer()

    rows.append({"question": question, "answer": answer})
    write_seed(seed_path, rows)

    print()
    print(f"Updated {seed_path}")
    print(f"FAQ seed rows: {len(rows)}")
    print("Next: commit this seed change and deploy to test with the existing embed/bootstrap path.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""

    parser = argparse.ArgumentParser(description="Manage FAQ seed rows.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="Interactively add one FAQ seed row")
    add_parser.add_argument("--seed-path", default=DEFAULT_SEED_PATH, help=f"FAQ seed JSON path (default: {DEFAULT_SEED_PATH})")
    add_parser.add_argument("--api-url", default=DEFAULT_API_URL, help=f"PG FAQ API base URL (default: {DEFAULT_API_URL})")
    add_parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=DEFAULT_SIMILARITY_THRESHOLD,
        help=f"Similarity score threshold for warning (default: {DEFAULT_SIMILARITY_THRESHOLD})",
    )
    add_parser.add_argument(
        "--similarity-k",
        type=int,
        default=DEFAULT_SIMILARITY_K,
        help=f"Number of similar FAQs to request (default: {DEFAULT_SIMILARITY_K})",
    )
    add_parser.add_argument(
        "--skip-similarity-check",
        action="store_true",
        help="Bypass the deployed FAQ API similarity review",
    )
    add_parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"FAQ API timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})",
    )
    add_parser.set_defaults(func=add_faq)
    return parser


def main(argv: Sequence[str]) -> int:
    """CLI entrypoint."""

    parser = build_parser()
    args = parser.parse_args(list(argv))

    if not 1 <= args.similarity_k <= 20:
        print("ERROR: --similarity-k must be between 1 and 20", file=sys.stderr)
        return 2
    if args.timeout < 1:
        print("ERROR: --timeout must be >= 1", file=sys.stderr)
        return 2
    if not 0 <= args.similarity_threshold <= 1:
        print("ERROR: --similarity-threshold must be between 0 and 1", file=sys.stderr)
        return 2

    try:
        return int(args.func(args))
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. Seed file was not changed.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
