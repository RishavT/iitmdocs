"""DRF serializers — the well-defined request/response schemas (analog of the
former FastAPI pydantic models). /answer and /feedback preserve exact legacy
response bytes in the views; /search and /faq use these for validation/shape.
"""
from __future__ import annotations

from rest_framework import serializers


class HistoryMessageSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=["user", "assistant"])
    content = serializers.CharField()


class AnswerRequestSerializer(serializers.Serializer):
    q = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    ndocs = serializers.IntegerField(required=False, default=2)
    history = serializers.ListField(required=False, default=list)
    session_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    message_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    username = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    faq_id = serializers.IntegerField(required=False, allow_null=True)


class FeedbackRequestSerializer(serializers.Serializer):
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
    q = serializers.CharField(min_length=1)
    k = serializers.IntegerField(default=5, min_value=1, max_value=20)


class SearchResultSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    question = serializers.CharField()
    answer = serializers.CharField()
    cosine_similarity = serializers.FloatField()


class SearchResponseSerializer(serializers.Serializer):
    results = SearchResultSerializer(many=True)
