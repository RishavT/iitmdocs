# Setup Guide - Modified for Claude API

This chatbot has been modified to use **Claude API** (Anthropic) instead of OpenAI, making it perfect if you already have a Claude subscription!

## API Keys You'll Need

### 1. Anthropic Claude API Key (REQUIRED)
Since you have a Claude paid subscription, you already have access!

**Get your API key:**
1. Go to https://console.anthropic.com/
2. Log in with your Claude account
3. Navigate to "API Keys" section
4. Click "Create Key"
5. Copy the key (starts with `sk-ant-...`)

Note: The API has separate billing from your Claude subscription. New accounts get free credits to start.

### 2. Weaviate Cloud (REQUIRED - Free tier available)
Vector database for storing document embeddings.

**Sign up and get credentials:**
1. Go to https://console.weaviate.cloud/
2. Sign up (free 14-day sandbox, no credit card needed)
3. Create a new cluster:
   - Click "Create Cluster"
   - Choose "Free Sandbox"
   - Select region: `asia-southeast1` (or closest to you)
   - Enable "API Key" authentication
4. Once ready, get your credentials:
   - **Cluster URL**: Copy from cluster details (e.g., `https://xxx-xxx.weaviate.cloud`)
   - **API Key**: Copy from authentication section

### 3. Cohere API Key (REQUIRED - Free tier available)
For text embeddings (converting documents to vectors).

**Get your API key:**
1. Go to https://dashboard.cohere.com/
2. Sign up (free tier: 100 API calls/minute)
3. Go to "API Keys" section
4. Copy your Trial Key or create a new one

## Quick Setup with Docker

### Step 1: Configure Environment Variables

```bash
# Copy the example file
cp .env.example .env

# Edit with your actual API keys
nano .env  # or use your preferred editor
```

Your `.env` should look like:
```bash
WEAVIATE_URL=https://your-actual-cluster.weaviate.cloud
WEAVIATE_API_KEY=your-weaviate-key-here
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
COHERE_API_KEY=your-cohere-key-here
```

Also create `.dev.vars` (required by Cloudflare Wrangler):
```bash
cp .env .dev.vars
```

### Step 2: Run the Embedding Pipeline

This processes all markdown documents and uploads them to Weaviate:

```bash
docker-compose --profile embed up embed
```

You should see:
```
Processing 50+ files from src/
Embedded X documents
```

### Step 3: Start the Chatbot Server

```bash
docker-compose up worker
```

The server will start at http://localhost:8787

### Step 4: Test It Out

**Web Interface:**
- Open http://localhost:8787/qa.html in your browser
- Ask questions like:
  - "How do I register for courses?"
  - "What is the admission process?"
  - "Tell me about placements"

**API Test:**
```bash
curl http://localhost:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"q": "How do I register for courses?", "ndocs": 3}'
```

## Cost Estimates (All Free Tier Friendly!)

- **Weaviate**: Free 14-day sandbox (renew when expired)
- **Cohere**: 100 calls/min free (enough for embeddings)
- **Claude API**: $5 free credits for new accounts
  - Embedding 50 docs: ~$0.10
  - 100 questions: ~$0.50 (using Claude 3.5 Sonnet)

Total estimated cost for testing: **FREE** (within free tiers)

## Troubleshooting

### "Weaviate connection failed"
- Check your WEAVIATE_URL includes `https://`
- Verify your cluster is running in Weaviate console
- Check API key is correct

### "Claude API error: 401"
- Verify your ANTHROPIC_API_KEY is correct
- Make sure you've added payment method at console.anthropic.com
- Check you haven't exceeded rate limits

### "Cohere API error"
- Verify COHERE_API_KEY is correct
- Check you haven't exceeded free tier limits (100 calls/min)

### Port 8787 already in use
```bash
lsof -ti:8787 | xargs kill -9
docker-compose down
docker-compose up worker
```

## Development Workflow

**Update documents:**
1. Edit files in `src/` directory
2. Re-run embeddings: `docker-compose --profile embed up embed --build`
3. Restart worker: `docker-compose restart worker`

**View logs:**
```bash
docker-compose logs -f worker
```

**Rebuild everything:**
```bash
docker-compose down
docker-compose build --no-cache
docker-compose --profile embed up embed
docker-compose up worker
```

## Next Steps

- **Embed the chatbot**: Add `<script src="http://localhost:8787/chatbot.js" type="module"></script>` to any webpage
- **Deploy to production**: Follow the original README for Cloudflare Workers deployment
- **Customize**: Edit `worker.js` to change Claude model or system prompt
