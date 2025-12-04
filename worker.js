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

// Condensed knowledge base summary for query rewriting context.
// This is a compact version of src/_knowledge_base_summary.md (the detailed reference).
// When the source documents change significantly, update both this constant and the full summary file.
// See generate-summary-prompt.txt for regeneration instructions.
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

  // Add RAAHAT info to context so fact-checker can verify mental health referrals
  const RAAHAT_INFO = `<document filename="RAAHAT_Support.md">
RAAHAT is the Mental Health & Wellness Society for IIT Madras BS students.
Contact: wellness.society@study.iitm.ac.in
Instagram: @wellness.society_iitmbs
RAAHAT provides support for emotional, psychological, interpersonal, and financial distress.
</document>`;

  const context = relevantDocs.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n") + "\n\n" + RAAHAT_INFO;

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

STRICTLY REFUSE to answer:
- Any help with cheating, academic dishonesty, or bypassing exam rules
- Questions completely unrelated to the IIT Madras BS programme

For cheating/unrelated questions, say: "I can only help with questions about the IIT Madras BS programme (admissions, courses, fees, placements, academic policies, etc.)."

SPECIAL CASE - Emotional/psychological distress:
If the user expresses ANY emotional, psychological, interpersonal, or financial distress (stress, anxiety, relationship issues, loneliness, feeling overwhelmed, money problems, etc.):
- Do NOT give any advice yourself
- Do NOT say "I can't help"
- ONLY direct them warmly to RAAHAT with this response:

"I hear you, and I want you to know that support is available. RAAHAT is the Mental Health & Wellness Society for IIT Madras BS students - they're here to help with exactly this kind of situation.

📧 Reach out to them at: wellness.society@study.iitm.ac.in
📱 Instagram: @wellness.society_iitmbs

Please don't hesitate to contact them - that's what they're there for. You're not alone in this."

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
  console.log('[DEBUG] Generated answer preview:', answerText.substring(0, 500));

  // Step 3: Handle RAAHAT content specially - split and fact-check non-RAAHAT content only
  const { raahatChunk, otherChunk, hasRaahat } = splitRaahatContent(answerText);
  console.log('[DEBUG] RAAHAT split - hasRaahat:', hasRaahat, ', otherChunk statements:', countStatements(otherChunk));

  let finalAnswer;

  if (hasRaahat) {
    // Response contains RAAHAT content - handle specially
    console.log('[DEBUG] Response contains RAAHAT content, applying special handling');

    const otherStatementCount = countStatements(otherChunk);

    if (otherStatementCount > 2) {
      // There's substantial non-RAAHAT content - fact-check it
      console.log('[DEBUG] Fact-checking non-RAAHAT chunk (', otherStatementCount, 'statements)');
      let isOtherChunkValid = await checkResponse({ response: otherChunk, context, history: validatedHistory, env });

      // Retry without history if needed
      if (!isOtherChunkValid && validatedHistory.length > 0) {
        console.log('[DEBUG] Retrying fact-check without history...');
        isOtherChunkValid = await checkResponse({ response: otherChunk, context, history: [], env });
      }

      if (isOtherChunkValid) {
        // Non-RAAHAT content is valid - show it + standardized RAAHAT message
        console.log('[DEBUG] Non-RAAHAT content approved, combining with standard RAAHAT message');
        finalAnswer = otherChunk + '\n\n---\n\n' + STANDARD_RAAHAT_MESSAGE;
      } else {
        // Non-RAAHAT content failed fact-check - show only standardized RAAHAT message
        console.log('[DEBUG] Non-RAAHAT content rejected, showing only standard RAAHAT message');
        finalAnswer = STANDARD_RAAHAT_MESSAGE;
      }
    } else {
      // Minimal or no non-RAAHAT content - just show standardized RAAHAT message
      console.log('[DEBUG] Minimal non-RAAHAT content, showing only standard RAAHAT message');
      finalAnswer = STANDARD_RAAHAT_MESSAGE;
    }
  } else {
    // No RAAHAT content - normal fact-checking flow
    console.log('[DEBUG] No RAAHAT content, using normal fact-check flow');
    console.log('[DEBUG] Starting fact-check with history length:', validatedHistory.length);
    let isFactuallyCorrect = await checkResponse({ response: answerText, context, history: validatedHistory, env });
    console.log('[DEBUG] Fact-check result:', isFactuallyCorrect);

    // Retry without history if needed
    if (!isFactuallyCorrect && validatedHistory.length > 0) {
      console.log('[DEBUG] Fact-check failed with history, retrying without history...');
      isFactuallyCorrect = await checkResponse({ response: answerText, context, history: [], env });
      console.log('[DEBUG] Fact-check retry result (no history):', isFactuallyCorrect);
    }

    finalAnswer = isFactuallyCorrect
      ? answerText
      : "I apologize, but I couldn't verify my response against the available documents. Please rephrase your question or ask something specific about the IIT Madras BS programme (admissions, courses, fees, academic policies, etc.). If you feel your question was valid and I made a mistake - please reach out to support@study.iitm.ac.in";
  }

  // Step 5: Return a simulated streaming response for compatibility with existing SSE format
  return createSSEResponse(finalAnswer);
}

