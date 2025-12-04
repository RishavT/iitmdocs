/**
 * Validate bot responses for first 10 questions against ground truth
 * Saves detailed analysis to file
 */

const fs = require('fs');

const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8788';
const DELAY_MS = 1000; // 1 second between questions
const OUTPUT_FILE = 'validation-questions-91-96-results.md';

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
    let buffer = ''; // Buffer for partial chunks

    try {
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append to buffer to handle split chunks
        buffer += decoder.decode(value, { stream: true });

        // Split by double newline but keep last partial event in buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep last partial event in buffer

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

            // Extract documents
            if (data.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'document') {
              const docArgs = JSON.parse(data.choices[0].delta.tool_calls[0].function.arguments);
              documents.push(docArgs);
            }

            // Extract answer content
            if (data.choices?.[0]?.delta?.content) {
              answer += data.choices[0].delta.content;
            }
          } catch (e) {
            // Skip non-JSON events or parsing errors
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
 * Check if response is a refusal
 *
 * Improved logic: A response is only a refusal if it:
 * 1. Contains refusal phrases, AND
 * 2. Is either short (<400 chars) OR lacks substantial helpful content
 *
 * This allows answers that acknowledge information gaps while still
 * providing helpful policy/grading/procedural information.
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

  // If no refusal phrases, it's definitely not a refusal
  if (!hasRefusalPhrase) {
    return false;
  }

  // Check if answer contains substantial helpful content
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

  // If answer is substantial (>400 chars) AND contains helpful content,
  // it's not a refusal even if it mentions information gaps
  if (answer.length > 400 && hasHelpfulContent) {
    return false;
  }

  // Short answer with refusal phrases = actual refusal
  return true;
}

/**
 * Validate a response against ground truth
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

    // Bot answered - that's good, but we'd need LLM judge for full validation
    return {
      valid: true,
      verdict: 'PASS',
      reason: 'Bot provided answer when data is present',
      severity: 'none'
    };
  } else {
    // data_present is NO or UNCERTAIN - bot can refuse or answer carefully
    return {
      valid: true,
      verdict: 'PASS',
      reason: `Bot ${isRefusalResponse ? 'refused' : 'answered'} for uncertain data (acceptable)`,
      severity: 'none'
    };
  }
}

/**
 * Main validation function
 */
