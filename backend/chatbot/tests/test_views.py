"""View tests via the Django test client (no network/DB for these paths)."""
import json

from django.test import Client, SimpleTestCase


class FeedbackViewTests(SimpleTestCase):
    def setUp(self):
        self.client = Client()

    def _post(self, payload):
        return self.client.post("/feedback", data=json.dumps(payload), content_type="application/json")

    def test_missing_required_fields(self):
        r = self._post({"session_id": "s"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"error": "Missing required fields"})

    def test_invalid_feedback_type(self):
        r = self._post({"session_id": "s", "message_id": "m", "feedback_type": "sideways"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"error": "Invalid feedback type"})

    def test_invalid_category(self):
        r = self._post({"session_id": "s", "message_id": "m", "feedback_type": "up", "feedback_category": "nope"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"error": "Invalid feedback category"})

    def test_success(self):
        r = self._post({"session_id": "s", "message_id": "m", "feedback_type": "up", "feedback_text": "great"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"success": True})


class AnswerViewValidationTests(SimpleTestCase):
    def setUp(self):
        self.client = Client()

    def test_missing_q(self):
        r = self.client.post("/answer", data=json.dumps({}), content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Missing", r.content.decode())

    def test_invalid_ndocs(self):
        r = self.client.post("/answer", data=json.dumps({"q": "hi", "ndocs": 99}), content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("ndocs", r.content.decode())


class HealthViewTests(SimpleTestCase):
    def test_health(self):
        r = Client().get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True})


class GithubConfigViewTests(SimpleTestCase):
    def test_returns_default_branch_url(self):
        r = Client().get("/github-config")

        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {
                "githubBranchBaseUrl": (
                    "https://github.com/iitmbsc-student-projects/iitmdocs/blob/main/"
                )
            },
        )
