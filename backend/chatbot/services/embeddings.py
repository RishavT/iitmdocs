"""Ollama embedding for Weaviate gce-mode vector search — port of worker.js getOllamaEmbedding."""
from __future__ import annotations

import math
import time

import requests

from .logs import log_duration


def get_ollama_embedding(text: str, ollama_url: str, model: str = "bge-m3"): # ollama_url can be http://ollama:11434
    """
    Get Ollama embedding for a given text. For model="bge-m3", the embedding is a 1024-dimensional vector. The embedding is returned as a list of floats.
    """
    start_time = time.monotonic()
    resp = requests.post(
        f"{ollama_url}/api/embeddings",
        json={"model": model, "prompt": text},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    log_duration("ollama_embedding", int((time.monotonic() - start_time) * 1000))
    if not resp.ok:
        raise RuntimeError(f"Ollama embedding failed: {resp.status_code}")
    result = resp.json()
    embedding = result.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama embedding response is not a non-empty array")

    try:
        numbers = [float(value) for value in embedding]
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Ollama embedding response contains a non-number") from exc

    if not all(math.isfinite(value) for value in numbers):
        raise RuntimeError("Ollama embedding response contains a non-finite number")
    return numbers
