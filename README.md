# IITM BS Chatbot

## Usage

**Quick Start (Local Development):** See [Configuration → Option 1: Local Development](#option-1-local-development-recommended-for-development)

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

#### Analytics & BigQuery

Conversation logs and user feedback are automatically exported to BigQuery for analytics.

**Infrastructure (auto-created by Cloud Build):**
- BigQuery dataset: `chatbot_logs`
- Log sink: `chatbot-conversations-sink` (exports conversation_turn and user_feedback logs)

**Setting up BigQuery Views:**

After the first deployment, create analytics views by running:

```bash
# Replace YOUR_PROJECT_ID with your GCP project ID
sed 's/YOUR_PROJECT_ID/your-project-id/g' scripts/setup-looker-view.sql | bq query --use_legacy_sql=false
```

Or run directly in [BigQuery Console](https://console.cloud.google.com/bigquery) after replacing `YOUR_PROJECT_ID`.

**Updating Existing Views:**

When the logging schema changes (new fields added), update the views:

```bash
# Re-run the SQL script - CREATE OR REPLACE will update existing views
sed 's/YOUR_PROJECT_ID/your-project-id/g' scripts/setup-looker-view.sql | bq query --use_legacy_sql=false
```

**Available Views:**
| View | Description |
|------|-------------|
| `conversations` | All conversation turns with latency, fact-check status, etc. |
| `user_feedback` | Thumbs up/down and report feedback |
| `feedback_summary` | Daily aggregates (satisfaction rate, report categories) |
| `conversations_with_feedback` | Conversations joined with feedback by message_id |

**Backward Compatibility:**

Views use `JSON_VALUE()` extraction which returns `NULL` for missing fields. This ensures older logs (before new fields were added) work alongside newer logs.

## Configuration

Choose one of three deployment modes:

### Option 1: Local Development (Recommended for development)

Uses Docker Compose with local Weaviate + Ollama containers.

**Environment Variables (`.env` and `.dev.vars`):**
```bash
EMBEDDING_MODE=local
LOCAL_WEAVIATE_URL=http://weaviate:8080
OLLAMA_MODEL=mxbai-embed-large

# Chat API (required)
OPENAI_API_KEY=sk-...
# Optional: use custom endpoint
# CHAT_API_ENDPOINT=https://aipipe.org/openrouter/v1/chat/completions
# CHAT_MODEL=gpt-4o-mini
```

**Setup:**
1. Start Weaviate + Ollama: `docker compose --profile local up -d`
2. Wait for Ollama to pull the model (~2 min first time)
3. Run embeddings: `docker compose --profile local --profile embed run --rm embed`
4. Start worker: `docker compose up worker`
5. Test at `http://localhost:8787`

### Option 2: GCE (Production - currently used)

Uses a GCE VM running Weaviate + Ollama, accessed via VPC connector from Cloud Run.

**Environment Variables** (set automatically by Cloud Build):
```bash
EMBEDDING_MODE=gce
GCE_WEAVIATE_URL=http://<GCE_VM_IP>:8080
GCE_OLLAMA_URL=http://<GCE_VM_IP>:11434

# Chat API (required)
OPENAI_API_KEY=sk-...
```

**Setup:**
- Push to main branch - Cloud Build handles everything automatically
- See [Google Cloud Deployment](#google-cloud-deployment) section for first-time setup

**Cost:** ~$25/month for GCE VM (`e2-medium`), Cloud Run scales to zero.

### Option 3: Cloud (Alternative - not used in production)

Uses Weaviate Cloud for vector storage + OpenAI/Cohere APIs for embeddings.

**Environment Variables:**
```bash
EMBEDDING_MODE=cloud
WEAVIATE_URL=https://your-cluster.weaviate.cloud
WEAVIATE_API_KEY=your_weaviate_key

# Embedding API (choose one)
EMBEDDING_PROVIDER=openai  # or cohere
OPENAI_API_KEY=sk-...      # if using OpenAI for embeddings
COHERE_API_KEY=...         # if using Cohere for embeddings

# Chat API (required)
OPENAI_API_KEY=sk-...
```

**⚠️ CRITICAL: Embedding Provider Compatibility**

The embedding provider used during ingestion MUST match the worker configuration. OpenAI and Cohere embeddings are NOT compatible - queries will fail silently if mismatched.

**To switch providers:**
1. Update `EMBEDDING_PROVIDER` in `.env` and `.dev.vars`
2. Re-run embeddings to recreate with new provider
3. Restart the worker

### Environment Variable Reference

| Variable | Modes | Default | Description |
|----------|-------|---------|-------------|
| `EMBEDDING_MODE` | All | `local` | `local`, `gce`, or `cloud` |
| `OPENAI_API_KEY` | All | - | OpenAI API key for chat |
| `CHAT_API_ENDPOINT` | All | OpenAI URL | Custom chat endpoint |
| `CHAT_MODEL` | All | `gpt-4o-mini` | Chat model |
| `OLLAMA_MODEL` | Local/GCE | `mxbai-embed-large` | Ollama embedding model |
| `LOCAL_WEAVIATE_URL` | Local | `http://weaviate:8080` | Local Weaviate URL |
| `GCE_WEAVIATE_URL` | GCE | - | GCE VM Weaviate URL |
| `GCE_OLLAMA_URL` | GCE | - | GCE VM Ollama URL |
| `WEAVIATE_URL` | Cloud | - | Weaviate Cloud URL |
| `WEAVIATE_API_KEY` | Cloud | - | Weaviate Cloud API key |
| `EMBEDDING_PROVIDER` | Cloud | `openai` | `openai` or `cohere` |
| `COHERE_API_KEY` | Cloud | - | Cohere API key |
| `GITHUB_REPO_URL` | All | `https://github.com/study-iitm/iitmdocs` | Doc links base URL |

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

## Guardrails & Safety

The chatbot includes multiple layers of protection against hallucination and harmful content.

### Fact-Checking

Every response is verified by a secondary LLM call that checks:
- **Factual accuracy**: Response must be grounded in the retrieved documents
- **Numerical precision**: Numbers must match exactly (treats "3L", "3 lakhs", "300000" as equivalent)
- **Contact info whitelist**: Only allows official `@study.iitm.ac.in` emails and approved phone numbers
- **Prohibited content**: Rejects cheating advice, personal/dating/sexual advice, false facts

If fact-checking fails, the bot returns a safe fallback message instead of potentially incorrect information.

### RAAHAT Mental Health Support

The bot detects emotional distress signals and redirects to RAAHAT (Mental Health & Wellness Society):
- Does NOT attempt to give psychological advice
- Provides standardized support message with contact info:
  - Email: `wellness.society@study.iitm.ac.in`
  - Instagram: `@wellness.society_iitmbs`

### Query Synonym Mapping

40+ pre-defined patterns map common questions to optimal search queries, providing fast and accurate results without LLM calls for frequent topics (grading, fees, placements, etc.).

## Embedding

The embedding system (`embed.py`) processes `src/*.md` files and stores them in Weaviate with vector embeddings.

**Production uses GCE mode** with Ollama (`mxbai-embed-large`) running on a GCE VM - no external embedding APIs needed. See [Configuration](#configuration) for all modes.

`embed.py` creates a `Document` collection with the following properties:

- `filename`: Name of the source file
- `filepath`: Full path to the source file
- `content`: Complete file content
- `file_size`: File size in bytes
- `content_hash`: SHA256 hash for duplicate detection
- `file_extension`: File extension (.md)

**Change detection:** Uses SHA256 content hashes. Modified files are updated, new files are inserted. Set `CLEAR_DB=true` to force full re-embedding (used by Cloud Build when files are deleted).

You can query the documents using Weaviate's GraphQL API or Python client.

**Local/GCE mode:**
```python
import weaviate
client = weaviate.connect_to_local(host="localhost", port=8080)  # or GCE VM IP
collection = client.collections.get("Document")
print(collection.query.hybrid(query="admission process", limit=3))
client.close()
```

**Cloud mode:**
```python
import os
import weaviate
client = weaviate.connect_to_weaviate_cloud(
    cluster_url=os.getenv("WEAVIATE_URL"),
    auth_credentials=weaviate.AuthApiKey(os.getenv("WEAVIATE_API_KEY")),
    headers={"X-OpenAI-Api-Key": os.getenv("OPENAI_API_KEY")},  # or Cohere
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
<script src="{{chatbot url}}"></script>
```

Replace with your deployed URL (Cloud Run or Cloudflare Workers).

The `chatbot.js` script will automatically create a floating chat button (bottom-right), load the chat interface in an iframe, and inject all necessary CSS.

## License

[MIT](LICENSE)
