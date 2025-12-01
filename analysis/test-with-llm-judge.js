/**
 * Test bot against manual feedback using LLM as judge
 */

const fs = require('fs');

// Configuration
const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8787';
const JUDGE_API_ENDPOINT = process.env.CHAT_API_ENDPOINT || 'https://aipipe.org/openrouter/v1/chat/completions';
const JUDGE_API_KEY = process.env.OPENAI_API_KEY || process.env.CHAT_API_KEY;
const DELAY_MS = 500; // Delay between requests

/**
 * Test a single question against the bot
 */
async function testQuestion(question) {
  try {
    const response = await fetch(`${CHATBOT_URL}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: question, ndocs: 5 }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    // Read streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    let documents = [];

    try {
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

            // Extract documents
            if (data.choices?.[0]?.delta?.tool_calls) {
              const toolCall = data.choices[0].delta.tool_calls[0];
              if (toolCall?.function?.name === 'document') {
                documents.push(JSON.parse(toolCall.function.arguments));
              }
            }

            // Extract answer
            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
      }
    } catch (readError) {
      return { success: false, error: `Stream error: ${readError.message}` };
    }

    return {
      success: true,
      answer: answer.trim(),
      documents: documents.length,
      hasRelevantDocs: documents.length > 0
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Use LLM to judge if answer is correct/acceptable
 */
async function judgAnswer(question, botAnswer, expectedAnswer, baselineFeedback) {
  const judgePrompt = `You are an expert evaluator judging chatbot responses.

Question: "${question}"

Expected/Reference Answer: "${expectedAnswer}"
Baseline Feedback: ${baselineFeedback}

Bot's Current Answer: "${botAnswer}"

Evaluate the bot's answer and provide:
1. Is it CORRECT, ACCEPTABLE, or WRONG?
   - CORRECT: Provides accurate information matching expected answer
   - ACCEPTABLE: Provides relevant information, may be partial but not wrong
   - WRONG: Provides incorrect information, hallucinations, or refuses to answer when it should answer

2. Brief explanation (1-2 sentences)

3. If bot says "I don't know" but the expected answer exists, mark as WRONG

Respond in JSON format:
{
  "verdict": "CORRECT" | "ACCEPTABLE" | "WRONG",
  "explanation": "brief explanation",
  "is_refusal": true/false (if bot refused to answer)
}`;

  try {
    const response = await fetch(JUDGE_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JUDGE_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert evaluator. Always respond with valid JSON.' },
          { role: 'user', content: judgePrompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return {
        verdict: 'ERROR',
        explanation: `Judge API error: ${response.status}`,
        is_refusal: false
      };
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    const judgment = JSON.parse(content);

    return judgment;

  } catch (error) {
    return {
      verdict: 'ERROR',
      explanation: `Judge error: ${error.message}`,
      is_refusal: false
    };
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 Testing bot against manual feedback with LLM judge\n');
  console.log(`Chatbot URL: ${CHATBOT_URL}`);
  console.log(`Judge API: ${JUDGE_API_ENDPOINT}\n`);

  const manualFeedback = JSON.parse(fs.readFileSync('manual-feedback.json', 'utf8'));

  const results = {
    total: manualFeedback.length,
    correct: 0,
    acceptable: 0,
    wrong: 0,
    errors: 0,
    baseline_correct: 0,
    baseline_incorrect: 0,
    degraded: [], // Questions that were correct in baseline but wrong now
    improved: [], // Questions that were wrong in baseline but correct now
    still_wrong: [], // Questions wrong in both baseline and now
    details: []
  };

  // Count baseline performance
  manualFeedback.forEach(row => {
    if (row['Feedback '] === 'Correct') {
      results.baseline_correct++;
    } else {
      results.baseline_incorrect++;
    }
  });

  console.log(`📊 Baseline Performance:`);
  console.log(`   Correct: ${results.baseline_correct}/${results.total} (${(results.baseline_correct/results.total*100).toFixed(1)}%)\n`);

  console.log(`🚀 Testing current bot...\n`);

  for (let i = 0; i < manualFeedback.length; i++) {
    const row = manualFeedback[i];
    const question = row['Question asked'];
    const expectedAnswer = row['Reply given '];
    const baselineFeedback = row['Feedback '];

    process.stdout.write(`[${i+1}/${manualFeedback.length}] Testing... `);

    // Test bot
    const botResult = await testQuestion(question);

    if (!botResult.success) {
      results.errors++;
      console.log(`❌ ERROR`);
      results.details.push({
        question,
        baseline: baselineFeedback,
        verdict: 'ERROR',
        error: botResult.error
      });
      continue;
    }

    // Judge answer
    const judgment = await judgAnswer(question, botResult.answer, expectedAnswer, baselineFeedback);

    const detail = {
      question,
      botAnswer: botResult.answer,
      expectedAnswer,
      baseline: baselineFeedback,
      verdict: judgment.verdict,
      explanation: judgment.explanation,
      is_refusal: judgment.is_refusal,
      documents: botResult.documents
    };

    results.details.push(detail);

    // Update counts
    if (judgment.verdict === 'CORRECT') {
      results.correct++;
      console.log(`✅ CORRECT`);
      if (baselineFeedback !== 'Correct') {
        results.improved.push(detail);
      }
    } else if (judgment.verdict === 'ACCEPTABLE') {
      results.acceptable++;
      console.log(`✓ ACCEPTABLE`);
    } else if (judgment.verdict === 'WRONG') {
      results.wrong++;
      console.log(`❌ WRONG`);
      if (baselineFeedback === 'Correct') {
        results.degraded.push(detail);
      } else {
        results.still_wrong.push(detail);
      }
    } else {
      results.errors++;
      console.log(`⚠️  ERROR`);
    }

    // Delay between requests
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  return results;
}

/**
 * Generate report
 */
function generateReport(results) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 TEST RESULTS');
  console.log('='.repeat(70));

  console.log('\n🎯 CURRENT PERFORMANCE:');
  console.log(`   Total tests:        ${results.total}`);
  console.log(`   Correct:            ${results.correct} (${(results.correct/results.total*100).toFixed(1)}%)`);
  console.log(`   Acceptable:         ${results.acceptable} (${(results.acceptable/results.total*100).toFixed(1)}%)`);
  console.log(`   Wrong:              ${results.wrong} (${(results.wrong/results.total*100).toFixed(1)}%)`);
  console.log(`   Errors:             ${results.errors}`);

  const successRate = (results.correct + results.acceptable) / results.total * 100;
  console.log(`\n   Success Rate:       ${successRate.toFixed(1)}% (Correct + Acceptable)`);

  console.log('\n📈 BASELINE COMPARISON:');
  console.log(`   Baseline correct:   ${results.baseline_correct}/${results.total} (${(results.baseline_correct/results.total*100).toFixed(1)}%)`);
  console.log(`   Current success:    ${results.correct + results.acceptable}/${results.total} (${successRate.toFixed(1)}%)`);

  const change = successRate - (results.baseline_correct/results.total*100);
  if (change > 0) {
    console.log(`   Change:             +${change.toFixed(1)}% ✅ IMPROVED`);
  } else {
    console.log(`   Change:             ${change.toFixed(1)}% ⚠️  DEGRADED`);
  }

  console.log('\n🔍 DETAILED ANALYSIS:');
  console.log(`   Degraded:           ${results.degraded.length} (correct → wrong)`);
  console.log(`   Improved:           ${results.improved.length} (wrong → correct)`);
  console.log(`   Still wrong:        ${results.still_wrong.length} (wrong → wrong)`);

  if (results.degraded.length > 0) {
    console.log('\n⚠️  DEGRADED QUESTIONS (were correct, now wrong):');
    results.degraded.slice(0, 10).forEach((detail, i) => {
      console.log(`\n${i+1}. Q: ${detail.question}`);
      console.log(`   Expected: ${detail.expectedAnswer.substring(0, 100)}...`);
      console.log(`   Bot says: ${detail.botAnswer.substring(0, 100)}...`);
      console.log(`   Reason: ${detail.explanation}`);
    });
  }

  if (results.improved.length > 0) {
    console.log('\n✅ IMPROVED QUESTIONS (were wrong, now correct):');
    results.improved.slice(0, 5).forEach((detail, i) => {
      console.log(`\n${i+1}. Q: ${detail.question}`);
    });
  }

  console.log('\n' + '='.repeat(70));

  if (change < 0) {
    console.log('❌ PERFORMANCE DEGRADED - Need to iterate on improvements');
  } else if (successRate < 90) {
    console.log('⚠️  PERFORMANCE BELOW 90% - More improvements needed');
  } else {
    console.log('✅ GOOD PERFORMANCE - Meeting quality targets');
  }

  console.log('='.repeat(70) + '\n');

  // Save detailed results
  fs.writeFileSync('test-results-with-judge.json', JSON.stringify(results, null, 2));
  console.log('💾 Detailed results saved to test-results-with-judge.json\n');

  return results;
}

/**
 * Main
 */
async function main() {
  const results = await runAllTests();
  generateReport(results);

  // Exit code based on performance
  const successRate = (results.correct + results.acceptable) / results.total * 100;
  process.exit(successRate >= 90 ? 0 : 1);
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

module.exports = { testQuestion, judgAnswer, runAllTests, generateReport };
