"""Query-rewrite metadata tests with a synthetic chat response.

Flow: submit a query, mock the OpenAI-compatible response, and verify that the
rewritten query and provider token usage are returned to the request pipeline.
"""
from unittest import mock

from django.test import SimpleTestCase

from chatbot.services import rewrite


class _Response:
    ok = True

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class RewriteMetadataTests(SimpleTestCase):
    @mock.patch("chatbot.services.rewrite.chat_completion")
    def test_llm_rewrite_returns_usage(self, completion):
        completion.return_value = _Response(
            {
                "choices": [{"message": {"content": "fees payment [LANG:english]"}}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 2},
            }
        )

        result = rewrite.rewrite_query_with_source("Could tuition be explained")

        self.assertEqual(result["source"], "llm")
        self.assertEqual(result["tokens"], {"input": 7, "output": 2})

    @mock.patch("chatbot.services.rewrite.chat_completion")
    def test_synonym_rewrite_has_no_provider_usage(self, completion):
        result = rewrite.rewrite_query_with_source("What is the grading policy?")

        self.assertEqual(result["source"], "synonym")
        self.assertIsNone(result["tokens"])
        completion.assert_not_called()