// Standardized RAAHAT message for mental health referrals
const STANDARD_RAAHAT_MESSAGE = `I hear you, and I want you to know that support is available. RAAHAT is the Mental Health & Wellness Society for IIT Madras BS students - they're here to help with exactly this kind of situation.

📧 Reach out to them at: wellness.society@study.iitm.ac.in
📱 Instagram: @wellness.society_iitmbs

Please don't hesitate to contact them - that's what they're there for. You're not alone in this.`;

/**
 * Checks if a response contains RAAHAT-related content.
 * @param {string} text - The response text to check
 * @returns {boolean} - true if contains RAAHAT content
 */
function containsRaahat(text) {
  const lowerText = text.toLowerCase();
  return lowerText.includes('raahat') ||
         lowerText.includes('wellness.society@study.iitm.ac.in') ||
         lowerText.includes('@wellness.society_iitmbs') ||
         lowerText.includes('mental health & wellness society');
}

/**
 * Splits a response into RAAHAT-related and non-RAAHAT chunks.
 * RAAHAT chunk: Lines mentioning RAAHAT, mental health society, or wellness contact info.
 * Other chunk: All other lines.
 * @param {string} text - The response text to split
 * @returns {{ raahatChunk: string, otherChunk: string, hasRaahat: boolean }}
 */
