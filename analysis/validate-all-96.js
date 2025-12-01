/**
 * Validate all 96 questions from manual2.csv
 * Runs complete end-to-end validation
 */

const fs = require('fs');

const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8788';
const DELAY_MS = 1000; // 1 second between questions
const OUTPUT_FILE = 'validation-all-96-results.md';

/**
 * Test a single question
 */
async function testQuestion(question) {
  try {
    const response = await fetch(`${CHATBOT_URL}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: question, ndocs: 15 }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    let documents = [];
    let buffer = '';

    try {
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const trimmed = event.trim();
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const dataStr = trimmed.substring(trimmed.indexOf('data: ') + 6).trim();
            if (dataStr === '[DONE]') {
              streamDone = true;
              break;
            }

            const data = JSON.parse(dataStr);

            if (data.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'document') {
              const docArgs = JSON.parse(data.choices[0].delta.tool_calls[0].function.arguments);
              documents.push(docArgs);
            }

            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Skip non-JSON events
          }
        }
      }
    } catch (streamError) {
      return { success: false, error: `Stream error: ${streamError.message}` };
    }

    return { success: true, answer: answer.trim(), documents };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if response is a refusal (improved logic)
 */
function isRefusal(answer) {
  const refusalPhrases = [
    "i don't have",
    "i do not have",
    "information not available",
    "cannot find",
    "don't know",
    "do not know",
    "not available in",
    "no information"
  ];

  const lowerAnswer = answer.toLowerCase();
  const hasRefusalPhrase = refusalPhrases.some(phrase => lowerAnswer.includes(phrase));

  if (!hasRefusalPhrase) {
    return false;
  }

  const helpfulContentIndicators = [
    'grading policy',
    'assessment',
    'eligibility',
    'formula',
    'criteria',
    'requirement',
    'procedure',
    'policy',
    'quiz',
    'exam',
    'oppe',
    'cgpa',
    'credits',
    'term',
    'registration',
    'fee'
  ];

  const hasHelpfulContent = helpfulContentIndicators.some(indicator =>
    lowerAnswer.includes(indicator)
  );

  if (answer.length > 400 && hasHelpfulContent) {
    return false;
  }

  return true;
}

/**
 * Validate a response
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
    }

    return {
      valid: true,
      verdict: 'PASS',
      reason: 'Bot provided answer when data is present',
      severity: 'none'
    };
  } else {
    return {
      valid: true,
      verdict: 'PASS',
      reason: `Bot ${isRefusalResponse ? 'refused' : 'answered'} for uncertain data (acceptable)`,
      severity: 'none'
    };
  }
}

/**
 * Parse CSV properly handling multi-line fields
 */
function parseCSV(content) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"' && nextChar === '"' && inQuotes) {
      currentField += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if (char === '\n' && !inQuotes) {
      currentRow.push(currentField.trim());
      if (currentRow.some(field => field !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(field => field !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Main validation function
 */
async function runValidation() {
  console.log('=== FRESH VALIDATION: ALL 96 QUESTIONS ===\n');
  console.log('Loading test data...');

  const csvContent = fs.readFileSync('manual2.csv', 'utf8');
  const rows = parseCSV(csvContent);
  console.log(`Parsed ${rows.length} rows from CSV\n`);

  const answerableQuestions = [];

  // Get all questions (1-96)
  for (let i = 1; i <= 96 && i < rows.length; i++) {
    const fields = rows[i];
    answerableQuestions.push({
      'Question asked': fields[0] || '',
      data_present: 'YES'
    });
  }

  console.log(`Testing ${answerableQuestions.length} questions...\n`);

  let results = [];
  let passed = 0;
  let failed = 0;
  let batchStats = {};

  let output = `# Fresh Validation Results - All 96 Questions\n\n`;
  output += `**Test Date:** ${new Date().toISOString()}\n`;
  output += `**Chatbot URL:** ${CHATBOT_URL}\n`;
  output += `**Questions Tested:** ${answerableQuestions.length}\n\n`;
  output += `---\n\n`;

  for (let i = 0; i < answerableQuestions.length; i++) {
    const item = answerableQuestions[i];
    const questionNum = i + 1;
    const question = item['Question asked'];

    // Calculate which batch this belongs to
    const batchNum = Math.floor(i / 10) + 1;
    const batchKey = `Batch ${batchNum} (Q${(batchNum-1)*10+1}-${Math.min(batchNum*10, 96)})`;
    if (!batchStats[batchKey]) {
      batchStats[batchKey] = { passed: 0, failed: 0, total: 0 };
    }

    process.stdout.write(`[${questionNum}/${answerableQuestions.length}] Testing: "${question.substring(0, 50)}..." `);

    const result = await testQuestion(question);

    if (!result.success) {
      process.stdout.write(`❌ ERROR\n`);
      failed++;
      batchStats[batchKey].failed++;
      batchStats[batchKey].total++;

      output += `## Question ${questionNum}: ❌ ERROR\n\n`;
      output += `**Q:** ${question}\n\n`;
      output += `**Error:** ${result.error}\n\n`;
      output += `---\n\n`;
      continue;
    }

    const validation = validateResponse(item.question, result.answer, item.data_present);

    if (validation.valid) {
      process.stdout.write(`✅ ${validation.verdict}\n`);
      passed++;
      batchStats[batchKey].passed++;
    } else {
      process.stdout.write(`❌ ${validation.verdict}\n`);
      failed++;
      batchStats[batchKey].failed++;
    }
    batchStats[batchKey].total++;

    results.push({
      question: question,
      dataPresent: item.data_present,
      ...result,
      validation
    });

    // Delay between requests
    if (i < answerableQuestions.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  // Summary
  const accuracy = (passed / answerableQuestions.length * 100).toFixed(2);

  console.log(`\n\n=== SUMMARY ===`);
  console.log(`Total Questions: ${answerableQuestions.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Accuracy: ${accuracy}%\n`);

  console.log('=== BATCH BREAKDOWN ===');
  for (const [batch, stats] of Object.entries(batchStats)) {
    const batchAccuracy = (stats.passed / stats.total * 100).toFixed(1);
    console.log(`${batch}: ${stats.passed}/${stats.total} (${batchAccuracy}%)`);
  }

  output += `\n# Summary\n\n`;
  output += `**Total Questions:** ${answerableQuestions.length}\n`;
  output += `**Passed:** ${passed}\n`;
  output += `**Failed:** ${failed}\n`;
  output += `**Accuracy:** ${accuracy}%\n\n`;

  output += `## Batch Breakdown\n\n`;
  output += `| Batch | Passed | Total | Accuracy |\n`;
  output += `|-------|--------|-------|----------|\n`;
  for (const [batch, stats] of Object.entries(batchStats)) {
    const batchAccuracy = (stats.passed / stats.total * 100).toFixed(1);
    output += `| ${batch} | ${stats.passed} | ${stats.total} | ${batchAccuracy}% |\n`;
  }
  output += `\n`;

  if (failed > 0) {
    output += `## Failed Questions\n\n`;
    results.forEach((r, idx) => {
      if (!r.validation?.valid || !r.success) {
        output += `${idx + 1}. ${r.question}\n`;
        output += `   - Reason: ${r.validation?.reason || r.error}\n\n`;
      }
    });
  }

  // Save to file
  fs.writeFileSync(OUTPUT_FILE, output);

  console.log(`\nDetailed results saved to: ${OUTPUT_FILE}`);

  if (accuracy >= 99) {
    console.log('\n🎉 TARGET ACHIEVED! Accuracy >= 99%');
  } else if (accuracy >= 95) {
    console.log('\n✅ EXCELLENT! Accuracy >= 95%');
  }
}

runValidation().catch(console.error);
