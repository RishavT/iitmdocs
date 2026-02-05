#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "tqdm"]
# ///
"""
Chatbot Log Analysis with Claude Code Headless Mode

This script analyzes chatbot logs using:
- Python for data processing and pattern matching
- Claude Code headless mode for ambiguous query classification and fact-checking

Usage:
    python3 analyze-logs-headless.py [--staging-file FILE] [--production-file FILE] [--output FILE]

Examples:
    # Basic analysis
    python3 analyze-logs-headless.py

    # Filter by date range (inclusive)
    python3 analyze-logs-headless.py --on-or-after 2025-12-01 --on-or-before 2026-01-01

    # With LLM classification for ambiguous queries
    python3 analyze-logs-headless.py --use-llm

    # With batch fact-checking (checks ALL valid answered responses)
    python3 analyze-logs-headless.py --fact-check

    # Analyze single file with fact-checking
    python3 analyze-logs-headless.py --staging-file /tmp/staging-extract2.csv --production-file /dev/null --fact-check

    # Compare old logs with new bot (could-answer queries only)
    python3 analyze-logs-headless.py --compare-with-new-bot=could-answer --new-bot-url=http://localhost:8787/answer

    # Compare old logs with new bot (could-not-answer queries only)
    python3 analyze-logs-headless.py --compare-with-new-bot=could-not-answer

    # Compare both could-answer and could-not-answer queries with new bot
    python3 analyze-logs-headless.py --compare-with-new-bot=could-answer,could-not-answer

Requirements:
    - Python 3.10+
    - Claude Code CLI installed and authenticated (for --use-llm and --fact-check)
    - CSV log files with columns: timestamp, question, response

Testing:
    pytest test_analyze_logs.py -v

    Tests cover:
    - Date parsing (various formats)
    - Query classification (valid/invalid patterns)
    - Cannot-answer detection
    - File analysis with date filtering
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
from tqdm import tqdm


# ============================================================================
# CONFIGURATION
# ============================================================================

# Patterns for automatic classification (no LLM needed)
AUTO_INVALID_PATTERNS = {
    "out_of_context": [
        r'\b(weather|pizza|movie|hotel|restaurant|recipe|cook|music|song|game|sport)\b',
        r'\b(whatsapp|instagram|facebook|twitter|youtube|netflix|amazon)\b',
        r'\b(girlfriend|boyfriend|dating|marriage|love)\b',
        r'\b(weight loss|diet|gym|workout|exercise)\b',
        r'\b(capital of|president of|prime minister)\b',
        r'\b(samosa|biryani|chai|coffee)\b(?!.*fee|.*exam|.*course)',
    ],
    "greeting": [
        r'^(hi|hello|hey|good morning|good evening|good afternoon|howdy)[\s!?.]*$',
        r'^how are you',
        r'^what\'?s up',
    ],
    "malicious": [
        r'ignore (previous|all|above) instructions',
        r'you are now',
        r'pretend to be',
        r'act as if',
        r'system prompt',
        r'jailbreak',
        r'bypass',
    ],
    "cheating": [
        r'give me (the )?answer',
        r'solve this (question|problem|assignment)',
        r'write (my |the )?(assignment|homework|essay|code)',
        r'help me cheat',
    ],
    "meta_question": [
        r'what (model|ai|llm|chatbot) (are you|am i|is this)',
        r'who (made|created|built) you',
        r'are you (gpt|claude|gemini|chatgpt)',
    ],
}

CANNOT_ANSWER_PATTERNS = [
    r"i'm sorry, i don't have the information",
    r"cannot answer",
    r"don't have enough information",
    r"unable to provide",
    r"outside.*scope",
]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def parse_date(date_str: str) -> Optional[datetime]:
    """
    Parse date string in various formats.
    Supported formats: MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY
    """
    if not date_str:
        return None

    formats = [
        "%m/%d/%Y",      # 12/13/2025
        "%Y-%m-%d",      # 2025-12-13
        "%d-%m-%Y",      # 13-12-2025
        "%m/%d/%Y %H:%M:%S",  # 12/13/2025 20:23:42
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None


def parse_cli_date(date_str: str) -> Optional[datetime]:
    """
    Parse date from CLI argument.
    Supports: YYYY-MM-DD, MM/DD/YYYY
    """
    if not date_str:
        return None

    formats = [
        "%Y-%m-%d",      # 2025-12-13 (preferred)
        "%m/%d/%Y",      # 12/13/2025
        "%d-%m-%Y",      # 13-12-2025
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue

    raise ValueError(f"Invalid date format: {date_str}. Use YYYY-MM-DD (e.g., 2025-12-13)")


def run_claude_code(prompt: str, timeout: int = 60) -> str:
    """
    Run Claude Code in headless mode with the given prompt.
    Returns the output text.
    """
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "text"],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=os.getcwd()
        )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "[TIMEOUT]"
    except FileNotFoundError:
        return "[ERROR: Claude Code CLI not found. Install it first.]"
    except Exception as e:
        return f"[ERROR: {str(e)}]"


def auto_classify_query(question: str) -> tuple[str, str] | None:
    """
    Try to classify query using patterns (no LLM needed).
    Returns (classification, reason) or None if ambiguous.
    """
    q_lower = question.lower().strip()

    if len(q_lower) < 3:
        return ("invalid", "too_short")

    for reason, patterns in AUTO_INVALID_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, q_lower, re.IGNORECASE):
                # Check if query also has IITM context
                if reason == "out_of_context":
                    if any(ctx in q_lower for ctx in ['iitm', 'iit', 'bs', 'degree', 'course', 'exam', 'fee', 'admission', 'qualifier']):
                        continue
                return ("invalid", reason)

    # If it clearly mentions IITM topics, it's valid
    iitm_keywords = ['iitm', 'iit madras', 'qualifier', 'foundation', 'diploma', 'bs degree',
                     'data science', 'electronic systems', 'admission', 'eligibility']
    if any(kw in q_lower for kw in iitm_keywords):
        return ("valid", "iitm_related")

    return None  # Ambiguous, needs LLM


def classify_with_claude(question: str) -> tuple[str, str]:
    """
    Use Claude Code to classify an ambiguous query.
    """
    prompt = f'''Classify this chatbot query for the IIT Madras BS Degree program:

Query: "{question}"

Is this query:
1. VALID - A legitimate question about IITM BS program (admission, fees, courses, exams, eligibility, etc.)
2. INVALID - Spam, malicious, out of context, or cheating attempt

Respond with ONLY one word: VALID or INVALID

If INVALID, add the reason in parentheses: INVALID (reason)
Example: INVALID (out_of_context) or VALID'''

    result = run_claude_code(prompt, timeout=30)

    if "VALID" in result.upper() and "INVALID" not in result.upper():
        return ("valid", "llm_classified")
    elif "INVALID" in result.upper():
        # Try to extract reason
        match = re.search(r'\(([^)]+)\)', result)
        reason = match.group(1) if match else "llm_classified_invalid"
        return ("invalid", reason)
    else:
        # Default to valid if unclear
        return ("valid", "llm_unclear")


def is_cannot_answer(response: str) -> bool:
    """Check if the bot said it cannot answer."""
    r_lower = response.lower()
    for pattern in CANNOT_ANSWER_PATTERNS:
        if re.search(pattern, r_lower):
            return True
    return False


def sanitize_for_prompt(text: str, max_length: int = 500) -> str:
    """
    Sanitize text for use in Claude prompts to prevent prompt injection.

    - Truncates to max_length
    - Removes/escapes potentially dangerous patterns
    - Removes control characters
    """
    if not text:
        return ""

    # Truncate
    text = text[:max_length]

    # Remove control characters (except newlines and tabs)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)

    # Escape patterns that could be used for prompt injection
    injection_patterns = [
        (r'<\|.*?\|>', '[REMOVED]'),  # Special tokens
        (r'\bsystem\s*:', '[system]'),  # System prompt attempts
        (r'\buser\s*:', '[user]'),  # Role injection
        (r'\bassistant\s*:', '[assistant]'),  # Role injection
        (r'\bhuman\s*:', '[human]'),  # Role injection
        (r'ignore\s+(all\s+)?(previous|above|prior)\s+instructions', '[REMOVED]'),
        (r'forget\s+(all\s+)?(previous|above|prior)\s+instructions', '[REMOVED]'),
        (r'disregard\s+(all\s+)?(previous|above|prior)\s+instructions', '[REMOVED]'),
    ]

    for pattern, replacement in injection_patterns:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    # Replace multiple newlines with single
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


def parse_batch_fact_check_result(result: str, expected_count: int) -> list[dict]:
    """Parse the batch fact-check result from Claude."""
    results = []

    if "[TIMEOUT]" in result or "[ERROR" in result:
        return [{"accuracy": "ERROR", "issues": result} for _ in range(expected_count)]

    # Try to parse line by line
    lines = result.strip().split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Look for patterns like "RESPONSE 1:" or "1:" or "1."
        if re.match(r'^(RESPONSE\s*)?\d+[\.:]\s*', line, re.IGNORECASE):
            # Extract accuracy
            accuracy = "UNKNOWN"
            issues = ""

            line_upper = line.upper()
            if "INCORRECT" in line_upper and "PARTIALLY" not in line_upper:
                accuracy = "INCORRECT"
            elif "PARTIALLY" in line_upper:
                accuracy = "PARTIALLY_CORRECT"
            elif "CORRECT" in line_upper:
                accuracy = "CORRECT"
            elif "CANNOT" in line_upper or "VERIFY" in line_upper:
                accuracy = "CANNOT_VERIFY"

            # Extract issues (everything after the dash or accuracy word)
            if " - " in line:
                issues = line.split(" - ", 1)[-1].strip()
                if issues.upper() == "OK" or issues.upper() == "NONE":
                    issues = ""

            results.append({"accuracy": accuracy, "issues": issues})

    # Pad with unknowns if we didn't get enough results
    while len(results) < expected_count:
        results.append({"accuracy": "UNKNOWN", "issues": "Could not parse"})

    return results[:expected_count]


def process_single_batch(batch: list[dict], batch_num: int) -> tuple[int, list[dict]]:
    """
    Process a single batch of responses for fact-checking.
    Returns (batch_num, results) tuple to maintain order.
    """
    # Create CSV-like content with just responses
    response_lines = []
    for i, item in enumerate(batch):
        safe_response = sanitize_for_prompt(item['response'], max_length=400)
        response_lines.append(f"[RESPONSE {i + 1}]\n{safe_response}\n[/RESPONSE {i + 1}]")

    responses_text = "\n\n".join(response_lines)

    prompt = f'''You are an expert fact checker for the IIT Madras BS Degree program.

IMPORTANT: First, read the documents in the src/ folder to understand the facts about the program.

Then, fact-check EACH of the following {len(batch)} chatbot responses against those documents.

=== RESPONSES TO VERIFY ===
{responses_text}
=== END RESPONSES ===

For EACH response, determine if it is factually accurate based on the src/ documents.

Respond with EXACTLY {len(batch)} lines, one per response, in this format:
RESPONSE 1: [CORRECT/INCORRECT/PARTIALLY_CORRECT] - [brief issue or "OK"]
RESPONSE 2: [CORRECT/INCORRECT/PARTIALLY_CORRECT] - [brief issue or "OK"]
...and so on for all {len(batch)} responses.

Be concise. Only flag clear factual errors.
'''

    result = run_claude_code(prompt, timeout=180)
    batch_results = parse_batch_fact_check_result(result, len(batch))

    # Map results back to original responses
    processed = []
    for i, item in enumerate(batch):
        if i < len(batch_results):
            processed.append({
                "question": item['question'][:150],
                "response_snippet": item['response'][:100],
                "accuracy": batch_results[i]['accuracy'],
                "issues": batch_results[i]['issues'],
            })
        else:
            processed.append({
                "question": item['question'][:150],
                "response_snippet": item['response'][:100],
                "accuracy": "ERROR",
                "issues": "Could not parse result",
            })

    return (batch_num, processed)


def fact_check_batch_with_claude(responses: list[dict], batch_size: int = 25) -> list[dict]:
    """
    Batch fact-check multiple responses using Claude CLI.

    This is much faster than checking one at a time because Claude reads
    source documents once per batch (not per response).

    Args:
        responses: List of dicts with 'question' and 'response' keys
        batch_size: Number of responses per Claude CLI call (default 25)

    Returns:
        List of fact-check results in original order
    """
    if not responses:
        return []

    # Split into batches
    batches = []
    for i in range(0, len(responses), batch_size):
        batches.append(responses[i:i + batch_size])

    total_batches = len(batches)
    print(f"  Fact-checking {len(responses)} responses in {total_batches} batch(es)...")

    all_results = []

    for batch_num, batch in enumerate(tqdm(batches, desc="    Fact-check batches", unit="batch")):
        _, batch_results = process_single_batch(batch, batch_num)
        all_results.extend(batch_results)

    return all_results


def parse_answer_search_result(result: str, expected_count: int) -> list[dict]:
    """Parse the answer search result from Claude."""
    results = []

    if "[TIMEOUT]" in result or "[ERROR" in result:
        return [{"ai_correct_answer": f"ERROR: {result}"} for _ in range(expected_count)]

    # Try to parse line by line
    lines = result.strip().split('\n')

    current_question = None
    current_answer = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Look for patterns like "QUESTION 1:" or "1:"
        match = re.match(r'^(QUESTION\s*)?(\d+)[\.:]\s*(.*)$', line, re.IGNORECASE)
        if match:
            # Save previous question's answer
            if current_question is not None:
                answer_text = ' '.join(current_answer).strip()
                if not answer_text or answer_text.upper() == "NOT FOUND":
                    results.append({"ai_correct_answer": "NOT FOUND"})
                else:
                    results.append({"ai_correct_answer": answer_text})

            current_question = int(match.group(2))
            current_answer = [match.group(3)] if match.group(3) else []
        elif current_question is not None:
            current_answer.append(line)

    # Don't forget the last one
    if current_question is not None:
        answer_text = ' '.join(current_answer).strip()
        if not answer_text or answer_text.upper() == "NOT FOUND":
            results.append({"ai_correct_answer": "NOT FOUND"})
        else:
            results.append({"ai_correct_answer": answer_text})

    # Pad with NOT FOUND if we didn't get enough results
    while len(results) < expected_count:
        results.append({"ai_correct_answer": "NOT FOUND"})

    return results[:expected_count]


def process_answer_search_batch(batch: list[dict], batch_num: int) -> tuple[int, list[dict]]:
    """
    Process a single batch of unanswered questions to find answers in src/ docs.
    Returns (batch_num, results) tuple to maintain order.
    """
    # Create question list
    question_lines = []
    for i, item in enumerate(batch):
        safe_question = sanitize_for_prompt(item['question'], max_length=300)
        question_lines.append(f"[QUESTION {i + 1}]\n{safe_question}\n[/QUESTION {i + 1}]")

    questions_text = "\n\n".join(question_lines)

    prompt = f'''You are a helpful assistant for the IIT Madras BS Degree program.

IMPORTANT: First, read ALL documents in the src/ folder to understand the program details.

Then, for EACH of the following {len(batch)} questions, search the src/ documents and provide the correct answer if available.

=== QUESTIONS ===
{questions_text}
=== END QUESTIONS ===

For EACH question, respond with the answer from the src/ documents, or "NOT FOUND" if the information is not available.

Respond with EXACTLY {len(batch)} answers, one per question, in this format:
QUESTION 1: [Answer from src/ docs or "NOT FOUND"]
QUESTION 2: [Answer from src/ docs or "NOT FOUND"]
...and so on for all {len(batch)} questions.

Keep answers concise (1-3 sentences). Only provide information that is explicitly in the src/ documents.
'''

    result = run_claude_code(prompt, timeout=180)
    batch_results = parse_answer_search_result(result, len(batch))

    # Map results back to original questions
    processed = []
    for i, item in enumerate(batch):
        if i < len(batch_results):
            processed.append({
                "question": item['question'],
                "row_index": item.get('row_index'),
                "ai_correct_answer": batch_results[i]['ai_correct_answer'],
            })
        else:
            processed.append({
                "question": item['question'],
                "row_index": item.get('row_index'),
                "ai_correct_answer": "NOT FOUND",
            })

    return (batch_num, processed)


def search_answers_batch_with_claude(questions: list[dict], batch_size: int = 25) -> list[dict]:
    """
    Batch search for answers to unanswered questions using Claude CLI.

    Args:
        questions: List of dicts with 'question' and 'row_index' keys
        batch_size: Number of questions per Claude CLI call (default 25)

    Returns:
        List of answer search results in original order
    """
    if not questions:
        return []

    # Split into batches
    batches = []
    for i in range(0, len(questions), batch_size):
        batches.append(questions[i:i + batch_size])

    total_batches = len(batches)
    print(f"  Searching answers for {len(questions)} questions in {total_batches} batch(es)...")

    all_results = []

    for batch_num, batch in enumerate(tqdm(batches, desc="    Answer search batches", unit="batch")):
        _, batch_results = process_answer_search_batch(batch, batch_num)
        all_results.extend(batch_results)

    return all_results


# ============================================================================
# NEW BOT COMPARISON FUNCTIONS
# ============================================================================

def query_new_bot(question: str, bot_url: str, timeout: int = 60) -> str:
    """
    Query the new chatbot and return its response.

    The chatbot uses SSE (Server-Sent Events) format, returning lines like:
    data: {"choices": [{"delta": {"content": "..."}}]}
    data: [DONE]

    Args:
        question: The question to ask
        bot_url: URL of the new chatbot API endpoint
        timeout: Request timeout in seconds

    Returns:
        The chatbot's response text, or an error message
    """
    try:
        response = requests.post(
            bot_url,
            json={"q": question},  # Worker expects 'q' not 'question'
            timeout=timeout,
            headers={"Content-Type": "application/json"},
            stream=True  # Handle SSE streaming response
        )
        response.raise_for_status()

        # Parse SSE response - collect all content chunks
        full_response = []
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line.startswith("data: "):
                data_str = line[6:]  # Remove "data: " prefix
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    # Extract content from SSE chunk
                    content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if content:
                        full_response.append(content)
                    # Check for error in response
                    if "error" in data:
                        return f"[ERROR: {data['error'].get('message', 'Unknown error')}]"
                except json.JSONDecodeError:
                    continue

        return "".join(full_response) if full_response else "[ERROR: Empty response]"

    except requests.exceptions.Timeout:
        return "[ERROR: Request timeout]"
    except requests.exceptions.ConnectionError:
        return "[ERROR: Could not connect to new bot]"
    except requests.exceptions.RequestException as e:
        return f"[ERROR: {str(e)}]"


def compare_responses_with_claude(comparisons: list[dict], batch_size: int = 10) -> list[dict]:
    """
    Use Claude to compare old bot responses with new bot responses.

    Args:
        comparisons: List of dicts with 'question', 'old_response', 'new_response'
        batch_size: Number of comparisons per Claude call

    Returns:
        List of comparison results with accuracy assessments
    """
    if not comparisons:
        return []

    all_results = []
    batches = [comparisons[i:i + batch_size] for i in range(0, len(comparisons), batch_size)]

    print(f"  Comparing {len(comparisons)} responses in {len(batches)} batch(es)...")

    for batch_num, batch in enumerate(tqdm(batches, desc="    Comparison batches", unit="batch")):

        comparison_text = []
        for i, item in enumerate(batch):
            safe_q = sanitize_for_prompt(item['question'], max_length=200)
            safe_old = sanitize_for_prompt(item['old_response'], max_length=300)
            safe_new = sanitize_for_prompt(item['new_response'], max_length=300)
            comparison_text.append(f"""[COMPARISON {i + 1}]
