// Validation helpers for hallucination detection
const OUT_OF_SCOPE_KEYWORDS = [
  'capital', 'country', 'cook', 'recipe', 'weather', 'sports',
  'movie', 'music', 'celebrity', 'politics', 'quantum physics',
  'fix.*car', 'lose.*weight', 'stock market', 'cryptocurrency',
  'world cup', 'pizza', 'guitar', 'hack'
];

function isLikelyOutOfScope(question) {
  const questionLower = question.toLowerCase();
  return OUT_OF_SCOPE_KEYWORDS.some(keyword =>
    new RegExp(`\\b${keyword}`, 'i').test(questionLower)
  );
}

// Knowledge base summary for query rewriting context
const KNOWLEDGE_BASE_SUMMARY = `Topics available in knowledge base:
1. ADMISSION: apply, application, qualifier, eligibility, JEE entry, DAD, documents, enroll, join
2. PROGRAMME STRUCTURE: foundation, diploma, BSc, BS, levels, credits, certificates, exit points
3. COURSES: PDSA, DBMS, MLF, MLT, MAD, BDM, Python, Java, electives, syllabus, curriculum
4. FEES: cost, waiver, scholarship, loan, payment, per credit, fee structure, affordable
5. ASSESSMENTS: exam, quiz, OPPE, grade, marks, score, pass, fail, assignment, eligibility
6. CALENDAR: term, semester, schedule, deadline, registration, dates, January, May, September
7. POLICIES: CCC, probation, struck off, repeat, drop, plagiarism, LLM usage, honor code
8. PLACEMENTS: job, career, internship, salary, recruiter, company, employment, hiring
9. HIGHER STUDIES: masters, MTech, MS, PhD, GATE, research, campus upgrade, CFTI
10. CREDIT TRANSFER: NPTEL, apprenticeship, campus courses, transfer fee
11. STUDENT LIFE: house, club, society, wellness, grievance, community
12. TECHNICAL: laptop, software, hardware, system requirements, internet
13. CERTIFICATES: degree, transcript, merit, distinction, topper
14. CONTACT: email, phone, support, office address`;

/**
 * Rewrites a user query to improve search relevance.
 * Uses knowledge base summary as context for better disambiguation.
 * @param {string} query - The original user query
 * @param {Object} env - Environment variables containing API keys
 * @returns {Promise<string>} - The rewritten query for search
 */
