# Docker Setup for IITM BS Chatbot

This guide explains how to run the IITM BS Chatbot using Docker Compose for local development.

## Prerequisites

- Docker and Docker Compose installed
- Weaviate Cloud account and API key
- OpenAI API key

## Quick Start

### 1. Configure Environment Variables

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

```bash
WEAVIATE_URL=https://your-cluster.weaviate.cloud
WEAVIATE_API_KEY=your-weaviate-api-key
OPENAI_API_KEY=your-openai-api-key
```

Also create `.dev.vars` with the same content (required by Wrangler):

```bash
cp .env .dev.vars
```

### 2. Run the Embedding Service

First, populate Weaviate with document embeddings:

```bash
docker-compose --profile embed up embed
```

This will:
- Build the Python environment
- Process all markdown files in `src/`
- Upload embeddings to Weaviate Cloud
- Exit when complete

### 3. Start the Worker Service

Once embeddings are complete, start the Cloudflare Worker:

```bash
docker-compose up worker
```

This will:
- Build the Node.js environment
- Start the Wrangler dev server
- Expose the API at http://localhost:8787

### 4. Test the Chatbot

Open your browser and visit:
- **Chat UI**: http://localhost:8787/qa.html
- **Demo Page**: http://localhost:8787/

Or test the API with curl:

```bash
curl http://localhost:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"q": "How do I register for courses?", "ndocs": 3}'
```

## Development Workflow

### Run Everything Together

```bash
# First time: run embeddings
docker-compose --profile embed up embed

# Then start the worker
docker-compose up worker
```

### Re-run Embeddings (when you update src/ files)

```bash
docker-compose --profile embed up embed --build
```

### View Logs

```bash
# Worker logs
docker-compose logs -f worker

# Embedding logs
docker-compose --profile embed logs embed
```

### Stop Services

```bash
docker-compose down
```

### Rebuild from Scratch

```bash
docker-compose down
docker-compose build --no-cache
docker-compose --profile embed up embed
docker-compose up worker
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Compose Environment                 │
│                                             │
│  ┌────────────────┐                        │
│  │  embed service │                        │
│  │  (Python)      │                        │
│  │                │                        │
│  │  - Reads src/  │                        │
│  │  - Uploads to  │──────────────┐         │
│  │    Weaviate    │              │         │
│  └────────────────┘              │         │
│                                  │         │
│  ┌────────────────┐              ▼         │
│  │ worker service │      ┌──────────────┐  │
│  │ (Node.js)      │      │   Weaviate   │  │
│  │                │◄─────┤    Cloud     │  │
│  │  - Wrangler    │      └──────────────┘  │
│  │    dev server  │              ▲         │
│  │  - Port 8787   │              │         │
│  └────────┬───────┘              │         │
│           │                      │         │
└───────────┼──────────────────────┼─────────┘
            │                      │
            ▼                      │
    http://localhost:8787          │
                                   │
                          ┌────────┴────────┐
                          │   OpenAI API    │
                          └─────────────────┘
```

## Troubleshooting

### Port 8787 already in use

```bash
# Find and kill the process using port 8787
lsof -ti:8787 | xargs kill -9
```

### Environment variables not loading

Make sure both `.env` and `.dev.vars` exist with identical content.

### Weaviate connection issues

Verify your `WEAVIATE_URL` and `WEAVIATE_API_KEY` are correct and the cluster is active.

### OpenAI API errors

Check that your `OPENAI_API_KEY` is valid and has sufficient credits.
