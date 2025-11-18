/**
 * Comprehensive Test Runner
 * Runs extensive tests on the chatbot and measures hallucination rates
 */

const fs = require('fs');
const { validateResponse, generateReport } = require('./response-validator');

// Configuration
const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8787';
const BATCH_SIZE = 10; // Test in batches to avoid overwhelming the server
const DELAY_MS = 500; // Delay between batches

/**
 * Test a single query
 */
async function testQuery(query, expectedBehavior = 'answer') {
  try {
    const startTime = Date.now();

    const response = await fetch(`${CHATBOT_URL}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, ndocs: 5 }),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    if (!response.ok) {
      return {
        query,
        success: false,
        error: `HTTP ${response.status}`,
        latency: Date.now() - startTime
      };
    }

    // Read streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let documents = [];
    let answer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;

        // Parse SSE events
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

            // Extract answer text
            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore parsing errors for non-JSON chunks
          }
        }
      }
    } catch (readError) {
      return {
        query,
        success: false,
        error: `Stream read error: ${readError.message}`,
        latency: Date.now() - startTime
      };
    }

    const latency = Date.now() - startTime;
    const hasRelevantDocs = documents.length > 0;

    // Validate response
    const validation = validateResponse(answer, query, documents, hasRelevantDocs);

    // Detect hallucinations based on expected behavior
    let isHallucination = false;
    const reasons = [];

    // Check validation issues
    if (!validation.valid) {
      isHallucination = true;
      reasons.push(...validation.issues.map(i => i.description));
    }

    // For out-of-scope questions, check if it properly declines
    if (expectedBehavior === 'decline') {
      const declinePatterns = /(I don't have|not available|cannot provide|outside.*scope|not mentioned in|don't know)/i;
      const properlyDeclined = declinePatterns.test(answer);

      if (!properlyDeclined && answer.length > 30) {
        isHallucination = true;
        reasons.push('Should have declined out-of-scope question');
      }
    }

    // Check for answers with no documents
    if (!hasRelevantDocs && answer.length > 100 && expectedBehavior === 'answer') {
      const admitsNoInfo = /(I don't have|not available|cannot find)/i.test(answer);
      if (!admitsNoInfo) {
        isHallucination = true;
        reasons.push('Long answer with no source documents');
      }
    }

    return {
      query,
      success: true,
      answer: answer.trim(),
      answerLength: answer.trim().length,
      documents: documents.length,
      latency,
      validation,
      isHallucination,
      hallucinationReasons: reasons,
      expectedBehavior
    };

  } catch (error) {
    return {
      query,
      success: false,
      error: error.message,
      latency: 0
    };
  }
}

/**
 * Run tests in batches
 */
async function runTests(prompts, options = {}) {
  const {
    batchSize = BATCH_SIZE,
    delayMs = DELAY_MS,
    maxTests = Infinity,
    onProgress = null
  } = options;

  const results = [];
  const promptsToTest = prompts.slice(0, maxTests);
  const totalBatches = Math.ceil(promptsToTest.length / batchSize);

  console.log(`\n🧪 Running ${promptsToTest.length} tests in ${totalBatches} batches...`);
  console.log(`   Batch size: ${batchSize}, Delay: ${delayMs}ms\n`);

  for (let i = 0; i < promptsToTest.length; i += batchSize) {
    const batch = promptsToTest.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    console.log(`📦 Batch ${batchNum}/${totalBatches} (tests ${i + 1}-${Math.min(i + batchSize, promptsToTest.length)})`);

    // Run batch in parallel
    const batchResults = await Promise.all(
      batch.map(prompt => testQuery(prompt.question, prompt.expected))
    );

    results.push(...batchResults);

    // Progress callback
    if (onProgress) {
      onProgress(results.length, promptsToTest.length, batchResults);
    }

    // Show batch summary
    const batchHallucinations = batchResults.filter(r => r.isHallucination).length;
    const batchErrors = batchResults.filter(r => !r.success).length;
    console.log(`   ✓ Complete: ${batchResults.length - batchErrors} passed, ${batchHallucinations} hallucinations, ${batchErrors} errors\n`);

    // Delay between batches (except for last batch)
    if (i + batchSize < promptsToTest.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Generate comprehensive report
 */
function generateTestReport(results) {
  const total = results.length;
  const successful = results.filter(r => r.success).length;
  const errors = total - successful;
  const hallucinations = results.filter(r => r.isHallucination).length;
  const clean = successful - hallucinations;

  const avgLatency = results
    .filter(r => r.success)
    .reduce((sum, r) => sum + r.latency, 0) / successful;

  const avgAnswerLength = results
    .filter(r => r.success)
    .reduce((sum, r) => sum + (r.answerLength || 0), 0) / successful;

  // Break down by expected behavior
  const byBehavior = {};
  results.forEach(r => {
    const behavior = r.expectedBehavior || 'unknown';
    if (!byBehavior[behavior]) {
      byBehavior[behavior] = { total: 0, hallucinations: 0, errors: 0 };
    }
    byBehavior[behavior].total++;
    if (r.isHallucination) byBehavior[behavior].hallucinations++;
    if (!r.success) byBehavior[behavior].errors++;
  });

  // Validation statistics
  const validations = results.filter(r => r.validation).map(r => r.validation);
  const validationReport = validations.length > 0 ? generateReport(validations) : null;

  return {
    summary: {
      total,
      successful,
      errors,
      clean,
      hallucinations,
      hallucinationRate: (hallucinations / successful * 100).toFixed(2),
      errorRate: (errors / total * 100).toFixed(2),
      successRate: (clean / total * 100).toFixed(2),
    },
    performance: {
      avgLatency: avgLatency.toFixed(0),
      avgAnswerLength: avgAnswerLength.toFixed(0),
    },
    byBehavior,
    validation: validationReport,
    topHallucinationReasons: getTopReasons(results),
  };
}

/**
 * Get top hallucination reasons
 */
function getTopReasons(results) {
  const reasonCounts = {};

  results.forEach(r => {
    if (r.hallucinationReasons) {
      r.hallucinationReasons.forEach(reason => {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
    }
  });

  return Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Print report
 */
function printReport(report) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 COMPREHENSIVE TEST REPORT');
  console.log('='.repeat(70));

  console.log('\n🎯 OVERALL SUMMARY:');
  console.log(`   Total tests:        ${report.summary.total}`);
  console.log(`   Successful:         ${report.summary.successful} (${report.summary.successRate}%)`);
  console.log(`   Errors:             ${report.summary.errors} (${report.summary.errorRate}%)`);
  console.log(`   Clean responses:    ${report.summary.clean}`);
  console.log(`   Hallucinations:     ${report.summary.hallucinations} (${report.summary.hallucinationRate}%)`);

  console.log('\n⚡ PERFORMANCE:');
  console.log(`   Avg latency:        ${report.performance.avgLatency}ms`);
  console.log(`   Avg answer length:  ${report.performance.avgAnswerLength} chars`);

  console.log('\n📋 BY EXPECTED BEHAVIOR:');
  for (const [behavior, stats] of Object.entries(report.byBehavior)) {
    const hallRate = (stats.hallucinations / stats.total * 100).toFixed(1);
    console.log(`   ${behavior}:`);
    console.log(`      Total: ${stats.total}, Hallucinations: ${stats.hallucinations} (${hallRate}%), Errors: ${stats.errors}`);
  }

  if (report.topHallucinationReasons.length > 0) {
    console.log('\n⚠️  TOP HALLUCINATION REASONS:');
    report.topHallucinationReasons.forEach((item, index) => {
      console.log(`   ${index + 1}. ${item.reason} (${item.count}x)`);
    });
  }

  console.log('\n' + '='.repeat(70));

  const hallRate = parseFloat(report.summary.hallucinationRate);
  if (hallRate < 1) {
    console.log('🎉 EXCELLENT! Hallucination rate is below 1%');
  } else if (hallRate < 5) {
    console.log('✅ GOOD! Hallucination rate is below 5%, but aim for <1%');
  } else if (hallRate < 10) {
    console.log('⚠️  NEEDS IMPROVEMENT. Hallucination rate should be below 5%');
  } else {
    console.log('❌ CRITICAL. Hallucination rate is too high, needs significant work');
  }

  console.log('='.repeat(70) + '\n');
}

/**
 * Save detailed results
 */
function saveResults(results, report, filename = 'test-results.json') {
  const output = {
    timestamp: new Date().toISOString(),
    report,
    results: results.map(r => ({
      query: r.query,
      success: r.success,
      answer: r.answer?.substring(0, 200), // Truncate for size
      isHallucination: r.isHallucination,
      reasons: r.hallucinationReasons,
      latency: r.latency,
      validation: r.validation ? {
        valid: r.validation.valid,
        confidence: r.validation.confidence,
        issueCount: r.validation.issues.length
      } : null
    }))
  };

  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`💾 Detailed results saved to ${filename}\n`);
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);
  const promptFile = args[0] || 'test-prompts.json';
  const maxTests = parseInt(args[1]) || Infinity;

  console.log('🚀 Comprehensive Hallucination Test Suite');
  console.log(`   Chatbot URL: ${CHATBOT_URL}`);
  console.log(`   Prompt file: ${promptFile}`);

  // Load prompts
  let prompts;
  try {
    const data = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
    prompts = data.prompts || data;
  } catch (error) {
    console.error(`❌ Error loading prompts from ${promptFile}:`, error.message);
    process.exit(1);
  }

  console.log(`   Loaded ${prompts.length} prompts`);
  if (maxTests < prompts.length) {
    console.log(`   Testing first ${maxTests} prompts only`);
  }

  // Run tests
  const results = await runTests(prompts, { maxTests });

  // Generate and print report
  const report = generateTestReport(results);
  printReport(report);

  // Save results
  saveResults(results, report);

  // Exit with error code if hallucination rate is too high
  const hallRate = parseFloat(report.summary.hallucinationRate);
  process.exit(hallRate > 1 ? 1 : 0);
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

module.exports = {
  testQuery,
  runTests,
  generateTestReport,
  printReport,
  saveResults
};
