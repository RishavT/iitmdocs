"""Required configuration tests with synthetic environment values.

Flow: set an isolated environment -> validate the startup configuration ->
confirm valid settings pass and invalid settings stop startup. No database or
network service is contacted.
"""
import os
from unittest import mock

from django.test import SimpleTestCase

from chatbot import appconfig


VALID_FAQ_ENV = {
    "PGHOST": "postgres.test",
    "PGDATABASE": "faq_test",
    "PGUSER": "faq_user",
    "PGPASSWORD": "synthetic-password",
    "PGPORT": "5432",
    "EMBEDDING_DIMENSION": "1024",
}


class RequiredConfigurationTests(SimpleTestCase):
    @mock.patch.dict("os.environ", VALID_FAQ_ENV, clear=True)
    def test_valid_configuration_passes(self):
        appconfig.validate_required_configuration()

    @mock.patch.dict("os.environ", VALID_FAQ_ENV, clear=True)
    def test_missing_postgres_setting_fails(self):
        del os.environ["PGHOST"]

        with self.assertRaisesRegex(RuntimeError, "Missing required Postgres env vars: PGHOST"):
            appconfig.validate_required_configuration()

    @mock.patch.dict("os.environ", VALID_FAQ_ENV, clear=True)
    def test_invalid_postgres_port_fails(self):
        os.environ["PGPORT"] = "not-a-port"

        with self.assertRaisesRegex(RuntimeError, "invalid literal"):
            appconfig.validate_required_configuration()

    @mock.patch.dict("os.environ", VALID_FAQ_ENV, clear=True)
    def test_invalid_embedding_dimension_fails(self):
        os.environ["EMBEDDING_DIMENSION"] = "not-a-number"

        with self.assertRaisesRegex(RuntimeError, "EMBEDDING_DIMENSION must be an integer"):
            appconfig.validate_required_configuration()
