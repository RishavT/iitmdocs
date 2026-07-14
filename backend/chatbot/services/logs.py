"""Structured JSON logging — port of worker.js structuredLog/logError.

Emits one JSON line per event to stdout. Cloud Run/Logging parses it; the BigQuery
sink filters on message == "conversation_turn" | "user_feedback", so that field and
the JSON shape must stay stable.
"""
from __future__ import annotations

import datetime
import json
import sys
import traceback


def _now_iso() -> str:
    # Mirror JS `new Date().toISOString()` -> "...Z" with millisecond precision.
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def structured_log(severity: str, message: str, **data) -> None:
    labels = data.pop("labels", None) or {}
    entry = {
        "severity": severity,
        "message": message,
        "timestamp": _now_iso(),
        **data,
        "logging.googleapis.com/labels": {"application": "iitm-chatbot", **labels},
    }
    # Compact separators to match the Worker's JSON.stringify output byte-for-byte.
    sys.stdout.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log_error(message: str, error, **context) -> None:
    stack = None
    if isinstance(error, BaseException):
        stack = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    err = {
        "message": getattr(error, "message", None) or str(error),
        "stack": stack,
    }
    structured_log("ERROR", message, error=err, **context, labels={"type": "error"})
