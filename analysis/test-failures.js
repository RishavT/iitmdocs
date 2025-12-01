/**
 * Test the 4 failing questions 5 times each to identify patterns
 */

const fs = require('fs');

const CHATBOT_URL = process.env.CHATBOT_URL || 'http://localhost:8788';
const DELAY_MS = 1000; // 1 second between questions

// The 4 failing questions
const failingQuestions = [
  { id: 'Q56', question: 'What is the syllabus for DBMS course?' },
  { id: 'Q57', question: 'when will the next registration open for qualifier' },
  { id: 'Q59', question: 'grading policy for python' },
  { id: 'Q77', question: 'what is the syllabus for DBMS course?' }
];

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
 * Main test function
 */
async function runTests() {
  console.log('Testing 4 failing questions 5 times each...\n');

  const results = {};

  for (const { id, question } of failingQuestions) {
    console.log(`\n=== Testing ${id}: "${question}" ===\n`);
    results[id] = {
      question,
      attempts: []
    };

    for (let attempt = 1; attempt <= 5; attempt++) {
      process.stdout.write(`  Attempt ${attempt}/5... `);

      const result = await testQuestion(question);

      let status, verdict;
      if (!result.success) {
        status = 'ERROR';
        verdict = result.error;
      } else if (isRefusal(result.answer)) {
        status = 'REFUSAL';
        verdict = 'Bot refused to answer';
      } else {
        status = 'SUCCESS';
        verdict = 'Bot provided answer';
      }

      results[id].attempts.push({
        attempt,
        status,
        verdict,
        answerLength: result.answer?.length || 0,
        documentCount: result.documents?.length || 0,
        answerPreview: result.answer?.substring(0, 150) || result.error
      });

      console.log(`${status} (${result.answer?.length || 0} chars, ${result.documents?.length || 0} docs)`);

      // Delay between attempts
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    // Delay between questions
    await new Promise(resolve => setTimeout(resolve, DELAY_MS * 2));
  }

  // Generate analysis report
  console.log('\n\n=== ANALYSIS REPORT ===\n');

  let report = '# Failure Pattern Analysis\n\n';
  report += `**Test Date:** ${new Date().toISOString()}\n`;
  report += `**Questions Tested:** 4 (5 attempts each)\n\n`;
  report += `---\n\n`;

  for (const [qId, data] of Object.entries(results)) {
    const successCount = data.attempts.filter(a => a.status === 'SUCCESS').length;
    const refusalCount = data.attempts.filter(a => a.status === 'REFUSAL').length;
    const errorCount = data.attempts.filter(a => a.status === 'ERROR').length;
    const successRate = (successCount / 5 * 100).toFixed(1);

    report += `## ${qId}: "${data.question}"\n\n`;
    report += `**Results:** ${successCount}/5 successful (${successRate}%)\n\n`;
    report += `**Breakdown:**\n`;
    report += `- SUCCESS: ${successCount}\n`;
    report += `- REFUSAL: ${refusalCount}\n`;
    report += `- ERROR: ${errorCount}\n\n`;

    report += `**Detailed Results:**\n\n`;
    for (const attempt of data.attempts) {
      report += `### Attempt ${attempt.attempt}: ${attempt.status}\n\n`;
      report += `- **Status:** ${attempt.status}\n`;
      report += `- **Verdict:** ${attempt.verdict}\n`;
      report += `- **Answer Length:** ${attempt.answerLength} characters\n`;
      report += `- **Documents Found:** ${attempt.documentCount}\n`;
      report += `- **Answer Preview:** ${attempt.answerPreview}...\n\n`;
    }

    report += `---\n\n`;
  }

  // Overall pattern analysis
  report += `# Overall Pattern Analysis\n\n`;

  for (const [qId, data] of Object.entries(results)) {
    const statuses = data.attempts.map(a => a.status);
    const successCount = statuses.filter(s => s === 'SUCCESS').length;
    const refusalCount = statuses.filter(s => s === 'REFUSAL').length;
    const errorCount = statuses.filter(s => s === 'ERROR').length;

    report += `**${qId}:**\n`;
    if (successCount === 5) {
      report += `- ✅ Consistently successful (5/5)\n`;
    } else if (successCount === 0 && refusalCount === 5) {
      report += `- ❌ Consistently refusing (5/5)\n`;
    } else if (successCount === 0 && errorCount === 5) {
      report += `- ⚠️ Consistently erroring (5/5)\n`;
    } else {
      report += `- ⚠️ Inconsistent behavior: ${successCount} success, ${refusalCount} refusal, ${errorCount} error\n`;
    }
    report += `\n`;
  }

  // Save report
  fs.writeFileSync('failure-pattern-analysis.md', report);
  console.log('\nDetailed analysis saved to: failure-pattern-analysis.md');
}

runTests().catch(console.error);
