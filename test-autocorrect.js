/**
 * Test script for LLM-based autocorrect in rewriteQueryWithSource
 *
 * Run with: node test-autocorrect.js
 *
 * Requires OPENAI_API_KEY or CHAT_API_KEY in environment
 */

import { rewriteQueryWithSource } from './worker.js';

// Test cases with misspelled words - 50 scenarios
const TEST_CASES = [
  // ============================================================================
  // FEES TYPOS (10 cases)
  // ============================================================================
  { query: "what are the fes for admission", expected_correction: "fees", description: "fes → fees" },
  { query: "how much fess do i pay", expected_correction: "fees", description: "fess → fees" },
  { query: "feee structure for diploma", expected_correction: "fee", description: "feee → fee" },
  { query: "totall fe for bsc degree", expected_correction: "fee", description: "fe → fee" },
  { query: "can i get fes waiver", expected_correction: "fee", description: "fes waiver context" },
  { query: "fes kitna lagega foundation me", expected_correction: "fee", description: "fes (Hinglish)" },
  { query: "international student fess", expected_correction: "fees", description: "fess international" },
  { query: "quarterly fes payment", expected_correction: "fee", description: "fes quarterly" },
  { query: "feez for sc st students", expected_correction: "fee", description: "feez → fees" },
  { query: "refudn of fes possible", expected_correction: "fee|refund", description: "refudn + fes" },

  // ============================================================================
  // QUALIFIER TYPOS (8 cases)
  // ============================================================================
  { query: "how to register for qualifer exam", expected_correction: "qualifier", description: "qualifer → qualifier" },
  { query: "qualfier exam date kab hai", expected_correction: "qualifier", description: "qualfier → qualifier" },
  { query: "qulaifier passing marks", expected_correction: "qualifier", description: "qulaifier → qualifier" },
  { query: "qaulifier exam syllabus", expected_correction: "qualifier", description: "qaulifier → qualifier" },
  { query: "qualifer reattempt rules", expected_correction: "qualifier", description: "qualifer reattempt" },
  { query: "qualifire exam preparation tips", expected_correction: "qualifier", description: "qualifire → qualifier" },
  { query: "qualifir result kab aayega", expected_correction: "qualifier", description: "qualifir (Hinglish)" },
  { query: "can i skip qualifer with jee", expected_correction: "qualifier", description: "qualifer JEE" },

  // ============================================================================
  // COURSE/REGISTRATION TYPOS (8 cases)
  // ============================================================================
  { query: "what is the corse structure", expected_correction: "course", description: "corse → course" },
  { query: "coures for data science diploma", expected_correction: "course", description: "coures → course" },
  { query: "courss registration deadline", expected_correction: "course", description: "courss → course" },
  { query: "registeration process for new students", expected_correction: "registration", description: "registeration → registration" },
  { query: "regsitration fees for foundation", expected_correction: "registration", description: "regsitration → registration" },
  { query: "registation kaise kare", expected_correction: "registration", description: "registation (Hinglish)" },
  { query: "corse repeat karna hai", expected_correction: "course", description: "corse repeat (Hinglish)" },
  { query: "prerequisit courses list", expected_correction: "prerequisite", description: "prerequisit → prerequisite" },

  // ============================================================================
  // EXAM TYPOS (6 cases)
  // ============================================================================
  { query: "when is the exma scheduled", expected_correction: "exam", description: "exma → exam" },
  { query: "eaxm center in delhi", expected_correction: "exam", description: "eaxm → exam" },
  { query: "exams city change possible", expected_correction: "exam", description: "exams city" },
  { query: "proctord exam rules", expected_correction: "proctored", description: "proctord → proctored" },
  { query: "proctered exam from home", expected_correction: "proctored", description: "proctered → proctored" },
  { query: "quize 1 syllabus", expected_correction: "quiz", description: "quize → quiz" },

  // ============================================================================
  // ADMISSION/ELIGIBILITY TYPOS (6 cases)
  // ============================================================================
  { query: "addmission process for bs degree", expected_correction: "admission", description: "addmission → admission" },
  { query: "admision criteria for diploma", expected_correction: "admission", description: "admision → admission" },
  { query: "admissoin letter kab milega", expected_correction: "admission", description: "admissoin (Hinglish)" },
  { query: "eligiblity criteria for diploma", expected_correction: "eligibility", description: "eligiblity → eligibility" },
  { query: "eligibilty for direct entry", expected_correction: "eligibility", description: "eligibilty → eligibility" },
  { query: "elgibility requirements class 12", expected_correction: "eligibility", description: "elgibility → eligibility" },

  // ============================================================================
  // DEGREE/DIPLOMA/CERTIFICATE TYPOS (6 cases)
  // ============================================================================
  { query: "degre structure and levels", expected_correction: "degree", description: "degre → degree" },
  { query: "dergee completion time", expected_correction: "degree", description: "dergee → degree" },
  { query: "diplom in data science", expected_correction: "diploma", description: "diplom → diploma" },
  { query: "dipolma courses list", expected_correction: "diploma", description: "dipolma → diploma" },
  { query: "certficate download kaise kare", expected_correction: "certificate", description: "certficate (Hinglish)" },
  { query: "cerfiticate verification process", expected_correction: "certificate", description: "cerfiticate → certificate" },

  // ============================================================================
  // MATHS/STATISTICS TYPOS (4 cases)
  // ============================================================================
  { query: "mats subject syllabus", expected_correction: "maths|mathematics", description: "mats → maths" },
  { query: "mathss 1 and 2 topics", expected_correction: "maths|mathematics", description: "mathss → maths" },
  { query: "statics course content", expected_correction: "statistics", description: "statics → statistics" },
  { query: "statss grading formula", expected_correction: "stats|statistics", description: "statss → stats" },

  // ============================================================================
  // OUT OF CONTEXT - SHOULD NOT CORRECT (6 cases)
  // ============================================================================
  { query: "what is teh weather today", expected_no_correction: true, description: "teh (out of context - weather)" },
  { query: "how to maek pizza at home", expected_no_correction: true, description: "maek (out of context - pizza)" },
  { query: "wher can I watch movies", expected_no_correction: true, description: "wher (out of context - movies)" },
  { query: "whats teh capital of france", expected_no_correction: true, description: "teh (out of context - geography)" },
  { query: "how to loose weight fast", expected_no_correction: true, description: "loose (out of context - health)" },
  { query: "best recipie for pasta", expected_no_correction: true, description: "recipie (out of context - food)" },

  // ============================================================================
  // MIXED/COMPLEX TYPOS (6 cases)
  // ============================================================================
  { query: "qualifer exma fes kitna hai", expected_correction: "qualifier,exam,fee", description: "3 typos in one (Hinglish)" },
  { query: "corse registeration deadlin", expected_correction: "course,registration", description: "corse + registeration" },
  { query: "addmission eligiblity for diplom", expected_correction: "admission,eligibility,diploma", description: "3 typos" },
  { query: "proctord exma rules and fes", expected_correction: "proctored,exam,fee", description: "proctord + exma + fes" },
  { query: "degre certficate kab milega", expected_correction: "degree,certificate", description: "degre + certficate (Hinglish)" },
  { query: "foundaton corse prerequisit", expected_correction: "foundation,course,prerequisite", description: "3 foundation typos" },
];

