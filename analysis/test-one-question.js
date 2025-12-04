/**
 * Test script to call the chatbot with ONE question
 */

const testQuestion = async () => {
  const url = 'http://localhost:8788/answer';
  const body = JSON.stringify({
    q: 'What is IIT Madras?',
    ndocs: 3
  });

  console.log('Testing with question:', 'What is IIT Madras?');
  console.log('Calling:', url);
  console.log('');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers));
    console.log('');

    if (!response.ok) {
      const text = await response.text();
      console.error('Error response:', text);
      return;
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let documents = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      process.stdout.write(chunk);

      // Parse SSE events
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            // Check for error
            if (parsed.error) {
              console.error('\n\nError from server:', parsed.error);
            }

            // Check for document
            if (parsed.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'document') {
              documents.push(parsed.choices[0].delta.tool_calls[0].function.arguments);
            }

            // Check for content
            if (parsed.choices?.[0]?.delta?.content) {
              fullResponse += parsed.choices[0].delta.content;
            }
          } catch (e) {
            // Not JSON, skip
          }
        }
      }
    }

    console.log('\n\n========== RESULTS ==========');
    console.log('Documents found:', documents.length);
    documents.forEach((doc, i) => {
      try {
        const parsed = JSON.parse(doc);
        console.log(`  ${i + 1}. ${parsed.name} (relevance: ${parsed.relevance})`);
      } catch (e) {
        console.log(`  ${i + 1}. ${doc}`);
      }
    });
    console.log('\nAnswer:', fullResponse || '(no answer received)');
    console.log('============================');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
};

testQuestion();
