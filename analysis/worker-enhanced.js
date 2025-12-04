/**
 * Enhanced Worker with Response Validation
 * This is an improved version with real-time hallucination detection
 */

import { quickValidate, validateResponse, getSafeFallbackResponse, OUT_OF_SCOPE_KEYWORDS } from './worker-validator.js';

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
  const { q: question, ndocs = 5, history = [], validate = true } = await request.json();
  if (!question) return new Response('Missing "q" parameter', { status: 400 });

  // Validate ndocs to prevent resource exhaustion
  const numDocs = parseInt(ndocs);
  if (isNaN(numDocs) || numDocs < 1 || numDocs > 20) {
    return new Response('Invalid "ndocs" parameter. Must be between 1 and 20', { status: 400 });
  }

  // Pre-check: Is this an obviously out-of-scope question?
  const questionLower = question.toLowerCase();
  const isObviouslyOutOfScope = OUT_OF_SCOPE_KEYWORDS.some(keyword =>
    new RegExp(`\\b${keyword}\\b`, 'i').test(questionLower)
  );

  if (isObviouslyOutOfScope) {
    // Return early with safe response for obviously out-of-scope questions
    const encoder = new TextEncoder();
    const safeResponse = getSafeFallbackResponse();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{
            delta: { content: safeResponse }
          }]
        })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Search Weaviate for relevant documents
        const documents = await searchWeaviate(question, numDocs, env);

        // Stream documents first (single enqueue)
        if (documents?.length) {
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

        const hasRelevantDocs = documents && documents.length > 0 &&
                                documents.some(d => d.relevance > 0.3);

        // Generate AI answer with validation
        const answer = await generateAnswer(question, documents, history, env);

        // Stream with validation if enabled
        if (validate) {
          let accumulatedResponse = '';
          let validationFailed = false;

          await answer.body.pipeTo(
            new WritableStream({
              write: (chunk) => {
                if (validationFailed) return; // Stop processing if validation failed

                // Decode and accumulate
                const text = new TextDecoder().decode(chunk);
                accumulatedResponse += text;

                // Quick validation on accumulated response
                const isValid = quickValidate(accumulatedResponse, question, hasRelevantDocs);

                if (!isValid) {
                  validationFailed = true;
                  // Send safe fallback response
                  const safeMsg = `data: ${JSON.stringify({
                    choices: [{
                      delta: { content: getSafeFallbackResponse() }
                    }]
                  })}\n\n`;
                  controller.enqueue(encoder.encode(safeMsg));
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                  return;
                }

                // If valid, pass through
                controller.enqueue(chunk);
              },
              close: () => {
                if (!validationFailed) {
                  controller.close();
                }
              },
              abort: (reason) => {
                if (!validationFailed) {
                  controller.error(reason);
                }
              },
            }),
          );
        } else {
          // Stream without validation
          await answer.body.pipeTo(
            new WritableStream({
              write: (chunk) => controller.enqueue(chunk),
              close: () => controller.close(),
              abort: (reason) => controller.error(reason),
            }),
          );
        }
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

async function searchWeaviate(query, limit, env) {
  const embeddingProvider = env.EMBEDDING_PROVIDER || "openai";
  const embeddingHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.WEAVIATE_API_KEY}`,
  };

  if (embeddingProvider === "cohere") {
    embeddingHeaders["X-Cohere-Api-Key"] = env.COHERE_API_KEY;
  } else {
    embeddingHeaders["X-OpenAI-Api-Key"] = env.OPENAI_API_KEY;
  }

  const sanitizedQuery = query
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\t/g, " ");

  const response = await fetch(`${env.WEAVIATE_URL}/v1/graphql`, {
    method: "POST",
    headers: embeddingHeaders,
    body: JSON.stringify({
      query: `{
        Get {
          Document(nearText: { concepts: ["${sanitizedQuery}"] } limit: ${limit}) {
            filename filepath content file_size
            _additional { distance }
          }
        }
      }`,
    }),
  });

  const data = await response.json();
  if (data.errors) throw new Error(`Weaviate error: ${data.errors.map((e) => e.message).join(", ")}`);

  const documents = data.data?.Get?.Document || [];
  return documents.map((doc) => ({ ...doc, relevance: doc._additional?.distance ? 1 - doc._additional.distance : 0 }));
}

async function generateAnswer(question, documents, history, env) {
  const RELEVANCE_THRESHOLD = 0.3;
  const relevantDocs = documents.filter(doc => doc.relevance > RELEVANCE_THRESHOLD);

  const context = relevantDocs.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n");

  let contextNote = "";
  if (relevantDocs.length === 0) {
    contextNote = "\n\nNOTE: No relevant documents found. The question may be outside the scope of IIT Madras BS programme documentation.";
  } else if (relevantDocs.length < documents.length) {
    contextNote = `\n\nNOTE: ${relevantDocs.length} of ${documents.length} documents passed relevance threshold.`;
  }

  const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.

CRITICAL RULES - Follow these STRICTLY:
1. ONLY answer using information from the documents provided below
2. If the documents don't contain the answer, say "I don't have this information in the available documentation"
3. NEVER make up facts, dates, numbers, names, or any specific details
4. NEVER answer questions unrelated to IIT Madras BS programme (e.g., general knowledge, other topics)
5. If unsure, explicitly state your uncertainty
6. Quote or reference specific documents when possible
7. Keep answers CONCISE and in simple Markdown
8. NEVER provide specific salary figures, placement statistics, or guarantees unless explicitly mentioned in documents

Current date: ${new Date().toISOString().split("T")[0]}.

The documents below are your ONLY source of truth. Do not use any other knowledge.${contextNote}`;

  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const chatModel = env.CHAT_MODEL || "gpt-4o-mini";
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  const MAX_MESSAGE_LENGTH = 10000;
  const MAX_HISTORY_MESSAGES = 10;

  const validatedHistory = Array.isArray(history)
    ? history
        .slice(0, MAX_HISTORY_MESSAGES)
        .filter((msg) => {
          if (!msg?.role || !msg?.content || typeof msg.content !== "string") {
            return false;
          }
          if (msg.role !== "user" && msg.role !== "assistant") {
            return false;
          }
          if (msg.content.length > MAX_MESSAGE_LENGTH) {
            return false;
          }
          return true;
        })
    : [];

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "assistant", content: context },
    ...validatedHistory,
    { role: "user", content: question },
  ];

  const response = await fetch(chatEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatApiKey}` },
    body: JSON.stringify({
      model: chatModel,
      messages,
      temperature: 0.3,
      store: true,
      stream: true,
    }),
  });

  if (!response.ok) throw new Error(`Chat API error: ${response.status} ${response.statusText}`);
  return response;
}
