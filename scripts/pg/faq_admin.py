#!/usr/bin/env python3
"""
Interactive admin helper for adding FAQ seed rows.

This MVP edits the git-tracked seed file only. It does not write to Postgres.
Semantic duplicate checks use the deployed test PG FAQ API, and the normal
deploy/bootstrap path remains responsible for refreshing test/prod databases.

Definitions:
- Seed file: the JSON file in the repo that stores the FAQ question/answer pairs before they are deployed into the database. This is the single source of truth for the FAQs.
  
- Seed row: one FAQ entry inside the seed file, usually an object with a `question` and an `answer`.
"""

import argparse
import json
import sys
import textwrap
import urllib.request
from pathlib import Path


DEFAULT_SEED_PATH = "pg/seed/faqs.json"
DEFAULT_API_URL = "https://iitm-pg-faq-api-d2k7gd2v6q-el.a.run.app"
DEFAULT_SIMILARITY_THRESHOLD = 0.65
DEFAULT_SIMILARITY_K = 5
DEFAULT_TIMEOUT_SECONDS = 60

PROGRAM_CHOICES = ("ds", "ae", "es", "mg", "common", "diff_ans")
MVP_ENABLED_PROGRAM = "ds"


def normalize_question(question: str) -> str:
    """
    Normalize a question for exact duplicate checks.

    Example:
        normalize_question("  Can I   do this degree ON-campus? ")
        returns "can i do this degree on-campus?"
    """

    return " ".join(question.lower().split())


def load_seed(path: Path) -> list[dict[str, str]]:
    """Load and minimally validate the FAQ seed JSON file."""

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as exc:
        raise SystemExit(f"ERROR: Seed file not found at path: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: Seed file is not valid JSON: {path}: {exc}")

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


def write_seed(path: Path, rows: list[dict]) -> None:
    """
    Write the FAQ seed file in a stable, readable format.

    Example:
        rows = [{"question": "Q?", "answer": "A."}]
        write_seed(Path("pg/seed/faqs.json"), rows)

        This writes a pretty-printed JSON array to `pg/seed/faqs.json`.
        The function returns None.
    """

    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def find_exact_duplicate(
    rows: list[dict],
    question: str,
    *,
    exclude_idx: int | None = None,
) -> int | None:
    """
    Return the first duplicate seed row index for a normalized question.

    `exclude_idx` is the row being edited, so the duplicate check ignores that same row while comparing questions.

    Example:
        rows = [
            {"question": "What is IITM BS?", "answer": "..."},
            {"question": "Can I study on-campus?", "answer": "..."},
        ]

        find_exact_duplicate(rows, "  CAN i study on-campus? ")
        returns 1.

        find_exact_duplicate(rows, "New question?")
        returns None.
    """

    needle = normalize_question(question)
    for idx, row in enumerate(rows):
        if idx == exclude_idx:
            continue
        if normalize_question(str(row.get("question", ""))) == needle:
            return idx
    return None


def find_rows_by_question(rows: list[dict], question: str) -> list[int]:
    """
    Return row indexes matching a normalized question.
    The rows are taken from the seed file.

    Example:
        rows = [
            {"question": "Can I study on-campus?", "answer": "..."},
            {"question": "Other question?", "answer": "..."},
            {"question": " can i study on-campus? ", "answer": "..."},
        ]

        find_rows_by_question(rows, "CAN I STUDY ON-CAMPUS?")
        returns [0, 2].
    """

    needle = normalize_question(question)
    return [
        idx
        for idx, row in enumerate(rows)
        if normalize_question(str(row.get("question", ""))) == needle
    ]


def prompt_non_empty(label: str) -> str:
    """
    Prompt until the user enters a non-empty single-line value.

    Example:
        prompt_non_empty("Question: ")

        If the user first presses Enter, they are asked again.
        If they then type "What is IITM BS?", this function returns
        "What is IITM BS?".
    """

    while True:
        value = input(label).strip()
        if value:
            return value
        print("Please enter a non-empty value.")


