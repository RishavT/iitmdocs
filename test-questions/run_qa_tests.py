# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests",
# ]
# ///
"""
Send questions to chatbot API and save responses.
Usage: uv run run_qa_tests.py
"""

import json
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent
QUESTIONS_PATH = ROOT_DIR / "analysis" / "questions.json"
OUTPUT_PATH = ROOT_DIR / "analysis" / "output.json"

API_URL = "https://iitm-chatbot-worker-329264250413.asia-south1.run.app/answer"


def parse_sse_response(response: requests.Response) -> dict:
    """Parse SSE response and extract answer and references."""
    answer_parts = []
    references = []

    for line in response.iter_lines(decode_unicode=True):
        if not line:
            continue

        if line.startswith("data: "):
            data = line[6:]  # Remove "data: " prefix
            if data == "[DONE]":
                break
            try:
                parsed = json.loads(data)
                # Check for tool calls (document references)
                if "choices" in parsed:
                    for choice in parsed["choices"]:
                        delta = choice.get("delta", {})
                        # Extract content
                        if "content" in delta and delta["content"]:
                            answer_parts.append(delta["content"])
                        # Extract tool calls (references)
                        if "tool_calls" in delta:
                            for tool_call in delta["tool_calls"]:
                                if "function" in tool_call:
                                    func = tool_call["function"]
                                    if "arguments" in func:
                                        try:
                                            args = json.loads(func["arguments"])
                                            references.append(args)
                                        except json.JSONDecodeError:
                                            pass
            except json.JSONDecodeError:
                # Non-JSON data line, might be raw text
                answer_parts.append(data)

    return {
        "answer": "".join(answer_parts),
        "references": references,
    }


def send_question(question: str) -> dict:
    """Send a question to the chatbot API."""
    try:
        response = requests.post(
            API_URL,
            json={"q": question},
            headers={"Content-Type": "application/json"},
            stream=True,
            timeout=60,
        )
        response.raise_for_status()
        result = parse_sse_response(response)
        return {"question": question, "success": True, **result}
    except requests.RequestException as e:
        return {"question": question, "success": False, "error": str(e), "answer": "", "references": []}


def main():
    if not QUESTIONS_PATH.exists():
        print(f"Questions file not found: {QUESTIONS_PATH}")
        print("Run extract_questions.py first.")
        sys.exit(1)

    with open(QUESTIONS_PATH) as f:
        questions = json.load(f)

    print(f"Loaded {len(questions)} questions from {QUESTIONS_PATH}")
    print(f"Sending to: {API_URL}\n")

    results = []
    for i, question in enumerate(questions, 1):
        print(f"[{i}/{len(questions)}] {question[:60]}{'...' if len(question) > 60 else ''}")
        result = send_question(question)
        results.append(result)

        if result["success"]:
            preview = result["answer"][:100].replace("\n", " ")
            print(f"    -> {preview}{'...' if len(result['answer']) > 100 else ''}")
        else:
            print(f"    -> ERROR: {result['error']}")

        # Small delay to avoid rate limiting
        time.sleep(0.5)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(results, f, indent=2)

    success_count = sum(1 for r in results if r["success"])
    print(f"\nDone! {success_count}/{len(results)} questions answered successfully.")
    print(f"Results saved to: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
