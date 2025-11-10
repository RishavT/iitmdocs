# Quick Guide: Get Your API Keys

## 1. Claude/Anthropic API Key ⚡
**You already have a Claude subscription - this gives you access!**

### Steps:
1. Visit: https://console.anthropic.com/
2. Log in with your Claude account
3. Click "API Keys" in the left sidebar
4. Click "Create Key"
5. Give it a name (e.g., "IITM Chatbot")
6. Copy the key (format: `sk-ant-api03-...`)

**Important Notes:**
- API billing is separate from your subscription
- New accounts get $5 free credits
- This chatbot costs ~$0.50 for 100 questions

---

## 2. Weaviate Cloud API Key 🗄️
**Free 14-day sandbox (no credit card needed)**

### Steps:
1. Visit: https://console.weaviate.cloud/
2. Click "Sign Up" (use email or GitHub)
3. After login, click "Create Cluster"
4. Choose these settings:
   - **Cluster Name**: `iitm-chatbot` (or any name)
   - **Type**: Free Sandbox ✓
   - **Region**: `asia-southeast1-gcp` (or nearest)
   - **Weaviate Version**: Latest
   - **Authentication**: Enable "API Key" ✓
5. Click "Create"
6. Wait 1-2 minutes for cluster to be ready
7. Click on your cluster to open details
8. Copy two things:
   - **Cluster URL**: From "Details" tab (e.g., `https://abc123xyz.weaviate.cloud`)
   - **API Key**: From "Authentication" section (click "Reveal" button)

**Expiry**: Free sandbox expires after 14 days, but you can create a new one

---

## 3. Cohere API Key 🔤
**Free tier: 100 API calls/minute (plenty for embeddings)**

### Steps:
1. Visit: https://dashboard.cohere.com/
2. Click "Sign Up" (use email or Google)
3. After login, you'll see the dashboard
4. Click "API Keys" in the left sidebar
5. You'll see a "Trial Key" already created
6. Copy the key (format: `xyz123abc...`)

**Optional**: Create a new key:
- Click "Create API Key"
- Name it (e.g., "IITM Chatbot")
- Copy the key

**Free Tier Limits:**
- 100 requests/minute
- Plenty for embedding 50+ documents
- No credit card required

---

## Summary Checklist

Once you have all three keys, you'll need:

```bash
# 1. Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx...

# 2. Weaviate Cloud
WEAVIATE_URL=https://xxxxx.weaviate.cloud
WEAVIATE_API_KEY=xxxxx...

# 3. Cohere
COHERE_API_KEY=xxxxx...
```

Save these in your `.env` file and `.dev.vars` file!

---

## Estimated Time
- **Anthropic**: 2 minutes (you already have an account!)
- **Weaviate**: 5 minutes (including cluster creation wait time)
- **Cohere**: 2 minutes

**Total: ~10 minutes**

## Need Help?

**Anthropic Console Issues?**
- Make sure you're logged into https://console.anthropic.com/ (not claude.ai)
- Check your email for verification link
- Try clearing browser cache/cookies

**Weaviate Cluster Not Starting?**
- Wait up to 3 minutes
- Refresh the page
- Try a different region if it fails

**Cohere Sign-up Issues?**
- Use a different email provider if sign-up fails
- Try signing up with Google instead of email

---

## Security Notes

- **Never commit API keys to git** (they're in `.gitignore`)
- **Never share your keys** publicly
- **Rotate keys** if you suspect they're compromised
- Each service has a "Regenerate Key" option if needed