def prompt_answer() -> str:
    """
    Read a multiline answer, terminated by a line containing only END.

    Example:
        User input:
            This is line one.
            This is line two.
            END

        returns:
            "This is line one.\nThis is line two."
    """

    print("Answer:")
    print("  Enter one or more lines. Finish with a line containing only END, or press Ctrl+D when done.")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError: # triggered on Ctrl+D.
            break
        if line.strip() == "END":
            break
        lines.append(line.rstrip())

    answer = "\n".join(lines).strip()
    if not answer:
        print("Please enter a non-empty answer.")
        return prompt_answer()
    return answer


def prompt_yes_no(label: str) -> bool:
    """
    Prompt until the user answers yes or no.

    Example:
        prompt_yes_no("Update answer? [y/n]: ")

        If the user types "y" or "yes", this function returns True.
        If the user types "n" or "no", this function returns False.
    """

    while True:
        value = input(label).strip().lower()
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Please enter y or n.")


def prompt_program() -> str:
    """
    Ask for the FAQ program/category and enforce the MVP gate.

    Example:
        If the user enters "ds", this function returns "ds".

        If the user enters "ae", "es", "mg", "common", or "diff_ans",
        this function exits because the current MVP only allows "ds".
    """

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


def search_similar_faqs(api_url: str, question: str, k: int, timeout: int) -> list[dict]:
    """
    Call PG FAQ API /search and return result rows.

    Example:
        search_similar_faqs(
            "http://localhost:8001",
            "Can I do this degree on-campus?",
            k=5,
            timeout=60,
        )

        sends this JSON to `http://localhost:8001/search`:
            {"q": "Can I do this degree on-campus?", "k": 5}

        If the API returns:
            {"results": [{"question": "Does IITM offer this on-campus?", "cosine_similarity": 0.91}]}

        this function returns:
            [{"question": "Does IITM offer this on-campus?", "cosine_similarity": 0.91}]
    """

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
    except Exception as exc:
        raise RuntimeError(f"FAQ API request failed: {exc}")

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("FAQ API returned invalid JSON")

    results = parsed.get("results")
    if not isinstance(results, list):
        raise RuntimeError("FAQ API response is missing results list")
    return [row for row in results if isinstance(row, dict)]


def print_similar_matches(matches: list[dict], threshold: float) -> None:
    """
    Print similar FAQ matches for human review.

    Example:
        matches = [
            {
                "question": "Does IITM offer this on-campus?",
                "answer": "No. This is a non-campus program.",
                "cosine_similarity": 0.91,
            }
        ]

        print_similar_matches(matches, 0.65)

        prints the question and a short answer preview.
        The function returns None.
    """

    print()
    print(f"Similar FAQs found (threshold >= {threshold:.2f}):")
    for idx, row in enumerate(matches, 1):
        question = str(row.get("question", "")).strip()
        answer = str(row.get("answer", "")).strip()
        answer_preview = " ".join(answer.split())
        if len(answer_preview) > 220:
            answer_preview = answer_preview[:217] + "..."

        print(f"{idx}. {question}")
        if answer_preview:
            print(textwrap.indent(f"Answer: {answer_preview}", "   "))
    print("\n\n")


def print_existing_seed_row(row: dict, row_idx: int) -> None:
    """
    Print one seed FAQ row for review before editing.

    Example:
        row = {"question": "Can I study on-campus?", "answer": "No."}
        print_existing_seed_row(row, 3)

        prints row number 3, its question, and its answer.
        The function returns None.
    """

    print()
    print(f"Existing FAQ at seed row {row_idx}:")
    print(f"Question: {str(row.get('question', '')).strip()}")
    print("Answer:")
    print(textwrap.indent(str(row.get("answer", "")).strip(), "  "))
    print()


