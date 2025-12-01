/**
 * Test Prompt Generator
 * Generates comprehensive test prompts from documentation
 */

const fs = require('fs');
const path = require('path');

// Question templates for different categories
const QUESTION_TEMPLATES = {
  factual: [
    "What is {topic}?",
    "Tell me about {topic}",
    "Explain {topic}",
    "What are the details about {topic}?",
    "Can you describe {topic}?",
    "I want to know about {topic}",
    "What information do you have about {topic}?",
    "Please explain {topic} to me",
  ],

  procedural: [
    "How do I {action}?",
    "What are the steps to {action}?",
    "What is the process for {action}?",
    "How can I {action}?",
    "What do I need to do to {action}?",
    "Guide me through {action}",
    "What's involved in {action}?",
  ],

  temporal: [
    "When is {event}?",
    "What is the timeline for {event}?",
    "When does {event} happen?",
    "What are the dates for {event}?",
  ],

  comparative: [
    "What's the difference between {topic1} and {topic2}?",
    "How does {topic1} compare to {topic2}?",
    "Should I choose {topic1} or {topic2}?",
  ],

  conditional: [
    "What happens if {condition}?",
    "Can I {action} if {condition}?",
    "Is it possible to {action} when {condition}?",
  ],

  numerical: [
    "How many {thing}?",
    "How much {thing}?",
    "What is the cost of {thing}?",
    "What is the duration of {thing}?",
  ],
};

// Out-of-scope question templates (should trigger "I don't know")
const OUT_OF_SCOPE_TEMPLATES = [
  "What is {random_topic}?",
  "How do I {random_action}?",
  "Tell me about {random_topic}",
  "What is the capital of {place}?",
  "Who is {person}?",
  "How to cook {food}?",
  "What is {science_topic}?",
  "Best {product} to buy?",
];

// Topics extracted from document filenames
const TOPICS = [
  "the admission process",
  "the IIT Madras programme",
  "course registration",
  "the grading system",
  "academic calendar",
  "fees structure",
  "diploma level courses",
  "foundation level courses",
  "credit transfer",
  "academic policies",
  "student life",
  "placement opportunities",
  "career choices",
  "learning paths",
  "academic documents",
  "the programme timeline",
  "software requirements",
  "hardware requirements",
  "re-entry after diploma",
  "direct entry to diploma",
  "apprenticeship program",
  "credit clearing",
  "partner institutions",
  "alumni details",
  "best projects",
  "eligibility criteria",
];

// Actions/procedures
const ACTIONS = [
  "register for courses",
  "apply for admission",
  "transfer credits",
  "access academic documents",
  "complete the foundation level",
  "progress to diploma level",
  "apply for placement",
  "re-enter after diploma",
  "get direct entry",
  "clear credits",
  "change my learning path",
];

// Events/timelines
const EVENTS = [
  "course registration",
  "admissions",
  "the academic calendar",
  "exam schedules",
  "placement activities",
];

// Out-of-scope topics
const RANDOM_TOPICS = [
  "quantum physics",
  "machine learning",
  "cryptocurrency",
  "cooking",
  "sports",
  "movies",
  "fashion",
  "politics",
  "climate change",
  "artificial intelligence",
];

const RANDOM_ACTIONS = [
  "fix my car",
  "cook pasta",
  "learn guitar",
  "lose weight",
  "make money online",
  "hack a website",
  "build a rocket",
];

// Tricky/edge case questions
const TRICKY_QUESTIONS = [
  "Is this programme free?",
  "Will I definitely get a job after this?",
  "Can I complete this in 6 months?",
  "Is this better than IIT Delhi?",
  "Who is the best professor?",
  "What is the pass rate?",
  "How many students fail?",
  "Is this programme easy?",
  "Will this make me rich?",
  "Can I skip foundation level?",
  "Do I need to attend classes?",
  "Can I cheat in exams?",
  "What if I fail?",
  "Can I get a refund?",
  "Is the degree valuable?",
  "Will companies hire me?",
  "What's the average salary?",
  "Can I do this while working full time?",
  "Do I need to know programming?",
  "What if I don't have a computer?",
  "Can international students apply?",
  "Is there an age limit?",
  "Can I transfer to on-campus?",
  "Are there scholarships?",
  "Can I pause my studies?",
];

// Edge cases
const EDGE_CASES = [
  "",
  "?",
  "???",
  "help",
  "yes",
  "no",
  "thanks",
  "hello",
  "hi",
  "a",
  "..." + ".".repeat(100),
  "tell me everything about everything",
  "what",
  "idk",
  "x".repeat(500),
];

/**
 * Generate test prompts
 */
