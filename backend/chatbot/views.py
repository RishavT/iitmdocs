"""HTTP views.

/answer, /search, /faq/<id> — native async Django views for data-heavy work.
/feedback, /health, /github-config — existing synchronous DRF JSON views.
"""
from __future__ import annotations

import json
from io import BytesIO

from django.conf import settings
from django.http import HttpResponse, JsonResponse, StreamingHttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from programs import DEFAULT_PROGRAM_ID, REAL_PROGRAM_IDS, validate_program_id

from . import appconfig
from .business import enable_history
from .services import faq, pipeline
from .services.http_client import get_async_http_client, get_openai_http_client
from .services.logs import structured_log


_INVALID_PROGRAM_MESSAGE = (
    'Invalid "program_id" parameter. Must be one of: ' + ", ".join(REAL_PROGRAM_IDS)
)


def _bad_request(message: str) -> HttpResponse:
    return HttpResponse(message, status=400, content_type="text/plain; charset=utf-8")


def _sse_response(generator) -> StreamingHttpResponse:
    """Return a streaming HTTP response for chatbot Server-Sent Events.

    `generator` yields already-formatted events while `AnswerView.post`
    processes a question. The returned response sends those events gradually
    to the browser and disables buffering so the user sees each update promptly.
    """
    resp = StreamingHttpResponse(generator, content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"  # disable proxy buffering so events flush promptly
    return resp


def _json_body(request) -> dict:
    try:
        data = json.loads(request.body or b"{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _search_json_body(request):
    """Parse `/search` JSON with the same errors as its former DRF view.

    Example: malformed JSON returns a `400` response, while a non-empty
    `text/plain` body returns `415` before FAQ retrieval starts.
    """
    if not request.body:
        return {}, None

    content_type = request.content_type or None
    if content_type != JSONParser.media_type:
        error = UnsupportedMediaType(content_type)
        return {}, JsonResponse({"detail": str(error.detail)}, status=error.status_code)

    try:
        data = JSONParser().parse(
            BytesIO(request.body),
            parser_context={"encoding": request.encoding or settings.DEFAULT_CHARSET},
        )
    except ParseError as error:
        return {}, JsonResponse({"detail": str(error.detail)}, status=error.status_code)
    return data if isinstance(data, dict) else {}, None


def _valid_question(question) -> bool:
    return isinstance(question, str) and bool(question.strip())


def _read_program_id(value):
    """Return a valid program id, or None if the caller sent an unknown one.

    Missing values fall back to the default programme, which keeps older embeds that
    never sent `program_id` working. Anything else is a client mistake, so the caller
    turns None into an error response rather than silently answering as DS.

    Example: _read_program_id("ES") -> "es"; _read_program_id("xx") -> None.
    """
    try:
        return validate_program_id(value)
    except ValueError:
        return None


def _parse_faq_id(faq_id):
    """Return a positive FAQ id integer or None when the request did not send one.

    Example: ``_parse_faq_id("42")`` returns ``42``. ``_parse_faq_id("bad")``
    raises ``ValueError`` so the HTTP layer can reject the request before SSE
    processing starts.
    """
    if faq_id is None:
        return None

    if isinstance(faq_id, bool):
        raise ValueError("faq_id must be numeric")

    if isinstance(faq_id, int):
        parsed = faq_id
    elif isinstance(faq_id, str) and faq_id.isdigit():
        parsed = int(faq_id)
    else:
        raise ValueError("faq_id must be numeric")

    if parsed < 1:
        raise ValueError("faq_id must be positive")

    return parsed


@method_decorator(csrf_exempt, name="dispatch")
class AnswerView(View):
    """Handle the main chatbot question endpoint.

    Flow: read the JSON body, validate `q`, `faq_id`, and `ndocs`, choose
    either a direct FAQ lookup or the normal answer pipeline, and return a
    `text/event-stream` response. The pipeline performs rewriting, retrieval,
    answer generation, and fact-checking while this view stays focused on HTTP.

    Example: `POST /answer` with `{"q": "How are grades calculated?"}`
    returns events that the browser can display as the answer is produced.

    ASSUMPTION: conversation history is currently disabled by default. While it
    is disabled, malformed `history` input is ignored instead of rejected.
    """

    async def post(self, request):
        body = _json_body(request)
        question = body.get("q")
        session_id = body.get("session_id")
        username = body.get("username")
        message_id = body.get("message_id")
        faq_id = body.get("faq_id")
        raw_history = body.get("history", [])

        if not _valid_question(question):
            return _bad_request('Invalid "q" parameter. Must be a non-empty string')

        program_id = _read_program_id(body.get("program_id"))
        if program_id is None:
            return _bad_request(_INVALID_PROGRAM_MESSAGE)

        # Direct FAQ lookup by id — skip the whole pipeline.
        try:
            parsed_faq_id = _parse_faq_id(faq_id)
        except ValueError:
            return _bad_request('Invalid "faq_id" parameter. Must be a positive integer')

        if parsed_faq_id is not None:
            return _sse_response(
                pipeline.direct_faq_events_async(
                    parsed_faq_id,
                    question,
                    session_id,
                    message_id,
                    username,
                    program_id,
                )
            )

        # Validate ndocs (1..20, default 2).
        ndocs = body.get("ndocs", 2)
        try:
            num_docs = int(ndocs)
            valid = 1 <= num_docs <= 20
        except (TypeError, ValueError):
            valid = False
        if not valid:
            return _bad_request('Invalid "ndocs" parameter. Must be between 1 and 20')

        history = raw_history if enable_history() else []
        return _sse_response(
            pipeline.answer_events_async(
                get_async_http_client(),
                get_openai_http_client(),
                question,
                num_docs,
                history,
                session_id,
                message_id,
                username,
                program_id,
            )
        )


class FeedbackView(APIView):
    """Receive and record feedback about a chatbot response.

    Flow: read the JSON fields, validate the required identifiers and allowed
    feedback values, trim optional feedback text, write a structured log, and
    return a small JSON success response. This view records feedback; it does
    not change the generated answer or store feedback in a database.

    Example: `POST /feedback` with `feedback_type="up"` returns
    `{"success": true}` when the required identifiers are present.
    """

    VALID_FEEDBACK_TYPES = ("up", "down", "report")
    VALID_CATEGORIES = ("wrong_info", "outdated", "unhelpful", "other")

    def post(self, request):
        try:
            body = request.data if isinstance(request.data, dict) else {}
            session_id = body.get("session_id")
            message_id = body.get("message_id")
            question = body.get("question")
            response_text = body.get("response")
            feedback_type = body.get("feedback_type")

            if not session_id or not message_id or not feedback_type:
                return Response({"error": "Missing required fields"}, status=400)

            if feedback_type not in self.VALID_FEEDBACK_TYPES:
                return Response({"error": "Invalid feedback type"}, status=400)

            program_id = _read_program_id(body.get("program_id"))
            if program_id is None:
                return Response({"error": "Invalid program_id"}, status=400)

            feedback_category = body.get("feedback_category")
            if feedback_category and feedback_category not in self.VALID_CATEGORIES:
                return Response({"error": "Invalid feedback category"}, status=400)

            feedback_text = body.get("feedback_text")
            if isinstance(feedback_text, str) and feedback_text.strip():
                trimmed = feedback_text.strip()[:1000]
            else:
                trimmed = None

            structured_log(
                "INFO",
                "user_feedback",
                session_id=session_id,
                message_id=message_id,
                program_id=program_id,
                question=question or None,
                response=response_text or None,
                feedback_type=feedback_type,
                feedback_category=feedback_category or None,
                feedback_text=trimmed,
            )
            return Response({"success": True}, status=200)
        except Exception:  # noqa: BLE001
            return Response({"error": "Failed to process feedback"}, status=500)


@method_decorator(csrf_exempt, name="dispatch")
class SearchView(View):
    """Search the FAQ database for questions similar to a user query.

    Flow: read `q` and `k`, validate their values, call the FAQ search
    service for embeddings and PostgreSQL lookup, map service failures to HTTP
    status codes, and return matching FAQ rows as JSON. This endpoint preserves
    the old FastAPI FAQ API contract for callers that need search results
    directly.

    Example: `POST /search` with `{"q": "grading", "k": 5}` returns up
    to five FAQ results.
    """

    async def post(self, request):
        body, parse_error = _search_json_body(request)
        if parse_error is not None:
            return parse_error
        q = body.get("q")
        k = body.get("k", 5)

        program_id = _read_program_id(body.get("program_id"))
        if program_id is None:
            return JsonResponse({"detail": _INVALID_PROGRAM_MESSAGE}, status=422)

        if not isinstance(q, str) or len(q) < 1:
            return JsonResponse({"detail": "q must be a non-empty string"}, status=422)
        try:
            k = int(k)
        except (TypeError, ValueError):
            return JsonResponse({"detail": "k must be an integer"}, status=422)
        if k < 1 or k > 20:
            return JsonResponse({"detail": "k must be between 1 and 20"}, status=422)

        try:
            results = await faq.search_async(get_async_http_client(), q, k, program_id)
        except faq.FaqEmbeddingError:
            return JsonResponse({"detail": "Embedding service failed"}, status=502)
        except faq.FaqDatabaseError:
            return JsonResponse({"detail": "Internal error"}, status=500)

        return JsonResponse({"results": results}, status=200)


class FaqDetailView(View):
    """Return one FAQ by its database id.

    Flow: receive `faq_id` from the URL, ask the FAQ service for the matching
    row, return the row as JSON, or return `404` when the id does not exist.
    This supports direct FAQ click-through from suggestions and preserves the
    old FAQ API behavior.

    Example: `GET /faq/42?program_id=es` returns FAQ 42 if it belongs to `es` or to
    the shared `common` pool, and 404 otherwise.
    """

    async def get(self, request, faq_id):
        program_id = _read_program_id(request.GET.get("program_id"))
        if program_id is None:
            return JsonResponse({"detail": _INVALID_PROGRAM_MESSAGE}, status=400)
        try:
            row = await faq.get_faq_async(faq_id, program_id)
        except faq.FaqDatabaseError:
            return JsonResponse({"detail": "Internal error"}, status=500)
        if not row:
            return JsonResponse({"detail": "FAQ not found"}, status=404)
        return JsonResponse(row, status=200)


class HealthView(APIView):
    """Confirm that Django and its required FAQ configuration are ready.

    Flow: receive ``GET /health``, validate the same configuration checked at
    startup, return ``{"ok": true}`` when valid, or return a sanitized 503
    response when invalid. This check does not make network calls to Weaviate,
    Ollama, or PostgreSQL.
    """

    def get(self, request):
        try:
            appconfig.validate_required_configuration()
        except RuntimeError:
            return Response(
                {"ok": False, "error": "Invalid service configuration"},
                status=503,
            )
        return Response({"ok": True})


class GithubConfigView(APIView):
    """Expose browser-safe config: the branch base URL and the programme list.

    Flow: the QA page requests this endpoint at startup. It uses the URL for the
    program-contact reference link, and the programme list to validate the
    `program_id` in its own URL. Serving the list from here means the four
    programme ids are defined once, in programs.py, instead of also in JavaScript.

    Example: ``GET /github-config`` returns
    ``{"githubBranchBaseUrl": "...", "programs": ["ds", "es", "mg", "ae"],
    "defaultProgramId": "ds"}``.
    """

    def get(self, request):
        return Response(
            {
                "githubBranchBaseUrl": appconfig.github_branch_base_url(),
                "programs": list(REAL_PROGRAM_IDS),
                "defaultProgramId": DEFAULT_PROGRAM_ID,
            }
        )