def choose_matching_seed_row(
    rows: list[dict],
    matches: list[dict],
) -> int | None:
    """
    Ask the user which similar FAQ they want to edit, then return its seed row index.

    The `/search` API returns the "k" closest FAQ rows, but we edit `pg/seed/faqs.json`, so this function maps the selected row match back to the matching row in the seed file using the question text.

    Example:
        rows = [
            {"question": "What is the IIT Madras BS degree?", "answer": "It is a degree."},
            {"question": "Can I do this degree on-campus?", "answer": "No."},
            {"question": "How long is the program?", "answer": "4 years."},
        ]
        matches = [
            {"question": "Can I do this degree on-campus?", "cosine_similarity": 0.91},
            {"question": "How long is the program?", "cosine_similarity": 0.78},
        ]

        If the user enters "1", the function looks at the first match, finds the same question in `rows`, and returns 1.

        If the user enters "2", it returns 2.

        If the user enters "c", this function returns None.
    """

    while True:
        selected = input(f"Select FAQ to edit (1-{len(matches)}), or c to cancel: ").strip().lower()
        if selected in {"c", "cancel"}:
            return None
        try:
            selected_idx = int(selected)
        except ValueError:
            print("Please enter a valid number, or c to cancel.")
            continue
        if not 1 <= selected_idx <= len(matches):
            print(f"Please enter a number between 1 and {len(matches)}, or c to cancel.")
            continue

        question = str(matches[selected_idx - 1].get("question", "")).strip()
        row_indexes = find_rows_by_question(rows, question)
        if len(row_indexes) == 1:
            return row_indexes[0] # If exactly one seed row matches, we are sure which row to edit. So the function returns that row index.
        if not row_indexes:
            print("ERROR: Could not find that FAQ in the seed file. Choose another FAQ or cancel.")
            continue # If no seed row matches, something is inconsistent. The selected FAQ exists in the API results, but not in the seed file. It prints an error and asks the user again.

        print("ERROR: Multiple seed rows have that same question. Choose another FAQ or cancel.") # If more than one seed row matches, the question is not unique.The function cannot safely choose one row. So it tells the user to pick another FAQ or cancel.


def confirm_exact_duplicate(existing: dict, duplicate_idx: int) -> str:
    """
    Return the user's choice after an exact duplicate is found.
    It is called when the user typed question exactly matches an existing question in the seed file.

    duplicate_idx = “which row in the seed file is the duplicate”

    Example:
        existing = {"question": "Can I study on-campus?", "answer": "No."}
        confirm_exact_duplicate(existing, 4)

        If the user enters "u", this function returns "update_existing".
        If the user enters "e", this function returns "edit_question".
        If the user enters "c", this function returns "cancel".
    """

    print_existing_seed_row(existing, duplicate_idx)
    while True:
        action = input("Choose: [u]pdate existing FAQ, [e]dit new question, [c]ancel: ").strip().lower()
        if action in {"u", "update"}:
            return "update_existing"
        if action in {"e", "edit"}:
            return "edit_question"
        if action in {"c", "cancel"}:
            return "cancel"
        print("Please enter u, e, or c.")


def confirm_after_similarity(
    rows: list[dict],
    matches: list[dict],
    threshold: float,
) -> tuple[str, int | None]:
    """
    Return the selected add/edit/cancel action after showing similar matches. It is called after the script has already found similar FAQs from the API (i.e. at least one match is above the threshold) and wants the user to choose what to do next. Now the user must decide whether to add the new FAQ, edit it, update an existing one, or cancel.

    - rows
        - the full list of FAQ rows from the seed file
        - used if the user chooses to update an existing FAQ

    - matches
        - the similar FAQ results returned by the search API
        - these are the FAQs shown to the user as possible near-duplicates

    - threshold
        - the similarity cutoff used to decide which API results are considered relevant
        - only matches at or above this value are shown

    Example:
        rows = [{"question": "Can I study on-campus?", "answer": "No."}]
        matches = [{"question": "Can I study on-campus?", "cosine_similarity": 0.91}]

        If the user enters "a", this function returns ("add", None).
        If the user enters "e", this function returns ("edit_question", None).
        If the user enters "u" and selects match 1, this function returns
        ("edit_existing", 0).
        If the user enters "c", this function returns ("cancel", None).
    """

    print_similar_matches(matches, threshold)
    while True:
        action = input(
            "Choose: [a]dd anyway, [e]dit new question, [u]pdate existing FAQ, [c]ancel: "
        ).strip().lower()
        if action in {"a", "add"}:
            return "add", None
        if action in {"e", "edit"}:
            return "edit_question", None
        if action in {"u", "update"}:
            row_idx = choose_matching_seed_row(rows, matches)
            if row_idx is None:
                continue
            return "edit_existing", row_idx
        if action in {"c", "cancel"}:
            return "cancel", None
        print("Please enter a, e, u, or c.")


