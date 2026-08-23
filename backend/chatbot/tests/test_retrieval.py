"""Retrieval result-envelope tests with synthetic service responses.

Flow: configure one local or GCE request, call the service helper, and assert
that usable items and concise failure causes reach the answer pipeline without
contacting real Weaviate, Ollama, or Postgres services.
"""
from unittest import mock

from django.test import SimpleTestCase

from chatbot.services import embeddings, faq, pipeline, weaviate


class _Response:
    def __init__(self, *, ok=True, status=200, text="{}", payload=None):
        self.ok = ok
        self.status_code = status
        self.text = text
        self._payload = payload or {}

    def json(self):
        return self._payload


class SearchContextIssueTests(SimpleTestCase):
    def test_errors_take_priority_over_empty_causes(self):
        reasons = pipeline.search_context_issues(
            {"items": [], "error": "weaviate_api_error:503"},
            {"items": [], "error": None},
        )
        self.assertEqual(reasons, ["weaviate_api_error:503", "pg_faqs_empty"])

    def test_reports_both_empty_sources(self):
        reasons = pipeline.search_context_issues(
            {"items": [], "error": None},
            {"items": [], "error": None},
        )
        self.assertEqual(reasons, ["weaviate_documents_empty", "pg_faqs_empty"])

    def test_reports_only_the_empty_source_when_documents_exist(self):
        reasons = pipeline.search_context_issues(
            {"items": [{"filename": "fees.md"}], "error": None},
            {"items": [], "error": None},
        )
        self.assertEqual(reasons, ["pg_faqs_empty"])

    def test_no_issues_when_both_sources_have_context(self):
        reasons = pipeline.search_context_issues(
            {"items": [{"filename": "fees.md"}], "error": None},
            {"items": [{"id": 2}], "error": None},
        )
        self.assertEqual(reasons, [])


class FaqResultTests(SimpleTestCase):
    @mock.patch("chatbot.services.faq.search")
    def test_returns_successful_search_results(self, search):
        items = [{"id": 1, "question": "What are the fees?"}]
        search.return_value = items

        self.assertEqual(
            faq.search_result("fees", 5),
            {"items": items, "error": None},
        )

    @mock.patch("chatbot.services.faq.search")
    def test_preserves_embedding_failure(self, search):
        search.side_effect = faq.FaqEmbeddingError("failed")
        self.assertEqual(
            faq.search_result("fees", 5),
            {"items": [], "error": "pg_faq_embedding_error"},
        )

    @mock.patch("chatbot.services.faq.search")
    def test_preserves_database_failure(self, search):
        search.side_effect = faq.FaqDatabaseError("failed")

        self.assertEqual(
            faq.search_result("fees", 5),
            {"items": [], "error": "pg_faq_database_error"},
        )

    @mock.patch("chatbot.services.faq.search")
    def test_reports_unexpected_search_failure(self, search):
        search.side_effect = RuntimeError("unexpected")

        self.assertEqual(
            faq.search_result("fees", 5),
            {"items": [], "error": "pg_faq_search_error"},
        )


class EmbeddingValidationTests(SimpleTestCase):
    @mock.patch("chatbot.services.embeddings.requests.post")
    def test_rejects_empty_embedding(self, post):
        post.return_value = _Response(payload={"embedding": []})

        with self.assertRaisesRegex(RuntimeError, "non-empty array"):
            embeddings.get_ollama_embedding("fees", "http://ollama")

    @mock.patch("chatbot.services.embeddings.requests.post")
    def test_rejects_non_array_embedding(self, post):
        post.return_value = _Response(payload={"embedding": "not an array"})

        with self.assertRaisesRegex(RuntimeError, "non-empty array"):
            embeddings.get_ollama_embedding("fees", "http://ollama")

    @mock.patch("chatbot.services.embeddings.requests.post")
    def test_rejects_non_finite_embedding(self, post):
        post.return_value = _Response(payload={"embedding": [1, float("nan")]})
        with self.assertRaisesRegex(RuntimeError, "non-finite"):
            embeddings.get_ollama_embedding("fees", "http://ollama")


