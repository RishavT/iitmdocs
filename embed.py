#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "weaviate-client>=4.4.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
Script to embed all files from src/ directory into Weaviate.
Supports local (Ollama), cloud (Cohere/OpenAI), and gce (remote Ollama) modes via EMBEDDING_MODE env var.
"""

import hashlib
import logging
import os
import weaviate
from dotenv import load_dotenv
from pathlib import Path
from weaviate.classes.config import Configure, Property, DataType
from weaviate.classes.query import Filter

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def create_schema(weaviate_client, embedding_mode="cloud", embedding_provider="openai", embedding_model=None, ollama_endpoint=None):
    """Create or update the Document class schema in Weaviate"""
    # Configure vectorizer based on mode and provider
    if embedding_mode == "local":
        model = embedding_model or "mxbai-embed-large"
        vectorizer_config = Configure.Vectorizer.text2vec_ollama(
            model=model,
            api_endpoint="http://ollama:11434"
        )
        expected_vectorizer = "text2vec-ollama"
    elif embedding_mode == "gce":
        # GCE mode: connect to remote Ollama on GCE VM
        model = embedding_model or "mxbai-embed-large"
        ollama_url = ollama_endpoint or os.getenv("GCE_OLLAMA_URL", "http://localhost:11434")
        vectorizer_config = Configure.Vectorizer.text2vec_ollama(
            model=model,
            api_endpoint=ollama_url
        )
        expected_vectorizer = "text2vec-ollama"
    elif embedding_provider == "cohere":
        model = embedding_model or "embed-multilingual-v3.0"
        vectorizer_config = Configure.Vectorizer.text2vec_cohere(model=model)
        expected_vectorizer = "text2vec-cohere"
    else:
        model = embedding_model or "text-embedding-3-small"
        vectorizer_config = Configure.Vectorizer.text2vec_openai(model=model)
        expected_vectorizer = "text2vec-openai"

    # Check if collection exists and validate vectorizer configuration
    if weaviate_client.collections.exists("Document"):
        try:
            collection = weaviate_client.collections.get("Document")
            existing_vectorizer = collection.config.get().vectorizer.value if hasattr(collection.config.get().vectorizer, 'value') else str(collection.config.get().vectorizer)

            # Only delete if vectorizer has changed
            if existing_vectorizer != expected_vectorizer:
                logger.warning(
                    f"Vectorizer mismatch! Existing: {existing_vectorizer}, Expected: {expected_vectorizer}. "
                    f"Deleting and recreating collection with {embedding_mode}/{embedding_provider} embeddings. "
                    f"ALL EXISTING EMBEDDINGS WILL BE LOST."
                )
                weaviate_client.collections.delete("Document")
            else:
                logger.info(f"Collection exists with correct vectorizer ({expected_vectorizer}). Reusing existing collection.")
                return collection
        except Exception as e:
            logger.warning(f"Could not validate existing collection config: {e}. Recreating collection.")
            weaviate_client.collections.delete("Document")

    properties = [
        Property(name="filename", data_type=DataType.TEXT, description="Name of the source file"),
        Property(name="filepath", data_type=DataType.TEXT, description="Full path to the source"),
        Property(name="content", data_type=DataType.TEXT, description="Content of the document"),
        Property(name="file_size", data_type=DataType.INT, description="File size in bytes"),
        Property(name="content_hash", data_type=DataType.TEXT, description="SHA256 of the content"),
        Property(name="file_extension", data_type=DataType.TEXT, description="File extension"),
    ]

    logger.info(f"Creating new Document collection with {embedding_mode} mode, {expected_vectorizer} (model: {model})")
    return weaviate_client.collections.create(
        name="Document",
        vectorizer_config=vectorizer_config,
        properties=properties,
    )


def embed_documents(weaviate_client, src_directory: str, embedding_mode="cloud", embedding_provider="openai", embedding_model=None, ollama_endpoint=None) -> bool:
    """Embed all documents from the src directory into Weaviate"""
    collection = create_schema(weaviate_client, embedding_mode, embedding_provider, embedding_model, ollama_endpoint)
    src_path = Path(src_directory)

    files = [f for f in src_path.glob("**/*") if f.is_file()]
    logger.info(f"Processing {len(files)} files from {src_path.absolute()}")

    successful_embeds = 0

    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except (UnicodeDecodeError, IOError) as e:
            logger.warning(f"Skipping {file_path}: {e}")
            continue

        try:
            doc_data = {
                "filename": file_path.name,
                "filepath": str(file_path),
                "content": content,
                "file_size": file_path.stat().st_size,
                "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "file_extension": file_path.suffix,
            }

            existing = collection.query.fetch_objects(
                filters=Filter.by_property("filepath").equal(doc_data["filepath"]), limit=1
            )

            if existing.objects:
                existing_doc = existing.objects[0]
                if existing_doc.properties["content_hash"] == doc_data["content_hash"]:
                    continue
                collection.data.update(uuid=existing_doc.uuid, properties=doc_data)
            else:
                collection.data.insert(doc_data)

            successful_embeds += 1
        except Exception as e:
            logger.error(f"Failed to embed {file_path}: {e}")
            continue

    logger.info(f"Embedded {successful_embeds} documents")
    return True


def main():
    """Main function to run the embedding process"""
    load_dotenv()

    # Determine embedding mode: 'local', 'gce', or 'cloud'
    embedding_mode = os.getenv("EMBEDDING_MODE", "cloud").lower()
    logger.info(f"Embedding mode: {embedding_mode}")

    if embedding_mode == "local":
        # Local mode: connect to local Weaviate (no auth needed)
        weaviate_url = os.getenv("LOCAL_WEAVIATE_URL", "http://weaviate:8080")
        embedding_model = os.getenv("OLLAMA_MODEL", "mxbai-embed-large")

        logger.info(f"Connecting to local Weaviate at {weaviate_url}")
        client = weaviate.connect_to_local(
            host=weaviate_url.replace("http://", "").split(":")[0],
            port=int(weaviate_url.split(":")[-1]) if ":" in weaviate_url.split("//")[-1] else 8080
        )
        embed_documents(client, "src", embedding_mode, None, embedding_model)
        client.close()
    elif embedding_mode == "gce":
        # GCE mode: connect to remote Weaviate on GCE VM (no auth needed)
        weaviate_url = os.getenv("GCE_WEAVIATE_URL")
        ollama_url = os.getenv("GCE_OLLAMA_URL")
        embedding_model = os.getenv("OLLAMA_MODEL", "mxbai-embed-large")

        if not weaviate_url:
            raise ValueError("GCE_WEAVIATE_URL is required for GCE mode")
        if not ollama_url:
            raise ValueError("GCE_OLLAMA_URL is required for GCE mode")

        logger.info(f"Connecting to GCE Weaviate at {weaviate_url}")
        logger.info(f"Using GCE Ollama at {ollama_url}")

        # Parse the URL to get host and port
        url_parts = weaviate_url.replace("http://", "").replace("https://", "")
        host = url_parts.split(":")[0]
        port = int(url_parts.split(":")[1]) if ":" in url_parts else 8080

        # Use connect_to_custom with skip_init_checks to use REST instead of gRPC
        client = weaviate.connect_to_custom(
            http_host=host,
            http_port=port,
            http_secure=False,
            grpc_host=host,
            grpc_port=50051,
            grpc_secure=False,
            skip_init_checks=True
        )
        embed_documents(client, "src", embedding_mode, None, embedding_model, ollama_url)
        client.close()
    else:
        # Cloud mode: connect to Weaviate Cloud with API keys
        required_vars = ["WEAVIATE_URL", "WEAVIATE_API_KEY"]
        missing_vars = [var for var in required_vars if not os.getenv(var)]
        if missing_vars:
            raise ValueError(
                f"Missing required environment variables for cloud mode: {', '.join(missing_vars)}. "
                f"Please set them in .env file."
            )

        embedding_provider = os.getenv("EMBEDDING_PROVIDER", "openai").lower()
        embedding_model = os.getenv("EMBEDDING_MODEL")

        # Validate embedding provider
        valid_providers = ["openai", "cohere"]
        if embedding_provider not in valid_providers:
            raise ValueError(
                f"Invalid EMBEDDING_PROVIDER: '{embedding_provider}'. "
                f"Must be one of: {', '.join(valid_providers)}"
            )

        # Configure headers based on embedding provider
        headers = {}
        if embedding_provider == "cohere":
            cohere_key = os.getenv("COHERE_API_KEY")
            if not cohere_key:
                raise ValueError(
                    "COHERE_API_KEY is required when EMBEDDING_PROVIDER=cohere. "
                    "Please set it in .env file."
                )
            headers["X-Cohere-Api-Key"] = cohere_key
        else:
            openai_key = os.getenv("OPENAI_API_KEY")
            if not openai_key:
                raise ValueError(
                    "OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai. "
                    "Please set it in .env file."
                )
            headers["X-OpenAI-Api-Key"] = openai_key

        logger.info(f"Connecting to Weaviate Cloud with {embedding_provider} embeddings")
        client = weaviate.connect_to_weaviate_cloud(
            cluster_url=os.getenv("WEAVIATE_URL"),
            auth_credentials=weaviate.AuthApiKey(os.getenv("WEAVIATE_API_KEY")),
            headers=headers,
        )
        embed_documents(client, "src", embedding_mode, embedding_provider, embedding_model)
        client.close()


if __name__ == "__main__":
    main()
