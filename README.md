# IITM BS Chatbot

## Usage

### Local Development (Docker)

1. Get API keys for your chosen providers (see Configuration section below)
2. Fill in keys in `.env` and `.dev.vars` (both are `.gitignore`d)
3. Start local Weaviate + Ollama stack:
   ```bash
   docker compose --profile local up -d
   ```
4. Wait for Ollama to pull the embedding model (~2 minutes first time), then run the embed service:
   ```bash
   docker compose --profile local --profile embed run --rm embed
   ```
5. Start the worker service:
   ```bash
   docker compose up worker
   ```
6. Test at `http://localhost:8787` or use the web UI at `http://localhost:8787/qa.html`

### Google Cloud Deployment

The project uses Google Cloud Build for CI/CD with automatic deployment to Cloud Run.

#### Architecture

- **Cloud Run Service**: Hosts the chatbot worker (auto-scales, serverless)
- **GCE VM** (`iitm-ollama-vm`): Runs Weaviate + Ollama for embeddings (persistent, cost-effective)
- **VPC Connector**: Allows Cloud Run to communicate with the GCE VM's internal IP
- **Cloud Run Job**: Runs embedding updates when `src/` files change

#### First-Time Setup

1. **Create a GCP Project** and enable the required APIs:
   ```bash
   gcloud services enable \
     cloudbuild.googleapis.com \
     run.googleapis.com \
     compute.googleapis.com \
     vpcaccess.googleapis.com \
     containerregistry.googleapis.com
   ```

2. **Grant Cloud Build permissions**:
   ```bash
   PROJECT_ID=$(gcloud config get-value project)
   PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

   # Grant Cloud Build service account necessary roles
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
     --role="roles/compute.admin"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
     --role="roles/run.admin"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
     --role="roles/vpcaccess.admin"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"
   ```

3. **Configure Cloud Build trigger**:
   ```bash
   gcloud builds triggers create github \
     --name="iitm-chatbot-deploy" \
     --repo-name="iitmdocs" \
     --repo-owner="YOUR_GITHUB_USER" \
     --branch-pattern="^main$" \
     --build-config="cloudbuild.yaml" \
     --substitutions="_OPENAI_API_KEY=your-key,_CHAT_API_ENDPOINT=https://api.openai.com/v1/chat/completions,_CHAT_MODEL=gpt-4o-mini"
   ```

4. **Push to main branch** to trigger the first deployment. Cloud Build will:
   - Create a VPC connector (if not exists)
   - Create a GCE VM with Weaviate + Ollama (if not exists)
   - Build and push Docker images
   - Run the embedding job (if `src/` files changed)
   - Deploy the Cloud Run service

#### Subsequent Deployments

Push to the main branch. Cloud Build automatically:
- Detects if `src/` files changed and runs embedding only when needed
- Handles file deletions by clearing and re-embedding the entire database
- Updates the Cloud Run service with the new code

#### Manual Commands

```bash
# Check GCE VM status
gcloud compute instances describe iitm-ollama-vm --zone=asia-south1-a

# SSH into GCE VM (for debugging)
gcloud compute ssh iitm-ollama-vm --zone=asia-south1-a --tunnel-through-iap

# View Cloud Run service logs
gcloud run services logs read iitm-chatbot-worker --region=asia-south1

# View embed job execution logs
gcloud run jobs executions list --job=iitm-embed-job --region=asia-south1

# Manually trigger a build
gcloud builds submit --config=cloudbuild.yaml
```

#### Cost Optimization

- The GCE VM uses `e2-medium` (~$25/month) with no external IP
- Cloud Run scales to zero when not in use
- Embedding job only runs when `src/` files change

## Configuration

The chatbot supports multiple API providers through environment variables:

### Required Variables

```bash
WEAVIATE_URL=https://your-cluster.weaviate.cloud
WEAVIATE_API_KEY=your_weaviate_key
```

### Chat API Configuration

**Option 1: OpenAI (Default)**
```bash
OPENAI_API_KEY=sk-...
# CHAT_API_ENDPOINT and CHAT_MODEL are optional, defaults to OpenAI
```

**Option 2: AI Pipe (OpenRouter)**
```bash
OPENAI_API_KEY=your_aipipe_token
CHAT_API_ENDPOINT=https://aipipe.org/openrouter/v1/chat/completions
CHAT_MODEL=gpt-4o-mini  # or any OpenRouter model
```

### Embedding Configuration

**Option 1: OpenAI (Default)**
```bash
OPENAI_API_KEY=sk-...
# EMBEDDING_PROVIDER defaults to "openai"
# EMBEDDING_MODEL defaults to "text-embedding-3-small"
```

**Option 2: Cohere**
```bash
COHERE_API_KEY=your_cohere_key
EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0  # or any Cohere embedding model
```

### All Configuration Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEAVIATE_URL` | Yes | - | Weaviate cluster URL |
| `WEAVIATE_API_KEY` | Yes | - | Weaviate API key |
| `OPENAI_API_KEY` | Yes* | - | OpenAI API key (required for OpenAI embeddings or as fallback for chat) |
| `COHERE_API_KEY` | If using Cohere | - | Cohere API key for embeddings |
| `CHAT_API_KEY` | No | Falls back to `OPENAI_API_KEY` | API key for chat endpoint (use for AI Pipe, OpenRouter, etc.) |
| `CHAT_API_ENDPOINT` | No | `https://api.openai.com/v1/chat/completions` | Chat completion endpoint |
| `CHAT_MODEL` | No | `gpt-4o-mini` | Chat model to use |
| `EMBEDDING_PROVIDER` | No | `openai` | Embedding provider (`openai` or `cohere`) |
| `EMBEDDING_MODEL` | No | Provider default | Embedding model to use |
| `GITHUB_REPO_URL` | No | `https://github.com/study-iitm/iitmdocs` | GitHub repository URL for document links |

