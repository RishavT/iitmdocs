"""Django app startup flow.

Django loads the chatbot app -> ``ready`` validates required FAQ settings ->
Gunicorn serves requests only when that configuration is usable.
"""
from django.apps import AppConfig

from .appconfig import validate_required_configuration


class ChatbotConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "chatbot"

    def ready(self):
        """Validate required runtime settings before accepting requests."""
        validate_required_configuration()