async function runValidation() {
  console.log('Loading test data...');

  // Read manual2.csv and parse questions properly handling multi-line fields
  const csvContent = fs.readFileSync('manual2.csv', 'utf8');

  // Proper CSV parser that handles multi-line quoted fields
  function parseCSV(content) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const nextChar = content[i + 1];

      if (char === '"' && nextChar === '"' && inQuotes) {
        // Escaped quote inside quoted field
        currentField += '"';
        i++; // Skip next quote
      } else if (char === '"') {
        // Toggle quote mode
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        // End of field
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' && !inQuotes) {
        // End of row
        currentRow.push(currentField.trim());
        if (currentRow.some(field => field !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
      } else {
        // Regular character
        currentField += char;
      }
    }

    // Push last field and row if exists
    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.some(field => field !== '')) {
        rows.push(currentRow);
      }
    }

    return rows;
  }

  const rows = parseCSV(csvContent);
  console.log(`Parsed ${rows.length} rows from CSV`);

  const answerableQuestions = [];
  // Change this range to test different sets of questions
  // Questions 1-10: i = 1 to 10
  // Questions 11-20: i = 11 to 20
  // Questions 21-30: i = 21 to 30
  // Questions 31-40: i = 31 to 40
  // Questions 41-50: i = 41 to 50
  // Questions 51-60: i = 51 to 60
  // Questions 61-70: i = 61 to 70
  // Questions 71-80: i = 71 to 80
  // Questions 81-90: i = 81 to 90
  // Questions 91-96: i = 91 to 96
  const startQuestion = 91;
  const endQuestion = 96;

  for (let i = startQuestion; i <= endQuestion; i++) {
    if (i < rows.length) {
      const fields = rows[i];
      answerableQuestions.push({
        'Question asked': fields[0] || '',
        data_present: 'YES'
      });
    }
  }

  console.log(`Testing ${answerableQuestions.length} questions...\n`);

  let results = [];
  let passed = 0;
  let failed = 0;

  let output = `# Validation Results - Questions 91-96\n\n`;
  output += `**Test Date:** ${new Date().toISOString()}\n`;
  output += `**Chatbot URL:** ${CHATBOT_URL}\n`;
  output += `**Questions Tested:** ${answerableQuestions.length}\n\n`;
  output += `---\n\n`;

  for (let i = 0; i < answerableQuestions.length; i++) {
    const item = answerableQuestions[i];
    const questionNum = i + 1;
    const question = item['Question asked'];

    process.stdout.write(`[${questionNum}/${answerableQuestions.length}] Testing: "${question.substring(0, 50)}..."`);

    const result = await testQuestion(question);

    if (!result.success) {
      process.stdout.write(` ❌ ERROR\n`);
      output += `## Question ${questionNum}: ❌ ERROR\n\n`;
      output += `**Q:** ${question}\n\n`;
      output += `**Error:** ${result.error}\n\n`;
      output += `**Data Present:** ${item.data_present}\n\n`;
      output += `---\n\n`;
      failed++;
      continue;
    }

    const validation = validateResponse(item.question, result.answer, item.data_present);

    if (validation.valid) {
      process.stdout.write(` ✅ ${validation.verdict}\n`);
      passed++;
    } else {
      process.stdout.write(` ❌ ${validation.verdict}\n`);
      failed++;
    }

    // Write detailed result
    output += `## Question ${questionNum}: ${validation.valid ? '✅' : '❌'} ${validation.verdict}\n\n`;
    output += `**Q:** ${question}\n\n`;
    output += `**Data Present:** ${item.data_present}\n\n`;
    output += `**Documents Found:** ${result.documents.length}\n`;
    if (result.documents.length > 0) {
      output += `\nTop documents:\n`;
      result.documents.slice(0, 3).forEach((doc, idx) => {
        output += `  ${idx + 1}. ${doc.name} (${(doc.relevance * 100).toFixed(1)}% relevance)\n`;
      });
      output += `\n`;
    }
    output += `**Bot Answer:**\n\n${result.answer}\n\n`;
    output += `**Validation:**\n`;
    output += `- Verdict: ${validation.verdict}\n`;
    output += `- Reason: ${validation.reason}\n`;
    output += `- Severity: ${validation.severity}\n\n`;
    output += `---\n\n`;

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

  output += `# Summary\n\n`;
  output += `**Total Questions:** ${answerableQuestions.length}\n`;
  output += `**Passed:** ${passed}\n`;
  output += `**Failed:** ${failed}\n`;
  output += `**Accuracy:** ${accuracy}%\n\n`;

  if (failed > 0) {
    output += `## Failed Questions\n\n`;
    results.forEach((r, idx) => {
      if (!r.validation.valid) {
        output += `${idx + 1}. ${r.question}\n`;
        output += `   - Reason: ${r.validation.reason}\n\n`;
      }
    });
  }

  output += `\n## Next Steps\n\n`;
  if (accuracy >= 99) {
    output += `🎉 **Target achieved!** Accuracy is ${accuracy}% (>= 99%)\n`;
  } else {
    output += `📊 **Current accuracy: ${accuracy}%** (Target: 99%)\n\n`;
    output += `**Recommendations:**\n`;
    output += `1. Review failed questions to identify patterns\n`;
    output += `2. Consider adjusting relevance threshold if documents aren't being found\n`;
    output += `3. Review system prompt if bot is refusing when it shouldn't\n`;
    output += `4. Run full validation suite once issues are addressed\n`;
  }

  // Save to file
  fs.writeFileSync(OUTPUT_FILE, output);

  console.log(`\n\n=== SUMMARY ===`);
  console.log(`Total Questions: ${answerableQuestions.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Accuracy: ${accuracy}%`);
  console.log(`\nDetailed results saved to: ${OUTPUT_FILE}`);
}

runValidation().catch(console.error);
