"""Duration log tests using synthetic elapsed times only.

Flow: call the central helper with logging on or off, then confirm the same
structured DEBUG event shape used by main. No external service is contacted.
"""
from unittest import mock
import asyncio

from django.test import SimpleTestCase

from chatbot.services import logs


class DurationLogTests(SimpleTestCase):
    @mock.patch.dict("os.environ", {"ENABLE_DURATION_LOGS": "true"})
    @mock.patch("chatbot.services.logs.structured_log")
    async def test_concurrent_contexts_are_isolated_and_reset(self, emit):
        async def operation(identity):
            with logs.duration_context(identity):
                await asyncio.sleep(0)
                with logs.measure_duration("test"):
                    await asyncio.sleep(0)
        await asyncio.gather(operation("first"), operation("second"))
        self.assertEqual(
            {call.kwargs["conversation_id"] for call in emit.call_args_list},
            {"first", "second"},
        )
        logs.log_duration("outside", 1)
        self.assertNotIn("conversation_id", emit.call_args.kwargs)

    @mock.patch.dict("os.environ", {"ENABLE_DURATION_LOGS": "true"})
    @mock.patch("chatbot.services.logs.structured_log")
    def test_failure_is_timed_and_context_reset(self, emit):
        with self.assertRaises(ValueError):
            with logs.duration_context("failed"):
                with logs.measure_duration("test"):
                    raise ValueError("private")
        self.assertEqual(emit.call_args.kwargs["outcome"], "exception")
        self.assertEqual(emit.call_args.kwargs["conversation_id"], "failed")
        logs.log_duration("outside", 1)
        self.assertNotIn("conversation_id", emit.call_args.kwargs)

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
