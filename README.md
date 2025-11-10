# IITM BS Chatbot

## Usage

### Docker Setup (Recommended for Local Development)

1. Set up a [Weaviate cluster](https://console.weaviate.cloud/cluster-details) and get an API key
2. Get API keys for your chosen providers (see Configuration section below)
3. Fill in keys in `.env` and `.dev.vars` (both are `.git-ignore`d)
4. Run the embed service once to upload documents:
   ```bash
   docker-compose run --rm embed
   ```
5. Start the worker service:
   ```bash
   docker-compose up worker
   ```
6. Test at `http://localhost:8787` or use the web UI at `http://localhost:8787/qa.html`

### Manual Setup

1. Set up a [Weaviate cluster](https://console.weaviate.cloud/cluster-details) and get an API key
2. Get API keys for your chosen providers (see Configuration section below)
3. Fill in keys in `.env` and `.dev.vars`
4. Run `uv run embed.py` to upload embeddings into Weaviate
5. Run `npm install` to install dependencies
6. Set up CloudFlare secrets using the same keys from `.dev.vars`:
   ```bash
   npx wrangler secret put WEAVIATE_URL
   npx wrangler secret put WEAVIATE_API_KEY
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put COHERE_API_KEY  # If using Cohere
   npx wrangler secret put CHAT_API_ENDPOINT  # If using custom endpoint
   npx wrangler secret put CHAT_MODEL  # If using custom model
   npx wrangler secret put EMBEDDING_PROVIDER  # If using Cohere
   npx wrangler secret put EMBEDDING_MODEL  # If using custom model
   ```
7. Run `npx wrangler dev` to test at `http://localhost:8787`
8. Run `npx wrangler deploy` to deploy to production

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
| `OPENAI_API_KEY` | Yes* | - | OpenAI API key or AI Pipe token |
| `COHERE_API_KEY` | If using Cohere | - | Cohere API key for embeddings |
| `CHAT_API_ENDPOINT` | No | `https://api.openai.com/v1/chat/completions` | Chat completion endpoint |
| `CHAT_MODEL` | No | `gpt-4o-mini` | Chat model to use |
| `EMBEDDING_PROVIDER` | No | `openai` | Embedding provider (`openai` or `cohere`) |
| `EMBEDDING_MODEL` | No | Provider default | Embedding model to use |
| `GITHUB_REPO_URL` | No | `https://github.com/study-iitm/iitmdocs` | GitHub repository URL for document links |

\* Can be OpenAI key, AI Pipe token, or any OpenAI-compatible API token

## Embedding

The embedding system processes `src/*.md` and stores them in Weaviate Cloud with vector embeddings. Supports both OpenAI and Cohere embedding providers (configured via `EMBEDDING_PROVIDER` environment variable).

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

A CloudFlare Worker provides semantic document search and AI-powered question answering using Weaviate and your chosen chat provider (OpenAI, AI Pipe, or any OpenAI-compatible API). Run:

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

## Chatbot

Add this code to the IITM BS website:

```html
<script src="https://iitm-bs-chatbot.sanand.workers.dev/chatbot.js" type="module"></script>
```

See a live demo at <https://iitm-bs-chatbot.sanand.workers.dev/>.

`chatbot.js` script will automatically create the chatbot button, the [chat app](https://iitm-bs-chatbot.sanand.workers.dev/qa) in an iframe, and inject all the necessary CSS for styling.

## License

[MIT](LICENSE)
