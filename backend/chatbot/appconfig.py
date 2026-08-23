"""Runtime configuration accessors — read the SAME env vars the Worker/FAQ-API used.

Read at call time (not import) so unit tests and partial deployments don't fail at
import when a var is unset, mirroring the Worker reading from `env` per request.
"""
from __future__ import annotations

import os


def deployment_mode() -> str:
    """Return the deployment mode used to choose local or GCE services."""
    return os.getenv("DEPLOYMENT_MODE", "local")


# --- Weaviate ---
def local_weaviate_url() -> str:
    """Return the local Weaviate URL used for document retrieval."""
    return os.getenv("LOCAL_WEAVIATE_URL", "http://weaviate:8080")


def gce_weaviate_url():
    """Return the GCE Weaviate URL used for document retrieval in deployment."""
    return os.getenv("GCE_WEAVIATE_URL")


def gce_ollama_url():
    """Return the GCE Ollama URL used for embeddings or local LLM calls."""
    return os.getenv("GCE_OLLAMA_URL")


def ollama_model() -> str:
    """Return the Ollama embedding model name used by the retrieval services."""
    return os.getenv("OLLAMA_MODEL", "bge-m3")


# --- Chat LLM (OpenAI-compatible) ---
def chat_endpoint() -> str:
    """Return the OpenAI-compatible endpoint used to generate chat answers."""
    return os.getenv("CHAT_API_ENDPOINT", "https://api.openai.com/v1/chat/completions")


def chat_model() -> str:
    """Return the chat model name used by the answer-generation service."""
    return os.getenv("CHAT_MODEL", "gpt-4o-mini")


def chat_api_key():
    """Return the API key used to authenticate chat-model requests."""
    return os.getenv("CHAT_API_KEY") or os.getenv("OPENAI_API_KEY")


# --- FAQ semantic search (was the FastAPI PG FAQ API) ---
def faq_ollama_url() -> str:
    """Return the Ollama URL used to create FAQ-search embeddings."""
    # The FastAPI service embedded FAQ queries via OLLAMA_URL (docker: http://ollama:11434).
    return os.getenv("OLLAMA_URL", "http://ollama:11434")


def embedding_dimension() -> int:
    """Return the vector size expected by the FAQ semantic-search database."""
    try:
        return int(os.getenv("EMBEDDING_DIMENSION", "1024"))
    except ValueError as exc:
        raise RuntimeError("EMBEDDING_DIMENSION must be an integer") from exc


# --- Reference document links ---
def github_branch_base_url() -> str:
    """Return the branch URL used for browser-viewable reference documents."""
    return os.getenv(
        "GITHUB_BRANCH_BASE_URL",
        "https://github.com/iitmbsc-student-projects/iitmdocs/blob/main/",
    )
