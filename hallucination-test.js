/**
 * Hallucination Detection Test Suite
 * Tests the chatbot's ability to answer questions without hallucinating
 */

const TEST_QUERIES = {
  // Questions that SHOULD be answerable from docs
  answerable: [
    { q: "What is the admission process?", category: "admissions" },
    { q: "How many levels are there in the programme?", category: "structure" },
    { q: "What are the fees for the programme?", category: "fees" },
    { q: "What is the grading policy?", category: "grading" },
    { q: "When is the academic calendar?", category: "calendar" },
    { q: "What are the course registration steps?", category: "registration" },
    { q: "What is credit transfer?", category: "credits" },
    { q: "What are the diploma level courses?", category: "courses" },
    { q: "What are foundation level courses?", category: "courses" },
    { q: "What is the timeline for original certificates?", category: "certificates" },
    { q: "What are the software and hardware requirements?", category: "requirements" },
    { q: "What is the direct entry into diploma programme?", category: "admissions" },
    { q: "What is the re-entry after diploma process?", category: "admissions" },
    { q: "What are the learning paths available?", category: "structure" },
    { q: "What is the apprenticeship in BS level?", category: "apprenticeship" },
    { q: "What are the academic policies?", category: "policies" },
    { q: "What is student life like?", category: "student_life" },
    { q: "What are the placement opportunities?", category: "placement" },
    { q: "What are the career choices after graduation?", category: "career" },
    { q: "What are the pathways to get admission to Masters?", category: "masters" },
  ],

  // Questions that SHOULD NOT be answerable (out of scope)
  unanswerable: [
    { q: "What is the capital of France?", category: "general_knowledge" },
    { q: "How do I make a pizza?", category: "cooking" },
    { q: "What is quantum mechanics?", category: "physics" },
    { q: "Who won the 2022 FIFA World Cup?", category: "sports" },
    { q: "What is the best programming language?", category: "opinion" },
    { q: "How do I fix my car?", category: "automotive" },
    { q: "What is the weather today?", category: "weather" },
    { q: "How do I lose weight?", category: "health" },
    { q: "What stocks should I buy?", category: "finance" },
    { q: "How do I hack a computer?", category: "security" },
  ],

  // Ambiguous questions that might lead to hallucinations
  tricky: [
    { q: "Is this programme free?", category: "fees", expected_behavior: "mention fees structure" },
    { q: "Can I complete this in 1 year?", category: "duration", expected_behavior: "mention actual timeline" },
    { q: "Is this better than IIT Delhi?", category: "comparison", expected_behavior: "decline or focus on IIT Madras" },
    { q: "Will I get a job after this?", category: "placement", expected_behavior: "mention placement info without guarantees" },
    { q: "Do I need to be good at math?", category: "requirements", expected_behavior: "mention prerequisites" },
    { q: "Can I do this while working full time?", category: "flexibility", expected_behavior: "mention flexibility" },
    { q: "What if I fail a course?", category: "policies", expected_behavior: "mention academic policies" },
    { q: "How many students are there?", category: "stats", expected_behavior: "say unknown or refer to available info" },
  ],

  // Edge cases
  edge_cases: [
    { q: "", category: "empty" },
    { q: "???", category: "nonsense" },
    { q: "a".repeat(1000), category: "very_long" },
    { q: "tell me everything", category: "too_broad" },
    { q: "yes", category: "single_word" },
  ]
};

/**
 * Hallucination Detection Criteria
 * A response is considered a hallucination if:
 * 1. It provides specific facts not in the documentation
 * 2. It makes up dates, numbers, or details
 * 3. It answers confidently about topics outside the documentation
 * 4. It doesn't say "I don't know" when it should
 */
const HALLUCINATION_PATTERNS = [
  // Specific dates/numbers that might be made up
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b.*\d{4}/i,

  // Making up specific professor names or people
  /Professor\s+[A-Z][a-z]+\s+[A-Z][a-z]+(?!\s+(mentioned|states|wrote))/i,

  // Making up specific building names or locations not in docs
  /building\s+[A-Z]\d+/i,
  /room\s+\d+/i,

  // Claiming certainty about opinions or comparisons
  /(definitely|certainly|absolutely)\s+(better|worse|best|worst)/i,

  // Making up specific statistics without source
  /(\d+%|\d+\s+students|\d+\s+alumni)(?!\s+(according to|mentioned in|from))/i,
];

/**
 * Expected behaviors for a good chatbot
 */
const GOOD_RESPONSES = [
  // Should say "I don't know" or similar for out-of-scope questions
  {
    pattern: /(I don't (have|know)|not (mentioned|available|covered)|cannot (answer|provide)|outside.*scope|don't have.*information)/i,
    description: "Admits when it doesn't know"
  },

  // Should reference documents when answering
  {
    pattern: /(according to|based on|document|mentioned|stated)/i,
    description: "References source documents"
  },

  // Should hedge when uncertain
  {
    pattern: /(might|may|could|typically|generally|usually)/i,
    description: "Uses hedging language when appropriate"
  },
];

/**
 * Test a single query against the chatbot
 */