function generateTestPrompts(count = 1000) {
  const prompts = [];
  const categories = {
    answerable: [],
    unanswerable: [],
    tricky: [],
    edge: [],
  };

  // Generate answerable questions from templates
  for (const [type, templates] of Object.entries(QUESTION_TEMPLATES)) {
    for (const template of templates) {
      if (template.includes('{topic}')) {
        for (const topic of TOPICS) {
          const question = template.replace('{topic}', topic);
          categories.answerable.push({
            question,
            type,
            expected: 'answer',
            source: 'template'
          });
        }
      } else if (template.includes('{action}')) {
        for (const action of ACTIONS) {
          const question = template.replace('{action}', action);
          categories.answerable.push({
            question,
            type,
            expected: 'answer',
            source: 'template'
          });
        }
      } else if (template.includes('{event}')) {
        for (const event of EVENTS) {
          const question = template.replace('{event}', event);
          categories.answerable.push({
            question,
            type,
            expected: 'answer',
            source: 'template'
          });
        }
      }
    }
  }

  // Generate out-of-scope questions
  for (const template of OUT_OF_SCOPE_TEMPLATES) {
    if (template.includes('{random_topic}')) {
      for (const topic of RANDOM_TOPICS) {
        const question = template.replace('{random_topic}', topic);
        categories.unanswerable.push({
          question,
          type: 'out_of_scope',
          expected: 'decline',
          source: 'template'
        });
      }
    } else if (template.includes('{random_action}')) {
      for (const action of RANDOM_ACTIONS) {
        const question = template.replace('{random_action}', action);
        categories.unanswerable.push({
          question,
          type: 'out_of_scope',
          expected: 'decline',
          source: 'template'
        });
      }
    }
  }

  // Add tricky questions
  for (const question of TRICKY_QUESTIONS) {
    categories.tricky.push({
      question,
      type: 'tricky',
      expected: 'careful',
      source: 'curated'
    });
  }

  // Add edge cases
  for (const question of EDGE_CASES) {
    categories.edge.push({
      question,
      type: 'edge',
      expected: 'handle_gracefully',
      source: 'edge_case'
    });
  }

  // Combine and shuffle to target count
  const allQuestions = [
    ...categories.answerable,
    ...categories.unanswerable,
    ...categories.tricky,
    ...categories.edge,
  ];

  // Shuffle
  for (let i = allQuestions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allQuestions[i], allQuestions[j]] = [allQuestions[j], allQuestions[i]];
  }

  // Take requested count
  const selectedQuestions = allQuestions.slice(0, count);

  // Add variations for common questions
  const variations = generateVariations(selectedQuestions.slice(0, 100));
  selectedQuestions.push(...variations.slice(0, count - selectedQuestions.length));

  return {
    prompts: selectedQuestions.slice(0, count),
    stats: {
      total: selectedQuestions.length,
      answerable: categories.answerable.length,
      unanswerable: categories.unanswerable.length,
      tricky: categories.tricky.length,
      edge: categories.edge.length,
    }
  };
}

/**
 * Generate variations of questions (spelling errors, different phrasings, etc.)
 */
function generateVariations(baseQuestions) {
  const variations = [];

  for (const q of baseQuestions.slice(0, 50)) {
    // Lowercase variation
    variations.push({
      question: q.question.toLowerCase(),
      type: q.type,
      expected: q.expected,
      source: 'variation_lowercase'
    });

    // ALL CAPS variation
    variations.push({
      question: q.question.toUpperCase(),
      type: q.type,
      expected: q.expected,
      source: 'variation_caps'
    });

    // With extra punctuation
    variations.push({
      question: q.question + '???',
      type: q.type,
      expected: q.expected,
      source: 'variation_punct'
    });

    // With typos (simple)
    const withTypo = q.question.replace(/the/i, 'teh').replace(/is/i, 'si');
    variations.push({
      question: withTypo,
      type: q.type,
      expected: q.expected,
      source: 'variation_typo'
    });
  }

  return variations;
}

/**
 * Save prompts to file
 */
function savePromptsToFile(prompts, filename = 'test-prompts.json') {
  fs.writeFileSync(filename, JSON.stringify(prompts, null, 2));
  console.log(`✅ Saved ${prompts.prompts.length} prompts to ${filename}`);
  console.log('\nStatistics:');
  console.log(`  Answerable questions: ${prompts.stats.answerable}`);
  console.log(`  Unanswerable questions: ${prompts.stats.unanswerable}`);
  console.log(`  Tricky questions: ${prompts.stats.tricky}`);
  console.log(`  Edge cases: ${prompts.stats.edge}`);
}

// CLI usage
if (require.main === module) {
  const count = parseInt(process.argv[2]) || 1000;
  console.log(`Generating ${count} test prompts...`);
  const prompts = generateTestPrompts(count);
  savePromptsToFile(prompts);
}

module.exports = { generateTestPrompts, savePromptsToFile };