function splitRaahatContent(text) {
  if (!containsRaahat(text)) {
    return { raahatChunk: '', otherChunk: text, hasRaahat: false };
  }

  const lines = text.split('\n');
  const raahatLines = [];
  const otherLines = [];

  // Keywords that indicate RAAHAT-related content
  const raahatKeywords = [
    'raahat',
    'wellness.society@study.iitm.ac.in',
    '@wellness.society_iitmbs',
    'mental health',
    'wellness society',
    'support is available',
    'you\'re not alone',
    'don\'t hesitate to contact'
  ];

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    const isRaahatLine = raahatKeywords.some(keyword => lowerLine.includes(keyword));

    if (isRaahatLine) {
      raahatLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  return {
    raahatChunk: raahatLines.join('\n').trim(),
    otherChunk: otherLines.join('\n').trim(),
    hasRaahat: raahatLines.length > 0
  };
}

/**
 * Counts meaningful statements in text (non-empty, non-header lines).
 * @param {string} text - The text to count statements in
 * @returns {number} - Number of meaningful statements
 */
function countStatements(text) {
  if (!text) return 0;

  const lines = text.split('\n').filter(line => {
    const trimmed = line.trim();
    // Skip empty lines, headers (starting with #), and very short lines
    return trimmed.length > 0 &&
           !trimmed.startsWith('#') &&
           trimmed.length > 5;
  });

  return lines.length;
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
 * Fact-checks an LLM response against the provided context documents and conversation history.
 * Calls the LLM to verify if the response is grounded in the context.
 * @param {Object} params - The parameters object
 * @param {string} params.response - The LLM's response text to fact-check
 * @param {string} params.context - The context documents used to generate the response
 * @param {Array} params.history - The conversation history (previous Q&A pairs)
 * @param {Object} params.env - Environment variables containing API keys
 * @returns {Promise<boolean>} - true if response is factually grounded, false otherwise
 */
async function checkResponse({ response, context, history = [], env }) {
  // Build history context string from conversation history
  const historyContext = history.length > 0
    ? "\n\nPREVIOUS CONVERSATION:\n" + history.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n\n")
    : "";

  const systemPrompt = `You are a fact-checker that responds ONLY in JSON format.

Your task: Check if a response should be REJECTED for any of these reasons:
1. Contains FALSE facts (wrong numbers, dates, names, procedures)
2. Contains PROHIBITED content (see rules 7-9 below)

OUTPUT FORMAT (respond with this exact JSON structure):
{"approved": "YES", "incorrect": []}
OR
{"approved": "NO", "incorrect": ["reason for rejection"]}

FACT-CHECKING RULES (1-6):
1. APPROVE if facts in the response MATCH the context (even with different formatting)
2. REJECT if a fact is WRONG (e.g., context says "30,000" but response says "50,000")
3. "₹30,000" = "30,000" = "Rs 30,000" - these are the SAME, approve them
4. "₹10,00,000" = "10 LPA" = "10,00,000 per annum" - these are the SAME, approve them
5. Paraphrasing is OK. Different currency symbols are OK. Different number formats are OK.
6. Only flag facts that are numerically or factually DIFFERENT from the context.

CONTENT RULES (7-9):
7. Academic/placement content (admissions, courses, fees, exams, placements) - APPROVE. Psychological/relationship ADVICE - REJECT. But referring to RAAHAT - APPROVE.
8. Advice about cheating, harming oneself/others, or any malicious activity - REJECT
9. Personal contact info NOT from context - REJECT. But wellness.society@study.iitm.ac.in (RAAHAT) is allowed.

Remember: Output ONLY the JSON object.`;

  const userPrompt = `CONTEXT DOCUMENTS:
${context}${historyContext}

---

RESPONSE TO VERIFY:
${response}

---

Output your fact-check result as JSON:`;

  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const factCheckModel = "gpt-4o-mini";
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  try {
    console.log('[DEBUG] checkResponse() - Calling LLM for fact-check');
    const factCheckResponse = await fetch(chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatApiKey}` },
      body: JSON.stringify({
        model: factCheckModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0, // Use 0 temperature for deterministic fact-checking
        max_tokens: 500, // Allow room for JSON with incorrect statements list
        response_format: { type: "json_object" }, // Force JSON output
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
    const rawAnswer = result.choices?.[0]?.message?.content?.trim();
    console.log('[DEBUG] checkResponse() - Raw fact-check response:', rawAnswer);

    // Parse JSON response
    try {
      const factCheckResult = JSON.parse(rawAnswer);
      console.log('[DEBUG] checkResponse() - Parsed JSON:', JSON.stringify(factCheckResult));
      if (factCheckResult.incorrect && factCheckResult.incorrect.length > 0) {
        console.log('[DEBUG] checkResponse() - Incorrect statements:', factCheckResult.incorrect);
      }
      return factCheckResult.approved?.toUpperCase() === "YES";
    } catch (parseError) {
      // Fallback: strict check for exactly "YES"
      console.log('[DEBUG] checkResponse() - JSON parse failed, falling back to strict text check');
      return rawAnswer?.toUpperCase() === "YES";
    }
  } catch (error) {
    console.error('[DEBUG] checkResponse() - Error during fact-check:', error.message);
    // On error, return true to avoid blocking valid responses
    return true;
  }
}
