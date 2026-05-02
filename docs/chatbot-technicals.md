# Chatbot Technicals — Architecture, Decisions, and Debugging

This document covers the technical internals of the IITM BS Admissions Chatbot. It is intended for DevOps engineers, software developers, and AI engineers who need to debug issues, optimize performance, or extend the system.

For a non-technical overview of the pipeline, see `docs/chatbot-101.md`.

---

## Table of Contents

1. [Tech Stack Overview](#1-tech-stack-overview)
2. [Why bge-m3 for Embeddings](#2-why-bge-m3-for-embeddings)
3. [How Weaviate Works in This System](#3-how-weaviate-works-in-this-system)
4. [How Retrieval Actually Works](#4-how-retrieval-actually-works)
5. [Query Rewriting Internals](#5-query-rewriting-internals)
6. [LLM Configuration and Prompt Design](#6-llm-configuration-and-prompt-design)
7. [Fact-Checker Internals](#7-fact-checker-internals)
8. [Docker Architecture](#8-docker-architecture)
9. [Deployment Environments](#9-deployment-environments)
10. [Cloud Build CI/CD Pipeline](#10-cloud-build-cicd-pipeline)
11. [Logging and Analytics](#11-logging-and-analytics)
12. [Debugging: Bot Not Giving Expected Answers](#12-debugging-bot-not-giving-expected-answers)
13. [Debugging: Infrastructure Issues](#13-debugging-infrastructure-issues)
14. [Environment Variables Reference](#14-environment-variables-reference)
15. [Security Measures](#15-security-measures)

---

## 1. Tech Stack Overview

| Component | Technology | Purpose |
|---|---|---|
| Backend runtime | Cloudflare Workers (via Wrangler) | Handles HTTP requests, runs the RAG pipeline |
| Vector database | Weaviate v1.27.0 | Stores document embeddings, runs hybrid search |
| Embedding model | bge-m3 (via Ollama) | Converts text to vectors for semantic search |
| FAQ database | Postgres + pgvector | Stores FAQ rows + embedding vectors for semantic FAQ lookup |
| FAQ search API | PG FAQ API (FastAPI) | Semantic FAQ search + direct FAQ lookup (powers “Did you mean?” + `faq_id`) |
| Query rewriting LLM | gpt-4o-mini (via OpenAI-compatible API) | Rewrites user queries for better retrieval |
| Answer generation LLM | Configurable via `CHAT_MODEL` env var (default: gpt-4o-mini) | Generates answers from retrieved context |
| Fact-check LLM | gpt-4o-mini (hardcoded) | Verifies answer accuracy against context |
| Frontend | Vanilla JS + lit-html + Bootstrap 5 | Chat UI, rendering, feedback |
| Containerization | Docker + Docker Compose | Local dev, embedding service |
| CI/CD | Google Cloud Build | Automated build, embed, deploy |
| Hosting (production) | Google Cloud Run | Serverless container hosting |
| Analytics | BigQuery via Cloud Logging sink | Conversation logs, feedback analytics |

### Key files

```
worker.js          → All backend logic (single file)
embed.py           → Embedding script (Python)
pg/faq_api/main.py → PG FAQ API service (FastAPI) for FAQ search
static/qa.js       → Frontend chat logic
static/chatbot.js  → Embeddable widget (iframe-based)
static/qa.html     → Chat interface HTML
docker-compose.yml → Local dev services
cloudbuild.yaml    → CI/CD pipeline (builds/deploys worker, PG FAQ API, and optional embed job)
wrangler.toml      → Cloudflare Workers config
```

---

## 2. Why bge-m3 for Embeddings

**Model**: [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) — run locally via Ollama

**Why this model was chosen:**

1. **Multilingual support**: The chatbot handles English, Hindi, Tamil, and Hinglish queries. bge-m3 supports 100+ languages natively, meaning a Hindi query will find English documents (and vice versa) through cross-lingual semantic similarity. Most English-only models (e.g., OpenAI's `text-embedding-3-small`) perform poorly on Hinglish and Tamil.

2. **Self-hosted / no API cost**: bge-m3 runs via Ollama on a GCE VM (e2-medium). There are no per-request embedding costs — only the fixed VM cost. This matters because embeddings happen both at index time (embed.py) and at query time (searchWeaviate in GCE mode).

3. **Quality**: bge-m3 is a top-performing model on MTEB benchmarks for retrieval tasks, competitive with proprietary models.

4. **Hybrid search compatibility**: bge-m3 produces dense embeddings that work well alongside BM25 keyword search in Weaviate's hybrid mode.

**Trade-offs:**

- bge-m3 produces 1024-dimensional vectors, which is larger than some alternatives. This increases storage but improves quality.
- The Ollama instance needs ~2GB RAM for bge-m3.

**Where embedding happens:**

| Mode | Index-time (embed.py) | Query-time (worker.js) |
|---|---|---|
| `local` | Ollama (local Docker) → Weaviate text2vec-ollama | Weaviate handles it internally |
| `gce` | Ollama (GCE VM) → Weaviate text2vec-ollama | worker.js calls Ollama API directly via `getOllamaEmbedding()`, then passes vector to Weaviate hybrid search |

---

## 3. How Weaviate Works in This System

### Schema

Weaviate stores a single collection called `Document` with these properties:

| Property | Type | Purpose |
|---|---|---|
| `filename` | TEXT | Source file name (e.g., `fees_and_payments.md`) |
| `filepath` | TEXT | Full path to the source file |
| `content` | TEXT | Full markdown content of the document |
| `file_size` | INT | File size in bytes |
| `content_hash` | TEXT | SHA256 hash of content (for change detection) |
| `file_extension` | TEXT | File extension (`.md`) |

Each document is stored as **one object** in Weaviate — the entire file content, not chunked. This is a deliberate decision:

- The `src/` files are relatively small (1-10KB each, 16 files total).
- Whole-document retrieval gives the LLM full context for each topic.

### Vectorizer configuration

The vectorizer module is set at collection creation time and **cannot be changed** without deleting and recreating the collection. `embed.py` detects vectorizer mismatches and handles them:

```python
# If the existing collection uses a different vectorizer module, it is deleted and recreated
if existing_vectorizer != expected_vectorizer:
    weaviate_client.collections.delete("Document")
```

### Change detection

`embed.py` uses SHA256 content hashing to skip unchanged files:

```python
if existing_doc.properties["content_hash"] == doc_data["content_hash"]:
    # Skip - content hasn't changed
```

This means re-running `embed.py` is cheap — only modified files get re-embedded.

### Excluded files

The `EXCLUDED_FILES` list in `embed.py` prevents certain files from being indexed:

```python
EXCLUDED_FILES = [
    "_knowledge_base_summary.md",  # Query rewriting context - not for vector search
]
```

---

## 4. How Retrieval Actually Works

The search uses **Weaviate's hybrid search** — a combination of BM25 (keyword) and vector (semantic) search.

### The hybrid search query

```graphql
{
  Get {
    Document(
      hybrid: {
        query: "user question + rewritten keywords"
        alpha: 0.5
      }
      limit: 2
    ) {
      filename filepath content file_size
      _additional { score }
    }
  }
}
```

### How `alpha` works

- `alpha = 0.0` → Pure BM25 (keyword matching only)
- `alpha = 0.5` → **Balanced** — 50% BM25 + 50% vector similarity (current setting)
- `alpha = 1.0` → Pure vector search (semantic only)

**Why 0.5?** The chatbot handles both exact keyword queries ("OPPE") and natural language queries ("how do I prepare for the programming exam?"). BM25 excels at exact matches, while vector search handles paraphrasing and cross-lingual matching. The 50/50 balance gives the best of both.

### How BM25 scoring works

BM25 (Best Matching 25) is a statistical keyword ranking algorithm. It scores documents based on:

- **Term frequency**: How often the query terms appear in the document
- **Inverse document frequency**: Rare terms get higher weight than common ones
- **Document length normalization**: Longer documents don't automatically win

This is why **Tags at the bottom of each `src/` file matter** — they add keyword variations that BM25 can match. For example, if a user types "fee waiver", the Tags line in `fees_and_payments.md` contains "fee waiver, SC ST PwD OBC-NCL EWS, 50% 75% waiver, income based, concession" — all of which boost BM25 scoring for that document.

### How vector scoring works

The query text is converted to a 1024-dimensional vector (using bge-m3), and documents are scored by cosine similarity with the query vector. This captures semantic meaning — "how much does it cost" and "fee structure" will match even though they share no keywords.

### GCE mode: manual embedding

In GCE mode, worker.js must compute the query embedding itself (because Weaviate on the GCE VM doesn't have direct access to the embedding model for query-time vectorization in the same way):

```javascript
// GCE mode: get embedding from Ollama first, then pass to Weaviate
const queryVector = await getOllamaEmbedding(query, ollamaUrl, embeddingModel);
graphqlQuery = `{
  Get {
    Document(
      hybrid: {
        query: "${sanitizedQuery}"
        vector: ${vectorStr}    // ← manually computed vector
        alpha: 0.5
      }
      ...
    )
  }
}`;
```

In local mode, Weaviate computes the query vector internally.

### FAQ retrieval: PG FAQ API (separate from Weaviate docs)

In addition to document retrieval from Weaviate, the worker also queries the **PG FAQ API**:
- `POST /search` to get the closest FAQ questions for the user query (used for “Did you mean?” suggestions, and also included as extra FAQ context during answer generation)
- `GET /faq/:id` for direct lookup when the user clicks a suggestion (the frontend sends `faq_id`)

This FAQ path is independent of Weaviate’s `Document` collection: it is backed by Postgres+pgvector and is designed specifically for matching short FAQ-style questions.

### Relevance threshold

After retrieval, documents below a relevance score of 0.05 (5%) are filtered out:

```javascript
const RELEVANCE_THRESHOLD = 0.05;
const relevantDocs = documents.filter(doc => doc.relevance > RELEVANCE_THRESHOLD);
```

This is intentionally very low — the fact-checker handles quality control, so retrieval should maximize recall.

---

## 5. Query Rewriting Internals

Query rewriting transforms the user's raw question into a keyword-rich search query. There are two paths:

### Fast path: QUERY_SYNONYMS (no API call)

`QUERY_SYNONYMS` is an array of `[patterns, canonical_query]` pairs. The user's query is lowercased and checked for substring matches:

```javascript
// If user asks "grading policy", matches → "grading formula score calculation GAA quiz..."
const synonymMatch = findSynonymMatch(query);
```

The matched query is **augmented** — the original query is prepended:

```javascript
const augmentedSynonym = `${query} ${synonymMatch}`;
// "how is grade calculated grading formula score calculation GAA quiz end term OPPE weightage"
```

This ensures the original phrasing is preserved for FAQ matching while adding keywords for BM25.

### Slow path: LLM rewriting (gpt-4o-mini)

When no synonym matches, the LLM rewrites the query. Key parameters:

```javascript
model: "gpt-4o-mini",
temperature: 0,        // Deterministic — same query always gives same rewrite
max_tokens: 100,       // Short output — just keywords, not sentences
```

The LLM receives `KNOWLEDGE_BASE_SUMMARY` (a compact list of 16 topics with 8-12 keywords each) as context. This tells the LLM what topics exist so it can map the user's question to the right domain.

**Why gpt-4o-mini for rewriting?** It's fast (~200ms), cheap, and the task is simple — keyword expansion, not complex reasoning. Using a larger model would add latency without meaningful quality improvement.

### Language detection

The LLM appends a `[LANG:xxx]` tag to the rewritten query. This tag is:
1. Extracted and stored as the detected language
2. Stripped from the query before sending to Weaviate (the tag would hurt search)
3. Used later to respond in the correct language

### KNOWLEDGE_BASE_SUMMARY vs Tags — the architectural distinction

| | KNOWLEDGE_BASE_SUMMARY | Tags in src/ files |
|---|---|---|
| **Consumer** | gpt-4o-mini (query rewriter) | Weaviate BM25 search |
| **Location** | `worker.js` constant | Bottom of each `src/*.md` file |
| **Goal** | Help LLM route query to right topic | Help search engine find right document |
| **Keyword strategy** | 8-12 **discriminating** keywords per topic (what makes this topic unique) | Many keywords including synonyms, variations, abbreviations (more = better recall) |
| **Why different counts** | LLM needs to distinguish between 16 topics — too many overlapping keywords confuse it | BM25 benefits from more keyword surface area — partial matches add up |

---

## 6. LLM Configuration and Prompt Design

### Answer generation

```javascript
const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
const chatModel = env.CHAT_MODEL || "gpt-4o-mini";
temperature: 0.1,     // Low but not zero — allows slight variation for natural language
stream: false,        // Full response collected for fact-checking before delivery
```

**Why non-streaming?** The answer must pass through the fact-checker before the user sees it. If we streamed directly, the user would see an answer that might later be rejected — bad UX.

### Message structure sent to the LLM

```
[system]  → Instructions (be helpful, be factual, handle RAAHAT, refuse cheating)
[assistant] → Context documents (wrapped in <document> tags) + RAAHAT info
[...history] → Previous Q&A pairs (if ENABLE_HISTORY is true)
[user]    → The user's original question (NOT the rewritten query)
```

**Important**: The user's **original question** is sent to the answer LLM, not the rewritten query. The rewritten query is only used for search. This ensures the LLM answers what the user actually asked.

### Context document format

```xml
<document filename="fees_and_payments.md">...full markdown content...</document>
<document filename="qualifier_eligibility.md">...full markdown content...</document>
<document filename="RAAHAT_Support.md">...RAAHAT contact info...</document>
```

RAAHAT info is always appended as a synthetic document, ensuring the LLM can reference mental health resources for any query.

---

## 7. Fact-Checker Internals

### What the fact-checker receives

```
System prompt → Rules for what's allowed/not allowed
User message  → Context documents + conversation history + "RESPONSE TO VERIFY: <answer>"
```

**Critical design decision**: The fact-checker does **NOT** receive the user's original question. It only checks: "Is this answer supported by these context documents?" This prevents the fact-checker from being confused by the question and keeps its job simple.

### What the fact-checker checks

**Allowed:**
- Facts matching context documents
- Paraphrasing of context information
- Combining info from 1-2 documents
- Whitelisted contact info (specific emails and phone numbers)
- Numerically equivalent values (3L = 300000 = 3,00,000)

**Not allowed:**
- Fabricated facts not in context
- Random advice
- Cheating/harmful content
- Non-whitelisted contact info
- Emotional/dating/sexual advice

### The retry mechanism

```javascript
let isFactuallyCorrect = await checkResponse({ response, context, history, env });
if (!isFactuallyCorrect && validatedHistory.length > 0) {
    // Retry without history — history sometimes confuses the fact-checker
    isFactuallyCorrect = await checkResponse({ response, context, history: [], env });
}
```

**Why retry without history?** The conversation history can contain context from previous turns that isn't in the current context documents. The fact-checker might see a reference to information from a previous answer and incorrectly flag it as unsupported. Retrying without history eliminates this false positive.

### Fact-checker model

```javascript
const factCheckModel = "gpt-4o-mini";  // Hardcoded, not configurable
temperature: 0,                         // Fully deterministic
response_format: { type: "json_object" }, // Forces valid JSON output
```

The fact-check model is hardcoded to gpt-4o-mini regardless of what `CHAT_MODEL` is set to. This ensures consistent fact-checking behavior.

### Fail-open design

If the fact-check API call fails (network error, timeout, etc.), the answer is **approved by default**:

```javascript
catch (error) {
    // On error, return true to avoid blocking valid responses
    return true;
}
```

This is a deliberate trade-off: it's better to occasionally show an unchecked answer than to always show "cannot answer" when the fact-check service is down.

---

## 8. Docker Architecture

### Services

```yaml
services:
  embed:    # Python - runs embed.py, exits when done (profile: embed)
  worker:   # Node.js - runs Wrangler dev server on port 8787
  postgres: # Postgres + pgvector for FAQ storage (profile: local)
  pg-faq-api: # FastAPI service that queries the FAQ DB (profile: local)
  weaviate: # Weaviate v1.27.0 vector DB on port 8080 (profile: local)
  ollama:   # Ollama LLM server on port 11434 (profile: local)
```

### Docker profiles

- **No profile** (`docker compose up worker`): Only starts the worker. Used when Weaviate/Ollama (and optionally the FAQ services) are running elsewhere (e.g., on a GCE VM).
- **`local` profile** (`docker compose --profile local up`): Starts the local stack (Weaviate + Ollama + Postgres + PG FAQ API) alongside the worker.
- **`embed` profile** (`docker compose --profile embed up embed`): Runs the embedding script (one-shot).

### Dockerfiles

**Dockerfile.worker** (Node.js):
- Based on `node:20-slim`
- Installs npm dependencies (Wrangler, etc.)
- Creates a startup script that generates `.dev.vars` from environment variables at runtime
- Runs `npx wrangler dev --port 8787 --ip 0.0.0.0`

**Dockerfile.embed** (Python):
- Based on `python:3.11-slim`
- Uses `uv` for fast dependency installation
- Copies `embed.py` and `src/` folder
- Runs `python embed.py` and exits

### Volume mounts (development)

The worker service mounts source files as read-only volumes for live-reload during development:

```yaml
volumes:
  - ./worker.js:/app/worker.js:ro
  - ./static:/app/static:ro
```

---

## 9. Deployment Environments

### Local mode (`EMBEDDING_MODE=local`)

```
Developer machine
├── Docker Compose
│   ├── worker (port 8787) ← runs Wrangler dev server
│   ├── weaviate (port 8080) ← local vector DB
│   └── ollama (port 11434) ← local embedding model
│   ├── postgres (port 5433) ← FAQ DB (pgvector)
│   └── pg-faq-api (port 8001) ← FAQ search API
└── Browser → http://localhost:8787
```

- Everything runs on the developer's machine via Docker Compose.
- Weaviate is configured with `text2vec-ollama` module pointing to the local Ollama container.
- No external API calls needed for embeddings.
- Still needs an OpenAI API key for the LLM calls (query rewriting, answer generation, fact-checking).

### GCE mode (`EMBEDDING_MODE=gce`)

```
Google Cloud
├── Cloud Run (worker) ← deployed as a container
│   ├── VPC Connector → internal network
│   ├── Calls OpenAI API for LLM
│   └── Calls PG FAQ API for FAQ suggestions/direct lookup
├── Cloud Run (pg-faq-api) ← FastAPI FAQ search service
│   ├── Calls Postgres/Cloud SQL for FAQ rows + vectors
│   └── Calls GCE Ollama for query embeddings
├── GCE VM (e2-medium, no public IP)
│   ├── Weaviate (port 8080)
│   └── Ollama (port 11434, bge-m3 model)
└── Cloud Build (CI/CD) → triggers on git tag
```

- Worker runs on Cloud Run (serverless, auto-scales).
- PG FAQ API also runs on Cloud Run and is deployed from `Dockerfile.pgfaq`.
- Weaviate + Ollama run on a single GCE VM (e2-medium, ~$25/month).
- Communication between Cloud Run and GCE VM is **internal-only** via VPC connector — the VM has no public IP.
- At query time, worker.js calls the Ollama API on the GCE VM to compute query embeddings, then passes them to Weaviate's hybrid search with an explicit vector.
- For FAQ search, worker.js calls the deployed PG FAQ API URL. The PG FAQ API calls Postgres for FAQ rows and GCE Ollama for query embeddings.

### FAQ system note (GCE)

- The Cloud Build pipeline bootstraps the FAQ database during embedding (`ENABLE_PG_FAQ_BOOTSTRAP=true` in the embed job env vars).
- Cloud Build also builds and deploys the PG FAQ API service as `iitm-pg-faq-api`.
- After deploying PG FAQ API, Cloud Build reads its Cloud Run URL and passes it to the worker as `PG_FAQ_API_URL`.
- Operationally this means FAQ suggestions/direct lookups are available in GCE when the configured Postgres database is reachable, the FAQ rows have embeddings, and the deployed PG FAQ API can reach GCE Ollama.

### Cloudflare Workers mode (wrangler deploy)

- The worker can also be deployed directly to Cloudflare's edge network using `wrangler deploy`.
- `wrangler.toml` configures: worker name, compatibility flags, static assets binding.
- Static files in `static/` are served via Cloudflare's asset binding (`env.ASSETS`).
- All requests go through the worker first (`run_worker_first = true`) so CORS headers are added.

---

## 10. Cloud Build CI/CD Pipeline

`cloudbuild.yaml` defines the CI/CD pipeline. The current pipeline builds/deploys the worker, builds/deploys the PG FAQ API, and conditionally builds/runs the embed job when the build tag asks for embedding:

| Step | What it does |
|---|---|
| 0. setup-logging-sink | Creates BigQuery dataset + Cloud Logging sink for analytics |
| 1. create-vpc-connector | Creates VPC connector for Cloud Run ↔ GCE VM communication |
| 2. create-vm | Creates the GCE VM (e2-medium) with startup script that installs Docker, Weaviate, Ollama, and pulls bge-m3 |
| 3. update-firewall | Restricts VM access to VPC internal IPs only (10.0.0.0/8) |
| 4. wait-services | Waits 60s for Weaviate + Ollama to be ready |
| 5. check-embed-trigger | If `TAG_NAME` contains `embed`, marks embedding as needed |
| 6. build-embed | Builds embed Docker image (conditional) |
| 7. build-worker | Builds worker Docker image |
| 8. build-pg-faq-api | Builds PG FAQ API Docker image |
| 9. push-embed | Pushes embed image (conditional) |
| 10. push-worker | Pushes worker image |
| 11. push-pg-faq-api | Pushes PG FAQ API image |
| 12. create-embed-job | Creates/updates a Cloud Run Job for embedding (conditional) |
| 13. run-embed-job | Executes the embed job and streams logs (conditional) |
| 14. deploy-pg-faq-api | Deploys PG FAQ API to Cloud Run and writes its service URL |
| 15. deploy-cloudrun | Deploys the worker to Cloud Run with env vars, including `PG_FAQ_API_URL` |

**Key: Embedding is conditional.** The embed image, embed job creation, and embed job execution are skipped unless `TAG_NAME` contains `embed`. The worker and PG FAQ API images are still built/pushed, and both Cloud Run services are deployed.

**Timeout**: 40 minutes (2400s) — needed for first-time setup when the GCE VM is created and bge-m3 is downloaded.

### Important: repo config vs live VM config

For GCE mode, the `docker-compose.yml` in this repo and the `docker-compose.yml` actually running on the VM are not automatically kept in sync.

What happens in practice:

- The repo files are the source blueprint.
- When the GCE VM is first created, the startup script writes a compose file onto the VM.
- After that, the VM keeps using its own local copy of that file.
- If someone later updates the repo's `docker-compose.yml` or `scripts/gce-startup.sh`, the already-existing VM does **not** automatically pick up those changes.

This means:

- repo config and VM config may start aligned
- but they can drift over time
- fixing the repo alone does not change the currently running VM

Operational implication:

- if GCE behavior does not match the repo, check the live VM's compose file directly
- to apply repo-side infra changes to GCE mode, you usually need one of:
  - VM recreation
  - a manual update on the VM
  - startup logic that explicitly rewrites the VM file during deployment

Simple way to think about it:

- the repo file is the blueprint
- the VM file is the actual built house
- changing the blueprint later does not change the already-built house by itself

---

## 11. Logging and Analytics

### Structured logging format

Every conversation turn is logged as structured JSON:

```javascript
structuredLog("INFO", "conversation_turn", {
    session_id,          // UUID, persists across page reloads
    conversation_id,     // UUID, unique per /answer call
    message_id,          // UUID, unique per message (for feedback linking)
    username,            // Optional email entered by user
    question,            // User's original question
    rewritten_query,     // Query after rewriting
    query_source,        // "synonym", "llm", "original", or "rejected"
    rejection_reason,    // "prompt_injection", "fact_check_failed", or null
    documents,           // [{filename, relevance}] — retrieved docs
    response,            // The final response text
    fact_check_passed,   // boolean
    contains_raahat,     // boolean
    detected_language,   // "english", "hindi", "tamil", "hinglish"
    history_length,      // Number of history messages sent
    latency_ms,          // Total time from request to response
    error,               // Error message if any
});
```

### BigQuery pipeline

Cloud Logging → Log Sink (filter: `conversation_turn` or `user_feedback`) → BigQuery dataset (`chatbot_logs`)

The log sink is configured in Cloud Build step 0. It filters for the specific log messages and exports them to BigQuery for SQL-based analytics.

### Feedback logging

User feedback (thumbs up/down/report) is logged via the `/feedback` endpoint:

```javascript
structuredLog("INFO", "user_feedback", {
    session_id, message_id, question, response,
    feedback_type,      // "up", "down", "report"
    feedback_category,  // "wrong_info", "outdated", "unhelpful", "other"
    feedback_text,      // Free-text (max 1000 chars)
});
```

---

## 12. Debugging: Bot Not Giving Expected Answers

This is the most common issue. Here's a systematic approach:

### Problem: Bot says "I don't have the information" for a valid question

**Check in this order:**

1. **Is the information in the `src/` files?**
   - Grep the `src/` folder for the topic. If it's not there, the bot can't answer.

2. **Was `embed.py` re-run after the last `src/` change?**
   - If you edited a `src/` file but didn't re-embed, Weaviate has stale content. Run `embed.py` again.

3. **Is the query rewriting producing good keywords?**
   - Check the `[DEBUG] Query augmented:` log line. Does the rewritten query contain keywords that match the target document's Tags?
   - If not, consider adding a `QUERY_SYNONYMS` entry for this phrasing, or updating `KNOWLEDGE_BASE_SUMMARY` to include the missing keywords.

4. **Is Weaviate returning the right documents?**
   - Check the `[DEBUG] Weaviate returned N documents` log and the `documents` field in the conversation_turn log.
   - If the wrong documents are returned, the issue is in retrieval — check Tags, check alpha value, check if the right document is even in Weaviate.

5. **Is the fact-checker incorrectly rejecting?**
   - Check the `fact_check_passed` field in logs. If it's `false`, the fact-checker is killing a valid answer.
   - Common false rejection causes:
     - The answer references info from conversation history that isn't in the current context documents.
     - The answer combines information in a way the fact-checker considers "not supported".
     - Contact info in the answer isn't in the fact-checker's whitelist.
   - Fix: Add the contact info to `ALLOWED_CONTACT_LIST` in the fact-checker prompt, or adjust the fact-checker's strictness.

### Problem: Bot gives a wrong answer

1. **Check the context documents.** Are they correct? The bot can only be as accurate as its source documents.

2. **Check if the wrong document was retrieved.** If Weaviate returns `fees_and_payments.md` when the user asked about eligibility, the answer will be wrong. Fix Tags or add a synonym entry.

3. **Check for outdated content.** If the `src/` file has old information but was re-embedded, the bot will confidently give outdated answers. Update the source file and re-embed.

4. **Check the fact-checker logs.** If `fact_check_passed: true` but the answer is still wrong, the fact-checker failed to catch it. This typically happens when the wrong information is actually in the context documents (garbage in, garbage out).

### Problem: Bot gives a good answer in English but bad in Hindi/Tamil

1. **Check language detection.** Is the `[LANG:xxx]` tag correct? If the language is misdetected, the bot responds in the wrong language.

2. **Check query rewriting in that language.** Hinglish queries sometimes produce poor keyword rewrites. Consider adding QUERY_SYNONYMS entries for common Hinglish phrasings.

3. **Check if bge-m3 handles the language.** bge-m3 supports Hindi and Tamil, but performance varies. If vector search is returning irrelevant documents for non-English queries, the alpha parameter might need adjustment (higher alpha = more vector weight).

### Problem: Bot rejects most answers (too many "cannot answer")

1. **Fact-checker too strict.** The prompt says "don't be overly strict, don't be too lenient" — but the LLM's interpretation can drift. Check the `incorrect` array in fact-check logs for patterns.

2. **Context documents too short / missing information.** If retrieved documents barely cover the topic, the fact-checker may see the answer as unsupported.

3. **Conversation history confusing the fact-checker.** The retry-without-history mechanism handles some of this, but persistent issues may need the history feature to be disabled entirely (`ENABLE_HISTORY = false`, which is the current default).

### Problem: Same question gives different answers

- Answer generation uses `temperature: 0.1` — not zero, so slight variation is expected.
- Fact-checking uses `temperature: 0` — fully deterministic.
- Query rewriting uses `temperature: 0` — fully deterministic.
- If answers vary significantly, it's the answer generation temperature. Set `CHAT_MODEL` to a model with more consistent output, or discuss lowering to `0`.

---

## 13. Debugging: Infrastructure Issues

### Weaviate connection failures

```
Error: Weaviate error: ...
```

- **Local**: Is the Weaviate container running? `docker ps | grep weaviate`
- **GCE**: Can Cloud Run reach the GCE VM? Check VPC connector status and firewall rules. The VM should allow TCP 8080 and 11434 from 10.0.0.0/8.

### PG FAQ API failures (optional)

- **Local**: Is `pg-faq-api` running? `docker compose ps` and check port `8001`. Is `postgres` running?
- **Worker config**: Is `PG_FAQ_API_URL` set correctly (or using the default `http://pg-faq-api:8000` on the Docker network)?
- Behavior: if the PG FAQ API is unreachable, the worker should continue to answer normally, but “Did you mean?” suggestions will be empty.

### Embedding failures

```
EMBEDDING FAILED for filename.md
```

- Check if the file content is too large. Weaviate has a default property length limit.
- Check if Ollama is running and the bge-m3 model is pulled: `docker exec ollama ollama list`
- Check Weaviate logs for vectorizer errors: `docker logs iitm-weaviate`

### Worker startup issues

- Wrangler needs `.dev.vars` file with environment variables. The Dockerfile.worker generates this from env vars at startup.
- If running locally without Docker: create `.dev.vars` manually or use `cp .env .dev.vars`.

### Cloud Run cold starts

- Cloud Run instances scale to zero when idle. First request after idle period has ~2-5 second latency (cold start).
- The VPC connector adds additional cold start latency (~1-2 seconds).
- Mitigation: Cloud Run min instances can be set to 1, but this costs more.

---

## 14. Environment Variables Reference

| Variable | Used by | Required | Default | Purpose |
|---|---|---|---|---|
| `EMBEDDING_MODE` | embed.py, worker.js | No | `local` | `local` or `gce` |
| `LOCAL_WEAVIATE_URL` | embed.py, worker.js | For local mode | `http://weaviate:8080` | Local Weaviate URL |
| `GCE_WEAVIATE_URL` | embed.py, worker.js | For GCE mode | — | GCE VM Weaviate URL |
| `GCE_OLLAMA_URL` | embed.py, worker.js | For GCE mode | — | GCE VM Ollama URL |
| `PG_FAQ_API_URL` | worker.js | No | `http://pg-faq-api:8000` | Base URL for the PG FAQ API (semantic FAQ search + direct FAQ lookup) |
| `OPENAI_API_KEY` | worker.js | Yes (unless `CHAT_API_KEY` set) | — | API key for the chat endpoint (rewrite + answer + fact-check) when using OpenAI |
| `OLLAMA_MODEL` | embed.py, worker.js | No | `bge-m3` | Ollama embedding model |
| `CHAT_API_ENDPOINT` | worker.js | No | `https://api.openai.com/v1/chat/completions` | LLM API endpoint |
| `CHAT_API_KEY` | worker.js | No | Falls back to `OPENAI_API_KEY` | API key for chat endpoint |
| `CHAT_MODEL` | worker.js | No | `gpt-4o-mini` | LLM model for answer generation |
| `CLEAR_DB` | embed.py | No | `true` | `true` to clear Weaviate before embedding |
| `ENABLE_PG_FAQ_BOOTSTRAP` | embed.py | No | — | Enable FAQ DB bootstrap/backfill during embedding |
| `FAQ_SEED_PATH` | embed.py | No | `pg/seed/faqs.json` | Path to FAQ seed JSON (in the embed container) |
| `FAQ_SQL_DIR` | embed.py | No | `pg/init` | Directory containing SQL files to apply to Postgres |
| `FAQ_EMBEDDING_DIMENSION` | embed.py | No | `1024` | Expected FAQ embedding dimension |
| `FAQ_EMBEDDING_BATCH_SIZE` | embed.py | No | `50` | FAQ embedding backfill batch size |
| `PGHOST` | embed.py, pg-faq-api | For FAQ DB | — | Postgres host |
| `PGPORT` | embed.py, pg-faq-api | For FAQ DB | `5432` | Postgres port |
| `PGDATABASE` | embed.py, pg-faq-api | For FAQ DB | — | Postgres database name |
| `PGUSER` | embed.py, pg-faq-api | For FAQ DB | — | Postgres user |
| `PGPASSWORD` | embed.py, pg-faq-api | For FAQ DB | — | Postgres password |

**Note on `.dev.vars`**: Wrangler (Cloudflare Workers dev server) reads secrets from `.dev.vars`, not `.env`. The Dockerfile.worker generates `.dev.vars` from environment variables at container startup.

---

# Local vs GCE Mode

This project supports both `local` mode and `gce` mode, but they are not the same environment with a different URL. They are meaningfully different systems.

The simplest way to think about it is:

- `local` mode is a developer sandbox on one machine
- `gce` mode is a split cloud setup using Cloud Run, a private VM, and Cloud Build

If a developer does not understand this difference, they can easily misread infra issues as code issues.

## 1. Where each service runs

### Local mode

In `local` mode, most services run together on the developer's machine using Docker Compose:

- `worker` runs locally
- `weaviate` runs locally
- `ollama` runs locally
- optionally `postgres` and `pg-faq-api` also run locally

This means the whole system is mostly inside one Docker network on one machine.

### GCE mode

In `gce` mode, the system is split:

- `worker` runs on Cloud Run
- `embed.py` runs as a Cloud Run job
- `weaviate` runs on a GCE VM
- `ollama` runs on the same GCE VM
- Cloud Build handles deployment

So `gce` mode is not just "local but hosted in Google Cloud". The app is distributed across different services.

## 2. How services talk to each other

### Local mode

Containers talk over the local Docker network using container names such as:

- `http://weaviate:8080`
- `http://ollama:11434`

Everything stays on the developer machine.

### GCE mode

Cloud Run is not on the VM's Docker network. It reaches the VM over internal Google Cloud networking through a VPC connector.

That means the URLs are private VM URLs such as:

- `http://10.160.0.10:8080`
- `http://10.160.0.10:11434`

So:

- local mode uses Docker service discovery
- GCE mode uses private VM networking

## 3. Who owns and controls the environment

### Local mode

The developer has direct control:

- start containers with `docker compose up`
- stop containers with `docker compose down`
- inspect logs directly
- delete local volumes when needed

### GCE mode

The environment is owned by multiple cloud layers:

- Cloud Build for deployment
- Cloud Run for worker and embed job execution
- GCE VM for Weaviate and Ollama
- IAM, VPC, and firewall rules for access control

Because of that, debugging usually needs:

- Cloud logs
- `gcloud`
- sometimes SSH into the VM

## 4. Deployment behavior

### Local mode

There is usually no formal deployment. You edit code and rerun containers.

If you change `docker-compose.yml`, your next local run uses that new file immediately.

### GCE mode

Deployment happens through `cloudbuild.yaml`, usually triggered by git tags.

That process may:

- build and push images
- deploy the Cloud Run worker
- create or run the embed job
- create the VM if it does not already exist

Important detail:

- a code deployment does not automatically rebuild or reconfigure an already-existing VM

## 5. Repo config vs live VM config

This is one of the most important differences.

### Local mode

The `docker-compose.yml` in the repo is the same file being used when you run locally.

So if you edit the repo file, your local environment uses that updated file on the next run.

### GCE mode

The repo contains a startup script, [scripts/gce-startup.sh](/home/rdpuser/Desktop/ICSR/iitmdocs/scripts/gce-startup.sh:1), which writes a `docker-compose.yml` onto the VM when the VM is first created.

After that, the VM keeps using its own local file, for example:

- `/opt/iitm-chatbot/docker-compose.yml`

This means:

- the repo file and the live VM file may start aligned
- but they can drift over time
- changing the repo later does not automatically update the already-running VM

Simple way to think about it:

- the repo file is the blueprint
- the VM file is the built house
- changing the blueprint later does not automatically rebuild the house

## 6. Data persistence and reset behavior

### Local mode

Data is usually stored in Docker volumes on the developer machine, such as:

- `weaviate_data`
- `ollama_data`
- `postgres_data`

Resetting is easy:

```bash
docker compose --profile local down -v
docker compose --profile local up -d
```

### GCE mode

Data lives on the VM filesystem, for example:

- `/opt/iitm-chatbot/weaviate_data`
- `/opt/iitm-chatbot/ollama_data`

That data survives normal code deployments if the VM is reused.

This is why stale Weaviate state can survive across deployments and keep causing failures even when code changes.

## 7. Embedding path differences

### Local mode

`embed.py` talks to local Weaviate, and Weaviate uses the local Ollama container through `text2vec-ollama`.

Everything is close together on one machine.

### GCE mode

`embed.py` runs as a Cloud Run job, then:

1. Cloud Run talks to Weaviate on the VM
2. Weaviate on the VM talks to Ollama on the VM

So the GCE embedding path crosses more boundaries and depends on more moving parts being healthy at the same time.

## 8. Query-time behavior differences

### Local mode

The local setup is tightly coupled inside one Docker environment.

### GCE mode

At query time, the worker computes the query embedding by calling Ollama on the VM, then sends that vector to Weaviate for hybrid search.

This means the worker can appear healthy as a Cloud Run service even if downstream VM services are degraded.

In other words:

- Cloud Run health does not prove Weaviate health
- a working UI does not always mean the embed path is healthy

## 9. Failure patterns are different

### Local mode

Local failures are often simple:

- model not pulled
- env var missing
- local container not started
- local volume needs reset

These are usually easy to inspect and fix.

### GCE mode

GCE failures are often more operational:

- stale Weaviate state
- live VM config drift
- VPC or firewall problems
- Weaviate readiness failures
- Weaviate-to-Ollama timeout issues
- Cloud Run can reach the VM, but the service on the VM is unhealthy

These are harder to diagnose because the code may be correct while the environment is wrong.

## 10. Observability and debugging

### Local mode

Debugging is direct:

- `docker compose ps`
- `docker compose logs`
- `curl localhost:8080`
- inspect files on your machine

### GCE mode

Debugging is layered:

- Cloud Run logs
- Cloud Build logs
- `gcloud run services describe`
- `gcloud run jobs describe`
- SSH into the VM
- Docker logs on the VM

So GCE debugging is slower and often needs extra permissions.

## 11. Security and access model

### Local mode

The local setup is mainly optimized for convenience.

### GCE mode

The cloud setup depends on:

- IAM permissions
- service account permissions
- VPC connector setup
- firewall rules
- SSH access if VM inspection is needed

That is why fixing a VM-side issue required access to your GCP account and then access to the VM itself.

## 12. Why local success does not guarantee GCE success

A successful local-from-zero run proves:

- the code path works
- the services can work together in a clean environment

It does **not** prove:

- the live VM is healthy
- the VM config matches the repo
- the persisted Weaviate state is clean
- Cloud Run to VM networking is healthy
- the live Weaviate and Ollama timeouts are correct

This exact difference mattered during the Weaviate debugging work:

- local worked
- GCE still failed
- the real issue was stale VM state and outdated live VM config

## 13. Practical rule of thumb

When something breaks, ask this first:

Is this a code-path problem, or a live environment problem?

Good rule:

- if local-from-zero also fails, suspect code or intended config
- if local-from-zero works but GCE fails, strongly suspect VM state, config drift, cloud networking, or service startup behavior

That rule saves a lot of time.

## 14. Final summary

### Local mode in one line

Everything important runs on the developer machine, the repo config is the live config, and resets are easy.

### GCE mode in one line

The worker runs on Cloud Run, Weaviate and Ollama run on a private VM, the VM keeps its own state and config, and cloud debugging is required when infra problems happen.

---

## 15. Security Measures

### Prompt injection protection

User queries are sanitized before any processing:

```javascript
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /you\s+are\s+now\s+a?/gi,
    /pretend\s+(you\s+are|to\s+be)/gi,
    // ... 12 patterns total
];
```

If sanitization removes all content, the query is marked as `rejected` and the user sees a "cannot answer" message. The rejection is logged for monitoring.

### Query length limit

```javascript
const MAX_QUERY_LENGTH = 500; // Characters
```

### History validation

Conversation history is validated before use:
- Max 10 messages (5 Q&A pairs)
- Max 10,000 characters per message
- Only `user` and `assistant` roles accepted

### GraphQL injection prevention

Queries sent to Weaviate are sanitized to prevent GraphQL injection:

```javascript
const sanitizedQuery = query
    .replace(/\\/g, "\\\\")   // Escape backslashes
    .replace(/"/g, '\\"')     // Escape quotes
    .replace(/\n/g, " ");     // Remove newlines
```

### CORS policy

Currently permissive (`Access-Control-Allow-Origin: *`) to allow cross-origin embedding of the chatbot widget. The chatbot is designed to be embedded on external sites via an iframe.

### Feedback abuse prevention

- Feedback text is limited to 1,000 characters.
- Feedback types are validated against an allowlist (`up`, `down`, `report`).
- Categories are validated against an allowlist (`wrong_info`, `outdated`, `unhelpful`, `other`).

### Contact info whitelisting

The fact-checker has a hardcoded list of allowed contact information. Any contact info not on this list in a bot response will trigger a rejection:

```
Allowed emails: support@study.iitm.ac.in, iic@study.iitm.ac.in, ge@study.iitm.ac.in,
                students-grievance@study.iitm.ac.in, wellness.society@study.iitm.ac.in,
                any *@study.iitm.ac.in
Allowed phones: 7850999966, +91 63857 89630, 9444020900, 8608076093
```
