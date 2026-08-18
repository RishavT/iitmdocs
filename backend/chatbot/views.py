"""HTTP views.

/answer  — plain Django View: raw SSE stream (DRF content-negotiation would reject
           text/event-stream), CSRF-free like the Worker.
/feedback, /search, /faq/<id>, /health — DRF APIViews (token-free JSON APIs).
"""
from __future__ import annotations

import json

from django.http import HttpResponse, JsonResponse, StreamingHttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from rest_framework.response import Response
from rest_framework.views import APIView

from .business import enable_history
from .services import faq, pipeline
from .services.logs import structured_log


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


@method_decorator(csrf_exempt, name="dispatch")
class AnswerView(View):
    """Handle the main chatbot question endpoint.

    Flow: read the JSON body, validate `q` and `ndocs`, choose either a
    direct FAQ lookup or the normal answer pipeline, and return a
    `text/event-stream` response. The pipeline performs rewriting, retrieval,
    answer generation, and fact-checking while this view stays focused on HTTP.

    Example: `POST /answer` with `{"q": "How are grades calculated?"}`
    returns events that the browser can display as the answer is produced.
    """

    def post(self, request):
        body = _json_body(request)
        question = body.get("q")
        session_id = body.get("session_id")
        username = body.get("username")
        message_id = body.get("message_id")
        faq_id = body.get("faq_id")
        raw_history = body.get("history", [])

        if not question:
            return HttpResponse('Missing "q" parameter', status=400, content_type="text/plain; charset=utf-8")

        # Direct FAQ lookup by id — skip the whole pipeline.
        if faq_id:
            return _sse_response(
                pipeline.direct_faq_events(faq_id, question, session_id, message_id, username)
            )

        # Validate ndocs (1..20, default 2).
        ndocs = body.get("ndocs", 2)
        try:
            num_docs = int(ndocs)
            valid = 1 <= num_docs <= 20
        except (TypeError, ValueError):
            valid = False
        if not valid:
            return HttpResponse(
                'Invalid "ndocs" parameter. Must be between 1 and 20',
                status=400,
                content_type="text/plain; charset=utf-8",
            )

        history = raw_history if enable_history() else []
        return _sse_response(
            pipeline.answer_events(question, num_docs, history, session_id, message_id, username)
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
                question=question or None,
                response=response_text or None,
                feedback_type=feedback_type,
                feedback_category=feedback_category or None,
                feedback_text=trimmed,
            )
            return Response({"success": True}, status=200)
        except Exception:  # noqa: BLE001
            return Response({"error": "Failed to process feedback"}, status=500)


class SearchView(APIView):
    """Search the FAQ database for questions similar to a user query.

    Flow: read `q` and `k`, validate their values, call the FAQ search
    service for embeddings and PostgreSQL lookup, map service failures to HTTP
    status codes, and return matching FAQ rows as JSON. This endpoint preserves
    the old FastAPI FAQ API contract for callers that need search results
    directly.

    Example: `POST /search` with `{"q": "grading", "k": 5}` returns up
    to five FAQ results.
    """

    def post(self, request):
        body = request.data if isinstance(request.data, dict) else {}
        q = body.get("q")
        k = body.get("k", 5)

        if not isinstance(q, str) or len(q) < 1:
            return Response({"detail": "q must be a non-empty string"}, status=422)
        try:
            k = int(k)
        except (TypeError, ValueError):
            return Response({"detail": "k must be an integer"}, status=422)
        if k < 1 or k > 20:
            return Response({"detail": "k must be between 1 and 20"}, status=422)

        try:
            results = faq.search(q, k)
        except faq.FaqTooManyConcurrent:
            return Response({"detail": "Too many concurrent searches"}, status=429)
        except faq.FaqEmbeddingError:
            return Response({"detail": "Embedding service failed"}, status=502)
        except faq.FaqDatabaseError:
            return Response({"detail": "Internal error"}, status=500)

        return Response({"results": results}, status=200)


class FaqDetailView(APIView):
    """Return one FAQ by its database id.

    Flow: receive `faq_id` from the URL, ask the FAQ service for the matching
    row, return the row as JSON, or return `404` when the id does not exist.
    This supports direct FAQ click-through from suggestions and preserves the
    old FAQ API behavior.

    Example: `GET /faq/42` returns the FAQ with id `42` if it exists.
    """

    def get(self, request, faq_id):
        try:
            row = faq.get_faq(faq_id)
        except faq.FaqDatabaseError:
            return Response({"detail": "Internal error"}, status=500)
        if not row:
            return Response({"detail": "FAQ not found"}, status=404)
        return Response(row, status=200)


class HealthView(APIView):
    """Confirm that the Django HTTP application is responding.

    Flow: receive `GET /health` and return `{"ok": true}`. This is a
    lightweight liveness check for deployment or monitoring systems; it does
    not verify that Weaviate, Ollama, or PostgreSQL are healthy.
    """

    def get(self, request):
        return Response({"ok": True})