async function rewriteQuery(query, env) {
  const systemPrompt = `You are a search query optimizer for an IIT Madras BS programme chatbot.

${KNOWLEDGE_BASE_SUMMARY}

Your job: Rewrite the user query to match document keywords for better search results.

RULES:
1. Output ONLY the rewritten query - no explanations, no quotes
2. Add 3-5 relevant keywords from the topics above
3. Keep it under 50 words
4. Disambiguate intent: "apply" likely means admission (not job application)
5. Handle Hinglish: "kitna" = how much, "kab" = when, "kya" = what, "hai" = is

Examples:
- "how do i apply" → "admission application process qualifier exam eligibility how to apply"
- "fee kitna hai" → "fee cost structure payment foundation diploma degree fees"
- "placement milega" → "job placement career salary recruiter internship employment"
- "GATE dena padega" → "GATE masters MTech MS PhD higher studies research"
- "course repeat kar sakte hai" → "course repeat policy fail retake fee academic"`;

  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  try {
    console.log('[DEBUG] Rewriting query:', query);
    const response = await fetch(chatEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chatApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        temperature: 0,
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      console.error('[DEBUG] Query rewrite API failed, using original query');
      return query;
    }

    const result = await response.json();
    const rewrittenQuery = result.choices?.[0]?.message?.content?.trim() || query;
    console.log('[DEBUG] Query rewritten:', query, '→', rewrittenQuery);
    return rewrittenQuery;
  } catch (error) {
    console.error('[DEBUG] Query rewrite error:', error.message);
    return query; // Fallback to original query on error
  }
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Only handle POST /answer
    const url = new URL(request.url);
    if (request.method == "POST" && url.pathname == "/answer") {
      return await answer(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function answer(request, env) {
  console.log('[DEBUG] answer() called');
  const { q: question, ndocs = 5, history = [] } = await request.json();
  console.log('[DEBUG] Question:', question);
  if (!question) return new Response('Missing "q" parameter', { status: 400 });

  // Validate ndocs to prevent resource exhaustion
  const numDocs = parseInt(ndocs);
  if (isNaN(numDocs) || numDocs < 1 || numDocs > 20) {
    return new Response('Invalid "ndocs" parameter. Must be between 1 and 20', { status: 400 });
  }

  // Early detection: Check if question is VERY obviously out of scope (only extreme cases)
  // Disabled for now to avoid false positives - let the LLM handle it with the prompt
  // if (isLikelyOutOfScope(question)) {
  //   const encoder = new TextEncoder();
  //   const safeResponse = "I don't have information about this topic. I can only answer questions about the IIT Madras BS programme, including admissions, courses, fees, academic policies, and related topics. Please ask a question related to the IIT Madras BS programme.";
  //   const stream = new ReadableStream({
  //     start(controller) {
  //       controller.enqueue(encoder.encode(`data: ${JSON.stringify({
  //         choices: [{ delta: { content: safeResponse } }]
  //       })}\n\n`));
  //       controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  //       controller.close();
  //     }
  //   });
  //   return new Response(stream, {
  //     headers: {
  //       "Content-Type": "text/event-stream",
  //       "Access-Control-Allow-Origin": "*",
  //     },
  //   });
  // }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Rewrite query for better search relevance
        const searchQuery = await rewriteQuery(question, env);

        // Search Weaviate for relevant documents using rewritten query
        const documents = await searchWeaviate(searchQuery, numDocs, env);
        // Stream documents first (single enqueue)
        if (documents?.length) {
          // Use configurable repository URL or default
          const repoUrl = env.GITHUB_REPO_URL || "https://github.com/study-iitm/iitmdocs";
          const sseDocs = documents
            .map(
              (doc) =>
                `data: ${JSON.stringify({
                  role: "assistant",
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            function: {
                              name: "document",
                              arguments: JSON.stringify({
                                relevance: doc.relevance,
                                name: doc.filename.replace(/\.md$/, ""),
                                link: `${repoUrl}/blob/main/src/${doc.filename}`,
                              }),
                            },
                          },
                        ],
                      },
                    },
                  ],
                })}\n\n`,
            )
            .join("");
          controller.enqueue(encoder.encode(sseDocs));
        }

        // Generate AI answer using documents as context (with fact-checking)
        const answerResponse = await generateAnswer(question, documents, history, env);
        // Pipe the SSE response to the client
        await answerResponse.body.pipeTo(
          new WritableStream({
            write: (chunk) => controller.enqueue(chunk),
            close: () => controller.close(),
            abort: (reason) => controller.error(reason),
          }),
        );
      } catch (error) {
        const errorMessage = `data: ${JSON.stringify({
          error: {
            message: error.message || "An error occurred while processing your request",
            type: "server_error",
          },
        })}\n\n`;
        controller.enqueue(encoder.encode(errorMessage));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Get embeddings from Ollama API
 * @param {string} text - The text to embed
 * @param {string} ollamaUrl - The Ollama API URL
 * @param {string} model - The embedding model name
 * @returns {Promise<number[]>} - The embedding vector
 */
async function getOllamaEmbedding(text, ollamaUrl, model = "mxbai-embed-large") {
  console.log('[DEBUG] Getting embedding from Ollama:', ollamaUrl);
  const response = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[DEBUG] Ollama embedding error:', errorText);
    throw new Error(`Ollama embedding failed: ${response.status}`);
  }

  const result = await response.json();
  console.log('[DEBUG] Ollama embedding received, vector length:', result.embedding?.length);
  return result.embedding;
}

async function searchWeaviate(query, limit, env) {
  console.log('[DEBUG] searchWeaviate() called, query:', query);

  // Determine embedding mode: 'local', 'gce', or 'cloud'
  const embeddingMode = env.EMBEDDING_MODE || "cloud";
  console.log('[DEBUG] Embedding mode:', embeddingMode);

  // Configure Weaviate URL and headers based on mode
  let weaviateUrl;
  const embeddingHeaders = {
    "Content-Type": "application/json",
  };

  if (embeddingMode === "local") {
    // Local mode: connect to local Weaviate (no auth needed)
    weaviateUrl = env.LOCAL_WEAVIATE_URL || "http://weaviate:8080";
    console.log('[DEBUG] Using local Weaviate at:', weaviateUrl);
  } else if (embeddingMode === "gce") {
    // GCE mode: connect to remote Weaviate on GCE VM
    weaviateUrl = env.GCE_WEAVIATE_URL;
    console.log('[DEBUG] Using GCE Weaviate at:', weaviateUrl);
  } else {
    // Cloud mode: connect to Weaviate Cloud with API keys
    weaviateUrl = env.WEAVIATE_URL;
    embeddingHeaders.Authorization = `Bearer ${env.WEAVIATE_API_KEY}`;

    const embeddingProvider = env.EMBEDDING_PROVIDER || "openai";
    console.log('[DEBUG] Embedding provider:', embeddingProvider);

    if (embeddingProvider === "cohere") {
      embeddingHeaders["X-Cohere-Api-Key"] = env.COHERE_API_KEY;
    } else {
      embeddingHeaders["X-OpenAI-Api-Key"] = env.OPENAI_API_KEY;
    }
  }

  // Escape special characters in query to prevent GraphQL injection
  const sanitizedQuery = query
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/"/g, '\\"')     // Escape quotes
    .replace(/\n/g, " ")      // Replace newlines with spaces
    .replace(/\r/g, " ")      // Replace carriage returns with spaces
    .replace(/\t/g, " ");     // Replace tabs with spaces

  console.log('[DEBUG] Fetching from Weaviate:', weaviateUrl);

  let graphqlQuery;

  if (embeddingMode === "gce") {
    // GCE mode: get embedding from Ollama first, then use hybrid search with vector
    const ollamaUrl = env.GCE_OLLAMA_URL;
    const queryVector = await getOllamaEmbedding(query, ollamaUrl);
    const vectorStr = `[${queryVector.join(",")}]`;

    // Use hybrid search combining BM25 keyword search with vector similarity
    // alpha: 0 = pure BM25, 1 = pure vector, 0.5 = balanced
    graphqlQuery = `{
      Get {
        Document(
          hybrid: {
            query: "${sanitizedQuery}"
            vector: ${vectorStr}
            alpha: 0.5
          }
          limit: ${limit}
        ) {
          filename filepath content file_size
          _additional { score }
        }
      }
    }`;
  } else {
    // Local/Cloud mode: use hybrid search (Weaviate handles embedding for vector part)
    // alpha: 0 = pure BM25, 1 = pure vector, 0.5 = balanced
    graphqlQuery = `{
      Get {
        Document(
          hybrid: {
            query: "${sanitizedQuery}"
            alpha: 0.5
          }
          limit: ${limit}
        ) {
          filename filepath content file_size
          _additional { score }
        }
      }
    }`;
  }

  const response = await fetch(`${weaviateUrl}/v1/graphql`, {
    method: "POST",
    headers: embeddingHeaders,
    body: JSON.stringify({ query: graphqlQuery }),
  });

  console.log('[DEBUG] Weaviate response received, status:', response.status);
  const responseText = await response.text();
  console.log('[DEBUG] Weaviate response text length:', responseText.length);
  console.log('[DEBUG] Weaviate response preview:', responseText.substring(0, 200));

  let data;
  try {
    data = JSON.parse(responseText);
    console.log('[DEBUG] Weaviate JSON parsed successfully');
  } catch (e) {
    console.error('[DEBUG] Weaviate JSON parse error:', e.message);
    console.error('[DEBUG] Full response text:', responseText);
    throw new Error(`Failed to parse Weaviate response: ${e.message}`);
  }
  if (data.errors) throw new Error(`Weaviate error: ${data.errors.map((e) => e.message).join(", ")}`);

  const documents = data.data?.Get?.Document || [];
  console.log('[DEBUG] Weaviate returned', documents.length, 'documents');
  // Hybrid search returns 'score' (higher is better), not 'distance' (lower is better)
  return documents.map((doc) => ({ ...doc, relevance: doc._additional?.score || 0 }));
}

async function generateAnswer(question, documents, history, env) {
  // Filter documents by relevance threshold to reduce noise
  const RELEVANCE_THRESHOLD = 0.05; // Very low threshold for maximum recall (5%)
  const relevantDocs = documents.filter(doc => doc.relevance > RELEVANCE_THRESHOLD);

  const context = relevantDocs.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n");

  // Don't add negative context notes that might make the LLM more hesitant to answer
  let contextNote = "";

  const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme, being an expert at understanding user queries, reading documents, and giving factually correct answers.

You have access to official programme documentation. Always try to answer questions using the information provided in the documents.

Guidelines:
1. Answer questions based on the provided documents - be helpful and informative
2. If documents mention related information, use it to provide a helpful answer
3. For policies, procedures, course details - extract and present the relevant information clearly
4. Course codes like PDSA, MLT, etc. refer to specific courses - look for grading policies, syllabus, and course details in the documents
5. Only refuse to answer if the documents contain absolutely no relevant information
6. If information is partial or you need to suggest contacting support, still provide what you know first
7. Be concise and use simple Markdown
8. DO NOT make up facts, dates, or anything that is not directly quoted in the documents
9. IMPORTANT: When citing specific numbers (CGPA cutoffs, fees, percentages, dates, credits), you MUST quote them EXACTLY as they appear in the documents. Never estimate, round, or infer numerical values.
10. Always give a title to your answer

Current date: ${new Date().toISOString().split("T")[0]}.${contextNote}`;

  // Configure chat API endpoint and model (defaults to OpenAI for backwards compatibility)
  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const chatModel = env.CHAT_MODEL || "gpt-4o-mini";

  // Use CHAT_API_KEY if provided (for custom endpoints like AI Pipe), otherwise fall back to OPENAI_API_KEY
  // This allows using different providers while maintaining backwards compatibility
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  // Validate and sanitize conversation history
  const MAX_MESSAGE_LENGTH = 10000; // 10KB per message to prevent DoS
  const MAX_HISTORY_MESSAGES = 10; // Maximum 5 Q&A pairs

  const validatedHistory = Array.isArray(history)
    ? history
        .slice(0, MAX_HISTORY_MESSAGES) // Limit total messages
        .filter((msg) => {
          // Validate message structure
          if (!msg?.role || !msg?.content || typeof msg.content !== "string") {
            return false;
          }
          // Validate role is either 'user' or 'assistant'
          if (msg.role !== "user" && msg.role !== "assistant") {
            return false;
          }
          // Validate message length to prevent DoS
          if (msg.content.length > MAX_MESSAGE_LENGTH) {
            return false;
          }
          return true;
        })
    : [];

  // Build messages array with conversation history
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "assistant", content: context },
    ...validatedHistory,
    { role: "user", content: question },
  ];

  console.log('[DEBUG] Calling chat API:', chatEndpoint, 'model:', chatModel);
  console.log('[DEBUG] Sending', messages.length, 'messages to chat API');

  // Step 1: Get non-streaming response from LLM
  const response = await fetch(chatEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatApiKey}` },
    body: JSON.stringify({
      model: chatModel,
      messages,
      temperature: 0.1, // Low temperature for factual, deterministic responses
      stream: false, // Non-streaming to collect full response for fact-checking
    }),
  });

  console.log('[DEBUG] Chat API response status:', response.status);
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[DEBUG] Chat API error response:', errorText);
    throw new Error(`Chat API error: ${response.status} ${response.statusText}`);
  }

  // Step 2: Parse the response
  const result = await response.json();
  const answerText = result.choices?.[0]?.message?.content || "";
  console.log('[DEBUG] Generated answer length:', answerText.length);

  // Step 3: Fact-check the response against context
  console.log('[DEBUG] Starting fact-check...');
  const isFactuallyCorrect = await checkResponse({ response: answerText, context, env });
  console.log('[DEBUG] Fact-check result:', isFactuallyCorrect);

  // Step 4: Create a response based on fact-check result
  const finalAnswer = isFactuallyCorrect
    ? answerText
    : "I apologize, but I couldn't verify my response against the available documents. Please rephrase your question or ask something specific about the IIT Madras BS programme (admissions, courses, fees, academic policies, etc.).";

  // Step 5: Return a simulated streaming response for compatibility with existing SSE format
  return createSSEResponse(finalAnswer);
}

