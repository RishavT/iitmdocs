"""Ollama embedding for Weaviate gce-mode vector search — port of worker.js getOllamaEmbedding."""
from __future__ import annotations

import requests


def get_ollama_embedding(text: str, ollama_url: str, model: str = "bge-m3"): # ollama_url can be http://ollama:11434
    """
    Get Ollama embedding for a given text. For model="bge-m3", the embedding is a 1024-dimensional vector. The embedding is returned as a list of floats.
    """
    resp = requests.post(
        f"{ollama_url}/api/embeddings",
        json={"model": model, "prompt": text},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"Ollama embedding failed: {resp.status_code}")
    result = resp.json()
    return result.get("embedding")
