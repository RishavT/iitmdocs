#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["flask"]
# ///
"""
Chatbot Log Analyzer - Flask Web Application

A single-file Flask app for analyzing chatbot logs with:
- File upload for CSV logs
- Date range filtering
- Background job processing with progress tracking
- Real-time progress updates via Server-Sent Events (SSE)

Usage:
    LOG_ANALYZER_PASSWORD=secret uv run log-analyzer-app.py

    Then open http://localhost:5123 in your browser.

    With custom port:
        LOG_ANALYZER_PASSWORD=secret uv run log-analyzer-app.py --port 8080

    With debug mode:
        LOG_ANALYZER_PASSWORD=secret uv run log-analyzer-app.py --debug

Environment Variables:
    LOG_ANALYZER_PASSWORD  - Required. Password for accessing the analyzer.

Alternative (with virtualenv):
    pip install flask
    LOG_ANALYZER_PASSWORD=secret python3 log-analyzer-app.py

API Endpoints:
    GET  /              - Main page with upload form
    POST /analyze       - Start analysis job (returns job_id)
    GET  /status/<id>   - Get job status (polling)
    GET  /stream/<id>   - SSE stream for real-time progress

Testing:
    The core analysis logic is shared with analyze-logs-headless.py.
    Run the test suite with:

        pytest test_analyze_logs.py -v

    For manual testing:
        1. Start the server: uv run log-analyzer-app.py
        2. Open http://localhost:5000
        3. Upload a CSV file (e.g., staging-logs.csv)
        4. Optionally set date range
        5. Click "Analyze Logs" and watch progress
"""

import csv
import concurrent.futures
import io
import json
import os
import re
import subprocess
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Optional

from flask import Flask, request, jsonify, Response, stream_with_context

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# Password authentication
APP_PASSWORD = os.environ.get('LOG_ANALYZER_PASSWORD', '')

# ============================================================================
# JOB STORE - In-memory storage for background jobs
# ============================================================================

jobs = {}  # job_id -> job_state
jobs_lock = threading.Lock()


def create_job() -> str:
    """Create a new job and return its ID."""
    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "pending",
            "progress": 0,
            "message": "Initializing...",
            "result": None,
            "error": None,
            "created_at": datetime.now().isoformat(),
        }
    return job_id


def update_job(job_id: str, **kwargs):
    """Update job state."""
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)


def get_job(job_id: str) -> Optional[dict]:
    """Get job state."""
    with jobs_lock:
        return jobs.get(job_id, {}).copy()


# ============================================================================
# ANALYSIS LOGIC (adapted from analyze-logs-headless.py)
# ============================================================================

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


def parse_date(date_str: str) -> Optional[datetime]:
    """Parse date string in various formats."""
    if not date_str:
        return None

    formats = [
        "%m/%d/%Y",
        "%Y-%m-%d",
        "%d-%m-%Y",
        "%m/%d/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None


def auto_classify_query(question: str) -> tuple[str, str] | None:
    """Try to classify query using patterns."""
    q_lower = question.lower().strip()

    if len(q_lower) < 3:
        return ("invalid", "too_short")

    for reason, patterns in AUTO_INVALID_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, q_lower, re.IGNORECASE):
                if reason == "out_of_context":
                    if any(ctx in q_lower for ctx in ['iitm', 'iit', 'bs', 'degree', 'course', 'exam', 'fee', 'admission', 'qualifier']):
                        continue
                return ("invalid", reason)

    iitm_keywords = ['iitm', 'iit madras', 'qualifier', 'foundation', 'diploma', 'bs degree',
                     'data science', 'electronic systems', 'admission', 'eligibility']
    if any(kw in q_lower for kw in iitm_keywords):
        return ("valid", "iitm_related")

    return ("valid", "default_valid")


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


