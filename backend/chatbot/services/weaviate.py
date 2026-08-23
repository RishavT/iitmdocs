"""Weaviate hybrid document search — port of worker.js searchWeaviate.

Supports both DEPLOYMENT_MODE=local (Weaviate does text2vec-ollama vectorization,
query text passed to hybrid) and =gce (compute an Ollama embedding first, pass the
vector to hybrid). GraphQL string built identically to the Worker (same escaping).
"""
from __future__ import annotations

import json
import time

import requests

from .. import appconfig
from .embeddings import get_ollama_embedding
from .logs import log_duration


def _sanitize_graphql(query: str) -> str:
    return (
        query.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", " ")
        .replace("\r", " ")
        .replace("\t", " ")
    )


def search_weaviate(query: str, limit: int):
    """Search for documents without preventing FAQ-only answers on failure.

    Called by the answer pipeline after query rewriting. The return envelope
    always contains ``items`` and ``error`` so the pipeline can stop only when
    neither retrieval source produced usable context.

    Example: ``{"items": [{"filename": "fees.md"}], "error": None}``.
    """
    deployment_mode = appconfig.deployment_mode()
    if deployment_mode not in ("local", "gce"):
        return {
            "items": [],
            "error": f"weaviate_config_error:unsupported_DEPLOYMENT_MODE_{deployment_mode}",
        }

    if deployment_mode == "local":
        weaviate_url = appconfig.local_weaviate_url()
    else:
        weaviate_url = appconfig.gce_weaviate_url()
        if not weaviate_url:
            return {"items": [], "error": "weaviate_config_error:missing_GCE_WEAVIATE_URL"}

    sanitized_query = _sanitize_graphql(query)

    if deployment_mode == "gce":
        ollama_url = appconfig.gce_ollama_url()
        embedding_model = appconfig.ollama_model()
        if not ollama_url:
            return {"items": [], "error": "weaviate_config_error:missing_GCE_OLLAMA_URL"}
        try:
            query_vector = get_ollama_embedding(query, ollama_url, embedding_model)
        except Exception as exc:  # noqa: BLE001
            return {"items": [], "error": f"weaviate_embedding_error:{exc}"}
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

    try:
        start_time = time.monotonic()
        resp = requests.post(
            f"{weaviate_url}/v1/graphql",
            json={"query": graphql_query},
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
        log_duration("weaviate_graphql_search", int((time.monotonic() - start_time) * 1000))
        response_text = resp.text
        if not resp.ok:
            return {"items": [], "error": f"weaviate_api_error:{resp.status_code}"}

        try:
            data = json.loads(response_text)
        except Exception as exc:  # noqa: BLE001
            return {"items": [], "error": f"weaviate_response_malformed:{exc}"}

        if not isinstance(data, dict):
            return {"items": [], "error": "weaviate_response_malformed:not_an_object"}

        documents = (((data.get("data") or {}).get("Get") or {}).get("Document")) or []
        graphql_error = None
        if "errors" in data:
            errors = data["errors"]
            if not isinstance(errors, list):
                graphql_error = "weaviate_response_malformed:errors_not_array"
            elif errors:
                messages = []
                for error in errors:
                    if isinstance(error, dict):
                        messages.append(error.get("message") or str(error))
                    else:
                        messages.append(str(error))
                graphql_error = "weaviate_graphql_error:" + ", ".join(messages)

        items = [
            {**doc, "relevance": (doc.get("_additional") or {}).get("score") or 0}
            for doc in documents
        ]
        return {"items": items, "error": graphql_error}
    except Exception as exc:  # noqa: BLE001
        return {"items": [], "error": f"weaviate_fetch_error:{exc}"}