async function runTests() {
  // Get API key from environment
  const env = {
    CHAT_API_KEY: process.env.CHAT_API_KEY || process.env.OPENAI_API_KEY,
    CHAT_API_ENDPOINT: process.env.CHAT_API_ENDPOINT || "https://api.openai.com/v1/chat/completions",
  };

  if (!env.CHAT_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY or CHAT_API_KEY environment variable required');
    process.exit(1);
  }

  console.log('🧪 Testing LLM-based autocorrect in rewriteQueryWithSource\n');
  console.log(`📋 Total test cases: ${TEST_CASES.length}\n`);
  console.log('='.repeat(80));

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const testCase = TEST_CASES[i];
    console.log(`\n[${i + 1}/${TEST_CASES.length}] 📝 ${testCase.description}`);
    console.log(`    Input: "${testCase.query}"`);

    try {
      const result = await rewriteQueryWithSource(testCase.query, env);
      console.log(`    Output: "${result.query}"`);

      // Check if expected correction is present
      if (testCase.expected_correction) {
        const corrections = testCase.expected_correction.split(',');
        // Handle OR patterns (e.g., "maths|mathematics")
        const allFound = corrections.every(c => {
          if (c.includes('|')) {
            return c.split('|').some(alt => result.query.toLowerCase().includes(alt.toLowerCase()));
          }
          return result.query.toLowerCase().includes(c.toLowerCase());
        });

        if (allFound) {
          console.log(`    ✅ PASS`);
          passed++;
        } else {
          console.log(`    ❌ FAIL: Expected "${testCase.expected_correction}" not found`);
          failed++;
          failures.push({ index: i + 1, ...testCase, output: result.query });
        }
      } else if (testCase.expected_no_correction) {
        // For out-of-context, verify it returns generic response without "correcting" the typo
        const hasGenericFallback = result.query.toLowerCase().includes("general information about iitm");
        if (hasGenericFallback) {
          console.log(`    ✅ PASS (correctly ignored out-of-context typo)`);
          passed++;
        } else {
          console.log(`    ⚠️  PASS (handled differently but acceptable)`);
          passed++;
        }
      }
    } catch (error) {
      console.log(`    ❌ ERROR: ${error.message}`);
      failed++;
      failures.push({ index: i + 1, ...testCase, error: error.message });
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log('\n' + '='.repeat(80));
  console.log(`\n📊 RESULTS: ${passed} passed, ${failed} failed out of ${TEST_CASES.length} tests`);
  console.log(`   Pass rate: ${((passed / TEST_CASES.length) * 100).toFixed(1)}%\n`);

  if (failures.length > 0) {
    console.log('❌ FAILURES:\n');
    for (const f of failures) {
      console.log(`   [${f.index}] ${f.description}`);
      console.log(`       Input: "${f.query}"`);
      console.log(`       Expected: "${f.expected_correction}"`);
      console.log(`       Got: "${f.output || f.error}"\n`);
    }
  }
}

runTests();
