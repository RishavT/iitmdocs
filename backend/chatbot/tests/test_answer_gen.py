"""generate_answer / check_response tests (chat_completion mocked)."""
from unittest import mock

from django.test import SimpleTestCase

from chatbot.services import answer as answer_mod


class _FakeResp:
    def __init__(self, ok=True, payload=None, status=200):
        self.ok = ok
        self._payload = payload or {}
        self.status_code = status
        self.reason = "OK"

    def json(self):
        return self._payload


def _chat(content):
    return {"choices": [{"message": {"content": content}}]}


class GenerateAnswerTests(SimpleTestCase):
    @mock.patch("chatbot.services.answer.chat_completion")
    def test_valid_answer_passes(self, m_chat):
        m_chat.side_effect = [
            _FakeResp(payload=_chat("The fee is 32000")),
            _FakeResp(payload=_chat('{"approved":"YES","incorrect":[]}')),
        ]
        result = answer_mod.generate_answer(
            "q", [{"filename": "f.md", "content": "c", "relevance": 0.9}], [], [], "english"
        )
        self.assertEqual(result["final_answer"], "The fee is 32000")
        self.assertFalse(result["rejected"])
        self.assertTrue(result["fact_check_passed"])
        self.assertIsNone(result["rejection_reason"])

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_failed_factcheck_falls_back_with_suggestions(self, m_chat):
        m_chat.side_effect = [
            _FakeResp(payload=_chat("A hallucinated answer")),
            _FakeResp(payload=_chat('{"approved":"NO","incorrect":["made up"]}')),
        ]
        result = answer_mod.generate_answer(
            "q", [], [{"id": 1, "question": "Q1", "answer": "A1", "cosine_similarity": 0.5}], [], "english"
        )
        self.assertIn("don't have the information", result["final_answer"])
        self.assertIn("[FAQID:1]", result["final_answer"])
        self.assertTrue(result["rejected"])
        self.assertFalse(result["fact_check_passed"])
        self.assertEqual(result["rejection_reason"], "fact_check_failed")

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_chat_api_error_raises(self, m_chat):
        m_chat.return_value = _FakeResp(ok=False, status=500)
        with self.assertRaises(RuntimeError):
            answer_mod.generate_answer("q", [], [], [], "english")


class RelevanceCoercionTests(SimpleTestCase):
    """Regression: Weaviate returns _additional.score as a STRING; the relevance
    filter must coerce it (worker.js relied on JS string->number coercion)."""

    def test_relevance_helper(self):
        self.assertEqual(answer_mod._relevance({"relevance": "0.64"}), 0.64)
        self.assertEqual(answer_mod._relevance({"relevance": "1"}), 1.0)
        self.assertEqual(answer_mod._relevance({"relevance": 0}), 0.0)
        self.assertEqual(answer_mod._relevance({"relevance": None}), 0.0)
        self.assertEqual(answer_mod._relevance({}), 0.0)

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_string_relevance_filters_without_error(self, m_chat):
        m_chat.side_effect = [
            _FakeResp(payload=_chat("answer")),
            _FakeResp(payload=_chat('{"approved":"YES","incorrect":[]}')),
        ]
        docs = [
            {"filename": "high.md", "content": "HIGHDOC", "relevance": "1"},
            {"filename": "low.md", "content": "LOWDOC", "relevance": "0.01"},
        ]
        result = answer_mod.generate_answer("q", docs, [], [], "english")  # must not raise TypeError
        self.assertEqual(result["final_answer"], "answer")
        context_msg = m_chat.call_args_list[0].args[0][1]["content"]
        self.assertIn("HIGHDOC", context_msg)  # "1" > 0.05 -> kept
        self.assertNotIn("LOWDOC", context_msg)  # "0.01" < 0.05 -> dropped


class CheckResponseTests(SimpleTestCase):
    @mock.patch("chatbot.services.answer.chat_completion")
    def test_approved_yes(self, m_chat):
        m_chat.return_value = _FakeResp(payload=_chat('{"approved":"YES","incorrect":[]}'))
        self.assertTrue(answer_mod.check_response("resp", "ctx", []))

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_rejected_no(self, m_chat):
        m_chat.return_value = _FakeResp(payload=_chat('{"approved":"NO","incorrect":["x"]}'))
        self.assertFalse(answer_mod.check_response("resp", "ctx", []))

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_fails_open_on_api_error(self, m_chat):
        m_chat.return_value = _FakeResp(ok=False, status=500)
        self.assertTrue(answer_mod.check_response("resp", "ctx", []))

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_fails_open_on_exception(self, m_chat):
        m_chat.side_effect = RuntimeError("network")
        self.assertTrue(answer_mod.check_response("resp", "ctx", []))

    @mock.patch("chatbot.services.answer.chat_completion")
    def test_malformed_json_strict_yes_fallback(self, m_chat):
        m_chat.return_value = _FakeResp(payload=_chat("YES"))
        self.assertTrue(answer_mod.check_response("resp", "ctx", []))