/**
 * Creates a simulated SSE streaming response from a complete text.
 * This maintains compatibility with the existing SSE client format.
 * @param {string} text - The complete response text
 * @returns {Response} - A Response object with SSE-formatted body
 */
function createSSEResponse(text) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send the content as a single SSE chunk (simulating streaming)
      const sseData = `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }]
      })}\n\n`;
      controller.enqueue(encoder.encode(sseData));

      // Send the done signal
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

/**
 * Fact-checks an LLM response against the provided context documents.
 * Calls the LLM to verify if the response is grounded in the context.
 * @param {Object} params - The parameters object
 * @param {string} params.response - The LLM's response text to fact-check
 * @param {string} params.context - The context documents used to generate the response
 * @param {Object} params.env - Environment variables containing API keys
 * @returns {Promise<boolean>} - true if response is factually grounded, false otherwise
 */
async function checkResponse({ response, context, env }) {
  const systemPrompt = `You are a strict fact-checker. Your ONLY job is to verify if a response is factually grounded in the provided context.

RULES:
1. Respond with ONLY "YES" or "NO" - nothing else, no explanations, no punctuation
2. Answer "YES" if ALL claims in the response can be verified from the context
3. Answer "NO" if ANY claim in the response cannot be found in or inferred from the context
4. Answer "YES" if the response correctly states it doesn't have information (when context lacks the info)
5. Answer "NO" if the response contains specific facts, dates, numbers, or names not present in the context

IMPORTANT: Be strict. If in doubt, answer "NO".`;

  const userPrompt = `CONTEXT DOCUMENTS:
${context}

---

RESPONSE TO VERIFY:
${response}

---

Is this response factually grounded in the context? Answer only YES or NO.`;

  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const chatModel = env.CHAT_MODEL || "gpt-4o-mini";
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  try {
    console.log('[DEBUG] checkResponse() - Calling LLM for fact-check');
    const factCheckResponse = await fetch(chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatApiKey}` },
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0, // Use 0 temperature for deterministic fact-checking
        max_tokens: 10, // We only need YES or NO
        stream: false,
      }),
    });

    if (!factCheckResponse.ok) {
      console.error('[DEBUG] checkResponse() - Fact-check API error:', factCheckResponse.status);
      // On API error, return true to avoid blocking valid responses
      return true;
    }

    const result = await factCheckResponse.json();
    console.log('[DEBUG] checkResponse() - Full API response:', JSON.stringify(result));
    const answer = result.choices?.[0]?.message?.content?.trim().toUpperCase();
    console.log('[DEBUG] checkResponse() - Fact-check result:', answer);

    return answer === "YES";
  } catch (error) {
    console.error('[DEBUG] checkResponse() - Error during fact-check:', error.message);
    // On error, return true to avoid blocking valid responses
    return true;
  }
}
