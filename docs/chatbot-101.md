# Chatbot 101 — How the IITM BS Admissions Chatbot Works

This document explains the end-to-end working of the chatbot — from the moment a user types a question to the moment they see the bot's answer. It is written to be a quick-start reference for anyone working on this codebase.

Keep this file updated whenever the bot's logic changes.

---

## Repository Structure at a Glance

| Folder / File | What it does |
|---|---|
| `worker.js` | The **brain of the chatbot**. Handles everything on the backend — receiving questions, rewriting queries, searching the knowledge base, generating answers, fact-checking, and streaming the response back. |
| `src/` | Contains topic markdown files (e.g., fees, eligibility, placements). This is the knowledge base. Each file has structured information and a `Tags` line at the bottom with keywords. |
| `embed.py` | A Python script that reads all files from `src/` and pushes them into the vector database (Weaviate). You run this whenever you add or change a `src/` file. |
| `pg/faq_api/` (PG FAQ API) | A small backend service that searches FAQs stored in a **Postgres database** (using embeddings) and returns the closest matching FAQ questions/answers. Used for **"Did you mean?" suggestions** and **direct FAQ answers** when the user clicks a suggestion. |
| `pg/seed/faqs.json` | The source-of-truth FAQ seed file for the Postgres FAQ database. During FAQ bootstrap, existing FAQ rows are replaced with this file's rows, then embeddings are regenerated. FAQ questions in this file must be unique; duplicate questions fail bootstrap before Postgres is touched. |
| `static/chatbot.js` | The **frontend widget** — the floating "Need Help?" button that you see on the website. It creates the chat window (an iframe) and handles opening/closing/fullscreen. |
| `static/qa.html` | The **chat interface** inside the iframe. Contains the input box, send button, consent overlay, and feedback buttons. |
| `static/qa.js` | The **frontend logic** — sends the user's question to the backend, receives the streamed response, renders it with a typing animation, handles "Did you mean?" clicks, and manages feedback (thumbs up/down/report). |
| `static/doc-viewer.js` | Opens referenced source documents in a popup when the user clicks on a "References" link. Fetches the raw markdown from GitHub and renders it. |
| `static/doc-viewer.css` | Styles for the document viewer popup. |
| `static/index.html` | A demo page that loads the chatbot widget. |
| `pdfsrc/` | Raw source documents (handbooks, PDFs converted to markdown). Used for comparing old vs new versions and tracking what changed. Not part of the live chatbot. |
| `prompts/` | Prompt templates used during knowledge base updates (e.g., how to compare documents). Not part of the live chatbot. |
| `generate-summary-prompt.txt` | Instructions for regenerating the knowledge base summary used in query rewriting. |
| `test-questions/` | Test question files for evaluating chatbot quality. |
| `chatbot.test.js`, `worker.test.js`, `qa.test.js` | Automated tests for the backend and frontend. |
| `docker-compose.yml`, `Dockerfile.*` | Docker setup for running the chatbot locally with Weaviate and Ollama. |
| `wrangler.toml` | Cloudflare Workers configuration (for cloud deployment). |

---

## The Pipeline: User Question to Bot Answer

Here is exactly what happens when a user types a question and hits "Ask":

### Step 1: Frontend sends the question

- The user types a question in the chat window (`qa.html`).
- The question must be at least **5 words** — the "Ask" button stays disabled until this threshold is met.
- When submitted, `qa.js` sends a POST request to the backend (`/answer` endpoint in `worker.js`) with: the question, session ID, message ID, username (optional), and conversation history.

### Step 2: Query sanitization (prompt injection protection)

- The backend immediately **sanitizes** the question to prevent prompt injection attacks.
- It strips out patterns like "ignore previous instructions", "you are now a...", "pretend to be...", etc.
- It also enforces a **500-character limit** on the question.
- If sanitization removes all content (meaning the entire question was an injection attempt), the query is **rejected** immediately — the user sees a "cannot answer" message.

### Step 3: Query rewriting

