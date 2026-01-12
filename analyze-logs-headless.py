#!/usr/bin/env python3
"""
Chatbot Log Analysis with Claude Code Headless Mode

This script analyzes chatbot logs using:
- Python for data processing and pattern matching
- Claude Code headless mode for ambiguous query classification and fact-checking

Usage:
    python3 analyze-logs-headless.py [--staging-file FILE] [--production-file FILE] [--output FILE]

Requirements:
    - Claude Code CLI installed and authenticated
    - CSV log files in the current directory
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


def fact_check_with_claude(question: str, response: str) -> dict:
    """
    Use Claude Code to fact-check a bot response against source documents.
    """
    prompt = f'''You are fact-checking a chatbot response for the IIT Madras BS Degree program.

The source documents are in the src/ folder. Read the relevant documents and verify the response.

User Question: "{question}"

Bot Response: "{response[:500]}"

Fact-check this response:
1. Read relevant documents from src/ folder
2. Check if the information in the response is accurate
3. Identify any errors or inaccuracies

Respond in this format:
ACCURACY: [CORRECT/INCORRECT/PARTIALLY_CORRECT]
ISSUES: [List any factual errors, or "None" if correct]
'''

    result = run_claude_code(prompt, timeout=90)

    accuracy = "UNKNOWN"
    issues = []

    if "CORRECT" in result.upper():
        if "PARTIALLY" in result.upper():
            accuracy = "PARTIALLY_CORRECT"
        elif "INCORRECT" in result.upper():
            accuracy = "INCORRECT"
        else:
            accuracy = "CORRECT"

    # Extract issues
    if "ISSUES:" in result:
        issues_text = result.split("ISSUES:")[-1].strip()
        if issues_text.lower() != "none":
            issues = [issues_text]

    return {"accuracy": accuracy, "issues": issues, "raw_response": result}


# ============================================================================
# MAIN ANALYSIS
# ============================================================================

def analyze_file(filename: str, use_llm_classification: bool = False,
                 fact_check_sample: int = 0,
                 after_date: Optional[datetime] = None,
                 before_date: Optional[datetime] = None) -> dict:
    """
    Analyze a single log file.

    Args:
        filename: Path to CSV file
        use_llm_classification: Use Claude for ambiguous queries
        fact_check_sample: Number of responses to fact-check (0 = skip)
        after_date: Only include records after this date
        before_date: Only include records before this date
    """
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
        "llm_classifications": 0,
    }

    rows_to_fact_check = []

    with open(filename, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
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

            # Try auto-classification first
            classification_result = auto_classify_query(question)

            if classification_result is None and use_llm_classification:
                # Use Claude for ambiguous queries
                print(f"  [LLM] Classifying: {question[:50]}...")
                classification_result = classify_with_claude(question)
                results["llm_classifications"] += 1
            elif classification_result is None:
                # Default to valid if not using LLM
                classification_result = ("valid", "default_valid")

            classification, reason = classification_result

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
                    results["valid_cannot_answer_queries"].append({
                        "question": question[:150],
                        "response_snippet": response[:100],
                    })
                else:
                    results["valid_answered"] += 1
                    # Collect for potential fact-checking
                    if len(rows_to_fact_check) < fact_check_sample:
                        rows_to_fact_check.append({"question": question, "response": response})

    # Fact-check sampled responses
    if fact_check_sample > 0 and rows_to_fact_check:
        print(f"\n  Fact-checking {len(rows_to_fact_check)} responses...")
        for i, row in enumerate(rows_to_fact_check):
            print(f"    [{i+1}/{len(rows_to_fact_check)}] {row['question'][:40]}...")
            fact_result = fact_check_with_claude(row['question'], row['response'])
            results["fact_checks"].append({
                "question": row['question'][:100],
                "accuracy": fact_result["accuracy"],
                "issues": fact_result["issues"],
            })

    return results


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

  # With LLM classification and fact-checking
  python3 analyze-logs-headless.py --use-llm --fact-check 5 --on-or-after 2026-01-01
        """
    )
    parser.add_argument("--staging-file", default="staging-logs.csv", help="Path to staging logs CSV")
    parser.add_argument("--production-file", default="production-logs.csv", help="Path to production logs CSV")
    parser.add_argument("--output", default="chatbot-analysis-report-headless.md", help="Output report file")
    parser.add_argument("--use-llm", action="store_true", help="Use Claude for ambiguous query classification")
    parser.add_argument("--fact-check", type=int, default=0, help="Number of responses to fact-check per file")
    parser.add_argument("--on-or-after", type=str, metavar="DATE",
                        help="Only analyze records on or after this date (format: YYYY-MM-DD)")
    parser.add_argument("--on-or-before", type=str, metavar="DATE",
                        help="Only analyze records on or before this date (format: YYYY-MM-DD)")

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

    # Check if files exist
    for f in [args.staging_file, args.production_file]:
        if not Path(f).exists():
            print(f"❌ File not found: {f}")
            sys.exit(1)

    # Analyze staging
    print(f"\n📊 Analyzing {args.staging_file}...")
    staging_results = analyze_file(
        args.staging_file,
        use_llm_classification=args.use_llm,
        fact_check_sample=args.fact_check,
        after_date=after_date,
        before_date=before_date
    )
    if staging_results['filtered_out'] > 0:
        print(f"   Filtered: {staging_results['total']}/{staging_results['total_before_filter']} records (excluded {staging_results['filtered_out']} by date)")
    print(f"   Total: {staging_results['total']}, Valid: {staging_results['valid']}, Invalid: {staging_results['invalid']}")
    print(f"   Answered: {staging_results['valid_answered']}, Cannot answer: {staging_results['valid_cannot_answer']}")

    # Analyze production
    print(f"\n📊 Analyzing {args.production_file}...")
    production_results = analyze_file(
        args.production_file,
        use_llm_classification=args.use_llm,
        fact_check_sample=args.fact_check,
        after_date=after_date,
        before_date=before_date
    )
    if production_results['filtered_out'] > 0:
        print(f"   Filtered: {production_results['total']}/{production_results['total_before_filter']} records (excluded {production_results['filtered_out']} by date)")
    print(f"   Total: {production_results['total']}, Valid: {production_results['valid']}, Invalid: {production_results['invalid']}")
    print(f"   Answered: {production_results['valid_answered']}, Cannot answer: {production_results['valid_cannot_answer']}")

    # Generate report
    print(f"\n📝 Generating report...")
    generate_report(staging_results, production_results, args.output)

    # Save detailed JSON
    json_output = args.output.replace('.md', '.json')
    with open(json_output, 'w') as f:
        json.dump({
            "staging": {k: v if not isinstance(v, defaultdict) else dict(v) for k, v in staging_results.items()},
            "production": {k: v if not isinstance(v, defaultdict) else dict(v) for k, v in production_results.items()},
        }, f, indent=2)
    print(f"✅ Detailed JSON saved to: {json_output}")

    print("\n" + "=" * 60)
    print("ANALYSIS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