Question: {safe_q}
Old Bot Response: {safe_old}
New Bot Response: {safe_new}
[/COMPARISON {i + 1}]""")

        prompt = f'''You are an expert evaluator for the IIT Madras BS Degree chatbot.

IMPORTANT: First, read the documents in the src/ folder to understand the facts about the program.

Compare the OLD and NEW chatbot responses for each question below. Determine if the NEW bot's response is:
- BETTER: More accurate, complete, or helpful than the old response
- SAME: Equally good (or equally bad) as the old response
- WORSE: Less accurate, less complete, or less helpful than the old response

=== COMPARISONS ===
{chr(10).join(comparison_text)}
=== END COMPARISONS ===

For EACH comparison, respond with EXACTLY one line in this format:
COMPARISON 1: [BETTER/SAME/WORSE] - [brief reason]
COMPARISON 2: [BETTER/SAME/WORSE] - [brief reason]
...and so on for all {len(batch)} comparisons.
'''

        result = run_claude_code(prompt, timeout=180)
        batch_results = parse_comparison_result(result, len(batch))

        for i, item in enumerate(batch):
            if i < len(batch_results):
                all_results.append({
                    "question": item['question'][:150],
                    "old_response": item['old_response'][:100],
                    "new_response": item['new_response'][:100],
                    "verdict": batch_results[i]['verdict'],
                    "reason": batch_results[i]['reason'],
                })
            else:
                all_results.append({
                    "question": item['question'][:150],
                    "old_response": item['old_response'][:100],
                    "new_response": item['new_response'][:100],
                    "verdict": "UNKNOWN",
                    "reason": "Could not parse result",
                })

    return all_results


def parse_comparison_result(result: str, expected_count: int) -> list[dict]:
    """Parse the comparison result from Claude."""
    results = []

    if "[TIMEOUT]" in result or "[ERROR" in result:
        return [{"verdict": "ERROR", "reason": result} for _ in range(expected_count)]

    lines = result.strip().split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if re.match(r'^(COMPARISON\s*)?\d+[\.:]\s*', line, re.IGNORECASE):
            verdict = "UNKNOWN"
            reason = ""

            line_upper = line.upper()
            if "WORSE" in line_upper:
                verdict = "WORSE"
            elif "BETTER" in line_upper:
                verdict = "BETTER"
            elif "SAME" in line_upper:
                verdict = "SAME"

            if " - " in line:
                reason = line.split(" - ", 1)[-1].strip()

            results.append({"verdict": verdict, "reason": reason})

    while len(results) < expected_count:
        results.append({"verdict": "UNKNOWN", "reason": "Could not parse"})

    return results[:expected_count]


def check_new_bot_can_answer(questions: list[dict], bot_url: str, batch_size: int = 10) -> list[dict]:
    """
    Check if the new bot can answer questions that the old bot couldn't.

    Args:
        questions: List of dicts with 'question' key
        bot_url: URL of the new chatbot
        batch_size: Number of questions per Claude analysis batch

    Returns:
        List of results with new_response and can_answer assessment
    """
    if not questions:
        return []

    print(f"  Querying new bot for {len(questions)} previously unanswered questions...")

    # First, query the new bot for all questions with progress bar
    results = []
    for item in tqdm(questions, desc="    Querying new bot", unit="query"):
        new_response = query_new_bot(item['question'], bot_url)
        results.append({
            "question": item['question'],
            "row_index": item.get('row_index'),
            "new_response": new_response,
            "new_bot_can_answer": not is_cannot_answer(new_response) and not new_response.startswith("[ERROR"),
        })

    # Now batch analyze responses that appear to be answers
    answerable = [r for r in results if r['new_bot_can_answer']]
    if answerable:
        print(f"  Fact-checking {len(answerable)} new responses...")
        fact_checks = fact_check_batch_with_claude(
            [{"question": r['question'], "response": r['new_response']} for r in answerable],
            batch_size=batch_size
        )
        for i, fc in enumerate(fact_checks):
            if i < len(answerable):
                answerable[i]['new_bot_accuracy'] = fc.get('accuracy', 'UNKNOWN')
                answerable[i]['new_bot_issues'] = fc.get('issues', '')

    return results


def generate_comparison_verdict(comparison_results: list[dict],
                                 could_not_answer_results: list[dict]) -> dict:
    """
    Generate an overall verdict comparing old vs new bot performance.

    Returns dict with verdict (BETTER/SAME/WORSE) and detailed stats.
    """
    stats = {
        "could_answer_comparisons": {
            "total": 0,
            "better": 0,
            "same": 0,
            "worse": 0,
            "unknown": 0,
        },
        "could_not_answer_checks": {
            "total": 0,
            "new_bot_can_answer": 0,
            "new_bot_cannot_answer": 0,
            "new_bot_correct": 0,
            "new_bot_incorrect": 0,
        },
        "overall_verdict": "SAME",
        "verdict_reason": "",
    }

    # Analyze could-answer comparisons
    for r in comparison_results:
        stats["could_answer_comparisons"]["total"] += 1
        verdict = r.get('verdict', 'UNKNOWN').upper()
        if verdict == "BETTER":
            stats["could_answer_comparisons"]["better"] += 1
        elif verdict == "WORSE":
            stats["could_answer_comparisons"]["worse"] += 1
        elif verdict == "SAME":
            stats["could_answer_comparisons"]["same"] += 1
        else:
            stats["could_answer_comparisons"]["unknown"] += 1

    # Analyze could-not-answer checks
    for r in could_not_answer_results:
        stats["could_not_answer_checks"]["total"] += 1
        if r.get('new_bot_can_answer'):
            stats["could_not_answer_checks"]["new_bot_can_answer"] += 1
            if r.get('new_bot_accuracy') == 'CORRECT':
                stats["could_not_answer_checks"]["new_bot_correct"] += 1
            elif r.get('new_bot_accuracy') in ('INCORRECT', 'PARTIALLY_CORRECT'):
                stats["could_not_answer_checks"]["new_bot_incorrect"] += 1
        else:
            stats["could_not_answer_checks"]["new_bot_cannot_answer"] += 1

    # Calculate overall verdict
    ca = stats["could_answer_comparisons"]
    cna = stats["could_not_answer_checks"]

    # Score: +1 for better, -1 for worse, +0.5 for new answers that are correct
    score = 0
    reasons = []

    if ca["total"] > 0:
        score += ca["better"] - ca["worse"]
        if ca["better"] > ca["worse"]:
            reasons.append(f"{ca['better']} responses improved vs {ca['worse']} degraded")
        elif ca["worse"] > ca["better"]:
            reasons.append(f"{ca['worse']} responses degraded vs {ca['better']} improved")

    if cna["total"] > 0:
        newly_answerable = cna["new_bot_can_answer"]
        if newly_answerable > 0:
            score += newly_answerable * 0.5
            reasons.append(f"Can now answer {newly_answerable} previously unanswerable questions")

    if score > 1:
        stats["overall_verdict"] = "BETTER"
    elif score < -1:
        stats["overall_verdict"] = "WORSE"
    else:
        stats["overall_verdict"] = "SAME"

    stats["verdict_reason"] = "; ".join(reasons) if reasons else "No significant differences detected"

    return stats


# ============================================================================
# MAIN ANALYSIS
# ============================================================================

def analyze_file(filename: str,
                 llm_usage_types: list[str] = None,
                 enable_fact_check: bool = False,
                 after_date: Optional[datetime] = None,
                 before_date: Optional[datetime] = None) -> dict:
    """
    Analyze a single log file.

    Args:
        filename: Path to CSV file
        llm_usage_types: List of query types for Claude processing ('valid-answered', 'valid-cannot-answer')
        enable_fact_check: Fact-check valid-answered responses (requires 'valid-answered' in llm_usage_types)
        after_date: Only include records after this date
        before_date: Only include records before this date
    """
    if llm_usage_types is None:
        llm_usage_types = []

    results = {
        "filename": filename,
        "total": 0,
        "total_before_filter": 0,
        "filtered_out": 0,
        "date_range": {
            "after": after_date.strftime("%Y-%m-%d") if after_date else None,
            "before": before_date.strftime("%Y-%m-%d") if before_date else None,
        },
        "valid": 0,
        "invalid": 0,
        "invalid_reasons": defaultdict(int),
        "valid_answered": 0,
        "valid_cannot_answer": 0,
        "valid_cannot_answer_queries": [],
        "invalid_queries": [],
        "fact_checks": [],
        "fact_check_summary": {"correct": 0, "incorrect": 0, "partial": 0, "error": 0},
        "answer_searches": [],
        "answer_search_summary": {"found": 0, "not_found": 0},
        "analyzed_rows": [],  # Per-row analysis data for CSV output
        "original_fieldnames": [],  # Original CSV column names
    }

    rows_to_fact_check = []
    rows_to_search_answer = []
    row_index = 0

    with open(filename, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        results["original_fieldnames"] = reader.fieldnames or []

        # Read all rows first for progress bar
        all_rows = list(reader)
        print(f"  Reading {len(all_rows)} rows from {filename}...")

        for row in tqdm(all_rows, desc="  Classifying rows", unit="row"):
            question = row.get('question', '').strip()
            response = row.get('response', '').strip()

            if not question:
                continue

            results["total_before_filter"] += 1

            # Date filtering
            row_date = parse_date(row.get('timestamp', '') or row.get('date', ''))

            if after_date and row_date:
                if row_date.date() < after_date.date():
                    results["filtered_out"] += 1
                    continue

            if before_date and row_date:
                if row_date.date() > before_date.date():
                    results["filtered_out"] += 1
                    continue

            results["total"] += 1

            # Classification using regex
            classification_result = auto_classify_query(question)
            if classification_result is None:
                classification_result = ("valid", "default_valid")

            classification, reason = classification_result

            # Prepare row analysis data
            row_analysis = {
                "original_row": row,
                "row_index": row_index,
                "classification": classification,
                "classification_reason": reason,
                "cannot_answer": False,
                "fact_check_accuracy": "",
                "fact_check_issues": "",
                "ai_correct_answer": "",
            }

            if classification == "invalid":
                results["invalid"] += 1
                results["invalid_reasons"][reason] += 1
                results["invalid_queries"].append({
                    "question": question[:100],
                    "reason": reason,
                })
            else:
                results["valid"] += 1
                if is_cannot_answer(response):
                    results["valid_cannot_answer"] += 1
                    row_analysis["cannot_answer"] = True
                    results["valid_cannot_answer_queries"].append({
                        "question": question[:150],
                        "response_snippet": response[:100],
                    })
                    # Collect for answer search if enabled
                    if "valid-cannot-answer" in llm_usage_types:
                        rows_to_search_answer.append({
                            "question": question,
                            "row_index": row_index,
                        })
                else:
                    results["valid_answered"] += 1
                    # Collect for fact-checking if enabled
                    if "valid-answered" in llm_usage_types and enable_fact_check:
                        rows_to_fact_check.append({
                            "question": question,
                            "response": response,
                            "row_index": row_index,
                        })

            results["analyzed_rows"].append(row_analysis)
            row_index += 1

    # Batch fact-check responses
    if rows_to_fact_check:
        print(f"\n  Fact-checking {len(rows_to_fact_check)} responses (batch mode)...")
        fact_check_results = fact_check_batch_with_claude(rows_to_fact_check, batch_size=25)
        results["fact_checks"] = fact_check_results

        # Map results back to analyzed_rows
        for i, fc in enumerate(fact_check_results):
            if i < len(rows_to_fact_check):
                target_row_index = rows_to_fact_check[i]["row_index"]
                results["analyzed_rows"][target_row_index]["fact_check_accuracy"] = fc.get("accuracy", "")
                results["analyzed_rows"][target_row_index]["fact_check_issues"] = fc.get("issues", "")

            if fc.get("accuracy") == "CORRECT":
                results["fact_check_summary"]["correct"] += 1
            elif fc.get("accuracy") == "INCORRECT":
                results["fact_check_summary"]["incorrect"] += 1
            elif fc.get("accuracy") == "PARTIALLY_CORRECT":
                results["fact_check_summary"]["partial"] += 1
            else:
                results["fact_check_summary"]["error"] += 1

    # Batch search for answers to unanswered questions
    if rows_to_search_answer:
        print(f"\n  Searching answers for {len(rows_to_search_answer)} unanswered questions (batch mode)...")
        answer_search_results = search_answers_batch_with_claude(rows_to_search_answer, batch_size=25)
        results["answer_searches"] = answer_search_results

        # Map results back to analyzed_rows
        for i, ans in enumerate(answer_search_results):
            if i < len(rows_to_search_answer):
                target_row_index = rows_to_search_answer[i]["row_index"]
                results["analyzed_rows"][target_row_index]["ai_correct_answer"] = ans.get("ai_correct_answer", "")

            if ans.get("ai_correct_answer", "").upper() != "NOT FOUND" and not ans.get("ai_correct_answer", "").startswith("ERROR"):
                results["answer_search_summary"]["found"] += 1
            else:
                results["answer_search_summary"]["not_found"] += 1

    return results


def write_analyzed_csv(results: dict, output_filename: str, comparison_data: dict = None):
    """
    Write analyzed results to a new CSV file with additional columns.

    Args:
        results: Analysis results from analyze_file
        output_filename: Path for the output CSV
        comparison_data: Optional dict with comparison results keyed by row_index
    """
    if not results["analyzed_rows"]:
        print(f"  No rows to write to {output_filename}")
        return

    comparison_data = comparison_data or {}

    # Build fieldnames: original + new analysis columns + comparison columns
    new_columns = [
        "classification",
        "classification_reason",
        "cannot_answer",
        "fact_check_accuracy",
        "fact_check_issues",
        "ai_correct_answer",
    ]

    # Add comparison columns if we have comparison data
    if comparison_data:
        new_columns.extend([
            "new_bot_response",
            "new_bot_comparison_verdict",
            "new_bot_comparison_reason",
            "new_bot_can_answer",
            "new_bot_accuracy",
        ])

    fieldnames = list(results["original_fieldnames"]) + new_columns

    with open(output_filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for row_analysis in results["analyzed_rows"]:
            row_idx = row_analysis["row_index"]

            # Combine original row with analysis data
            output_row = dict(row_analysis["original_row"])
            output_row["classification"] = row_analysis["classification"]
            output_row["classification_reason"] = row_analysis["classification_reason"]
            output_row["cannot_answer"] = str(row_analysis["cannot_answer"]).lower()
            output_row["fact_check_accuracy"] = row_analysis["fact_check_accuracy"]
            output_row["fact_check_issues"] = row_analysis["fact_check_issues"]
            output_row["ai_correct_answer"] = row_analysis["ai_correct_answer"]

            # Add comparison data if available
            if row_idx in comparison_data:
                comp = comparison_data[row_idx]
                output_row["new_bot_response"] = comp.get("new_response", "")
                output_row["new_bot_comparison_verdict"] = comp.get("verdict", "")
                output_row["new_bot_comparison_reason"] = comp.get("reason", "")
                output_row["new_bot_can_answer"] = str(comp.get("new_bot_can_answer", "")).lower()
                output_row["new_bot_accuracy"] = comp.get("new_bot_accuracy", "")
            elif comparison_data:
                # Fill empty values for rows without comparison
                output_row["new_bot_response"] = ""
                output_row["new_bot_comparison_verdict"] = ""
                output_row["new_bot_comparison_reason"] = ""
                output_row["new_bot_can_answer"] = ""
                output_row["new_bot_accuracy"] = ""

            writer.writerow(output_row)

    print(f"  Analyzed CSV saved to: {output_filename}")


def generate_report(staging_results: dict, production_results: dict, output_file: str):
    """Generate markdown report."""

    report = f"""# Chatbot Performance Analysis Report

