"""Weaviate hybrid document search — port of worker.js searchWeaviate.

Supports both DEPLOYMENT_MODE=local (Weaviate does text2vec-ollama vectorization,
query text passed to hybrid) and =gce (compute an Ollama embedding first, pass the
vector to hybrid). GraphQL string built identically to the Worker (same escaping).
"""
from __future__ import annotations

import json

import requests

from .. import appconfig
from .embeddings import get_ollama_embedding


def _sanitize_graphql(query: str) -> str:
    return (
        query.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", " ")
        .replace("\r", " ")
        .replace("\t", " ")
    )


def search_weaviate(query: str, limit: int):
    deployment_mode = appconfig.deployment_mode()
    if deployment_mode not in ("local", "gce"):
        raise RuntimeError(
            f"Unsupported DEPLOYMENT_MODE='{deployment_mode}'. Supported values: local, gce."
        )

    if deployment_mode == "local":
        weaviate_url = appconfig.local_weaviate_url()
    else:
        weaviate_url = appconfig.gce_weaviate_url()
        if not weaviate_url:
            raise RuntimeError("GCE_WEAVIATE_URL is required for DEPLOYMENT_MODE=gce")

    sanitized_query = _sanitize_graphql(query)

    if deployment_mode == "gce":
        ollama_url = appconfig.gce_ollama_url()
        embedding_model = appconfig.ollama_model()
        if not ollama_url:
            raise RuntimeError("GCE_OLLAMA_URL is required for DEPLOYMENT_MODE=gce")
        query_vector = get_ollama_embedding(query, ollama_url, embedding_model)
        vector_str = "[" + ",".join(str(v) for v in query_vector) + "]"
        graphql_query = (
            "{\n"
            "      Get {\n"
            "        Document(\n"
            "          hybrid: {\n"
            f'            query: "{sanitized_query}"\n'
            f"            vector: {vector_str}\n"
            "            alpha: 0.5\n"
            "          }\n"
            f"          limit: {limit}\n"
            "        ) {\n"
            "          filename filepath content file_size\n"
            "          _additional { score }\n"
            "        }\n"
            "      }\n"
            "    }"
        )
    else:
        graphql_query = (
            "{\n"
            "      Get {\n"
            "        Document(\n"
            "          hybrid: {\n"
            f'            query: "{sanitized_query}"\n'
            "            alpha: 0.5\n"
            "          }\n"
            f"          limit: {limit}\n"
            "        ) {\n"
            "          filename filepath content file_size\n"
            "          _additional { score }\n"
            "        }\n"
            "      }\n"
            "    }"
        )

    resp = requests.post(
        f"{weaviate_url}/v1/graphql",
        json={"query": graphql_query},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    response_text = resp.text
    try:
        data = json.loads(response_text)
    except Exception as exc:  # noqa: BLE001 - mirror Worker's parse-error message
        raise RuntimeError(f"Failed to parse Weaviate response: {exc}")

    if data.get("errors"):
        raise RuntimeError(
            "Weaviate error: " + ", ".join(e.get("message", "") for e in data["errors"])
        )

    documents = (((data.get("data") or {}).get("Get") or {}).get("Document")) or []
    # Hybrid search returns 'score' (higher is better).
    return [{**doc, "relevance": (doc.get("_additional") or {}).get("score") or 0} for doc in documents]