This is where the chatbot figures out what the user actually wants and translates their question into something the search engine can find. There are **two paths**:

#### Fast path — Synonym matching
- The bot first checks if the question matches any entry in `QUERY_SYNONYMS` — a hand-curated mapping of common phrasings to keyword-rich search queries.
- Example: If the user asks "how is grade calculated", it matches the synonym pattern and gets rewritten to include keywords like "grading formula score calculation GAA quiz end term OPPE weightage".
- This is instant (no API call needed) and very reliable for known question patterns.

#### Slow path — LLM rewriting
- If no synonym matches, the bot calls an LLM (gpt-4o-mini) to rewrite the query.
- Before sending to the LLM, **common grammatical stopwords are removed** from the query (words like "what", "is", "the", "how", "please", etc.). This reduces phrasing variance so that "what is the fee structure" and "fee structure" produce the same rewrite. Domain-sensitive words like "may" (month name), "not", "no", "only", and "free" are **never removed** even though they look like stopwords — they carry meaning in this context.
- The LLM receives `KNOWLEDGE_BASE_SUMMARY` — a compact list of all 16 topics with 8-12 discriminating keywords each — so it knows what topics exist and can map the user's question to the right keywords.
- The LLM also detects the user's **language** (English, Hindi, Tamil, or Hinglish) and appends a `[LANG:xxx]` tag to the rewritten query. This tag is stripped before search but used later to respond in the correct language.
- The LLM also fixes **spelling mistakes** in education-related words (e.g., "qualifer" → "qualifier").
- The rewritten query always combines the user's **original question** (with stopwords intact) with the LLM-added keywords — the original question is never thrown away. Stopword removal only affects what the LLM sees, not what goes into the final search query.

### Step 4: Searching the knowledge base

- The rewritten query is sent to **Weaviate** (the vector database) using **hybrid search**.
- Hybrid search combines two approaches:
  - **Keyword matching**: Looks for exact/partial word matches in the documents. This is where the `Tags` line at the bottom of each `src/` file matters — those keywords make documents findable by specific terms.
  - **Meaning-based matching**: Converts the query and documents into numerical representations (vectors) and finds documents with similar meaning, even if they use different words.
- The search uses a **balanced 50/50 mix** of keyword matching and meaning-based matching.
- By default, the **top 2 documents** are returned as context.

### Step 5: Generating the answer

- The retrieved documents are wrapped in `<document>` tags and sent to the main LLM along with:
  - A system prompt that tells the bot how to behave (be helpful, be factual, use markdown, refuse cheating questions, etc.)
  - The conversation history (previous Q&A pairs, if any)
  - The user's original question
