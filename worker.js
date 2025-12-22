// ============================================================================
// LOGGING INFRASTRUCTURE
// Structured logging for Cloud Run / Google Cloud Logging
// Logs are in JSON format with severity levels for easy BigQuery export
// ============================================================================

/**
 * Generates a UUID v4 for conversation tracking
 * @returns {string} UUID in standard format
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Logs a structured message to console in Cloud Logging format.
 * Cloud Run automatically picks up JSON logs and parses them.
 * @param {string} severity - Log level: DEBUG, INFO, WARNING, ERROR
 * @param {string} message - Human-readable message
 * @param {Object} data - Additional structured data to log
 */
function structuredLog(severity, message, data = {}) {
  const logEntry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...data,
    // Labels help with filtering in Cloud Logging and BigQuery
    "logging.googleapis.com/labels": {
      application: "iitm-chatbot",
      ...(data.labels || {}),
    },
  };
  // Remove nested labels from root level
  delete logEntry.labels;
  console.log(JSON.stringify(logEntry));
}


/**
 * Logs an error with context
 * @param {string} message - Error message
 * @param {Error|Object} error - Error object or details
 * @param {Object} context - Additional context
 */
function logError(message, error, context = {}) {
  structuredLog("ERROR", message, {
    error: {
      message: error?.message || String(error),
      stack: error?.stack,
    },
    ...context,
    labels: { type: "error" },
  });
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

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


/**
 * Handles user feedback submission
 * @param {Request} request - The incoming request
 * @returns {Response} - JSON response
 */
async function handleFeedback(request) {
  try {
    const body = await request.json();

    // Validate required fields
    const { session_id, message_id, question, response, feedback_type } = body;
    if (!session_id || !message_id || !feedback_type) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Validate feedback_type
    const validFeedbackTypes = ["up", "down", "report"];
    if (!validFeedbackTypes.includes(feedback_type)) {
      return new Response(
        JSON.stringify({ error: "Invalid feedback type" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Log the feedback for BigQuery ingestion
    structuredLog("INFO", "user_feedback", {
      session_id,
      message_id,
      question: question || null,
      response: response || null,
      feedback_type,
      feedback_category: body.feedback_category || null,
      feedback_text: body.feedback_text || null,
    });

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Feedback error:", error.message);
    return new Response(
      JSON.stringify({ error: "Failed to process feedback" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// Query synonym mapping: Maps various question phrasings to canonical search queries
// Format: array of [patterns, canonical_query] where patterns trigger the canonical query
const QUERY_SYNONYMS = [
  // GRADING & ASSESSMENT
  [["grading policy", "grading formula", "grade calculation", "how is grade calculated", "marks distribution", "score calculation"],
   "grading formula score calculation GAA quiz end term OPPE weightage"],
  [["pdsa grading", "pdsa marks", "pdsa score"],
   "PDSA Programming Data Structures Algorithms grading formula T = 0.1GAA + 0.4F + 0.2OP quiz"],
  [["python grading", "python marks"],
   "Python programming grading formula OPPE PE1 PE2 quiz end term"],
  [["i grade", "incomplete grade", "i_op", "i_both"],
   "I grade incomplete I_OP I_BOTH absent end term OPPE fail next term"],

  // QUIZ & EXAM
  [["quiz 1 syllabus", "quiz1 syllabus", "q1 syllabus"],
   "Quiz 1 syllabus weeks 1-4 content coverage"],
  [["quiz 2 syllabus", "quiz2 syllabus", "q2 syllabus"],
   "Quiz 2 Qz2 syllabus Week 5-8 Week 3-8 content coverage grading"],
  [["end term syllabus", "final exam syllabus", "et syllabus"],
   "End term exam syllabus weeks 1-12 full course content"],
  [["exam city change", "change exam center", "change quiz city", "edit exam city"],
   "exam city change registration different cities quiz end term each term"],
  [["answer review", "review answers", "see my answers", "check answers after exam"],
   "answer review exam results dashboard score release"],
  [["no quiz 1", "without quiz 1", "courses no quiz"],
   "courses without Quiz 1 Software Engineering MLP BDM TDS Big Data"],
  [["no quiz 2", "without quiz 2"],
   "courses without Quiz 2 Python Programming C MLP TDS Big Data"],

  // CREDITS
  [["3 credits", "three credits", "3 credit subjects", "which subjects 3 credits"],
   "credits per course foundation 4 credits diploma degree 4 credits NPTEL 1-3 credits"],
  [["4 credits", "four credits"],
   "4 credits foundation courses diploma courses apprenticeship"],
  [["nptel credits", "nptel transfer", "how many nptel", "nptel credit transfer"],
   "NPTEL credit transfer maximum 8 credits 4-week=1 8-week=2 12-week=3 Rs 1000 per credit"],
  [["campus credits", "iitm campus courses"],
   "campus courses credit transfer maximum 24 credits CGPA 8.0 Rs 2500 per credit"],

  // COURSES & CURRICULUM
  [["diploma data science courses", "ds diploma courses", "data science diploma subjects"],
   "Diploma Data Science courses MLF MLT MLP BDM BA TDS Machine Learning Business"],
  [["diploma programming courses", "dp diploma courses", "programming diploma subjects"],
   "Diploma Programming courses DBMS PDSA Java System Commands AppDev1 AppDev2"],
  [["foundation courses", "foundation subjects", "year 1 courses"],
   "Foundation courses Maths 1 2 Statistics 1 2 English 1 2 Python Computational Thinking"],
  [["degree courses", "bsc courses", "bs courses"],
   "Degree level courses Software Engineering Testing AI Deep Learning electives"],
  [["core pairs", "mandatory pairs"],
   "core pairs Software Engineering Testing AI Search Deep Learning degree level"],
  [["prerequisites", "prereq", "pre-requisite"],
   "prerequisites course requirements Maths Statistics English Python foundation diploma"],

  // ADMISSION & ELIGIBILITY
  [["direct entry", "dad", "direct admission diploma", "skip foundation"],
   "Direct Admission Diploma DAD 2 years UG qualifier exam Rs 6000"],
  [["jee entry", "jee admission", "jee advanced"],
   "JEE Advanced direct entry foundation level skip qualifier"],
  [["eligibility", "who can apply", "qualification required"],
   "eligibility Class 12 passed Mathematics English Class 10 any age any stream"],
  [["qualifier exam", "qualifier process", "how to qualify"],
   "qualifier exam 4 weeks preparation Rs 3000 fee application process"],

  // FEES
  [["fee waiver", "scholarship", "fee reduction", "concession"],
   "fee waiver SC ST PwD OBC-NCL EWS income 50% 75% waiver"],
  [["fee waiver documents", "documents for waiver", "waiver proof"],
   "fee waiver documents category certificate income certificate PwD certificate"],
  [["army fee waiver", "defense fee waiver", "military fee waiver"],
   "fee waiver army defense General category income based EWS 50% 75% waiver"],
  [["total fee", "programme fee", "course fee", "how much fee"],
   "fee structure Foundation Rs 32000 Diploma Rs 62500 BSc Rs 2.21L BS Rs 3.25L"],
  [["international fee", "foreign student fee", "outside india fee"],
   "international students facilitation fee Quiz Rs 2000 End Term Rs 2000-4000"],

  // CERTIFICATES
  [["hard copy certificate", "original certificate", "physical certificate"],
   "original certificate hard copy alumni registration Rs 6000 exit form processing"],
  [["transcript", "mark sheet", "grade card"],
   "transcript academic record grades courses completed CGPA"],

  // OPPE & SCT
  [["oppe", "online proctored", "programming exam"],
   "OPPE Online Proctored Programming Exam remote proctored coding"],
  [["sct", "system compatibility", "compatibility test"],
   "SCT System Compatibility Test mandatory before OPPE camera microphone check"],

  // PLACEMENTS
  [["placement eligibility", "when placement", "eligible for placement"],
   "placement eligibility internship after 1 diploma job after BSc degree"],
  [["average salary", "placement salary", "package"],
   "placement salary average Rs 10 LPA highest Rs 25 LPA internship Rs 30000"],
  [["companies", "recruiters", "which companies"],
   "recruiters Amazon Microsoft Deloitte Wipro TCS companies placement"],

  // ACADEMIC POLICIES
  [["repeat course", "fail course", "retake"],
   "repeat course fail full fee again all assessments next term"],
  [["probation", "struck off", "removed"],
   "academic probation 2 terms struck off 3 terms without registration readmission"],
  [["chatgpt", "llm", "ai help", "plagiarism"],
   "LLM ChatGPT plagiarism honor code violation not allowed assignments"],

  // HIGHER STUDIES
  [["masters", "mtech", "ms", "phd", "higher studies"],
   "Masters MTech MS PhD GATE CFTI route CGPA 8.0 research campus upgrade"],
];

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
 * Checks if a query matches any synonym pattern and returns the canonical query.
 * @param {string} query - The user query to check
 * @returns {string|null} - The canonical query if matched, null otherwise
 */
function findSynonymMatch(query) {
  const queryLower = query.toLowerCase();
  for (const [patterns, canonicalQuery] of QUERY_SYNONYMS) {
    for (const pattern of patterns) {
      if (queryLower.includes(pattern.toLowerCase())) {
        return canonicalQuery;
      }
    }
  }
  return null;
}

/**
 * Rewrites a user query to improve search relevance.
 * First checks synonym mapping, then falls back to LLM rewriting.
 * @param {string} query - The original user query
 * @param {Object} env - Environment variables containing API keys
 * @returns {Promise<string>} - The rewritten query for search
 * @deprecated Use rewriteQueryWithSource instead for logging
 */
async function rewriteQuery(query, env) {
  const { query: rewrittenQuery } = await rewriteQueryWithSource(query, env);
  return rewrittenQuery;
}

/**
 * Rewrites a user query to improve search relevance, returning both the query and source.
 * First checks synonym mapping, then falls back to LLM rewriting.
 * @param {string} query - The original user query
 * @param {Object} env - Environment variables containing API keys
 * @returns {Promise<{query: string, source: string}>} - The rewritten query and its source
 */
async function rewriteQueryWithSource(query, env) {
  // First, check if query matches any synonym pattern (fast path)
  const synonymMatch = findSynonymMatch(query);
  if (synonymMatch) {
    console.log('[DEBUG] Synonym match found:', query, '→', synonymMatch);
    return { query: synonymMatch, source: "synonym" };
  }

  // Fall back to LLM rewriting for unmatched queries
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
    console.log('[DEBUG] No synonym match, using LLM rewrite for:', query);
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
      return { query: query, source: "original" };
    }

    const result = await response.json();
    const rewrittenQuery = result.choices?.[0]?.message?.content?.trim() || query;
    console.log('[DEBUG] Query rewritten:', query, '→', rewrittenQuery);
    return { query: rewrittenQuery, source: "llm" };
  } catch (error) {
    console.error('[DEBUG] Query rewrite error:', error.message);
    return { query: query, source: "original" }; // Fallback to original query on error
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

    // Route handling
    const url = new URL(request.url);

    // Handle POST /answer
    if (request.method == "POST" && url.pathname == "/answer") {
      return await answer(request, env);
    }

    // Handle POST /feedback
    if (request.method == "POST" && url.pathname == "/feedback") {
      return await handleFeedback(request);
    }

    return env.ASSETS.fetch(request);
  },
};

async function answer(request, env) {
  const startTime = Date.now();
  const conversationId = generateUUID();

  console.log('[DEBUG] answer() called');
  const { q: question, ndocs = 5, history = [], session_id: sessionId, username, message_id: messageId } = await request.json();
  console.log('[DEBUG] Question:', question);
  console.log('[DEBUG] Session ID:', sessionId || 'not provided');
  console.log('[DEBUG] Message ID:', messageId || 'not provided');
  console.log('[DEBUG] Username:', username || 'not provided');
  console.log('[DEBUG] Conversation ID:', conversationId);
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

  // Logging context - will be populated during processing
  const logContext = {
    session_id: sessionId || "anonymous",
    conversation_id: conversationId,
    message_id: messageId || null,
    username: username || null,
    question: question,
    rewritten_query: null,
    query_source: "original", // "synonym", "llm", or "original"
    documents: [],
    response: null,
    fact_check_passed: null,
    contains_raahat: false,
    history_length: Array.isArray(history) ? history.length : 0,
    latency_ms: null,
    error: null,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Rewrite query for better search relevance
        const { query: searchQuery, source: querySource } = await rewriteQueryWithSource(question, env);
        logContext.rewritten_query = searchQuery;
        logContext.query_source = querySource;

        // Search Weaviate for relevant documents using rewritten query
        const documents = await searchWeaviate(searchQuery, numDocs, env);

        // Log document metadata (not full content)
        logContext.documents = (documents || []).map((doc) => ({
          filename: doc.filename,
          relevance: doc.relevance,
        }));

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
        // Pass logContext to collect response data
        const answerResponse = await generateAnswer(question, documents, history, env, logContext);
        // Pipe the SSE response to the client
        await answerResponse.body.pipeTo(
          new WritableStream({
            write: (chunk) => controller.enqueue(chunk),
            close: () => {
              // Log the conversation when stream closes
              logContext.latency_ms = Date.now() - startTime;
              structuredLog("INFO", "conversation_turn", logContext);
              controller.close();
            },
            abort: (reason) => {
              logContext.latency_ms = Date.now() - startTime;
              logContext.error = reason?.message || String(reason);
              structuredLog("INFO", "conversation_turn", logContext);
              controller.error(reason);
            },
          }),
        );
      } catch (error) {
        // Log the error
        logContext.latency_ms = Date.now() - startTime;
        logContext.error = error?.message || String(error);
        logError("conversation_error", error, {
          session_id: sessionId,
          conversation_id: conversationId,
          question: question,
        });
        structuredLog("INFO", "conversation_turn", logContext);

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

async function generateAnswer(question, documents, history, env, logContext = null) {
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
9. IMPORTANT: When citing specific numbers (CGPA cutoffs, fees, percentages, dates, credits), you MUST quote them EXACTLY as they appear in the documents. Never estimate, round, or infer numerical values. If the document says "2.21L", write "2.21L" - do NOT expand to "2,21,000" or "221000".
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
  let factCheckPassed = null; // Track fact-check result for logging

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

      factCheckPassed = isOtherChunkValid;

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
      factCheckPassed = true; // No fact-check needed for pure RAAHAT response
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

    factCheckPassed = isFactuallyCorrect;

    finalAnswer = isFactuallyCorrect
      ? answerText
      : "I apologize, but I couldn't verify my response against the available documents. Please rephrase your question or ask something specific about the IIT Madras BS programme (admissions, courses, fees, academic policies, etc.). If you feel your question was valid and I made a mistake - please reach out to support@study.iitm.ac.in";
  }

  // Populate logContext if provided
  if (logContext) {
    logContext.response = finalAnswer;
    logContext.fact_check_passed = factCheckPassed;
    logContext.contains_raahat = hasRaahat;
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

  const systemPrompt = `You are a fact-checker that responds ONLY in JSON format. We are providing you with a support query response (not the query) as well as some context documents.

Your task: Check if a response should be APPROVED or REJECTED based on its accuracy.

What is allowed:

- Facts aligning with the context documents
- Paraphrasing of any information from the context documents
- Combining information from one or two context documents
- contact info from the following "ALLOWED_CONTACT_LIST" as below:
- Emails: support@study.iitm.ac.in, iic@study.iitm.ac.in, ge@study.iitm.ac.in, students-grievance@study.iitm.ac.in, wellness.society@study.iitm.ac.in
- Phones: 7850999966, +91 63857 89630, 9444020900, 8608076093
- Any club/society email ending in @study.iitm.ac.in (e.g., chess.club@study.iitm.ac.in)
- Any numbers which are numerically equal to the numbers you find in context documents - even if they are not exact string matches - for example, 3L is the same as 3 lakhs is the same as 3,00,000 is the same as 300000 is the same as 300k.

What is not allowed:

- Contains false facts (incorrect numbers, dates, names, procedures)
- Random advice given to the students
- Prohibited content, such as:
  - Advice about cheating, harming oneself/others, or any malicious activity - REJECT
  - Personal contact info NOT in "ALLOWED_CONTACT_LIST" info mentioned earlier
- Any emotional / psychological advice
- Any dating advice
- Any sexual advice

Once you perform the fact check, decide whether the response is approved or not. Don't be overly strict, don't be too lenient. Be the right amount of strict.

IMPORTANT: Do NOT second-guess specific technical details like week ranges (e.g., "Weeks 5-8"), grading formulas, or course codes. If the response mentions specific weeks or formulas, trust them - they come directly from grading documents. Only reject if something is clearly fabricated or contradicts the context.

---

OUTPUT FORMAT (respond with this exact JSON structure):
{"approved": "YES", "incorrect": []}
OR
{"approved": "NO", "incorrect": ["reason for rejection"]}

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