**Generated:** {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
**Analysis Method:** Python + Claude Code Headless

---

## Executive Summary

| Metric | Staging | Production |
|--------|---------|------------|
| Total Queries | {staging_results['total']} | {production_results['total']} |
| Valid Queries | {staging_results['valid']} ({100*staging_results['valid']/max(staging_results['total'],1):.1f}%) | {production_results['valid']} ({100*production_results['valid']/max(production_results['total'],1):.1f}%) |
| Invalid Queries | {staging_results['invalid']} ({100*staging_results['invalid']/max(staging_results['total'],1):.1f}%) | {production_results['invalid']} ({100*production_results['invalid']/max(production_results['total'],1):.1f}%) |
| Successfully Answered | {staging_results['valid_answered']} ({100*staging_results['valid_answered']/max(staging_results['valid'],1):.1f}%) | {production_results['valid_answered']} ({100*production_results['valid_answered']/max(production_results['valid'],1):.1f}%) |
| Could Not Answer | {staging_results['valid_cannot_answer']} | {production_results['valid_cannot_answer']} |

---

## Invalid Query Breakdown

### Staging
"""
    for reason, count in sorted(staging_results['invalid_reasons'].items(), key=lambda x: -x[1]):
        report += f"- {reason}: {count}\n"

    report += "\n### Production\n"
    for reason, count in sorted(production_results['invalid_reasons'].items(), key=lambda x: -x[1]):
        report += f"- {reason}: {count}\n"

    report += """
---

## Sample Unanswered Valid Queries

### Staging
"""
    for item in staging_results['valid_cannot_answer_queries'][:10]:
        report += f"- {item['question'][:80]}...\n"

    report += "\n### Production\n"
    for item in production_results['valid_cannot_answer_queries'][:10]:
        report += f"- {item['question'][:80]}...\n"

    # Add fact-check results if available
    if staging_results.get('fact_checks') or production_results.get('fact_checks'):
        report += """
---

## Fact-Check Results
"""
        all_checks = staging_results.get('fact_checks', []) + production_results.get('fact_checks', [])
        correct = sum(1 for c in all_checks if c['accuracy'] == 'CORRECT')
        report += f"\n**Accuracy:** {correct}/{len(all_checks)} responses verified as correct\n"

        for check in all_checks:
            if check['accuracy'] != 'CORRECT':
                report += f"\n- **{check['accuracy']}**: {check['question'][:60]}...\n"
                if check['issues']:
                    report += f"  - Issues: {check['issues']}\n"

    report += """
---

## LLM Classification Stats

"""
    report += f"- Staging: {staging_results.get('llm_classifications', 0)} queries classified by Claude\n"
    report += f"- Production: {production_results.get('llm_classifications', 0)} queries classified by Claude\n"

    report += "\n---\n\n*Report generated by analyze-logs-headless.py*\n"

    with open(output_file, 'w') as f:
        f.write(report)

    print(f"\n✅ Report saved to: {output_file}")


# ============================================================================
# CLI ENTRY POINT
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Analyze chatbot logs with Claude Code headless",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic analysis
  python3 analyze-logs-headless.py

  # Filter by date (on or after Jan 1, 2026)
  python3 analyze-logs-headless.py --on-or-after 2026-01-01

  # Filter by date range (inclusive)
  python3 analyze-logs-headless.py --on-or-after 2025-12-01 --on-or-before 2026-01-01

  # Search for answers to unanswered questions using Claude
  python3 analyze-logs-headless.py --llm-usage-type=valid-cannot-answer

  # Fact-check answered responses using Claude
  python3 analyze-logs-headless.py --llm-usage-type=valid-answered --fact-check

  # Both: fact-check answered + search answers for unanswered
  python3 analyze-logs-headless.py --llm-usage-type=valid-answered,valid-cannot-answer --fact-check

  # Analyze single file with answer search
  python3 analyze-logs-headless.py --staging-file /tmp/logs.csv --production-file /dev/null --llm-usage-type=valid-cannot-answer

  # Compare old logs with new bot (could-answer queries)
  python3 analyze-logs-headless.py --compare-with-new-bot=could-answer --new-bot-url=http://localhost:8787/answer

  # Compare old logs with new bot (could-not-answer queries)
  python3 analyze-logs-headless.py --compare-with-new-bot=could-not-answer

  # Compare both types with new bot
  python3 analyze-logs-headless.py --compare-with-new-bot=could-answer,could-not-answer
        """
    )
    parser.add_argument("--staging-file", default="staging-logs.csv", help="Path to staging logs CSV")
    parser.add_argument("--production-file", default="production-logs.csv", help="Path to production logs CSV")
    parser.add_argument("--output", default="chatbot-analysis-report-headless.md", help="Output report file")
    parser.add_argument("--llm-usage-type", type=str, metavar="TYPES",
                        help="Comma-separated query types for Claude processing: valid-answered, valid-cannot-answer")
    parser.add_argument("--fact-check", action="store_true",
                        help="Fact-check valid-answered responses using Claude CLI (requires --llm-usage-type=valid-answered)")
    parser.add_argument("--on-or-after", type=str, metavar="DATE",
                        help="Only analyze records on or after this date (format: YYYY-MM-DD)")
    parser.add_argument("--on-or-before", type=str, metavar="DATE",
                        help="Only analyze records on or before this date (format: YYYY-MM-DD)")
    parser.add_argument("--compare-with-new-bot", type=str, metavar="TYPES",
                        help="Compare old logs with new bot. Comma-separated: could-answer, could-not-answer, or both")
    parser.add_argument("--new-bot-url", type=str, default="http://localhost:8787/answer",
                        help="URL of the new chatbot API endpoint (default: http://localhost:8787/answer)")

    args = parser.parse_args()

    # Parse date filters
    after_date = None
    before_date = None

    if args.on_or_after:
        try:
            after_date = parse_cli_date(args.on_or_after)
        except ValueError as e:
            print(f"❌ Error: {e}")
            sys.exit(1)

    if args.on_or_before:
        try:
            before_date = parse_cli_date(args.on_or_before)
        except ValueError as e:
            print(f"❌ Error: {e}")
            sys.exit(1)

    # Parse LLM usage types
    llm_usage_types = []
    if args.llm_usage_type:
        llm_usage_types = [t.strip() for t in args.llm_usage_type.split(',')]
        valid_types = {'valid-answered', 'valid-cannot-answer'}
        for t in llm_usage_types:
            if t not in valid_types:
                print(f"❌ Error: Invalid --llm-usage-type '{t}'. Valid options: {', '.join(valid_types)}")
                sys.exit(1)

    # Parse comparison types
    compare_types = []
    if args.compare_with_new_bot:
        compare_types = [t.strip() for t in args.compare_with_new_bot.split(',')]
        valid_compare_types = {'could-answer', 'could-not-answer'}
        for t in compare_types:
            if t not in valid_compare_types:
                print(f"❌ Error: Invalid --compare-with-new-bot '{t}'. Valid options: {', '.join(valid_compare_types)}")
                sys.exit(1)

    print("=" * 60)
    print("CHATBOT LOG ANALYSIS (with Claude Code Headless)")
    print("=" * 60)

    # Show date filter info
    if after_date or before_date:
        print("\n📅 Date Filter:")
        if after_date:
            print(f"   On or after: {after_date.strftime('%Y-%m-%d')}")
        if before_date:
            print(f"   On or before: {before_date.strftime('%Y-%m-%d')}")

    # Show LLM usage info
    if llm_usage_types:
        print(f"\n🤖 LLM Processing: {', '.join(llm_usage_types)}")
        if args.fact_check and 'valid-answered' in llm_usage_types:
            print("   Fact-checking: enabled")

    # Show comparison info
    if compare_types:
        print(f"\n🔄 New Bot Comparison: {', '.join(compare_types)}")
        print(f"   New bot URL: {args.new_bot_url}")

    # Check if files exist
    for f in [args.staging_file, args.production_file]:
        if not Path(f).exists():
            print(f"❌ File not found: {f}")
            sys.exit(1)

    # Analyze staging
    print(f"\n📊 Analyzing {args.staging_file}...")
    staging_results = analyze_file(
        args.staging_file,
        llm_usage_types=llm_usage_types,
        enable_fact_check=args.fact_check,
        after_date=after_date,
        before_date=before_date
    )
    if staging_results['filtered_out'] > 0:
        print(f"   Filtered: {staging_results['total']}/{staging_results['total_before_filter']} records (excluded {staging_results['filtered_out']} by date)")
    print(f"   Total: {staging_results['total']}, Valid: {staging_results['valid']}, Invalid: {staging_results['invalid']}")
    print(f"   Answered: {staging_results['valid_answered']}, Cannot answer: {staging_results['valid_cannot_answer']}")
    if staging_results['fact_checks']:
        summary = staging_results['fact_check_summary']
        print(f"   Fact-check: {summary['correct']} correct, {summary['incorrect']} incorrect, {summary['partial']} partial")
    if staging_results['answer_searches']:
        summary = staging_results['answer_search_summary']
        print(f"   Answer search: {summary['found']} found, {summary['not_found']} not found")

    # Compare with new bot for staging if requested
    staging_comparison_data = {}
    staging_comparison_results = []
    staging_could_not_answer_results = []

    if compare_types and staging_results['analyzed_rows'] and args.staging_file != '/dev/null':
        print(f"\n🔄 Comparing staging logs with new bot...")

        # Collect rows for comparison
        could_answer_rows = []
        could_not_answer_rows = []

        for row_analysis in staging_results['analyzed_rows']:
            if row_analysis['classification'] == 'valid':
                original_row = row_analysis['original_row']
                question = original_row.get('question', '')
                response = original_row.get('response', '')
                row_idx = row_analysis['row_index']

                if row_analysis['cannot_answer']:
                    could_not_answer_rows.append({
                        'question': question,
                        'row_index': row_idx,
                    })
                else:
                    could_answer_rows.append({
                        'question': question,
                        'old_response': response,
                        'row_index': row_idx,
                    })

        # Compare could-answer queries
        if 'could-answer' in compare_types and could_answer_rows:
            print(f"  Comparing {len(could_answer_rows)} could-answer queries...")

            # Query new bot for all could-answer questions
            for item in tqdm(could_answer_rows, desc="    Querying new bot", unit="query"):
                item['new_response'] = query_new_bot(item['question'], args.new_bot_url)

            # Compare with Claude
            staging_comparison_results = compare_responses_with_claude(could_answer_rows)

            # Map to comparison_data by row_index
            for i, item in enumerate(could_answer_rows):
                if i < len(staging_comparison_results):
                    staging_comparison_data[item['row_index']] = {
                        'new_response': item['new_response'],
                        'verdict': staging_comparison_results[i].get('verdict', ''),
                        'reason': staging_comparison_results[i].get('reason', ''),
                    }

        # Check could-not-answer queries
        if 'could-not-answer' in compare_types and could_not_answer_rows:
            print(f"  Checking {len(could_not_answer_rows)} could-not-answer queries...")
            staging_could_not_answer_results = check_new_bot_can_answer(
                could_not_answer_rows,
                args.new_bot_url
            )

            # Map to comparison_data by row_index
            for result in staging_could_not_answer_results:
                row_idx = result.get('row_index')
                if row_idx is not None:
                    staging_comparison_data[row_idx] = {
                        'new_response': result.get('new_response', ''),
                        'new_bot_can_answer': result.get('new_bot_can_answer', False),
                        'new_bot_accuracy': result.get('new_bot_accuracy', ''),
                    }

    # Write analyzed CSV for staging
    if staging_results['analyzed_rows'] and args.staging_file != '/dev/null':
        staging_csv_output = args.staging_file.replace('.csv', '-analyzed.csv')
        write_analyzed_csv(staging_results, staging_csv_output, staging_comparison_data)

    # Analyze production
    print(f"\n📊 Analyzing {args.production_file}...")
    production_results = analyze_file(
        args.production_file,
        llm_usage_types=llm_usage_types,
        enable_fact_check=args.fact_check,
        after_date=after_date,
        before_date=before_date
    )
    if production_results['filtered_out'] > 0:
        print(f"   Filtered: {production_results['total']}/{production_results['total_before_filter']} records (excluded {production_results['filtered_out']} by date)")
    print(f"   Total: {production_results['total']}, Valid: {production_results['valid']}, Invalid: {production_results['invalid']}")
    print(f"   Answered: {production_results['valid_answered']}, Cannot answer: {production_results['valid_cannot_answer']}")
    if production_results['fact_checks']:
        summary = production_results['fact_check_summary']
        print(f"   Fact-check: {summary['correct']} correct, {summary['incorrect']} incorrect, {summary['partial']} partial")
    if production_results['answer_searches']:
        summary = production_results['answer_search_summary']
        print(f"   Answer search: {summary['found']} found, {summary['not_found']} not found")

    # Compare with new bot for production if requested
    production_comparison_data = {}
    production_comparison_results = []
    production_could_not_answer_results = []

    if compare_types and production_results['analyzed_rows'] and args.production_file != '/dev/null':
        print(f"\n🔄 Comparing production logs with new bot...")

        # Collect rows for comparison
        could_answer_rows = []
        could_not_answer_rows = []

        for row_analysis in production_results['analyzed_rows']:
            if row_analysis['classification'] == 'valid':
                original_row = row_analysis['original_row']
                question = original_row.get('question', '')
                response = original_row.get('response', '')
                row_idx = row_analysis['row_index']

                if row_analysis['cannot_answer']:
                    could_not_answer_rows.append({
                        'question': question,
                        'row_index': row_idx,
                    })
                else:
                    could_answer_rows.append({
                        'question': question,
                        'old_response': response,
                        'row_index': row_idx,
                    })

        # Compare could-answer queries
        if 'could-answer' in compare_types and could_answer_rows:
            print(f"  Comparing {len(could_answer_rows)} could-answer queries...")

            # Query new bot for all could-answer questions
            for item in tqdm(could_answer_rows, desc="    Querying new bot", unit="query"):
                item['new_response'] = query_new_bot(item['question'], args.new_bot_url)

            # Compare with Claude
            production_comparison_results = compare_responses_with_claude(could_answer_rows)

            # Map to comparison_data by row_index
            for i, item in enumerate(could_answer_rows):
                if i < len(production_comparison_results):
                    production_comparison_data[item['row_index']] = {
                        'new_response': item['new_response'],
                        'verdict': production_comparison_results[i].get('verdict', ''),
                        'reason': production_comparison_results[i].get('reason', ''),
                    }

        # Check could-not-answer queries
        if 'could-not-answer' in compare_types and could_not_answer_rows:
            print(f"  Checking {len(could_not_answer_rows)} could-not-answer queries...")
            production_could_not_answer_results = check_new_bot_can_answer(
                could_not_answer_rows,
                args.new_bot_url
            )

            # Map to comparison_data by row_index
            for result in production_could_not_answer_results:
                row_idx = result.get('row_index')
                if row_idx is not None:
                    production_comparison_data[row_idx] = {
                        'new_response': result.get('new_response', ''),
                        'new_bot_can_answer': result.get('new_bot_can_answer', False),
                        'new_bot_accuracy': result.get('new_bot_accuracy', ''),
                    }

    # Write analyzed CSV for production
    if production_results['analyzed_rows'] and args.production_file != '/dev/null':
        production_csv_output = args.production_file.replace('.csv', '-analyzed.csv')
        write_analyzed_csv(production_results, production_csv_output, production_comparison_data)

    # Generate and display comparison verdict if comparison was done
    if compare_types:
        all_comparison_results = staging_comparison_results + production_comparison_results
        all_could_not_answer_results = staging_could_not_answer_results + production_could_not_answer_results

        verdict_stats = generate_comparison_verdict(all_comparison_results, all_could_not_answer_results)

        print("\n" + "=" * 60)
        print("NEW BOT COMPARISON VERDICT")
        print("=" * 60)

        ca = verdict_stats['could_answer_comparisons']
        if ca['total'] > 0:
            print(f"\n📊 Could-Answer Comparisons ({ca['total']} total):")
            print(f"   Better: {ca['better']}")
            print(f"   Same: {ca['same']}")
            print(f"   Worse: {ca['worse']}")
            if ca['unknown'] > 0:
                print(f"   Unknown: {ca['unknown']}")

        cna = verdict_stats['could_not_answer_checks']
        if cna['total'] > 0:
            print(f"\n📊 Could-Not-Answer Checks ({cna['total']} total):")
            print(f"   New bot CAN answer: {cna['new_bot_can_answer']}")
            print(f"   New bot still cannot: {cna['new_bot_cannot_answer']}")
            if cna['new_bot_correct'] > 0:
                print(f"   New answers correct: {cna['new_bot_correct']}")
            if cna['new_bot_incorrect'] > 0:
                print(f"   New answers incorrect: {cna['new_bot_incorrect']}")

        verdict = verdict_stats['overall_verdict']
        verdict_emoji = {"BETTER": "✅", "SAME": "➡️", "WORSE": "❌"}.get(verdict, "❓")

        print(f"\n{'=' * 60}")
        print(f"🏆 OVERALL VERDICT: {verdict_emoji} {verdict}")
        print(f"   {verdict_stats['verdict_reason']}")
        print("=" * 60)

    # Generate report
    print(f"\n📝 Generating report...")
    generate_report(staging_results, production_results, args.output)

    # Save detailed JSON (exclude large data)
    json_output = args.output.replace('.md', '.json')

    def prepare_for_json(results):
        """Prepare results for JSON serialization, excluding large row data."""
        return {
            k: (dict(v) if isinstance(v, defaultdict) else v)
            for k, v in results.items()
            if k not in ('analyzed_rows', 'original_fieldnames')  # Exclude large data
        }

    with open(json_output, 'w') as f:
        json.dump({
            "staging": prepare_for_json(staging_results),
            "production": prepare_for_json(production_results),
        }, f, indent=2)
    print(f"✅ Detailed JSON saved to: {json_output}")

    print("\n" + "=" * 60)
    print("ANALYSIS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