- The LLM generates a **non-streaming** response (the full answer is collected at once, not streamed word-by-word). This is important because the answer needs to go through fact-checking before the user sees it.
- The system prompt also includes instructions for handling **mental health / emotional distress** queries — the bot must not give advice itself, and must only direct the user to RAAHAT (the institute's wellness society).

### Step 6: RAAHAT handling (mental health detection)

- Before fact-checking, the bot checks if the answer contains **RAAHAT-related content** (mentions of the wellness society, their email, etc.).
- If the answer is purely about mental health, the bot replaces whatever the LLM generated with a **standardized RAAHAT message** — this ensures consistent, accurate mental health referral information every time.
- If the answer mixes RAAHAT content with other factual content (e.g., the user asked about exam stress AND academic policies), the bot:
  - Fact-checks only the non-RAAHAT part
  - If that part passes, shows both parts (factual info + standardized RAAHAT message)
  - If that part fails, shows only the standardized RAAHAT message

### Step 7: Fact-checking

- The bot's generated answer is sent to a **separate LLM call** (gpt-4o-mini) for fact-checking.
- The fact-checker receives:
  - The **bot's answer** (what the bot wants to say)
  - The **context documents** (the source documents retrieved from the knowledge base)
  - The **conversation history** (if any)
- The fact-checker does **NOT** receive the user's original question. It only checks: "Is this answer supported by these documents?"
- The fact-checker returns a JSON response: either `{"approved": "YES"}` or `{"approved": "NO", "incorrect": ["reason"]}`.
- If the fact-check fails and conversation history was included, the bot **retries without history** — sometimes the history confuses the fact-checker.

#### When does the fact-checker reject an answer?

- The answer contains **made-up facts** not found in the context documents (wrong numbers, dates, procedures)
- The answer gives **random advice** to students
- The answer contains **prohibited content** (cheating advice, personal contact info not in the allowed list, emotional/dating/sexual advice)
- The answer contains **contact information** not on the approved list (specific emails and phone numbers are whitelisted)

#### When does the fact-checker approve an answer?

- Facts align with the context documents
- The answer paraphrases or combines information from the documents
- Numbers are numerically equivalent (e.g., "3L" = "3,00,000" = "300000" — these are all treated as the same)
- Contact info is from the approved list

### Step 8: Response delivery

- **If fact-check passes**: The answer is streamed back to the user as Server-Sent Events (SSE).
- **If fact-check fails**: The user sees a "cannot answer" message in their detected language, along with **"Did you mean?" FAQ suggestions**.
  - These suggestions come from the **PG FAQ API**, which searches a Postgres FAQ database for the closest matching FAQ questions for the user's query.
  - The backend formats the results as a short numbered list. Each suggestion includes an internal id like `[FAQID:123]` so the frontend can make it clickable.
- Before the answer text, the bot also streams **document references** — links to the source files that were used, displayed as a collapsible "References" section in the UI.

### Step 9: Frontend rendering

- `qa.js` receives the streamed response and renders it with a **typing animation** (characters appear gradually).
- Markdown in the response is rendered as HTML (headers, bold, links, lists, etc.).
- The "Did you mean?" suggestions are converted into **clickable buttons**.
- Each response gets **feedback buttons** (thumbs up, thumbs down, report) for the user to provide feedback.

### Step 10: "Did you mean?" FAQ direct lookup

- When the user clicks a "Did you mean?" suggestion, the frontend sends the request with a `faq_id` parameter (the id inside `[FAQID:...]`) and the question text.
- The backend **skips the entire pipeline** (no query rewriting, no LLM answer generation, no fact-checking).
- It calls the **PG FAQ API** to fetch the FAQ by id and returns that question + answer directly — this is fast and guaranteed accurate (because it is a direct lookup).

### Step 11: FAQ seed bootstrap

- `pg/seed/faqs.json` is the source of truth for the Postgres FAQ database.
- When FAQ bootstrap is enabled, `embed.py` replaces the existing FAQ rows with the rows from `pg/seed/faqs.json`.
- After inserting the seed rows, `embed.py` generates embeddings for the FAQ questions.
- Duplicate FAQ questions are not allowed in `pg/seed/faqs.json`. If duplicates are found, bootstrap fails before modifying Postgres.

---

## Common Pitfalls

These are things that are easy to get wrong when making changes. Read this section carefully.

### 1. Tags in `src/` files vs KNOWLEDGE_BASE_SUMMARY in `worker.js` — they serve different purposes

- **Tags** (at the bottom of each `src/` file): These are keywords for the **search engine** (Weaviate). More keywords = better recall. Be generous with synonyms and variations.
- **KNOWLEDGE_BASE_SUMMARY** (in `worker.js`): These are keywords for the **query rewriting LLM** (gpt-4o-mini). Fewer, more discriminating keywords = better precision. Only 8-12 keywords per topic. The LLM needs to tell topics apart, not find every synonym.
- **Do not copy-paste Tags into KNOWLEDGE_BASE_SUMMARY or vice versa.** They are optimized for different consumers.

### 2. The fact-checker does NOT see the user's question

- The fact-checker only receives the bot's answer + context documents + conversation history.
- It does **not** know what the user asked. This is by design — the fact-checker's job is to verify "is this answer supported by these documents?", not "is this answer relevant to the question?".
- If you change the fact-checker prompt, keep this in mind.

### 3. The answer is NOT streamed from the LLM

- Even though the user sees a typing animation, the actual LLM call is **non-streaming** (`stream: false`).
- The full answer is collected first, fact-checked, and only then sent to the frontend as a single SSE chunk.
- The typing animation in `qa.js` simulates streaming for a better user experience.

### 4. Query rewriting always preserves the original question

- The rewritten query is: `original question + LLM keywords + [LANG:tag]` (or `original question + synonym keywords`).
- The original question is never thrown away. This is important for FAQ matching — the search needs to see the user's exact words.
- Stopword removal only affects what the LLM sees for rewriting — the original question (with stopwords) is still included in the final search query.

### 5. `embed.py` excludes `_knowledge_base_summary.md`

- The file `src/_knowledge_base_summary.md` (if it exists) is explicitly excluded from embedding. The query rewriter relies on the `KNOWLEDGE_BASE_SUMMARY` string constant in `worker.js` at runtime, rather than this markdown file.
- The exclusion is controlled by the `EXCLUDED_FILES` list in `embed.py`.

### 6. Rejected responses are excluded from conversation history

- When the fact-checker rejects a response, the SSE chunk includes `rejected: true`.
- The frontend sees this flag and does **not** save that exchange to conversation history.
- This prevents bad answers from poisoning future queries in the same session.

### 7. RAAHAT messages are always standardized

- The bot never passes through the LLM's version of RAAHAT content. It always replaces it with the `STANDARD_RAAHAT_MESSAGE` constant in `worker.js`.
- This ensures the wellness society contact info is always correct and consistent.

### 8. The chatbot supports 4 languages

- English, Hindi, Tamil, and Hinglish (Hindi written in English script).
- Language is detected during query rewriting (the `[LANG:xxx]` tag).
- The "cannot answer" message and "Did you mean?" header are translated.
- The LLM is instructed to respond in the detected language.

---

## How to Update the Knowledge Base

1. Edit or add markdown files in `src/`. Each file should have:
   - Structured information at the top
   - A `Tags:` line at the very end with relevant keywords

2. Run `embed.py` to push changes into Weaviate. The script is smart about updates — it only re-embeds files whose content has changed (based on SHA256 hash).

3. If you added a new topic or significantly changed what a topic covers, also update `KNOWLEDGE_BASE_SUMMARY` in `worker.js` with 8-12 discriminating keywords for the new/changed topic.

4. If there are common ways users might phrase questions about your new content, consider adding entries to `QUERY_SYNONYMS` in `worker.js` for fast-path matching.

---

## Key Configuration in `worker.js`

| Constant | Purpose |
|---|---|
| `ENABLE_HISTORY` | Toggle multi-turn conversations on/off (currently `false`) |
| `MAX_QUERY_LENGTH` | Maximum user question length (500 chars) |
| `QUERY_SYNONYMS` | Fast-path mappings from common phrasings to keyword-rich queries |
| `KNOWLEDGE_BASE_SUMMARY` | Compact topic list for LLM query rewriting (8-12 keywords per topic) |
| `CONTACT_INFO` | Centralized contact email and phone number |
| `CANNOT_ANSWER_MESSAGES` | "Cannot answer" messages in all 4 supported languages |
| `STANDARD_RAAHAT_MESSAGE` | Standardized mental health referral message |
| `INJECTION_PATTERNS` | Regex patterns for prompt injection detection |
| `OUT_OF_SCOPE_KEYWORDS` | Keywords for obviously off-topic questions (currently disabled) |
| `STOPWORDS` | Grammatical words removed from queries before LLM rewriting (e.g., "what", "is", "the") |
| `STOPWORDS_TO_IGNORE` | Domain-sensitive words that must never be removed (e.g., "may", "not", "free") |
| `RELEVANCE_THRESHOLD` | Minimum document relevance score to include in context (0.05 = 5%) |

---

## Logging and Feedback

- Every conversation turn is logged as a structured JSON object (for BigQuery export). The log includes: question, rewritten query, query source (synonym/llm/original), documents used, the response, fact-check result, language, latency, and any errors.
- User feedback (thumbs up/down/report) is logged separately via the `/feedback` endpoint.
- All logs include `session_id` and `message_id` for tracing conversations.

---

## Deployment Modes

The chatbot supports two modes for the vector database:

| Mode | When to use | How it connects |
|---|---|---|
| `local` | Development on your machine | Docker Compose runs Weaviate + Ollama locally |
| `gce` | Running on a Google Cloud VM | Connects to Weaviate and Ollama on the VM |

The mode is set via the `EMBEDDING_MODE` environment variable and affects both `embed.py` and `worker.js`.


---

# Personal doubts

**Before you touch the tags section, first  of all explain me in simple language, what exactly is the use of tags section? I want your answer in context of KNOWLEDGE_BASE_SUMMARY inside worker.js file and the hybrid search method used to retrieve the relevant docs.**   

Sure. Here's how it all fits together:

  The retrieval pipeline has two stages

  Stage 1: Query Rewriting (uses KNOWLEDGE_BASE_SUMMARY)

  When a user asks a question, gpt-4o-mini rewrites it into a keyword-rich search query. To do this well, the LLM needs to know what topics
  exist so it can route the question to the right domain.

  That's what KNOWLEDGE_BASE_SUMMARY in worker.js provides — a compact list of all 16 topics with 8-12 discriminating keywords each. The
  goal here is precision — help the LLM tell topics apart. Too many overlapping keywords across topics would confuse it.

  Example: User asks "how much does it cost?" → LLM reads KNOWLEDGE_BASE_SUMMARY, sees fees_and_payments has keywords like "fee structure,
  course fees, waiver" → rewrites the query to include those keywords.

  Stage 2: Hybrid Search in Weaviate (uses Tags)

  The rewritten query is then sent to Weaviate, which runs hybrid search — a 50/50 mix of:

  - BM25 (keyword matching): Looks for exact word matches in the document text. This is where Tags matter. BM25 scores a document higher
  when query words appear in it. Tags artificially boost a document's keyword surface area — they add synonyms, abbreviations, and alternate
   phrasings that users might type but the main document text doesn't contain.
  - Vector search (semantic matching): Converts the query into a numerical vector and finds documents with similar meaning. Tags don't
  really matter here — this works on meaning, not exact words.

  So Tags specifically help the BM25 half of hybrid search

  Without Tags, if a user types "fee waiver" but the document body only says "concession for SC/ST candidates", BM25 wouldn't match well.
  But because the Tags line contains fee waiver, SC ST PwD OBC-NCL EWS, 50% 75% waiver, concession, BM25 can now match that document.

  The key rule: don't mix them

  ┌───────────────┬───────────────────────────────────────────┬─────────────────────────────────────────────────────┐
  │               │          KNOWLEDGE_BASE_SUMMARY           │                        Tags                         │
  ├───────────────┼───────────────────────────────────────────┼─────────────────────────────────────────────────────┤
  │ Where         │ worker.js                                 │ Bottom of each src/*.md file                        │
  ├───────────────┼───────────────────────────────────────────┼─────────────────────────────────────────────────────┤
  │ Who reads it  │ gpt-4o-mini (the query rewriter)          │ Weaviate BM25 search engine                         │
  ├───────────────┼───────────────────────────────────────────┼─────────────────────────────────────────────────────┤
  │ Goal          │ Help LLM pick the right topic (precision) │ Help search engine find the right document (recall) │
  ├───────────────┼───────────────────────────────────────────┼─────────────────────────────────────────────────────┤
  │ Keyword count │ Few (8-12), unique per topic              │ Many, generous with synonyms and variations         │
  └───────────────┴───────────────────────────────────────────┴─────────────────────────────────────────────────────┘

  Think of it this way: KNOWLEDGE_BASE_SUMMARY is the signpost ("which road to take"), and Tags are the street addresses ("find the exact
  house on that road"). One helps the LLM decide what to search for, the other helps the search engine find the right document.
