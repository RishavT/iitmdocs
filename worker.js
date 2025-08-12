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
      const answer = await generateAnswer(question, documents, env);
      await answer.body.pipeTo(
        new WritableStream({
          write: (chunk) => controller.enqueue(chunk),
          close: () => controller.close(),
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

async function generateAnswer(question, documents, env) {
  const context = documents.map((doc) => `<document filename="${doc.filename}">${doc.content}</document>`).join("\n\n");

  const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.
Answer directly in VERY simple, CONCISE Markdown.
If the question is unclear, infer, state your assumption, and then respond accordingly.
Current date: ${new Date().toISOString().split("T")[0]}.
Use the information below.

<documents>
${context}
</documents>`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
      stream: true,
    }),
  });

  if (!response.ok) throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  return response;
}
