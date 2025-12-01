# Iteration Guide - Balancing Answerability vs Hallucination Prevention

## Current Status

### Problem Identified
Your manual testing showed **performance degradation** - the bot was saying "I don't know" for questions it previously answered correctly.

### Root Cause Analysis
Analyzed the 98 manual feedback cases and found:
- ✅ **52% Baseline correct rate** (51/98 questions)
- ❌ **38.8% Incorrect** (38/98 questions)
  - **16 cases**: Bot says "I don't know" when it should answer (PRIMARY ISSUE)
  - **21 cases**: Bot provides wrong/hallucinated information
- ⚠️ **8.2% Nearly correct** (8/98 questions)

### Changes Made (2 Iterations)

**Iteration 1: Initial Performance Fixes**
- Lowered relevance threshold: 0.3 → 0.15
- Disabled early out-of-scope detection
- Softened prompt language
- Increased temperature: 0.3 → 0.5

**Iteration 2: Aggressive Answerability Fixes** (Current)
- Drastically lowered relevance threshold: 0.15 → 0.05 (5%)
- Completely rewrote prompt to be encouraging
- Removed discouraging context notes
- Philosophy: Be helpful > Be cautious

## How to Test and Iterate

### Step 1: Deploy Current Version

```bash
# Deploy to production or test environment
npm run deploy
# OR test locally
npm run dev
```

### Step 2: Run Quick Test (10 questions)

```bash
node quick-test.js
```

This will test the first 10 manual feedback questions and show:
- Question
- Expected feedback
- Bot's actual response

### Step 3: Run Full Test with LLM Judge (98 questions)

```bash
node test-with-llm-judge.js
```

This will:
- Test all 98 manual feedback questions
- Use LLM to judge each response (CORRECT/ACCEPTABLE/WRONG)
- Compare to baseline
- Identify degraded vs improved questions
- Generate detailed report

**Expected output:**
```
📊 CURRENT PERFORMANCE:
   Total tests:        98
   Correct:            X (X%)
   Acceptable:         Y (Y%)
   Wrong:              Z (Z%)

📈 BASELINE COMPARISON:
   Baseline correct:   51/98 (52.0%)
   Current success:    XX/98 (XX%)
   Change:             +/-X%

🔍 DETAILED ANALYSIS:
   Degraded:           X (correct → wrong)
   Improved:           Y (wrong → correct)
   Still wrong:        Z (wrong → wrong)
```

###Step 4: Analyze Results

**Target Metrics:**
- ✅ **Success Rate (Correct + Acceptable)**: > 70%
- ✅ **Hallucination Rate (Wrong with fabricated info)**: < 5%
- ✅ **"I don't know" refusals for answerable questions**: < 10%

**Good Result:**
- Improved vs baseline (>52% success)
- Reduced "I don't know" refusals
- No significant increase in hallucinations

**Bad Result:**
- Still many "I don't know" responses
- OR increased hallucinations
- Need to iterate further

### Step 5: Iterate Based on Results

#### Scenario A: Too Many "I Don't Know" Responses

**Diagnosis**: Still refusing to answer legitimate questions

**Fixes**:
1. Lower relevance threshold further (try 0.02 or 0.01)
2. Increase number of documents (ndocs)
3. Make prompt even more encouraging
4. Check if Weaviate is returning documents

```javascript
// In worker.js, try:
const RELEVANCE_THRESHOLD = 0.01; // Almost no filtering
const numDocs = parseInt(ndocs) || 10; // Get more documents
```

#### Scenario B: Too Many Hallucinations/Wrong Answers

**Diagnosis**: Bot is making things up or providing incorrect info

**Fixes**:
1. Increase relevance threshold (try 0.10 or 0.15)
2. Add back some prompt strictness
3. Add specific warnings about not making up stats/dates

```javascript
// In worker.js, try:
const RELEVANCE_THRESHOLD = 0.10; // More selective

// And update prompt:
Guidelines:
1. Use information from the provided documents
2. If you find relevant information, provide it
3. **DO NOT make up statistics, dates, or specific numbers**
4. If uncertain about specifics, say so explicitly
...
```

#### Scenario C: Good Balance Achieved

**Success criteria**:
- Success rate > baseline (>52%)
- Reduced "I don't know" responses
- Acceptable hallucination rate

**Actions**:
1. Document the optimal settings
2. Deploy to production
3. Monitor with ongoing testing

### Step 6: Re-test After Changes

```bash
# After each change to worker.js
git add worker.js
git commit -m "Iteration X: [describe change and reason]"

# Restart worker
npm run dev

# Re-run tests
node test-with-llm-judge.js

# Compare results
```

## Testing Tools Reference

### 1. analyze-failure-patterns.js
**Purpose**: Understand what types of failures occur

```bash
node analyze-failure-patterns.js
```

