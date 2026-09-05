"""Ollama embedding for Weaviate gce-mode vector search — port of worker.js getOllamaEmbedding."""
from __future__ import annotations

import math

from .logs import measure_duration


async def get_ollama_embedding_async(client, text, ollama_url, model="bge-m3"):
    """Get and validate an Ollama embedding without blocking the event loop."""
    with measure_duration("ollama_embedding"):
        response = await client.post(
            f"{ollama_url}/api/embeddings",
            json={"model": model, "prompt": text},
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
    if not response.is_success:
        raise RuntimeError(f"Ollama embedding failed: {response.status_code}")
    embedding = response.json().get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama embedding response is not a non-empty array")
    try:
        numbers = [float(value) for value in embedding]
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Ollama embedding response contains a non-number") from exc
    if not all(math.isfinite(value) for value in numbers):
        raise RuntimeError("Ollama embedding response contains a non-finite number")
    return numbers