def edit_existing_faq(rows: list[dict], row_idx: int) -> bool:
    """
    Interactively edit an existing FAQ seed row and return whether it changed. It is called only when the user has chosen to update an existing FAQ row instead of adding a new one.

  - rows
      - the full list of FAQ rows from the seed file
      - the function edits this list in place

  - row_idx
      - the index of the exact row to edit inside rows
      - for example, row_idx = 7 means edit rows[7]

    Example:
        rows = [{"question": "Old question?", "answer": "Old answer."}]
        edit_existing_faq(rows, 0)

        If the user changes the question to "New question?" and updates the
        answer to "New answer.", this function updates `rows[0]` and returns True.

        If the user keeps both the old question and old answer, this function
        returns False.
    """

    while True:
        row = rows[row_idx]
        current_question = str(row.get("question", "")).strip()
        current_answer = str(row.get("answer", "")).strip()

        print_existing_seed_row(row, row_idx)
        print("Updated question:")
        print("  Press Enter to keep the current question.")
        updated_question = input("Question: ").strip() or current_question
        if not updated_question:
            print("ERROR: Question cannot be empty.")
            continue

        duplicate_idx = find_exact_duplicate(rows, updated_question, exclude_idx=row_idx) # exclude_idx=row_idx is there because we are editing one existing row, and we do not want that same row to count as a duplicate of itself.
        if duplicate_idx is not None:
            print()
            print(f"ERROR: Updated question duplicates seed row {duplicate_idx}:")
            print(str(rows[duplicate_idx].get("question", "")).strip())
            print("Please try again.")
            continue

        if prompt_yes_no("Update answer? [y/n]: "):
            updated_answer = prompt_answer()
        else:
            updated_answer = current_answer

        if not updated_answer:
            print("ERROR: Answer cannot be empty.")
            continue

        if updated_question == current_question and updated_answer == current_answer:
            print("No changes made.")
            return False

        row["question"] = updated_question
        row["answer"] = updated_answer
        return True


def collect_question_with_checks(
    rows: list[dict],
    *,
    api_url: str,
    similarity_k: int,
    similarity_threshold: float,
    skip_similarity_check: bool,
    timeout: int,
) -> tuple[str, str | int]:
    """
    Prompt for a question, enforce exact duplicates, and run similarity review.

    Example:
        rows = [{"question": "Can I study on-campus?", "answer": "No."}]

        If the user enters a completely new question and no similar FAQ crosses the threshold, this function returns:("add", "the user's new question")

        If the user enters an exact duplicate and chooses to update it, this function returns: ("edit_existing", 0)

        If the user sees similar FAQs and chooses to update seed row 3, this function returns: ("edit_existing", 3)
    """

    while True:
        question = prompt_non_empty("Question: ")
        duplicate_idx = find_exact_duplicate(rows, question)
        if duplicate_idx is not None:
            existing = rows[duplicate_idx]
            action = confirm_exact_duplicate(existing, duplicate_idx)
            if action == "update_existing":
                return "edit_existing", duplicate_idx
            if action == "cancel":
                raise SystemExit("Cancelled. Seed file was not changed.")
            continue

        if skip_similarity_check:
            return "add", question

        try:
            results = search_similar_faqs(api_url, question, similarity_k, timeout)
        except RuntimeError as exc:
            raise SystemExit(
                f"ERROR: Similarity check failed: {exc}\n"
                "Re-run with --skip-similarity-check only if you intentionally want to bypass this review."
            )

        matches = [
            row
            for row in results
            if isinstance(row.get("cosine_similarity"), (int, float))
            and float(row["cosine_similarity"]) >= similarity_threshold
        ]
        if not matches:
            print()
            print(f"No close FAQ matches found (threshold >= {similarity_threshold:.2f}).")
            print("Proceeding to add this as a new FAQ.")
            print()
            return "add", question

        action, row_idx = confirm_after_similarity(rows, matches, similarity_threshold)
        if action == "edit_existing" and row_idx is not None:
            return "edit_existing", row_idx
        if action == "add":
            return "add", question
        if action == "cancel":
            raise SystemExit("Cancelled. Seed file was not changed.")


