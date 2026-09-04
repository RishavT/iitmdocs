"""Query-rewrite metadata tests with a synthetic chat response.

Flow: submit a query, mock the OpenAI-compatible response, and verify that the
rewritten query and provider token usage are returned to the request pipeline.
"""
from unittest import mock
import asyncio

from django.test import SimpleTestCase

from chatbot.services import rewrite
from chatbot.services import llm


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


class AsyncChatCompletionTests(SimpleTestCase):
    def test_async_chat_completion_sends_the_current_openai_payload(self):
        """A wrong async payload would break every chat call after the migration."""
        response = object()

        class Client:
            async def post(self, endpoint, **kwargs):
                self.endpoint = endpoint
                self.kwargs = kwargs
                return response

        client = Client()
        result = asyncio.run(
            llm.chat_completion_async(
                client,
                [{"role": "user", "content": "fees"}],
                model="gpt-4o-mini",
                temperature=0,
                max_tokens=100,
                timeout=60,
            )
        )

        self.assertIs(result, response)
        self.assertEqual(client.kwargs["json"]["stream"], False)
        self.assertEqual(client.kwargs["json"]["max_tokens"], 100)
        self.assertEqual(client.kwargs["timeout"], 60)

    def test_async_rewrite_returns_llm_query_and_usage(self):
        """The async path must preserve the query format consumed by retrieval."""
        class Response:
            ok = True

            def json(self):
                return {
                    "choices": [{"message": {"content": "fees payment [LANG:english]"}}],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 2},
                }

        class Client:
            async def post(self, *args, **kwargs):
                return Response()

        result = asyncio.run(rewrite.rewrite_query_with_source_async(Client(), "Could tuition be explained"))

        self.assertEqual(result["source"], "llm")
        self.assertEqual(result["tokens"], {"input": 7, "output": 2})
        self.assertTrue(result["query"].endswith("[LANG:english]"))
