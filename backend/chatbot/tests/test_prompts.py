"""Tests for instructions given to the answer-generating model."""

from django.test import SimpleTestCase

from chatbot.prompts import build_answer_system_prompt


class AnswerSystemPromptTests(SimpleTestCase):
    def test_english_is_explicitly_required(self):
        prompt = build_answer_system_prompt("english", "August 23, 2026")

        self.assertIn("Always respond in English.", prompt)

    def test_selected_non_english_language_is_explicitly_required(self):
        prompt = build_answer_system_prompt("hinglish", "August 23, 2026")

        self.assertIn("Always respond in hinglish.", prompt)