def run_claude_cli(prompt: str, timeout: int = 90) -> str:
    """
    Run Claude CLI in non-interactive mode.
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
        return "[ERROR: Claude CLI not found]"
    except Exception as e:
        return f"[ERROR: {str(e)}]"


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

    result = run_claude_cli(prompt, timeout=180)
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


def fact_check_batch_with_claude(responses: list[dict], job_id: str,
                                  batch_size: int = 25, max_workers: int = 4) -> list[dict]:
    """
    Batch fact-check multiple responses using Claude CLI with parallel workers.

    This is much faster than checking one at a time because:
    1. Claude reads source documents once per batch (not per response)
    2. Multiple batches run in parallel (default 4 workers)

    Args:
        responses: List of dicts with 'question', 'response', and 'index' keys
        job_id: Job ID for progress updates
        batch_size: Number of responses per Claude CLI call (default 25)
        max_workers: Number of parallel Claude CLI processes (default 4)

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
    update_job(job_id,
               message=f"Starting {total_batches} batches with {max_workers} parallel workers...",
               progress=82)

    # Track completed batches for progress
    completed = [0]  # Use list to allow modification in nested function
    results_lock = threading.Lock()

    def track_progress(future):
        with results_lock:
            completed[0] += 1
            progress = 82 + int(13 * completed[0] / total_batches)
            update_job(job_id,
                       message=f"Fact-checking: {completed[0]}/{total_batches} batches complete...",
                       progress=progress)

    # Run batches in parallel
    all_results = [None] * total_batches  # Pre-allocate to maintain order

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = []
        for batch_num, batch in enumerate(batches):
            future = executor.submit(process_single_batch, batch, batch_num)
            future.add_done_callback(track_progress)
            futures.append(future)

        # Collect results
        for future in concurrent.futures.as_completed(futures):
            try:
                batch_num, batch_results = future.result()
                all_results[batch_num] = batch_results
            except Exception as e:
                # Handle any errors
                pass

    # Flatten results in order
    final_results = []
    for batch_results in all_results:
        if batch_results:
            final_results.extend(batch_results)

    return final_results


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


