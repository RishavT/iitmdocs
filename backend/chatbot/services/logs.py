"""
`structured_log` and `log_error` are the app's central observability tools. They help developers and operators understand what happened during each chatbot request.

`structured_log` records normal application events as one JSON line:

structured_log(
    "INFO",
    "conversation_turn",
    session_id=session_id,
    question=question,
)

It adds:

- severity, such as `INFO` or `ERROR`
- event name in `message`
- UTC timestamp
- useful context, such as session ID, question, answer, and retrieved FAQs
- application labels

This is important because Cloud Run/Google Cloud Logging can automatically parse the JSON and BigQuery can find events using:

```
message == "conversation_turn"
```

So it supports debugging, analytics, and monitoring.

`log_error` is a specialized helper for failures:

```
log_error("Answer generation failed", exc, session_id=session_id)
```

It records:

- the error message
- the full stack trace
- extra context
- an error label

Internally, it delegates to `structured_log` with `ERROR` severity.

The mental model is:

```
structured_log = record a structured event
log_error      = record a structured failure with traceback
```

They do not affect the chatbot's answer. They create a reliable record of what happened behind the scenes.

---

`conversation_turn` is the event name for one complete chatbot interaction:

```text
user asks a question
→ chatbot processes it
→ chatbot produces an answer
```

The log stores information such as the question, answer, session ID, retrieved FAQs, fact-check result, and rejection reason.

It is used consistently because the BigQuery logging setup filters on:

```text
message == "conversation_turn"
```

Other message values currently used are:

- `user_feedback` — feedback submitted by a user.
- Error-specific messages passed to `log_error`, such as `"Answer generation failed"`.

The `severity` is separate and can be:

- `"INFO"` — normal event.
- `"ERROR"` — failure or error.

So:

```python
structured_log("INFO", "conversation_turn", ...)
```

means “record a normal chatbot interaction,” while:

```python
log_error("Answer generation failed", error, ...)
```

means “record an error related to answer generation.”

"""
from __future__ import annotations

import datetime
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import json
import os
import sys
import time
import traceback


# Async tasks inherit this value; each request restores its previous context.
_conversation_id = ContextVar("duration_conversation_id", default=None)


@contextmanager
def duration_context(conversation_id):
    """Associate service waits with a conversation, then restore prior context.

    Use around awaits, never across an SSE yield: a generator may be closed
    from another task. Example: ``with duration_context("synthetic-id"): ...``.
    """
    token = _conversation_id.set(conversation_id)
    try:
        yield
    finally:
        _conversation_id.reset(token)


@contextmanager
def measure_duration(operation, **metadata):
    """Time one operation even if it fails; yield a dict for safe metadata.

    Example: ``with measure_duration("pg_faq_search"): await search()``.
    Exceptions and cancellation propagate unchanged to the existing callers.
    """
    start = time.monotonic()
    try:
        yield metadata
    except asyncio.CancelledError:
        metadata["outcome"] = "cancelled"
        raise
    except Exception:
        metadata["outcome"] = "exception"
        raise
    finally:
        log_duration(operation, int((time.monotonic() - start) * 1000), **metadata)


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


def log_duration(operation, duration_ms, **metadata):
    """Log one operation's elapsed milliseconds when duration logs are enabled.

    ASSUMPTION: duration logs stay on unless ``ENABLE_DURATION_LOGS`` is exactly
    ``false``, matching the Worker behavior on main.

    Example: ``log_duration("pg_faq_search", 125)`` emits one DEBUG event.
    """
    if os.getenv("ENABLE_DURATION_LOGS") == "false":
        return

    conversation_id = _conversation_id.get()
    if conversation_id is not None:
        metadata["conversation_id"] = conversation_id

    structured_log(
        "DEBUG",
        "duration",
        operation=operation,
        duration_ms=duration_ms,
        **metadata,
        labels={"type": "duration"},
    )


def log_error(message: str, error, **context) -> None:
    stack = None
    if isinstance(error, BaseException):
        stack = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    err = {
        "message": getattr(error, "message", None) or str(error),
        "stack": stack,
    }
    structured_log("ERROR", message, error=err, **context, labels={"type": "error"})
