"""DRF serializers — the well-defined request/response schemas (analog of the
former FastAPI pydantic models). /answer and /feedback preserve exact legacy
response bytes in the views; /search and /faq use these for validation/shape.
"""
from __future__ import annotations

from rest_framework import serializers


class HistoryMessageSerializer(serializers.Serializer):
    """Validate one earlier message from the chatbot conversation history.

    The chatbot uses the role to distinguish the user from the assistant and
    uses the content as the text of that earlier message.
    """

    role = serializers.ChoiceField(choices=["user", "assistant"])
    content = serializers.CharField()


class AnswerRequestSerializer(serializers.Serializer):
    """Validate data sent to the main chatbot answer endpoint.

    It defines the question, optional conversation details, the number of
    documents to retrieve, and an optional FAQ id for direct FAQ answers.
    """

    q = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    ndocs = serializers.IntegerField(required=False, default=2)
    history = serializers.ListField(required=False, default=list)
    session_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    message_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    username = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    faq_id = serializers.IntegerField(required=False, allow_null=True)


class FeedbackRequestSerializer(serializers.Serializer):
    """Validate feedback submitted about an answer from the chatbot.

    It checks the feedback type and category, while carrying the identifiers
    and optional explanation needed to record the feedback.
    """

    session_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    message_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    question = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    response = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    feedback_type = serializers.ChoiceField(choices=["up", "down", "report"], required=False)
    feedback_category = serializers.ChoiceField(
        choices=["wrong_info", "outdated", "unhelpful", "other"], required=False, allow_null=True
    )
    feedback_text = serializers.CharField(required=False, allow_blank=True, allow_null=True)


class SearchRequestSerializer(serializers.Serializer):
    """Validate a request to search the FAQ database.

    It checks the search question and limits how many FAQ results can be
    requested at one time.
    """

    q = serializers.CharField(min_length=1)
    k = serializers.IntegerField(default=5, min_value=1, max_value=20)


class SearchResultSerializer(serializers.Serializer):
    """Describe one FAQ result returned by the search service.

    It keeps each result consistent by defining its id, question, answer, and
    similarity score.
    """

    id = serializers.IntegerField()
    question = serializers.CharField()
    answer = serializers.CharField()
    cosine_similarity = serializers.FloatField()


class SearchResponseSerializer(serializers.Serializer):
    """Describe the complete response returned by FAQ search.

    The response contains a list of results, with every result following the
    structure defined by SearchResultSerializer.
    """

    results = SearchResultSerializer(many=True)
