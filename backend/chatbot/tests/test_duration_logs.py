"""Duration log tests using synthetic elapsed times only.

Flow: call the central helper with logging on or off, then confirm the same
structured DEBUG event shape used by main. No external service is contacted.
"""
from unittest import mock

from django.test import SimpleTestCase

from chatbot.services import logs


class DurationLogTests(SimpleTestCase):
    @mock.patch.dict("os.environ", {}, clear=True)
    @mock.patch("chatbot.services.logs.structured_log")
    def test_enabled_by_default(self, structured_log):
        logs.log_duration("pg_faq_search", 125)

        structured_log.assert_called_once_with(
            "DEBUG",
            "duration",
            operation="pg_faq_search",
            duration_ms=125,
            labels={"type": "duration"},
        )

    @mock.patch.dict("os.environ", {"ENABLE_DURATION_LOGS": "false"}, clear=True)
    @mock.patch("chatbot.services.logs.structured_log")
    def test_exact_false_disables_logging(self, structured_log):
        logs.log_duration("pg_faq_search", 125)

        structured_log.assert_not_called()