\* At least one of `OPENAI_API_KEY` or `COHERE_API_KEY` is required depending on your embedding provider

### ⚠️ CRITICAL: Embedding Provider Compatibility

**The embedding provider used during document ingestion (embed.py) MUST match the provider configured in the worker (worker.js).**

If embeddings were created with OpenAI but the worker uses Cohere (or vice versa), semantic search will **fail silently** because the vector spaces are incompatible:

- **OpenAI embeddings**: 1536-dimensional vectors using `text-embedding-3-small` model
- **Cohere embeddings**: Different dimensional vectors using `embed-multilingual-v3.0` model

**These vector spaces are NOT compatible.** Queries using one provider cannot find documents embedded with another provider.

**To switch embedding providers:**
1. Update `EMBEDDING_PROVIDER` in `.env` and `.dev.vars`
2. Run `docker compose --profile local --profile embed run --rm embed` to recreate embeddings with the new provider
3. Restart the worker to use the matching provider

The embed service now validates the vectorizer configuration and only deletes the collection when the provider changes, preventing accidental data loss.

## Query Rewriting & Search Optimization

The chatbot uses two techniques to improve search relevance:

### Hybrid Search
Combines BM25 keyword search with vector semantic search (configurable via `alpha` parameter in worker.js). This catches both exact keyword matches and conceptually similar content.

### Query Rewriting
Before searching, user queries are expanded using an LLM to add relevant keywords. This helps with:
- **Disambiguation**: "how do i apply" → adds "admission qualifier eligibility" (not job placement)
- **Hinglish support**: "fee kitna hai" → adds "cost structure payment"
- **Short queries**: "OPPE" → adds "programming exam proctored online"

The query rewriter uses a knowledge base summary (`src/_knowledge_base_summary.md`) as context. This file lists all topics, keywords, and 100 example queries.

### Regenerating the Knowledge Base Summary

When source documents change significantly, regenerate the summary:

1. Use the prompt in `generate-summary-prompt.txt` with Claude or GPT
2. Save output to `src/_knowledge_base_summary.md`
3. Update the `KNOWLEDGE_BASE_SUMMARY` constant in `worker.js` (condensed version)
4. The summary is **excluded from Weaviate embeddings** (see `EXCLUDED_FILES` in embed.py)

## Embedding

The embedding system processes `src/*.md` (excluding files in `EXCLUDED_FILES`) and stores them in Weaviate Cloud with vector embeddings. Supports both OpenAI and Cohere embedding providers (configured via `EMBEDDING_PROVIDER` environment variable).

`embed.py` creates a `Document` collection with the following properties:

- `filename`: Name of the source file
- `filepath`: Full path to the source file
- `content`: Complete file content
- `file_size`: File size in bytes
- `content_hash`: SHA256 hash for duplicate detection
- `file_extension`: File extension (.md)

**Default (OpenAI):** Uses `text-embedding-3-small` model (1536 dimensions)
**Cohere:** Uses `embed-multilingual-v3.0` model (configurable via `EMBEDDING_MODEL`)

Modified files are replaced. New documents are inserted. Deleted documents are _not_ deleted. #TODO

You can query the documents using Weaviate's GraphQL API or Python client. Example:

```python
import os
import weaviate

# Configure headers based on your embedding provider
embedding_provider = os.getenv("EMBEDDING_PROVIDER", "openai")
headers = {}
if embedding_provider == "cohere":
    headers["X-Cohere-Api-Key"] = os.getenv("COHERE_API_KEY")
else:
    headers["X-OpenAI-Api-Key"] = os.getenv("OPENAI_API_KEY")

client = weaviate.connect_to_weaviate_cloud(
    cluster_url=os.getenv("WEAVIATE_URL"),
    auth_credentials=weaviate.AuthApiKey(os.getenv("WEAVIATE_API_KEY")),
    headers=headers,
)

collection = client.collections.get("Document")
print(collection.query.hybrid(query="admission process", limit=3))
client.close()
```

## Querying

The chatbot service provides semantic document search and AI-powered question answering using Weaviate and your chosen chat provider (OpenAI, AI Pipe, or any OpenAI-compatible API). Run:

```bash
curl http://localhost:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"q": "How do I register for courses", "ndocs": 3}'
```

The is a `text/event-stream` _subset_ of the [OpenAI chat completion object](https://platform.openai.com/docs/api-reference/chat/object).
Here are the fields:

```
data: {"choices": [{"delta": {"tool_calls": { "function": { "name": "document", "arguments": "{\"name\": ..., \"link\": ... }" }}}}]}

data: {"choices": [{"delta": {"tool_calls": { "function": { "name": "document", "arguments": "{\"name\": ..., \"link\": ... }" }}}}]}

data: {"choices": [{"delta": {"content": "..."}}]}

data: {"choices": [{"delta": {"content": "..."}}]}

data: [DONE]
```

- It begins with `choices[0].delta.tool_calls` having one JSON-encoded `arguments` for each document, mentioning `{name, link}`.
- It continues with `choices[0].delta.content` that has the streaming answer text

## Chatbot Widget

Add this code to embed the chatbot on any website:

```html
<script src="YOUR_CLOUD_RUN_URL/chatbot.js" type="module"></script>
```

Replace `YOUR_CLOUD_RUN_URL` with your deployed Cloud Run service URL (e.g., `https://iitm-chatbot-worker-xxxxx.asia-south1.run.app`).

The `chatbot.js` script will automatically create the chatbot button, the chat app in an iframe, and inject all the necessary CSS for styling.

## License

[MIT](LICENSE)
