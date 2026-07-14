"""Ollama embedding for Weaviate gce-mode vector search — port of worker.js getOllamaEmbedding."""
from __future__ import annotations

import requests


def get_ollama_embedding(text: str, ollama_url: str, model: str = "bge-m3"):
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