**Output**:
- Breakdown of correct/incorrect/nearly correct
- Categories of failures (don't know, partial, wrong)
- Examples of each failure type
- Question type analysis (exam, fees, admission, etc.)

**Use**: Identify patterns in failures to make targeted improvements

### 2. quick-test.js
**Purpose**: Fast testing with 10 questions

```bash
node quick-test.js
```

**Output**:
- 10 question-answer pairs
- Quick validation before full test

**Use**: Rapid iteration during development

### 3. test-with-llm-judge.js
**Purpose**: Comprehensive testing with LLM evaluation

```bash
node test-with-llm-judge.js
```

**Output**:
- Detailed report with metrics
- Degraded vs improved questions
- Saves results to test-results-with-judge.json

**Use**: Measure progress quantitatively

## Configuration Knobs

### worker.js Settings You Can Adjust

**1. Relevance Threshold** (Line ~186)
```javascript
const RELEVANCE_THRESHOLD = 0.05; // Current: 5%
```
- **Lower (0.01-0.05)**: More documents included, better recall, might include noise
- **Higher (0.10-0.30)**: Fewer documents, more precision, might miss relevant info
- **Sweet spot**: Start at 0.05, adjust based on "I don't know" rate

**2. Temperature** (Line ~260)
```javascript
temperature: 0.5, // Current: balanced
```
- **Lower (0.1-0.3)**: More deterministic, less creative, fewer hallucinations
- **Higher (0.5-0.8)**: More natural, more creative, higher hallucination risk
- **Sweet spot**: 0.3-0.5 for balance

**3. System Prompt** (Line ~194)
```javascript
const systemPrompt = `You are a helpful assistant...`
```
- **More strict**: Add "ONLY", "NEVER", "CRITICAL" language
- **More lenient**: Use "try to", "when possible", "generally" language
- **Sweet spot**: Encouraging but with key rules about not fabricating

**4. Number of Documents** (Line ~26, ~40)
```javascript
const { q: question, ndocs = 5, history = [] } = await request.json();
```
- **Fewer (3-5)**: Faster, more focused, might miss info
- **More (7-10)**: Slower, more comprehensive, more context
- **Sweet spot**: 5-7 documents

## Iteration Strategy

### Recommended Approach

1. **Start with current aggressive settings** (high recall)
   - See how many "I don't know" responses are eliminated
   - Check hallucination rate

2. **If too many hallucinations**, dial back:
   - Increase relevance threshold by 0.05
   - Add prompt strictness
   - Lower temperature by 0.1
   - Re-test

3. **If still too many "I don't know"**, make more aggressive:
   - Decrease relevance threshold by 0.02
   - Make prompt more encouraging
   - Increase number of documents
   - Re-test

4. **Iterate until balance found**:
   - Target: >70% success, <5% hallucinations
   - 3-5 iterations typically needed

### Document Your Changes

After each iteration:
```bash
git add worker.js
git commit -m "Iteration X: Adjusted [setting] to [value] because [reason]

Results:
- Success rate: X% → Y%
- Hallucinations: A% → B%
- "I don't know" responses: C → D
"
```

## Troubleshooting

### Worker Not Responding
```bash
# Check if worker is running
curl http://localhost:8787/answer \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"q":"test","ndocs":1}'

# Check wrangler logs
# (check terminal where `npm run dev` is running)
```

### Tests Timing Out
- Weaviate might be slow
- Chat API might be slow
- Increase timeout in test scripts:
  ```javascript
  signal: AbortSignal.timeout(60000) // 60 seconds
  ```

### LLM Judge Not Working
- Check OPENAI_API_KEY in .env or .dev.vars
- Check CHAT_API_ENDPOINT is correct
- Try simpler test without judge first

## Next Steps

1. ✅ Deploy current version with aggressive fixes
2. ⏳ Run test-with-llm-judge.js
3. ⏳ Analyze results vs baseline
4. ⏳ Iterate on settings based on results
5. ⏳ Repeat until optimal balance found
6. ⏳ Document final settings and deploy

## Expected Outcome

After 3-5 iterations, you should achieve:
- ✅ **>70% success rate** (vs 52% baseline)
- ✅ **<10 "I don't know" refusals** for answerable questions (vs 16 baseline)
- ✅ **<5% hallucination rate** (fabricated information)
- ✅ **Good user experience**: Helpful and accurate

## Files Reference

**Test Data**:
- `manual-feedback.xlsx` - Original manual test data (98 questions)
- `manual-feedback.json` - Converted to JSON for scripts

**Analysis Tools**:
- `analyze-failure-patterns.js` - Identify failure types
- `analyze-feedback.js` - Basic feedback stats
- `read-excel.js` - Excel to JSON converter

**Testing Tools**:
- `quick-test.js` - Fast test with 10 questions
- `test-with-llm-judge.js` - Full test with LLM evaluation (98 questions)
- `hallucination-test.js` - Original hallucination detection tests

**Main Code**:
- `worker.js` - The chatbot worker (THIS IS WHAT YOU ITERATE ON)

**Documentation**:
- `ITERATION-GUIDE.md` - This file
- `QA-TESTING.md` - Original QA testing guide
- `HALLUCINATION-PREVENTION-SUMMARY.md` - Original implementation summary

## Contact / Questions

If you need to adjust the approach:
1. Check current settings in worker.js
2. Run tests to measure current performance
3. Make incremental changes
4. Test and measure
5. Repeat

The key is balancing **helping users** (answerability) with **not misleading them** (accuracy).
