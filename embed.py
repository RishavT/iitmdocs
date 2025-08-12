#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "weaviate-client>=4.4.0",
#     "openai>=1.0.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
Script to embed all files from src/ directory into Weaviate cloud using OpenAI text-embedding-3-small
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


def create_schema(weaviate_client):
    """Create or update the Document class schema in Weaviate"""
    if weaviate_client.collections.exists("Document"):
        return weaviate_client.collections.get("Document")
    properties = [
        Property(name="filename", data_type=DataType.TEXT, description="Name of the source file"),
        Property(name="filepath", data_type=DataType.TEXT, description="Full path to the source"),
        Property(name="content", data_type=DataType.TEXT, description="Content of the document"),
        Property(name="file_size", data_type=DataType.INT, description="File size in bytes"),
        Property(name="content_hash", data_type=DataType.TEXT, description="SHA256 of the content"),
        Property(name="file_extension", data_type=DataType.TEXT, description="File extension"),
    ]
    return weaviate_client.collections.create(
        name="Document",
        vectorizer_config=Configure.Vectorizer.text2vec_openai(model="text-embedding-3-small"),
        properties=properties,
    )


def embed_documents(weaviate_client, src_directory: str) -> bool:
    """Embed all documents from the src directory into Weaviate"""
    collection = create_schema(weaviate_client)
    src_path = Path(src_directory)

    files = [f for f in src_path.glob("**/*") if f.is_file()]
    logger.info(f"Processing {len(files)} files from {src_path.absolute()}")

    successful_embeds = 0

    for file_path in files:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
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

    logger.info(f"Embedded {successful_embeds} documents")
    return True


def main():
    """Main function to run the embedding process"""
    load_dotenv()
    client = weaviate.connect_to_weaviate_cloud(
        cluster_url=os.getenv("WEAVIATE_URL"),
        auth_credentials=weaviate.AuthApiKey(os.getenv("WEAVIATE_API_KEY")),
        headers={"X-OpenAI-Api-Key": os.getenv("OPENAI_API_KEY")},
    )
    embed_documents(client, "src")
    client.close()


if __name__ == "__main__":
    main()
