/**
 * Check if data for each question is actually present in documentation
 */

const fs = require('fs');
const path = require('path');

// Read all documentation files
function readAllDocs() {
  const docsDir = path.join(__dirname, 'src');
  const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));

  const docs = [];
  for (const file of files) {
    const filePath = path.join(docsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    docs.push({
      filename: file,
      content: content.toLowerCase(), // Lowercase for easier searching
      originalContent: content
    });
  }

  return docs;
}

// Check if a question's answer is likely in the docs
function checkDataPresence(question, expectedAnswer, docs) {
  if (!question || typeof question !== 'string') {
    return {
      dataPresent: false,
      confidence: 'low',
      foundDocs: [],
      reasoning: 'Invalid question'
    };
  }

  const q = question.toLowerCase();
  const a = (expectedAnswer || '').toLowerCase();

  // Extract key terms from question
  const keyTerms = extractKeyTerms(q);

  // Search for these terms in docs
  let foundDocs = [];
  let relevanceScores = [];

  for (const doc of docs) {
    let score = 0;
    let matches = [];

    // Check if key terms appear in the document
    for (const term of keyTerms) {
      if (doc.content.includes(term)) {
        score++;
        matches.push(term);
      }
    }

    if (score > 0) {
      foundDocs.push({
        filename: doc.filename,
        score,
        matches,
        snippet: getSnippet(doc.originalContent, keyTerms[0])
      });
      relevanceScores.push(score);
    }
  }

  // Sort by relevance
  foundDocs.sort((a, b) => b.score - a.score);

  // Determine if data is present
  // Heuristic: If we found documents with good keyword matches, likely present
  const maxScore = Math.max(...relevanceScores, 0);
  const hasRelevantDocs = foundDocs.length > 0 && maxScore >= 2;

  return {
    dataPresent: hasRelevantDocs,
    confidence: maxScore >= 3 ? 'high' : maxScore >= 2 ? 'medium' : 'low',
    foundDocs: foundDocs.slice(0, 3), // Top 3
    reasoning: `Found ${foundDocs.length} relevant docs, max keyword matches: ${maxScore}`
  };
}

// Extract key terms from question
function extractKeyTerms(question) {
  // Remove common words
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
    'could', 'can', 'what', 'when', 'where', 'who', 'how', 'why', 'which',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
    'i', 'you', 'we', 'they', 'it', 'this', 'that', 'these', 'those',
    'my', 'your', 'our', 'their', 'me', 'us', 'them'
  ]);

  // Extract words, remove punctuation
  const words = question
    .toLowerCase()
    .replace(/[?.!,]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Also extract multi-word phrases
  const phrases = [];

  // Common IITM BS terms
  const commonPhrases = [
    'iit madras', 'bs degree', 'bs programme', 'bs program',
    'foundation level', 'diploma level', 'degree level',
    'exam city', 'fee waiver', 'income certificate',
    'credit transfer', 'course registration', 'grading policy',
    'qualifier exam', 'end term', 'quiz', 'oppe',
    'advanced certificate', 'completion certificate',
    'cgpa cutoff', 'prerequisite', 'reattempt', 'reapply'
  ];

  const qLower = question.toLowerCase();
  for (const phrase of commonPhrases) {
    if (qLower.includes(phrase)) {
      phrases.push(phrase);
    }
  }

  return [...new Set([...phrases, ...words])];
}

// Get a snippet around a keyword
function getSnippet(content, keyword, contextLength = 100) {
  const lowerContent = content.toLowerCase();
  const lowerKeyword = (keyword || '').toLowerCase();
  const index = lowerContent.indexOf(lowerKeyword);

  if (index === -1) return '';

  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + keyword.length + contextLength);

  let snippet = content.substring(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// Main processing
async function main() {
  console.log('📚 Reading all documentation files...\n');
  const docs = readAllDocs();
  console.log(`Found ${docs.length} documentation files\n`);

  console.log('📋 Loading manual feedback...\n');
  const manualFeedback = JSON.parse(fs.readFileSync('manual-feedback.json', 'utf8'));

  console.log(`Processing ${manualFeedback.length} questions...\n`);

  const results = [];
  let yesCount = 0;
  let noCount = 0;
  let uncertainCount = 0;

  for (let i = 0; i < manualFeedback.length; i++) {
    const row = manualFeedback[i];
    const question = row['Question asked'];
    const expectedAnswer = row['Reply given '];
    const feedback = row['Feedback '];

    process.stdout.write(`[${i+1}/${manualFeedback.length}] Checking... `);

    const check = checkDataPresence(question, expectedAnswer, docs);

    const dataPresent = check.confidence === 'low' ? 'UNCERTAIN' : (check.dataPresent ? 'YES' : 'NO');

    if (dataPresent === 'YES') yesCount++;
    else if (dataPresent === 'NO') noCount++;
    else uncertainCount++;

    results.push({
      ...row,
      data_present: dataPresent,
      confidence: check.confidence,
      relevant_docs: check.foundDocs.map(d => d.filename).join(', '),
      reasoning: check.reasoning
    });

    console.log(`${dataPresent} (${check.confidence})`);
  }

  console.log('\n📊 SUMMARY:\n');
  console.log(`  YES (data present):     ${yesCount} (${(yesCount/manualFeedback.length*100).toFixed(1)}%)`);
  console.log(`  NO (data not present):  ${noCount} (${(noCount/manualFeedback.length*100).toFixed(1)}%)`);
  console.log(`  UNCERTAIN:              ${uncertainCount} (${(uncertainCount/manualFeedback.length*100).toFixed(1)}%)`);
  console.log('');

  // Save results
  fs.writeFileSync('manual-feedback-with-data-check.json', JSON.stringify(results, null, 2));
  console.log('✅ Saved to manual-feedback-with-data-check.json\n');

  // Show some examples
  console.log('📝 EXAMPLES WHERE DATA IS PRESENT:\n');
  results.filter(r => r.data_present === 'YES').slice(0, 5).forEach((r, i) => {
    console.log(`${i+1}. ${r['Question asked']}`);
    console.log(`   Docs: ${r.relevant_docs}`);
    console.log('');
  });

  console.log('❌ EXAMPLES WHERE DATA IS NOT PRESENT:\n');
  results.filter(r => r.data_present === 'NO').slice(0, 5).forEach((r, i) => {
    console.log(`${i+1}. ${r['Question asked']}`);
    console.log(`   Reasoning: ${r.reasoning}`);
    console.log('');
  });

  // Update Excel file
  console.log('📝 Updating Excel file...');
  updateExcel(results);
}

// Update Excel file with new column
function updateExcel(results) {
  const XLSX = require('xlsx');

  // Read existing workbook
  const workbook = XLSX.readFile('manual-feedback.xlsx');
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];

  // Convert to array of arrays
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

  // Add new column header
  if (data[0]) {
    data[0].push('data_present');
    data[0].push('confidence');
    data[0].push('relevant_docs');
  }

  // Add data for each row
  for (let i = 1; i < data.length && i - 1 < results.length; i++) {
    const result = results[i - 1];
    data[i].push(result.data_present);
    data[i].push(result.confidence);
    data[i].push(result.relevant_docs);
  }

  // Create new worksheet
  const newWorksheet = XLSX.utils.aoa_to_sheet(data);
  workbook.Sheets[workbook.SheetNames[0]] = newWorksheet;

  // Save
  XLSX.writeFile(workbook, 'manual-feedback-updated.xlsx');
  console.log('✅ Saved to manual-feedback-updated.xlsx\n');
}

main().catch(console.error);
