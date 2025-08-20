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

// Store for conversation sessions (in production, use a proper database)
const sessions = new Map();

async function answer(request, env) {
  const { q: question, ndocs = 5, session_id, previous_response_id } = await request.json();
  if (!question) return new Response('Missing "q" parameter', { status: 400 });
  
  // Generate session ID if not provided
  const sessionId = session_id || crypto.randomUUID();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Search Weaviate for relevant documents
      const documents = await searchWeaviate(question, ndocs, env);
      // Stream documents first (single enqueue)
      if (documents?.length) {
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
                              link: `https://github.com/study-iitm/iitmdocs/blob/main/src/${doc.filename}`,
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
      const answer = await generateAnswer(question, documents, sessionId, previous_response_id, env);
      let responseContent = "";
      
      await answer.body.pipeTo(
        new WritableStream({
          write: (chunk) => {
            const text = new TextDecoder().decode(chunk);
            // Extract content from SSE format for storage
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.output?.[0]?.content) {
                    responseContent += data.output[0].content;
                  }
                } catch (e) {
                  // Ignore parsing errors for non-JSON lines
                }
              }
            }
            controller.enqueue(chunk);
          },
          close: () => {
            // Store the complete response in session history
            if (responseContent) {
              const sessionHistory = sessions.get(sessionId) || [];
              sessionHistory.push({ role: "assistant", content: responseContent });
              sessions.set(sessionId, sessionHistory);
            }
            controller.close();
          },
          abort: (reason) => controller.error(reason),
        }),
      );
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
  const response = await fetch(`${env.WEAVIATE_URL}/v1/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.WEAVIATE_API_KEY}`,
      "X-OpenAI-Api-Key": env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      query: `{
        Get {
          Document(nearText: { concepts: ["${query}"] } limit: ${limit}) {
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

async function generateAnswer(question, documents, sessionId, previousResponseId, env) {
  const context = documents.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n");

  const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.
Answer directly in VERY simple, CONCISE Markdown.
If the question is unclear, infer, state your assumption, and then respond accordingly.
Current date: ${new Date().toISOString().split("T")[0]}.
Use the information from documents provided.`;

  // Get or initialize conversation history for this session
  let sessionHistory = sessions.get(sessionId) || [];
  
  // Add context and current question to history
  const input = [
    { role: "system", content: systemPrompt },
    { role: "assistant", content: context },
    ...sessionHistory,
    { role: "user", content: question },
  ];

  const requestBody = {
    model: "gpt-5-mini",
    input: input,
    store: true,
    stream: true,
  };
  
  if (previousResponseId) {
    requestBody.previous_response_id = previousResponseId;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  
  // Store the question in session history (response will be stored after streaming completes)
  sessionHistory.push({ role: "user", content: question });
  sessions.set(sessionId, sessionHistory);
  
  return response;
}
