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
  const { q: question, ndocs = 5 } = await request.json();
  if (!question) return new Response('Missing "q" parameter', { status: 400 });

  // Validate ndocs to prevent resource exhaustion
  const numDocs = parseInt(ndocs);
  if (isNaN(numDocs) || numDocs < 1 || numDocs > 20) {
    return new Response('Invalid "ndocs" parameter. Must be between 1 and 20', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Search Weaviate for relevant documents
        const documents = await searchWeaviate(question, numDocs, env);
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

        // Generate AI answer using documents as context and stream via piping
        const answer = await generateAnswer(question, documents, env);
        await answer.body.pipeTo(
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

async function searchWeaviate(query, limit, env) {
  // Configure embedding provider headers (default to openai for backwards compatibility)
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

  // Escape special characters in query to prevent GraphQL injection
  const sanitizedQuery = query
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/"/g, '\\"')     // Escape quotes
    .replace(/\n/g, " ")      // Replace newlines with spaces
    .replace(/\r/g, " ")      // Replace carriage returns with spaces
    .replace(/\t/g, " ");     // Replace tabs with spaces

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

async function generateAnswer(question, documents, env) {
  const context = documents.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n");

  const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.
Answer directly in VERY simple, CONCISE Markdown.
If the question is unclear, infer, state your assumption, and then respond accordingly.
Current date: ${new Date().toISOString().split("T")[0]}.
Use the information from documents provided.`;

  // Configure chat API endpoint and model (defaults to OpenAI for backwards compatibility)
  const chatEndpoint = env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const chatModel = env.CHAT_MODEL || "gpt-4o-mini";

  // Use CHAT_API_KEY if provided (for custom endpoints like AI Pipe), otherwise fall back to OPENAI_API_KEY
  // This allows using different providers while maintaining backwards compatibility
  const chatApiKey = env.CHAT_API_KEY || env.OPENAI_API_KEY;

  const response = await fetch(chatEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatApiKey}` },
    body: JSON.stringify({
      model: chatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: context },
        { role: "user", content: question },
      ],
      store: true,
      stream: true,
    }),
  });

  if (!response.ok) throw new Error(`Chat API error: ${response.status} ${response.statusText}`);
  return response;
}
