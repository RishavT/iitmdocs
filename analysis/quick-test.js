/**
 * Quick test with 10 questions
 */

const data = require('./manual-feedback.json');

// Take first 10 questions
const testCases = data.slice(0, 10);

async function quickTest() {
  console.log('Running quick test with 10 questions...\n');

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`${i+1}. Q: ${testCase['Question asked']}`);
    console.log(`   Expected feedback: ${testCase['Feedback ']}`);

    try {
      const response = await fetch('http://localhost:8787/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: testCase['Question asked'], ndocs: 3 }),
        signal: AbortSignal.timeout(20000)
      });

      if (!response.ok) {
        console.log(`   Bot: ERROR - HTTP ${response.status}\n`);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let answer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const events = chunk.split('\n\n').filter(e => e.trim().startsWith('data: '));

        for (const event of events) {
          try {
            const dataStr = event.substring(event.indexOf('data: ') + 6);
            if (dataStr === '[DONE]') continue;

            const data = JSON.parse(dataStr);
            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore
          }
        }
      }

      const shortAnswer = answer.trim().substring(0, 150);
      console.log(`   Bot: ${shortAnswer}${answer.length > 150 ? '...' : ''}\n`);

    } catch (error) {
      console.log(`   Bot: ERROR - ${error.message}\n`);
    }

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

quickTest().catch(console.error);
