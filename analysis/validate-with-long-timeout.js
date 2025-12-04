/**
 * Validate bot responses with VERY long timeout for slow API responses
 * Modified version of validate-with-ground-truth.js with 120s timeout
 */

const fs = require('fs');

const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8787';
const DELAY_MS = 1000; // Longer delay between requests
const TIMEOUT_MS = 120000; // 120 seconds

/**
 * Test a single question
 */
async function testQuestion(question) {
  try {
    const response = await fetch(`${CHATBOT_URL}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: question, ndocs: 5 }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    let documents = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const events = chunk.split('\\n\\n').filter(e => e.trim().startsWith('data: '));

        for (const event of events) {
          try {
            const dataStr = event.substring(event.indexOf('data: ') + 6);
            if (dataStr === '[DONE]') continue;

            const data = JSON.parse(dataStr);

            if (data.choices?.[0]?.delta?.tool_calls) {
              const toolCall = data.choices[0].delta.tool_calls[0];
              if (toolCall?.function?.name === 'document') {
                documents.push(JSON.parse(toolCall.function.arguments));
              }
            }

            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore parse errors
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
      hasAnswer: answer.trim().length > 0
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if response is a refusal
 */
function isRefusal(answer) {
  const refusalPatterns = [
    /i don'?t (have|know)/i,
    /not available/i,
    /cannot (find|provide)/i,
    /no information/i,
    /information is not/i,
    /don'?t have.*information/i
  ];

  return refusalPatterns.some(pattern => pattern.test(answer));
}

/**
 * Validate a single response
 */
function validateResponse(question, answer, dataPresent) {
  const isRefusalResponse = isRefusal(answer);

  if (dataPresent === 'YES') {
    if (isRefusalResponse) {
      return {
        valid: false,
        verdict: 'FAIL',
        reason: 'Data present but bot refused to answer',
        severity: 'high'
      };
    } else if (answer.length < 20) {
      return {
        valid: false,
        verdict: 'FAIL',
        reason: 'Data present but answer too short/incomplete',
        severity: 'medium'
      };
    } else {
      return {
        valid: true,
        verdict: 'PASS',
        reason: 'Data present and bot provided answer'
      };
    }
  } else {
    if (isRefusalResponse) {
      return {
        valid: true,
        verdict: 'PASS',
        reason: 'Data uncertain/not present, bot appropriately declined'
      };
    } else {
      return {
        valid: true,
        verdict: 'PASS_WITH_WARNING',
        reason: 'Data uncertain but bot attempted answer (check for hallucination)'
      };
    }
  }
}

/**
 * Run limited batch of tests
 */
async function runBatchTests(batchSize = 5) {
  console.log(`🧪 Validating bot with long timeout (${TIMEOUT_MS/1000}s)\\n`);
  console.log(`Chatbot URL: ${CHATBOT_URL}\\n`);

  const testData = JSON.parse(fs.readFileSync('manual-feedback-with-data-check.json', 'utf8'));

  // Filter out invalid questions and limit batch size
  const validTests = testData
    .filter(r => r['Question asked'] && r['Question asked'] !== 'undefined')
    .slice(0, batchSize);

  console.log(`Testing ${validTests.length} questions (batch of ${batchSize})\\n`);

  const results = {
    total: validTests.length,
    passed: 0,
    failed: 0,
    errors: 0,
    dataPresent_shouldAnswer: 0,
    dataPresent_refused: 0,
    dataPresent_answered: 0,
    details: []
  };

  // Count data present
  validTests.forEach(r => {
    if (r.data_present === 'YES') {
      results.dataPresent_shouldAnswer++;
    }
  });

  console.log(`Questions with data present: ${results.dataPresent_shouldAnswer}\\n`);
  console.log('🚀 Testing...\\n');

  for (let i = 0; i < validTests.length; i++) {
    const row = validTests[i];
    const question = row['Question asked'];
    const dataPresent = row.data_present;

    process.stdout.write(`[${i+1}/${validTests.length}] ${question.substring(0, 50)}... `);

    const startTime = Date.now();
    const botResult = await testQuestion(question);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!botResult.success) {
      results.errors++;
      console.log(`❌ ERROR (${elapsed}s): ${botResult.error}`);
      results.details.push({
        question,
        dataPresent,
        verdict: 'ERROR',
        error: botResult.error,
        elapsed
      });
      continue;
    }

    const validation = validateResponse(question, botResult.answer, dataPresent);

    const detail = {
      question,
      answer: botResult.answer,
      dataPresent,
      verdict: validation.verdict,
      reason: validation.reason,
      severity: validation.severity,
      documents: botResult.documents,
      elapsed
    };

    results.details.push(detail);

    if (validation.valid) {
      results.passed++;
      if (validation.verdict === 'PASS') {
        console.log(`✅ PASS (${elapsed}s)`);
      } else {
        console.log(`⚠️  PASS (warning) (${elapsed}s)`);
      }

      if (dataPresent === 'YES') {
        results.dataPresent_answered++;
      }
    } else {
      results.failed++;
      console.log(`❌ FAIL (${elapsed}s)`);

      if (dataPresent === 'YES') {
        results.dataPresent_refused++;
      }
    }

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  return results;
}

/**
 * Generate report
 */
function generateReport(results) {
  console.log('\\n' + '='.repeat(70));
  console.log('📊 BATCH TEST RESULTS');
  console.log('='.repeat(70));

  console.log('\\n🎯 OVERALL:');
  console.log(`   Total tests:        ${results.total}`);
  console.log(`   Passed:             ${results.passed} (${(results.passed/results.total*100).toFixed(1)}%)`);
  console.log(`   Failed:             ${results.failed} (${(results.failed/results.total*100).toFixed(1)}%)`);
  console.log(`   Errors:             ${results.errors}`);

  if (results.dataPresent_shouldAnswer > 0) {
    console.log('\\n📋 DATA PRESENT (should answer):');
    console.log(`   Total with data:    ${results.dataPresent_shouldAnswer}`);
    console.log(`   Answered correctly: ${results.dataPresent_answered} (${(results.dataPresent_answered/results.dataPresent_shouldAnswer*100).toFixed(1)}%)`);
    console.log(`   Refused (FAILURES): ${results.dataPresent_refused} (${(results.dataPresent_refused/results.dataPresent_shouldAnswer*100).toFixed(1)}%)`);
  }

  const accuracy = (results.passed / results.total * 100).toFixed(2);
  const avgTime = (results.details.reduce((sum, d) => sum + parseFloat(d.elapsed || 0), 0) / results.details.length).toFixed(1);

  console.log('\\n🎯 KEY METRICS:');
  console.log(`   Overall Accuracy:   ${accuracy}%`);
  console.log(`   Average Time:       ${avgTime}s`);

  console.log('\\n📝 DETAILED RESULTS:\\n');
  results.details.forEach((d, i) => {
    const icon = d.verdict === 'PASS' ? '✅' : d.verdict === 'ERROR' ? '❌' : '⚠️';
    console.log(`${i+1}. ${icon} ${d.verdict} (${d.elapsed}s)`);
    console.log(`   Q: ${d.question}`);
    if (d.answer) {
      console.log(`   A: ${d.answer.substring(0, 100)}${d.answer.length > 100 ? '...' : ''}`);
    }
    if (d.error) {
      console.log(`   Error: ${d.error}`);
    }
    console.log('');
  });

  console.log('='.repeat(70) + '\\n');

  fs.writeFileSync('batch-validation-results.json', JSON.stringify(results, null, 2));
  console.log('💾 Detailed results saved to batch-validation-results.json\\n');

  return { accuracy: parseFloat(accuracy) };
}

/**
 * Main
 */
async function main() {
  const batchSize = parseInt(process.argv[2]) || 5;
  console.log(`Running batch test with ${batchSize} questions\\n`);

  const results = await runBatchTests(batchSize);
  const metrics = generateReport(results);

  process.exit(0);
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

module.exports = { testQuestion, validateResponse, runBatchTests, generateReport };