def analyze_csv_content(csv_content: str, after_date: Optional[datetime],
                        before_date: Optional[datetime], job_id: str,
                        enable_fact_check: bool = False) -> dict:
    """
    Analyze CSV content with progress reporting.

    Args:
        csv_content: CSV file content as string
        after_date: Filter records on or after this date
        before_date: Filter records on or before this date
        job_id: Job ID for progress updates
        enable_fact_check: If True, fact-check answered queries using Claude CLI
    """
    results = {
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
    }

    # Collect responses for batch fact-checking
    responses_to_check = []

    # Parse CSV
    update_job(job_id, message="Parsing CSV file...", progress=5)

    reader = csv.DictReader(io.StringIO(csv_content))
    rows = list(reader)
    total_rows = len(rows)

    if total_rows == 0:
        update_job(job_id, message="No data found in CSV", progress=100)
        return results

    update_job(job_id, message=f"Found {total_rows} rows, analyzing...", progress=10)

    # Process each row
    for i, row in enumerate(rows):
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

        # Classify query
        classification_result = auto_classify_query(question)
        if classification_result is None:
            classification_result = ("valid", "default_valid")

        classification, reason = classification_result

        if classification == "invalid":
            results["invalid"] += 1
            results["invalid_reasons"][reason] += 1
            results["invalid_queries"].append({
                "question": question[:150],
                "reason": reason,
            })
        else:
            results["valid"] += 1
            if is_cannot_answer(response):
                results["valid_cannot_answer"] += 1
                results["valid_cannot_answer_queries"].append({
                    "question": question[:150],
                    "response_snippet": response[:100],
                })
            else:
                results["valid_answered"] += 1
                # Collect for batch fact-checking later
                if enable_fact_check:
                    responses_to_check.append({
                        "question": question,
                        "response": response,
                        "index": results["valid_answered"] - 1,
                    })

        # Update progress (0-80% for classification)
        progress = 10 + int(70 * (i + 1) / total_rows)
        if i % max(1, total_rows // 20) == 0:  # Update every 5%
            update_job(job_id,
                       message=f"Analyzed {i + 1}/{total_rows} rows...",
                       progress=progress)

    # Batch fact-checking (80-95% progress)
    if enable_fact_check and responses_to_check:
        update_job(job_id,
                   message=f"Starting batch fact-check of {len(responses_to_check)} responses...",
                   progress=80)

        fact_check_results = fact_check_batch_with_claude(responses_to_check, job_id, batch_size=25)
        results["fact_checks"] = fact_check_results

        # Calculate summary
        for fc in fact_check_results:
            if fc["accuracy"] == "CORRECT":
                results["fact_check_summary"]["correct"] += 1
            elif fc["accuracy"] == "INCORRECT":
                results["fact_check_summary"]["incorrect"] += 1
            elif fc["accuracy"] == "PARTIALLY_CORRECT":
                results["fact_check_summary"]["partial"] += 1
            else:
                results["fact_check_summary"]["error"] += 1

    # Finalize
    update_job(job_id, message="Generating summary...", progress=95)

    # Convert defaultdict to regular dict for JSON serialization
    results["invalid_reasons"] = dict(results["invalid_reasons"])

    return results


def run_analysis_job(job_id: str, csv_content: str,
                     after_date: Optional[datetime], before_date: Optional[datetime],
                     enable_fact_check: bool = False):
    """Background job function."""
    try:
        update_job(job_id, status="running", message="Starting analysis...", progress=0)

        result = analyze_csv_content(csv_content, after_date, before_date, job_id,
                                     enable_fact_check=enable_fact_check)

        # Calculate summary stats
        if result["valid"] > 0:
            result["success_rate"] = round(100 * result["valid_answered"] / result["valid"], 1)
        else:
            result["success_rate"] = 0

        if result["total"] > 0:
            result["valid_rate"] = round(100 * result["valid"] / result["total"], 1)
        else:
            result["valid_rate"] = 0

        update_job(job_id,
                   status="completed",
                   message="Analysis complete!",
                   progress=100,
                   result=result)

    except Exception as e:
        update_job(job_id,
                   status="error",
                   message=f"Error: {str(e)}",
                   progress=100,
                   error=str(e))


# ============================================================================
# FLASK ROUTES
# ============================================================================

@app.route('/')
def index():
    """Serve the main page."""
    return HTML_TEMPLATE


@app.route('/analyze', methods=['POST'])
def start_analysis():
    """Start a new analysis job."""
    # Check password
    if APP_PASSWORD:
        password = request.form.get('password', '')
        if password != APP_PASSWORD:
            return jsonify({"error": "Invalid password"}), 401

    # Check for file
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400

    if not file.filename.endswith('.csv'):
        return jsonify({"error": "File must be a CSV"}), 400

    # Read file content
    try:
        csv_content = file.read().decode('utf-8')
    except Exception as e:
        return jsonify({"error": f"Failed to read file: {str(e)}"}), 400

    # Parse dates
    after_date = None
    before_date = None

    start_date_str = request.form.get('start_date', '').strip()
    end_date_str = request.form.get('end_date', '').strip()

    if start_date_str:
        after_date = parse_date(start_date_str)
        if not after_date:
            return jsonify({"error": f"Invalid start date: {start_date_str}"}), 400

    if end_date_str:
        before_date = parse_date(end_date_str)
        if not before_date:
            return jsonify({"error": f"Invalid end date: {end_date_str}"}), 400

    # Check if fact-checking is enabled
    enable_fact_check = request.form.get('fact_check', '').lower() in ('true', '1', 'on', 'yes')

    # Create job and start background thread
    job_id = create_job()
    thread = threading.Thread(
        target=run_analysis_job,
        args=(job_id, csv_content, after_date, before_date, enable_fact_check),
        daemon=True
    )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route('/status/<job_id>')
def job_status(job_id):
    """Get current job status."""
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route('/stream/<job_id>')
def stream_status(job_id):
    """Stream job status updates via SSE."""
    def generate():
        last_progress = -1
        while True:
            job = get_job(job_id)
            if not job:
                yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                break

            # Only send if progress changed
            if job.get('progress', 0) != last_progress:
                last_progress = job.get('progress', 0)
                yield f"data: {json.dumps(job)}\n\n"

            if job.get('status') in ('completed', 'error'):
                break

            time.sleep(0.5)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    )


