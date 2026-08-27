"""
Django settings for the IITM BS chatbot backend.

This service replaces the Cloudflare Worker (worker.js) and the FastAPI PG FAQ API.
It is an API + static-hosting service: no Django ORM models, no auth tables, no
sessions. FAQ data is read through the reused SQLAlchemy layer in pg/faq_api, so
Django itself needs no database connection (dummy backend).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Optionally load a local .env when running outside Docker (`manage.py runserver`).
try:
    from dotenv import load_dotenv

    _repo_root_env = Path(__file__).resolve().parent.parent.parent / ".env"
    if _repo_root_env.exists():
        load_dotenv(_repo_root_env)
except Exception:  # pragma: no cover - dotenv is optional at runtime
    pass

BASE_DIR = Path(__file__).resolve().parent.parent          # .../backend
REPO_ROOT = BASE_DIR.parent                                 # repo root (has pg/, static/, src/)

# Make `pg.faq_api.*` importable (shared FAQ data layer, also used by embed.py).
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-insecure-key-change-in-prod")
DEBUG = _bool_env("DJANGO_DEBUG", False)
ALLOWED_HOSTS = os.getenv("DJANGO_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "django.contrib.staticfiles",  # required by whitenoise storage helpers
    "corsheaders",
    "rest_framework",
    "chatbot.apps.ChatbotConfig",
]

# CorsMiddleware must sit above anything that can generate a response (WhiteNoise,
# CommonMiddleware) so cross-origin embeds of the widget get CORS headers on every
# response — including static assets and the SSE stream. No CSRF/session/auth
# middleware: this is a token-free public API exactly like the Worker was.
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    },
]

# No Django ORM models → no real database use. An inert in-memory SQLite keeps the
# test runner happy (no models ⇒ empty schema) while never touching disk at runtime;
# all FAQ reads go through the reused SQLAlchemy layer, not the Django ORM.
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}

# ---- Static / frontend hosting (unchanged static/ dir served at the site root) ----
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# WhiteNoise serves the existing widget files (index.html, qa.html, qa.js, ...) at "/".
WHITENOISE_ROOT = str(REPO_ROOT / "static")
WHITENOISE_INDEX_FILE = True
WHITENOISE_AUTOREFRESH = DEBUG

# ---- CORS: permissive, matching the Worker's `Access-Control-Allow-Origin: *` ----
CORS_ALLOW_ALL_ORIGINS = True

# ---- DRF: token-free, JSON-first (no browsable API auth machinery) ----
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "UNAUTHENTICATED_USER": None,
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

# ---- App logging: structured JSON to stdout (Cloud Logging captures it) ----
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
}