class WeaviateResultTests(SimpleTestCase):
    @mock.patch("chatbot.services.weaviate.appconfig.local_weaviate_url", return_value="http://weaviate")
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="local")
    @mock.patch("chatbot.services.weaviate.requests.post")
    def test_preserves_documents_from_partial_graphql_response(self, post, _mode, _url):
        post.return_value = _Response(
            text=(
                '{"data":{"Get":{"Document":[{"filename":"fees.md",'
                '"_additional":{"score":"0.8"}}]}},'
                '"errors":[{"message":"optional field failed"}]}'
            )
        )

        result = weaviate.search_weaviate("fees", 2)

        self.assertEqual(result["items"][0]["filename"], "fees.md")
        self.assertEqual(result["error"], "weaviate_graphql_error:optional field failed")

    @mock.patch("chatbot.services.weaviate.appconfig.local_weaviate_url", return_value="http://weaviate")
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="local")
    @mock.patch("chatbot.services.weaviate.requests.post")
    def test_reports_malformed_graphql_errors_field(self, post, _mode, _url):
        post.return_value = _Response(text='{"errors":"upstream unavailable"}')

        self.assertEqual(
            weaviate.search_weaviate("fees", 2),
            {"items": [], "error": "weaviate_response_malformed:errors_not_array"},
        )

    @mock.patch("chatbot.services.weaviate.appconfig.local_weaviate_url", return_value="http://weaviate")
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="local")
    @mock.patch("chatbot.services.weaviate.requests.post")
    def test_reports_http_and_malformed_responses(self, post, _mode, _url):
        post.return_value = _Response(ok=False, status=503, text="unavailable")
        self.assertEqual(
            weaviate.search_weaviate("fees", 2),
            {"items": [], "error": "weaviate_api_error:503"},
        )

        post.return_value = _Response(text="not json")
        result = weaviate.search_weaviate("fees", 2)
        self.assertEqual(result["items"], [])
        self.assertTrue(result["error"].startswith("weaviate_response_malformed:"))

    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="invalid")
    def test_reports_unsupported_mode_without_fetching(self, _mode):
        result = weaviate.search_weaviate("fees", 2)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["error"], "weaviate_config_error:unsupported_DEPLOYMENT_MODE_invalid")

    @mock.patch("chatbot.services.weaviate.appconfig.gce_weaviate_url", return_value=None)
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="gce")
    def test_reports_missing_gce_weaviate_url(self, _mode, _url):
        self.assertEqual(
            weaviate.search_weaviate("fees", 2),
            {"items": [], "error": "weaviate_config_error:missing_GCE_WEAVIATE_URL"},
        )

    @mock.patch("chatbot.services.weaviate.appconfig.gce_ollama_url", return_value=None)
    @mock.patch("chatbot.services.weaviate.appconfig.gce_weaviate_url", return_value="http://weaviate")
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="gce")
    def test_reports_missing_gce_ollama_url(self, _mode, _weaviate_url, _ollama_url):
        self.assertEqual(
            weaviate.search_weaviate("fees", 2),
            {"items": [], "error": "weaviate_config_error:missing_GCE_OLLAMA_URL"},
        )

    @mock.patch("chatbot.services.weaviate.get_ollama_embedding")
    @mock.patch("chatbot.services.weaviate.appconfig.gce_ollama_url", return_value="http://ollama")
    @mock.patch("chatbot.services.weaviate.appconfig.gce_weaviate_url", return_value="http://weaviate")
    @mock.patch("chatbot.services.weaviate.appconfig.deployment_mode", return_value="gce")
    def test_reports_gce_embedding_failure(
        self,
        _mode,
        _weaviate_url,
        _ollama_url,
        get_embedding,
    ):
        get_embedding.side_effect = RuntimeError("Ollama unavailable")

        self.assertEqual(
            weaviate.search_weaviate("fees", 2),
            {"items": [], "error": "weaviate_embedding_error:Ollama unavailable"},
        )
