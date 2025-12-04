const data = require('./manual-feedback.json');

// Count feedback types
const feedbackCounts = {};
data.forEach(row => {
  const feedback = row['Feedback '] || row['Feedback'] || 'Unknown';
  feedbackCounts[feedback] = (feedbackCounts[feedback] || 0) + 1;
});

console.log('Feedback Distribution:');
Object.entries(feedbackCounts).forEach(([feedback, count]) => {
  console.log(`  ${feedback}: ${count} (${(count/data.length*100).toFixed(1)}%)`);
});

console.log(`\nTotal: ${data.length} questions`);
console.log(`Baseline Success Rate: ${((feedbackCounts['Correct'] || 0)/data.length*100).toFixed(1)}%`);

// Show some incorrect ones
const incorrect = data.filter(row => row['Feedback '] !== 'Correct');
console.log(`\nIncorrect Answers: ${incorrect.length}`);
console.log('\nSample incorrect answers:');
incorrect.slice(0, 5).forEach((row, i) => {
  console.log(`\n${i+1}. Q: ${row['Question asked']}`);
  console.log(`   A: ${row['Reply given ']?.substring(0, 100)}...`);
  console.log(`   Feedback: ${row['Feedback ']}`);
});