# ============================================================================
# HTML TEMPLATE
# ============================================================================

HTML_TEMPLATE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chatbot Log Analyzer</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
            padding: 20px;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
        }

        h1 {
            text-align: center;
            margin-bottom: 30px;
            color: #2c3e50;
        }

        .card {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 24px;
            margin-bottom: 20px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }

        input[type="file"] {
            width: 100%;
            padding: 12px;
            border: 2px dashed #ccc;
            border-radius: 6px;
            cursor: pointer;
            background: #fafafa;
        }

        input[type="file"]:hover {
            border-color: #999;
        }

        input[type="date"] {
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            width: 200px;
        }

        input[type="password"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
        }

        input[type="password"]:focus {
            outline: none;
            border-color: #3498db;
            box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
        }

        .checkbox-group {
            margin-top: 10px;
        }

        .checkbox-label {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            cursor: pointer;
            font-weight: normal;
        }

        .checkbox-label input[type="checkbox"] {
            width: 18px;
            height: 18px;
            margin-top: 2px;
            cursor: pointer;
        }

        .checkbox-label span {
            font-weight: 600;
            color: #333;
        }

        .checkbox-label small {
            display: block;
            color: #666;
            font-size: 12px;
            margin-top: 2px;
        }

        .date-row {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
        }

        button {
            background: #3498db;
            color: white;
            border: none;
            padding: 14px 28px;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            transition: background 0.2s;
        }

        button:hover {
            background: #2980b9;
        }

        button:disabled {
            background: #bdc3c7;
            cursor: not-allowed;
        }

        .progress-container {
            display: none;
            margin-top: 20px;
        }

        .progress-bar {
            height: 24px;
            background: #ecf0f1;
            border-radius: 12px;
            overflow: hidden;
            margin-bottom: 10px;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3498db, #2ecc71);
            width: 0%;
            transition: width 0.3s ease;
            border-radius: 12px;
        }

        .progress-text {
            text-align: center;
            color: #666;
            font-size: 14px;
        }

        .results {
            display: none;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-box {
            background: #f8f9fa;
            padding: 16px;
            border-radius: 8px;
            text-align: center;
        }

        .stat-value {
            font-size: 28px;
            font-weight: bold;
            color: #2c3e50;
        }

        .stat-label {
            font-size: 12px;
            color: #7f8c8d;
            text-transform: uppercase;
            margin-top: 4px;
        }

        .stat-box.success .stat-value { color: #27ae60; }
        .stat-box.warning .stat-value { color: #f39c12; }
        .stat-box.danger .stat-value { color: #e74c3c; }

        .section-title {
            font-size: 18px;
            margin: 24px 0 16px;
            padding-bottom: 8px;
            border-bottom: 2px solid #ecf0f1;
            color: #2c3e50;
        }

        .query-list {
            max-height: 300px;
            overflow-y: auto;
            background: #f8f9fa;
            border-radius: 6px;
            padding: 12px;
        }

        .query-item {
            padding: 10px;
            border-bottom: 1px solid #eee;
            font-size: 14px;
        }

        .query-item:last-child {
            border-bottom: none;
        }

        .query-item .reason {
            display: inline-block;
            background: #e74c3c;
            color: white;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            margin-right: 8px;
        }

        .query-item .reason.cannot-answer {
            background: #f39c12;
        }

        .breakdown-list {
            list-style: none;
            padding: 0;
        }

        .breakdown-list li {
            padding: 8px 12px;
            background: #f8f9fa;
            margin-bottom: 6px;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
        }

        .breakdown-list .count {
            font-weight: bold;
            color: #e74c3c;
        }

        .fact-check-summary {
            display: flex;
            gap: 16px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }

        .fact-check-summary .stat {
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
        }

        .fact-check-summary .correct {
            background: #d4edda;
            color: #155724;
        }

        .fact-check-summary .incorrect {
            background: #f8d7da;
            color: #721c24;
        }

        .fact-check-summary .partial {
            background: #fff3cd;
            color: #856404;
        }

        .fact-check-item {
            padding: 12px;
            border-bottom: 1px solid #eee;
            font-size: 14px;
        }

        .fact-check-item:last-child {
            border-bottom: none;
        }

        .fact-check-item .accuracy {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            margin-right: 8px;
        }

        .fact-check-item .accuracy.correct {
            background: #27ae60;
            color: white;
        }

        .fact-check-item .accuracy.incorrect {
            background: #e74c3c;
            color: white;
        }

        .fact-check-item .accuracy.partial {
            background: #f39c12;
            color: white;
        }

        .fact-check-item .accuracy.unknown {
            background: #95a5a6;
            color: white;
        }

        .fact-check-item .issues {
            margin-top: 8px;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 12px;
            color: #666;
        }

        .error-message {
            background: #fee;
            color: #c0392b;
            padding: 16px;
            border-radius: 6px;
            margin-top: 20px;
            display: none;
        }

        .filter-info {
            background: #e8f4fd;
            color: #2980b9;
            padding: 12px 16px;
            border-radius: 6px;
            margin-bottom: 16px;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Chatbot Log Analyzer</h1>

        <div class="card">
            <form id="analyzeForm">
                <div class="form-group">
                    <label for="file">Upload CSV Log File</label>
                    <input type="file" id="file" name="file" accept=".csv" required>
                </div>

                <div class="form-group">
                    <label>Date Range (Optional)</label>
                    <div class="date-row">
                        <div>
                            <label for="start_date" style="font-weight: normal; font-size: 13px;">Start Date</label>
                            <input type="date" id="start_date" name="start_date">
                        </div>
                        <div>
                            <label for="end_date" style="font-weight: normal; font-size: 13px;">End Date</label>
                            <input type="date" id="end_date" name="end_date">
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="password">Password</label>
                    <input type="password" id="password" name="password" placeholder="Enter password" required>
                </div>

                <div class="form-group checkbox-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="fact_check" name="fact_check" value="true">
                        <span>Enable AI Fact-Checking</span>
                        <small>(Uses Claude CLI to verify each response - slower but more thorough)</small>
                    </label>
                </div>

                <button type="submit" id="submitBtn">Analyze Logs</button>
            </form>

            <div class="progress-container" id="progressContainer">
                <div class="progress-bar">
                    <div class="progress-fill" id="progressFill"></div>
                </div>
                <div class="progress-text" id="progressText">Initializing...</div>
            </div>

            <div class="error-message" id="errorMessage"></div>
        </div>

        <div class="card results" id="results">
            <h2 style="margin-bottom: 20px;">Analysis Results</h2>

            <div class="filter-info" id="filterInfo" style="display: none;"></div>

            <div class="stats-grid">
                <div class="stat-box">
                    <div class="stat-value" id="totalQueries">-</div>
                    <div class="stat-label">Total Queries</div>
                </div>
                <div class="stat-box success">
                    <div class="stat-value" id="validQueries">-</div>
                    <div class="stat-label">Valid Queries</div>
                </div>
                <div class="stat-box danger">
                    <div class="stat-value" id="invalidQueries">-</div>
                    <div class="stat-label">Invalid Queries</div>
                </div>
                <div class="stat-box success">
                    <div class="stat-value" id="answeredQueries">-</div>
                    <div class="stat-label">Answered</div>
                </div>
                <div class="stat-box warning">
                    <div class="stat-value" id="unansweredQueries">-</div>
                    <div class="stat-label">Could Not Answer</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="successRate">-</div>
                    <div class="stat-label">Success Rate</div>
                </div>
            </div>

            <div id="invalidBreakdown">
                <h3 class="section-title">Invalid Query Breakdown</h3>
                <ul class="breakdown-list" id="invalidReasonsList"></ul>
            </div>

            <div id="unansweredSection">
                <h3 class="section-title">Valid Queries Bot Could Not Answer</h3>
                <div class="query-list" id="unansweredList"></div>
            </div>

            <div id="invalidSection">
                <h3 class="section-title">Sample Invalid Queries</h3>
                <div class="query-list" id="invalidList"></div>
            </div>

            <div id="factCheckSection" style="display: none;">
                <h3 class="section-title">Fact-Check Results</h3>
                <div class="fact-check-summary" id="factCheckSummary"></div>
                <div class="query-list" id="factCheckList"></div>
            </div>
        </div>
    </div>

    <script>
        const form = document.getElementById('analyzeForm');
        const submitBtn = document.getElementById('submitBtn');
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const errorMessage = document.getElementById('errorMessage');
        const results = document.getElementById('results');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Reset UI
            results.style.display = 'none';
            errorMessage.style.display = 'none';
            progressContainer.style.display = 'block';
            progressFill.style.width = '0%';
            progressText.textContent = 'Uploading file...';
            submitBtn.disabled = true;

            const formData = new FormData(form);

            try {
                // Start analysis
                const response = await fetch('analyze', {
                    method: 'POST',
                    body: formData
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to start analysis');
                }

                const jobId = data.job_id;

                // Connect to SSE stream for progress updates
                const eventSource = new EventSource(`stream/${jobId}`);

                eventSource.onmessage = (event) => {
                    const job = JSON.parse(event.data);

                    if (job.error) {
                        eventSource.close();
                        showError(job.error);
                        return;
                    }

                    // Update progress
                    progressFill.style.width = `${job.progress}%`;
                    progressText.textContent = job.message;

                    if (job.status === 'completed') {
                        eventSource.close();
                        showResults(job.result);
                    } else if (job.status === 'error') {
                        eventSource.close();
                        showError(job.error || job.message);
                    }
                };

                eventSource.onerror = () => {
                    eventSource.close();
                    // Fall back to polling
                    pollStatus(jobId);
                };

            } catch (error) {
                showError(error.message);
            }
        });

        async function pollStatus(jobId) {
            try {
                const response = await fetch(`status/${jobId}`);
                const job = await response.json();

                progressFill.style.width = `${job.progress}%`;
                progressText.textContent = job.message;

                if (job.status === 'completed') {
                    showResults(job.result);
                } else if (job.status === 'error') {
                    showError(job.error || job.message);
                } else {
                    setTimeout(() => pollStatus(jobId), 1000);
                }
            } catch (error) {
                showError('Lost connection to server');
            }
        }

        function showError(message) {
            progressContainer.style.display = 'none';
            errorMessage.textContent = message;
            errorMessage.style.display = 'block';
            submitBtn.disabled = false;
        }

        function showResults(data) {
            progressContainer.style.display = 'none';
            submitBtn.disabled = false;

            // Show filter info if dates were used
            const filterInfo = document.getElementById('filterInfo');
            if (data.date_range.after || data.date_range.before) {
                let filterText = 'Filtered by date: ';
                if (data.date_range.after) filterText += `from ${data.date_range.after} `;
                if (data.date_range.before) filterText += `to ${data.date_range.before}`;
                if (data.filtered_out > 0) filterText += ` (${data.filtered_out} records excluded)`;
                filterInfo.textContent = filterText;
                filterInfo.style.display = 'block';
            } else {
                filterInfo.style.display = 'none';
            }

            // Update stats
            document.getElementById('totalQueries').textContent = data.total;
            document.getElementById('validQueries').textContent = data.valid;
            document.getElementById('invalidQueries').textContent = data.invalid;
            document.getElementById('answeredQueries').textContent = data.valid_answered;
            document.getElementById('unansweredQueries').textContent = data.valid_cannot_answer;
            document.getElementById('successRate').textContent = data.success_rate + '%';

            // Invalid reasons breakdown
            const invalidReasonsList = document.getElementById('invalidReasonsList');
            invalidReasonsList.innerHTML = '';
            if (Object.keys(data.invalid_reasons).length > 0) {
                for (const [reason, count] of Object.entries(data.invalid_reasons)) {
                    invalidReasonsList.innerHTML += `
                        <li>
                            <span>${reason.replace(/_/g, ' ')}</span>
                            <span class="count">${count}</span>
                        </li>
                    `;
                }
                document.getElementById('invalidBreakdown').style.display = 'block';
            } else {
                document.getElementById('invalidBreakdown').style.display = 'none';
            }

            // Unanswered queries
            const unansweredList = document.getElementById('unansweredList');
            unansweredList.innerHTML = '';
            if (data.valid_cannot_answer_queries.length > 0) {
                data.valid_cannot_answer_queries.slice(0, 20).forEach(q => {
                    unansweredList.innerHTML += `
                        <div class="query-item">
                            <span class="reason cannot-answer">could not answer</span>
                            ${escapeHtml(q.question)}
                        </div>
                    `;
                });
                document.getElementById('unansweredSection').style.display = 'block';
            } else {
                document.getElementById('unansweredSection').style.display = 'none';
            }

            // Invalid queries
            const invalidList = document.getElementById('invalidList');
            invalidList.innerHTML = '';
            if (data.invalid_queries.length > 0) {
                data.invalid_queries.slice(0, 20).forEach(q => {
                    invalidList.innerHTML += `
                        <div class="query-item">
                            <span class="reason">${q.reason.replace(/_/g, ' ')}</span>
                            ${escapeHtml(q.question)}
                        </div>
                    `;
                });
                document.getElementById('invalidSection').style.display = 'block';
            } else {
                document.getElementById('invalidSection').style.display = 'none';
            }

            // Fact-check results
            const factCheckSection = document.getElementById('factCheckSection');
            const factCheckSummary = document.getElementById('factCheckSummary');
            const factCheckList = document.getElementById('factCheckList');

            if (data.fact_checks && data.fact_checks.length > 0) {
                // Show summary
                const summary = data.fact_check_summary || {};
                factCheckSummary.innerHTML = `
                    <div class="stat correct">Correct: ${summary.correct || 0}</div>
                    <div class="stat incorrect">Incorrect: ${summary.incorrect || 0}</div>
                    <div class="stat partial">Partial: ${summary.partial || 0}</div>
                `;

                // Show individual results
                factCheckList.innerHTML = '';
                data.fact_checks.slice(0, 30).forEach(fc => {
                    const accuracyClass = fc.accuracy.toLowerCase().replace('_', '');
                    factCheckList.innerHTML += `
                        <div class="fact-check-item">
                            <span class="accuracy ${accuracyClass}">${fc.accuracy.replace(/_/g, ' ')}</span>
                            ${escapeHtml(fc.question)}
                            ${fc.issues && fc.accuracy !== 'CORRECT' ? `<div class="issues">${escapeHtml(fc.issues)}</div>` : ''}
                        </div>
                    `;
                });

                factCheckSection.style.display = 'block';
            } else {
                factCheckSection.style.display = 'none';
            }

            results.style.display = 'block';
            results.scrollIntoView({ behavior: 'smooth' });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    </script>
</body>
</html>
'''


# ============================================================================
# MAIN
# ============================================================================

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Chatbot Log Analyzer Web App')
    parser.add_argument('--port', type=int, default=5123, help='Port to run on (default: 5123)')
    parser.add_argument('--debug', action='store_true', help='Enable debug mode')
    args = parser.parse_args()

    print("=" * 50)
    print("Chatbot Log Analyzer")
    print("=" * 50)

    if not APP_PASSWORD:
        print("\nWARNING: No password set! Set LOG_ANALYZER_PASSWORD environment variable.")
        print("Example: LOG_ANALYZER_PASSWORD=secret uv run log-analyzer-app.py\n")
    else:
        print("\nPassword authentication enabled.")

    print(f"Starting server at http://localhost:{args.port}")
    print("Press Ctrl+C to stop\n")
    app.run(debug=args.debug, host='0.0.0.0', port=args.port, threaded=True)
