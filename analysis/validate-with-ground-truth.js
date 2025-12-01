/**
 * Validate bot responses against ground truth (data_present column)
 *
 * Rules:
 * - If data_present = YES: Bot MUST answer (not refuse)
 * - If data_present = NO/UNCERTAIN: Bot can say "I don't know" OR provide careful answer
 *
 * Target: 99%+ accuracy
 */

const fs = require('fs');

const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8787';
const DELAY_MS = 500;

/**
 * Test a single question
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
            // Ignore
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
function validateResponse(question, answer, dataPresent, baselineFeedback) {
  const isRefusalResponse = isRefusal(answer);

  // Validation rules
  if (dataPresent === 'YES') {
    // Data is present - bot MUST answer (not refuse)
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
    // Data not present or uncertain - bot can refuse OR provide careful answer
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
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 Validating bot against ground truth (data_present)\n');
  console.log(`Chatbot URL: ${CHATBOT_URL}\n`);

  const testData = JSON.parse(fs.readFileSync('manual-feedback-with-data-check.json', 'utf8'));

  // Filter out invalid questions
  const validTests = testData.filter(r => r['Question asked'] && r['Question asked'] !== 'undefined');

  console.log(`Testing ${validTests.length} questions\n`);

  const results = {
    total: validTests.length,
    passed: 0,
    failed: 0,
    errors: 0,
    dataPresent_shouldAnswer: 0,
    dataPresent_refused: 0, // Critical failures
    dataPresent_answered: 0,
    dataAbsent_refused: 0,
    dataAbsent_answered: 0,
    details: []
  };

  // Count data present vs absent
  validTests.forEach(r => {
    if (r.data_present === 'YES') {
      results.dataPresent_shouldAnswer++;
    }
  });

  console.log(`Questions with data present: ${results.dataPresent_shouldAnswer}\n`);
  console.log('🚀 Testing...\n');

  for (let i = 0; i < validTests.length; i++) {
    const row = validTests[i];
    const question = row['Question asked'];
    const dataPresent = row.data_present;
    const baselineFeedback = row['Feedback '];

    process.stdout.write(`[${i+1}/${validTests.length}] `);

    // Test bot
    const botResult = await testQuestion(question);

    if (!botResult.success) {
      results.errors++;
      console.log(`❌ ERROR`);
      results.details.push({
        question,
        dataPresent,
        verdict: 'ERROR',
        error: botResult.error
      });
      continue;
    }

    // Validate response
    const validation = validateResponse(question, botResult.answer, dataPresent, baselineFeedback);

    const detail = {
      question,
      answer: botResult.answer,
      dataPresent,
      baselineFeedback,
      verdict: validation.verdict,
      reason: validation.reason,
      severity: validation.severity,
      documents: botResult.documents
    };

    results.details.push(detail);

    // Update counts
    if (validation.valid) {
      results.passed++;
      if (validation.verdict === 'PASS') {
        console.log(`✅ PASS`);
      } else {
        console.log(`⚠️  PASS (warning)`);
      }

      if (dataPresent === 'YES') {
        results.dataPresent_answered++;
      } else {
        if (isRefusal(botResult.answer)) {
          results.dataAbsent_refused++;
        } else {
          results.dataAbsent_answered++;
        }
      }
    } else {
      results.failed++;
      console.log(`❌ FAIL`);

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
  console.log('\n' + '='.repeat(70));
  console.log('📊 VALIDATION RESULTS');
  console.log('='.repeat(70));

  console.log('\n🎯 OVERALL:');
  console.log(`   Total tests:        ${results.total}`);
  console.log(`   Passed:             ${results.passed} (${(results.passed/results.total*100).toFixed(1)}%)`);
  console.log(`   Failed:             ${results.failed} (${(results.failed/results.total*100).toFixed(1)}%)`);
  console.log(`   Errors:             ${results.errors}`);

  console.log('\n📋 DATA PRESENT (should answer):');
  console.log(`   Total with data:    ${results.dataPresent_shouldAnswer}`);
  console.log(`   Answered correctly: ${results.dataPresent_answered} (${(results.dataPresent_answered/results.dataPresent_shouldAnswer*100).toFixed(1)}%)`);
  console.log(`   Refused (FAILURES): ${results.dataPresent_refused} (${(results.dataPresent_refused/results.dataPresent_shouldAnswer*100).toFixed(1)}%)`);

  const accuracy = (results.passed / results.total * 100).toFixed(2);
  const answerRate = (results.dataPresent_answered / results.dataPresent_shouldAnswer * 100).toFixed(2);

  console.log('\n🎯 KEY METRICS:');
  console.log(`   Overall Accuracy:   ${accuracy}%`);
  console.log(`   Answer Rate (data present): ${answerRate}%`);
  console.log(`   Refusal Rate (data present): ${(100 - parseFloat(answerRate)).toFixed(2)}%`);

  // Show critical failures
  const criticalFailures = results.details.filter(d => d.severity === 'high');
  if (criticalFailures.length > 0) {
    console.log('\n❌ CRITICAL FAILURES (data present but bot refused):\n');
    criticalFailures.slice(0, 10).forEach((d, i) => {
      console.log(`${i+1}. Q: ${d.question}`);
      console.log(`   A: ${d.answer.substring(0, 100)}...`);
      console.log('');
    });
  }

  console.log('='.repeat(70));

  if (parseFloat(accuracy) >= 99) {
    console.log('🎉 EXCELLENT! Accuracy >= 99% - TARGET ACHIEVED!');
  } else if (parseFloat(accuracy) >= 95) {
    console.log('✅ GOOD! Accuracy >= 95% - Close to target');
  } else if (parseFloat(accuracy) >= 90) {
    console.log('⚠️  FAIR - Need improvement to reach 99%');
  } else {
    console.log('❌ NEEDS SIGNIFICANT IMPROVEMENT');
  }

  console.log('='.repeat(70) + '\n');

  // Save results
  fs.writeFileSync('validation-results.json', JSON.stringify(results, null, 2));
  console.log('💾 Detailed results saved to validation-results.json\n');

  return { accuracy: parseFloat(accuracy), answerRate: parseFloat(answerRate) };
}

/**
 * Main
 */
async function main() {
  const results = await runAllTests();
  const metrics = generateReport(results);

  // Exit code based on accuracy
  process.exit(metrics.accuracy >= 99 ? 0 : 1);
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

module.exports = { testQuestion, validateResponse, runAllTests, generateReport };
