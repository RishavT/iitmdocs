"""Runtime configuration accessors — read the SAME env vars the Worker/FAQ-API used.

Read at call time (not import) so unit tests and partial deployments don't fail at
import when a var is unset, mirroring the Worker reading from `env` per request.
"""
from __future__ import annotations

import os


def deployment_mode() -> str:
    return os.getenv("DEPLOYMENT_MODE", "local")


# --- Weaviate ---
def local_weaviate_url() -> str:
    return os.getenv("LOCAL_WEAVIATE_URL", "http://weaviate:8080")


def gce_weaviate_url():
    return os.getenv("GCE_WEAVIATE_URL")


def gce_ollama_url():
    return os.getenv("GCE_OLLAMA_URL")


def ollama_model() -> str:
    return os.getenv("OLLAMA_MODEL", "bge-m3")


# --- Chat LLM (OpenAI-compatible) ---
def chat_endpoint() -> str:
    return os.getenv("CHAT_API_ENDPOINT", "https://api.openai.com/v1/chat/completions")


def chat_model() -> str:
    return os.getenv("CHAT_MODEL", "gpt-4o-mini")


def chat_api_key():
    return os.getenv("CHAT_API_KEY") or os.getenv("OPENAI_API_KEY")


# --- FAQ semantic search (was the FastAPI PG FAQ API) ---
def faq_ollama_url() -> str:
    # The FastAPI service embedded FAQ queries via OLLAMA_URL (docker: http://ollama:11434).
    return os.getenv("OLLAMA_URL", "http://ollama:11434")


def faq_search_max_concurrent() -> int:
    return int(os.getenv("FAQ_SEARCH_MAX_CONCURRENT", "4"))


def embedding_dimension() -> int:
    try:
        return int(os.getenv("EMBEDDING_DIMENSION", "1024"))
    except ValueError as exc:
        raise RuntimeError("EMBEDDING_DIMENSION must be an integer") from exc
