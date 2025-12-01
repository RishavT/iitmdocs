#!/bin/bash

echo "🔍 API Diagnostics for Chatbot Timeout Issue"
echo "==========================================="
echo ""

# Load environment variables
if [ -f .dev.vars ]; then
  export $(cat .dev.vars | grep -v '^#' | xargs)
fi

echo "1️⃣  Testing AI Pipe Chat Endpoint..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
timeout 15 curl -v -X POST "$CHAT_API_ENDPOINT" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello, respond with just OK"}]}' \
  2>&1 | head -30

echo -e "\n\n2️⃣  Testing Weaviate Health..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
timeout 15 curl -v "$WEAVIATE_URL/v1/.well-known/ready" \
  -H "Authorization: Bearer $WEAVIATE_API_KEY" \
  2>&1 | head -20

echo -e "\n\n3️⃣  Testing Weaviate GraphQL..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
timeout 15 curl -v -X POST "$WEAVIATE_URL/v1/graphql" \
  -H "Authorization: Bearer $WEAVIATE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{Get{Documents(limit:1){content}}}"}' \
  2>&1 | head -30

echo -e "\n\n4️⃣  Testing Cohere Embeddings..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
timeout 15 curl -v -X POST https://api.cohere.ai/v1/embed \
  -H "Authorization: Bearer $COHERE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"texts":["test"],"model":"embed-multilingual-v3.0"}' \
  2>&1 | head -30

echo -e "\n\n5️⃣  Testing Weaviate with Cohere Embedding..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
timeout 30 curl -v -X POST "$WEAVIATE_URL/v1/graphql" \
  -H "Authorization: Bearer $WEAVIATE_API_KEY" \
  -H "X-Cohere-Api-Key: $COHERE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ Get { Documents(nearText: {concepts: [\"grading\"]}, limit: 1) { content } } }"}' \
  2>&1 | head -40

echo -e "\n\n📊 Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check above for:"
echo "  - Connection timeouts (took > 15-30 seconds)"
echo "  - HTTP errors (401, 403, 500, etc.)"
echo "  - Network errors (Could not resolve host, Connection refused)"
echo ""
echo "If AI Pipe timed out → Switch to standard OpenAI endpoint"
echo "If Weaviate timed out → Check Weaviate dashboard status"
echo "If Cohere timed out → Switch to OpenAI embeddings"
echo ""
