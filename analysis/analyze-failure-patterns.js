/**
 * Analyze failure patterns in manual feedback
 */

const data = require('./manual-feedback.json');

// Categorize failures
const analysis = {
  total: data.length,
  correct: [],
  incorrect: [],
  nearly_correct: [],
  unknown: []
};

data.forEach(row => {
  const feedback = row['Feedback '];
  const entry = {
    question: row['Question asked'],
    answer: row['Reply given '],
    feedback
  };

  if (feedback === 'Correct') {
    analysis.correct.push(entry);
  } else if (feedback === 'Incorrect') {
    analysis.incorrect.push(entry);
  } else if (feedback === 'Nearly correct') {
    analysis.nearly_correct.push(entry);
  } else {
    analysis.unknown.push(entry);
  }
});

console.log('📊 MANUAL FEEDBACK ANALYSIS\n');
console.log(`Total: ${analysis.total}`);
console.log(`✅ Correct: ${analysis.correct.length} (${(analysis.correct.length/analysis.total*100).toFixed(1)}%)`);
console.log(`❌ Incorrect: ${analysis.incorrect.length} (${(analysis.incorrect.length/analysis.total*100).toFixed(1)}%)`);
console.log(`⚠️  Nearly correct: ${analysis.nearly_correct.length} (${(analysis.nearly_correct.length/analysis.total*100).toFixed(1)}%)`);
console.log(`❓ Unknown: ${analysis.unknown.length}\n`);

// Analyze incorrect answers - what patterns do we see?
console.log('🔍 ANALYZING INCORRECT ANSWERS:\n');

const incorrectPatterns = {
  says_dont_know: [],
  partial_answer: [],
  wrong_info: [],
  hallucination: []
};

analysis.incorrect.forEach(entry => {
  const answerLower = entry.answer.toLowerCase();

  if (answerLower.includes("i don't know") || answerLower.includes("don't have") || answerLower.includes("not available")) {
    incorrectPatterns.says_dont_know.push(entry);
  } else if (entry.answer.length < 50) {
    incorrectPatterns.partial_answer.push(entry);
  } else {
    // Check if it's potentially a hallucination or just wrong info
    incorrectPatterns.wrong_info.push(entry);
  }
});

console.log(`Questions where bot says "I don't know" but should answer: ${incorrectPatterns.says_dont_know.length}`);
console.log(`Partial/incomplete answers: ${incorrectPatterns.partial_answer.length}`);
console.log(`Wrong information: ${incorrectPatterns.wrong_info.length}\n`);

// Show examples of "don't know" when it should answer
console.log('❌ EXAMPLES: Bot says "I don\'t know" but should answer:\n');
incorrectPatterns.says_dont_know.slice(0, 10).forEach((entry, i) => {
  console.log(`${i+1}. Q: ${entry.question}`);
  console.log(`   Bot: ${entry.answer.substring(0, 100)}...`);
  console.log('');
});

// Show examples of wrong info
if (incorrectPatterns.wrong_info.length > 0) {
  console.log('❌ EXAMPLES: Wrong information provided:\n');
  incorrectPatterns.wrong_info.slice(0, 5).forEach((entry, i) => {
    console.log(`${i+1}. Q: ${entry.question}`);
    console.log(`   Bot: ${entry.answer.substring(0, 150)}...`);
    console.log('');
  });
}

// Analyze question types
console.log('📝 QUESTION TYPE ANALYSIS:\n');

const questionTypes = {
  about_exam: [],
  about_fees: [],
  about_admission: [],
  about_courses: [],
  about_grading: [],
  about_documents: [],
  about_policies: [],
  other: []
};

data.forEach(row => {
  const q = row['Question asked'].toLowerCase();
  const entry = {
    question: row['Question asked'],
    feedback: row['Feedback ']
  };

  if (q.includes('exam') || q.includes('quiz') || q.includes('test')) {
    questionTypes.about_exam.push(entry);
  } else if (q.includes('fee') || q.includes('cost') || q.includes('price') || q.includes('pay')) {
    questionTypes.about_fees.push(entry);
  } else if (q.includes('admission') || q.includes('admit') || q.includes('enroll')) {
    questionTypes.about_admission.push(entry);
  } else if (q.includes('course') || q.includes('subject') || q.includes('curriculum')) {
    questionTypes.about_courses.push(entry);
  } else if (q.includes('grade') || q.includes('grading') || q.includes('mark')) {
    questionTypes.about_grading.push(entry);
  } else if (q.includes('document') || q.includes('certificate') || q.includes('transcript')) {
    questionTypes.about_documents.push(entry);
  } else if (q.includes('policy') || q.includes('rule') || q.includes('regulation')) {
    questionTypes.about_policies.push(entry);
  } else {
    questionTypes.other.push(entry);
  }
});

Object.entries(questionTypes).forEach(([type, questions]) => {
  if (questions.length > 0) {
    const correct = questions.filter(q => q.feedback === 'Correct').length;
    console.log(`${type}: ${questions.length} questions, ${correct} correct (${(correct/questions.length*100).toFixed(1)}%)`);
  }
});

console.log('\n💡 INSIGHTS:\n');
console.log(`1. Main problem: Bot refusing to answer (${incorrectPatterns.says_dont_know.length} cases)`);
console.log(`2. This suggests overly strict relevance filtering or prompt`);
console.log(`3. Need to balance hallucination prevention with answerability`);
console.log(`4. Target: Reduce refusals while maintaining accuracy\n`);