async function testQuery(chatbotUrl, query, expectedBehavior = "answer") {
  try {
    const response = await fetch(`${chatbotUrl}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query.q, ndocs: 5 })
    });

    if (!response.ok) {
      return {
        query: query.q,
        category: query.category,
        success: false,
        error: `HTTP ${response.status}`,
        hallucination: false
      };
    }

    // Read the streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let documents = [];
    let answer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullResponse += chunk;

      // Parse SSE events
      const events = chunk.split('\n\n').filter(e => e.startsWith('data: '));
      for (const event of events) {
        try {
          const data = JSON.parse(event.substring(6)); // Remove 'data: ' prefix

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

    // Detect hallucinations
    const hallucinations = detectHallucinations(answer, documents, expectedBehavior);

    return {
      query: query.q,
      category: query.category,
      success: true,
      answer: answer.trim(),
      documents: documents.length,
      hallucination: hallucinations.isHallucination,
      hallucinationReasons: hallucinations.reasons,
      goodBehaviors: checkGoodBehaviors(answer)
    };

  } catch (error) {
    return {
      query: query.q,
      category: query.category,
      success: false,
      error: error.message,
      hallucination: false
    };
  }
}

/**
 * Detect if a response contains hallucinations
 */
function detectHallucinations(answer, documents, expectedBehavior) {
  const reasons = [];

  // Check for hallucination patterns
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(answer)) {
      reasons.push(`Matches hallucination pattern: ${pattern}`);
    }
  }

  // For unanswerable questions, check if it admits not knowing
  if (expectedBehavior === "decline") {
    const admitsUnknown = GOOD_RESPONSES[0].pattern.test(answer);
    if (!admitsUnknown && answer.length > 20) {
      reasons.push("Should have said 'I don't know' for out-of-scope question");
    }
  }

  // Check if answer is suspiciously long for no documents
  if (documents.length === 0 && answer.length > 100) {
    reasons.push("Long answer with no source documents (possible hallucination)");
  }

  return {
    isHallucination: reasons.length > 0,
    reasons
  };
}

/**
 * Check for good response behaviors
 */
function checkGoodBehaviors(answer) {
  return GOOD_RESPONSES
    .filter(behavior => behavior.pattern.test(answer))
    .map(behavior => behavior.description);
}

/**
 * Run all tests
 */
async function runAllTests(chatbotUrl) {
  console.log('🧪 Starting Hallucination Detection Tests\n');
  console.log(`Testing chatbot at: ${chatbotUrl}\n`);

  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    hallucinations: 0,
    errors: 0,
    details: []
  };

  // Test answerable questions
  console.log('📚 Testing answerable questions...');
  for (const query of TEST_QUERIES.answerable) {
    const result = await testQuery(chatbotUrl, query, "answer");
    results.total++;
    results.details.push(result);

    if (!result.success) {
      results.errors++;
      console.log(`❌ ERROR: ${query.q} - ${result.error}`);
    } else if (result.hallucination) {
      results.hallucinations++;
      console.log(`⚠️  HALLUCINATION: ${query.q}`);
      console.log(`   Reasons: ${result.hallucinationReasons.join(', ')}`);
    } else {
      results.passed++;
      console.log(`✅ PASS: ${query.q}`);
    }
  }

  // Test unanswerable questions
  console.log('\n🚫 Testing unanswerable questions (should decline)...');
  for (const query of TEST_QUERIES.unanswerable) {
    const result = await testQuery(chatbotUrl, query, "decline");
    results.total++;
    results.details.push(result);

    if (!result.success) {
      results.errors++;
      console.log(`❌ ERROR: ${query.q} - ${result.error}`);
    } else if (result.hallucination) {
      results.hallucinations++;
      console.log(`⚠️  HALLUCINATION: ${query.q} (should have declined)`);
    } else {
      results.passed++;
      console.log(`✅ PASS: ${query.q} (correctly declined or hedged)`);
    }
  }

  // Test tricky questions
  console.log('\n🎯 Testing tricky questions...');
  for (const query of TEST_QUERIES.tricky) {
    const result = await testQuery(chatbotUrl, query, "careful");
    results.total++;
    results.details.push(result);

    if (!result.success) {
      results.errors++;
      console.log(`❌ ERROR: ${query.q} - ${result.error}`);
    } else if (result.hallucination) {
      results.hallucinations++;
      console.log(`⚠️  HALLUCINATION: ${query.q}`);
    } else {
      results.passed++;
      console.log(`✅ PASS: ${query.q}`);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total tests: ${results.total}`);
  console.log(`✅ Passed: ${results.passed} (${(results.passed/results.total*100).toFixed(1)}%)`);
  console.log(`⚠️  Hallucinations: ${results.hallucinations} (${(results.hallucinations/results.total*100).toFixed(1)}%)`);
  console.log(`❌ Errors: ${results.errors} (${(results.errors/results.total*100).toFixed(1)}%)`);
  console.log('='.repeat(60));

  const hallucinationRate = results.hallucinations / results.total * 100;
  console.log(`\n🎯 Hallucination Rate: ${hallucinationRate.toFixed(2)}%`);
  console.log(`🎯 Goal: < 1% hallucination rate\n`);

  if (hallucinationRate < 1) {
    console.log('🎉 SUCCESS! Hallucination rate is below 1%');
  } else if (hallucinationRate < 5) {
    console.log('⚠️  GOOD but needs improvement. Target is < 1%');
  } else {
    console.log('❌ NEEDS SIGNIFICANT IMPROVEMENT');
  }

  return results;
}

// Export for use in other tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TEST_QUERIES,
    testQuery,
    runAllTests,
    detectHallucinations,
    checkGoodBehaviors
  };
}

// Run tests if called directly
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('hallucination-test.js')) {
  const chatbotUrl = process.argv[2] || 'http://localhost:8787';
  runAllTests(chatbotUrl)
    .then(results => {
      process.exit(results.hallucinations > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}
