/**
 * CloudFlare Worker for Semantic Document Search & AI Answer Generation
 * Returns OpenAI-style streaming responses compatible with asyncLLM
 */

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Only handle POST /answer
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/answer') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const { q: question, ndocs = 5 } = await request.json();
      if (!question) {
        return new Response('Missing "q" parameter', { status: 400 });
      }

      const stream = new ReadableStream({
        async start(controller) {
          const requestLog = {
            request_id: requestId,
            timestamp: new Date().toISOString(),
            question: question,
            answer: null,
            references: [],
            error: null,
            duration_ms: 0,
            status: 'success'
          };

          try {
            // Search Weaviate for relevant documents
            const documents = await searchWeaviate(question, ndocs, env);
            requestLog.references = documents.map(doc => ({
              filename: doc.filename,
              relevance: doc.relevance
            }));

            // Stream documents first as OpenAI-style chunks
            for (const doc of documents) {
              const docData = {
                id: `doc-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "document-search",
                choices: [{
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: JSON.stringify({
                      type: "document",
                      relevance: doc.relevance,
                      text: doc.content.substring(0, 500) + (doc.content.length > 500 ? '...' : ''),
                      link: `https://github.com/study-iitm/iitmdocs/blob/main/src/${doc.filename}`
                    })
                  },
                  finish_reason: null
                }]
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(docData)}\n\n`));
            }

            // Generate AI answer using documents as context
            const answer = await generateAnswer(question, documents, controller, env);
            requestLog.answer = answer;

            // Send final chunk
            const finalChunk = {
              id: `final-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "gpt-4.1-mini",
              choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop"
              }]
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));

            controller.close();
          } catch (error) {
            requestLog.error = {
              message: error.message,
              stack: error.stack
            };
            requestLog.status = 'error';
            controller.error(error);
          } finally {
            requestLog.duration_ms = Date.now() - startTime;
            console.log(requestLog);
          }
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (error) {
      const requestLog = {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        question: null,
        answer: null,
        references: [],
        error: {
          message: error.message,
          stack: error.stack
        },
        duration_ms: Date.now() - startTime,
        status: 'error'
      };
      console.log(requestLog);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

async function searchWeaviate(query, limit, env) {
  const response = await fetch(`${env.WEAVIATE_URL}/v1/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.WEAVIATE_API_KEY}`,
      'X-OpenAI-Api-Key': env.OPENAI_API_KEY
    },
    body: JSON.stringify({
      query: `{
        Get {
          Document(nearText: { concepts: ["${query}"] } limit: ${limit}) {
            filename filepath content file_size
            _additional { distance }
          }
        }
      }`
    })
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Weaviate error: ${data.errors.map(e => e.message).join(', ')}`);
  }

  const documents = data.data?.Get?.Document || [];
  return documents.map(doc => ({
    filename: doc.filename,
    filepath: doc.filepath,
    content: doc.content,
    relevance: doc._additional?.distance ? (1 - doc._additional.distance) : 0
  }));
}

async function generateAnswer(question, documents, controller, env) {
  // Prepare context in XML format
  const context = documents.map(doc =>
    `<document filename="${doc.filename}" filepath="${doc.filepath}">
${doc.content}
</document>`
  ).join('\n\n');

  const currentDate = new Date().toISOString().split('T')[0];
  
  const systemPrompt = `You are a helpful assistant answering questions about an academic program. Today's date is ${currentDate}. Use the provided documents to answer the user's question accurately and concisely.

<documents>
${context}
</documents>

When user's intent is unclear, infer, clearly state the assumption, and then respond accordingly.
Please provide a clear, helpful answer based on the information in the documents above. Respond in markdown format.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      stream: true
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return fullResponse;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;

            if (content) {
              fullResponse += content;
              const answerChunk = {
                id: parsed.id,
                object: "chat.completion.chunk",
                created: parsed.created,
                model: parsed.model,
                choices: [{
                  index: 0,
                  delta: {
                    content: JSON.stringify({ type: "chunk", text: content })
                  },
                  finish_reason: null
                }]
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(answerChunk)}\n\n`));
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullResponse += content;
              const answerChunk = {
                id: parsed.id,
                object: "chat.completion.chunk",
                created: parsed.created,
                model: parsed.model,
                choices: [{
                  index: 0,
                  delta: {
                    content: JSON.stringify({ type: "chunk", text: content })
                  },
                  finish_reason: null
                }]
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(answerChunk)}\n\n`));
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return fullResponse;

  } finally {
    reader.releaseLock();
  }
}