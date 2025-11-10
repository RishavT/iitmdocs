#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "weaviate-client>=4.4.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
Script to embed all files from src/ directory into Weaviate cloud.
Supports both OpenAI and Cohere embeddings via EMBEDDING_PROVIDER env var.
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


def create_schema(weaviate_client, embedding_provider="openai", embedding_model=None):
    """Create or update the Document class schema in Weaviate"""
    # Configure vectorizer based on provider (default to openai for backwards compatibility)
    if embedding_provider == "cohere":
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
                    f"Deleting and recreating collection with {embedding_provider} embeddings. "
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

    logger.info(f"Creating new Document collection with {embedding_provider} embeddings (model: {model})")
    return weaviate_client.collections.create(
        name="Document",
        vectorizer_config=vectorizer_config,
        properties=properties,
    )


def embed_documents(weaviate_client, src_directory: str, embedding_provider="openai", embedding_model=None) -> bool:
    """Embed all documents from the src directory into Weaviate"""
    collection = create_schema(weaviate_client, embedding_provider, embedding_model)
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

    # Validate required environment variables
    required_vars = ["WEAVIATE_URL", "WEAVIATE_API_KEY"]
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    if missing_vars:
        raise ValueError(
            f"Missing required environment variables: {', '.join(missing_vars)}. "
            f"Please set them in .env file."
        )

    # Get configuration from environment (default to openai for backwards compatibility)
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

    client = weaviate.connect_to_weaviate_cloud(
        cluster_url=os.getenv("WEAVIATE_URL"),
        auth_credentials=weaviate.AuthApiKey(os.getenv("WEAVIATE_API_KEY")),
        headers=headers,
    )
    embed_documents(client, "src", embedding_provider, embedding_model)
    client.close()


if __name__ == "__main__":
    main()