def add_faq(args: argparse.Namespace) -> int:
    """
    Run the interactive FAQ admin flow.

    Example:
        args = argparse.Namespace(
            seed_path="pg/seed/faqs.json",
            api_url="http://localhost:8001",
            similarity_k=5,
            similarity_threshold=0.65,
            skip_similarity_check=False,
            timeout=60,
        )

        add_faq(args) loads the seed file, asks the user what to add or edit,
        writes the seed file if something changed, and returns 0.
    """

    seed_path = Path(args.seed_path)
    rows = load_seed(seed_path)

    print("FAQ admin MVP")
    print(f"Seed file: {seed_path}")
    print(f"Similarity API: {args.api_url}")
    print()

    prompt_program()
    action, value = collect_question_with_checks(
        rows,
        api_url=args.api_url,
        similarity_k=args.similarity_k,
        similarity_threshold=args.similarity_threshold,
        skip_similarity_check=args.skip_similarity_check,
        timeout=args.timeout,
    )

    changed = True
    if action == "add":
        answer = prompt_answer()
        rows.append({"question": str(value), "answer": answer})
    else:
        changed = edit_existing_faq(rows, int(value))

    if changed:
        write_seed(seed_path, rows)

    print()
    if changed:
        print(f"Updated {seed_path}")
    else:
        print(f"No changes written to {seed_path}")
    print(f"FAQ seed rows: {len(rows)}")
    print("Next: commit this seed change and deploy to test with the existing embed/bootstrap path.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """
    Build the command-line parser.
    """

    parser = argparse.ArgumentParser(description="Manage FAQ seed rows.")
    parser.add_argument("--seed-path", default=DEFAULT_SEED_PATH, help=f"FAQ seed JSON path (default: {DEFAULT_SEED_PATH})")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help=f"PG FAQ API base URL (default: {DEFAULT_API_URL})")
    parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=DEFAULT_SIMILARITY_THRESHOLD,
        help=f"Similarity score threshold for warning (default: {DEFAULT_SIMILARITY_THRESHOLD})",
    )
    parser.add_argument(
        "--similarity-k",
        type=int,
        default=DEFAULT_SIMILARITY_K,
        help=f"Number of similar FAQs to request (default: {DEFAULT_SIMILARITY_K})",
    )
    parser.add_argument(
        "--skip-similarity-check",
        action="store_true",
        help="Bypass the deployed FAQ API similarity review",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"FAQ API timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})",
    )
    return parser


def main(argv: list[str]) -> int:
    """
    CLI entrypoint.

    Example:
        main(["--similarity-k", "5"])

        validates CLI arguments, runs the FAQ admin flow, and returns the exit
        code. Invalid arguments return 2. Ctrl+C returns 130.
    """

    parser = build_parser()
    args = parser.parse_args(list(argv))

    if not 1 <= args.similarity_k <= 20:
        print("ERROR: --similarity-k must be between 1 and 20")
        return 2
    if args.timeout < 1:
        print("ERROR: --timeout must be >= 1")
        return 2
    if not 0 <= args.similarity_threshold <= 1:
        print("ERROR: --similarity-threshold must be between 0 and 1")
        return 2

    try:
        return add_faq(args)
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. Seed file was not changed.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
