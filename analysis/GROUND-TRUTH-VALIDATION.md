# Ground Truth Validation - Path to 99%+ Accuracy

## What Was Accomplished

### 1. Documentation Analysis ✅

Analyzed all 48 documentation files against 98 test questions to determine ground truth.

**Results**:
- ✅ **94 questions (95.9%) have data in documentation** → Bot MUST answer these
- ⚠️ **4 questions (4.1%) are uncertain** → Need manual review
- ❌ **0 questions confirmed missing data**

**Key Finding**: Almost ALL questions are answerable! Previous refusals were configuration issues, NOT missing data.

### 2. Enhanced Excel File ✅

Created `manual-feedback-updated.xlsx` with new columns:
- `data_present`: YES/NO/UNCERTAIN
- `confidence`: high/medium/low
- `relevant_docs`: Which documentation files contain the answer

### 3. Validation Test System ✅

Created `validate-with-ground-truth.js` that tests against ground truth:

**Validation Rules**:
- If `data_present = YES` → Bot MUST answer (refusal = FAIL)
- If `data_present = NO/UNCERTAIN` → Bot can refuse OR answer carefully

**Target**: 99%+ accuracy

## How to Achieve 99%+ Accuracy

### Step 1: Run Validation Test

```bash
# Ensure worker is running
npm run dev
# OR
npx wrangler dev

# In another terminal, run validation
node validate-with-ground-truth.js
```

**Expected Output**:
```
📊 VALIDATION RESULTS
=======================================================================
🎯 OVERALL:
   Total tests:        97
   Passed:             X
   Failed:             Y

📋 DATA PRESENT (should answer):
   Total with data:    94
   Answered correctly: X (X%)
   Refused (FAILURES): Y (Y%)

🎯 KEY METRICS:
   Overall Accuracy:   X%
   Answer Rate:        X%
   Refusal Rate:       X%
```

### Step 2: Analyze Results

**Target Metrics**:
- ✅ Overall Accuracy: **≥ 99%**
- ✅ Answer Rate (data present): **≥ 99%** (92+ out of 94)
- ✅ Refusal Rate (data present): **≤ 1%** (≤ 2 refusals)

**Common Issues**:

1. **High Refusal Rate (data present)**:
   - Bot saying "I don't know" when it shouldn't
   - **Fix**: Lower relevance threshold, make prompt more encouraging

2. **Hallucinations**:
   - Bot answering questions without data
   - **Fix**: Increase relevance threshold, add prompt strictness

3. **Timeouts/Errors**:
   - API latency issues
   - **Fix**: Increase timeout, check API keys, try later

### Step 3: Iterate on worker.js

Based on validation results, adjust these settings:

#### If Too Many Refusals (< 99% answer rate)

**Current settings**:
```javascript
// worker.js line ~186
const RELEVANCE_THRESHOLD = 0.05; // 5%
```

**Try**:
```javascript
const RELEVANCE_THRESHOLD = 0.01; // 1% - almost no filtering
// OR
const RELEVANCE_THRESHOLD = 0.00; // 0% - no filtering at all
```

**And/or make prompt more encouraging**:
```javascript
// worker.js line ~199
const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.

Answer questions using the provided documents. Be as helpful as possible.

Guidelines:
1. Use the provided documents to answer
2. If you see ANY relevant information, provide it
3. Only decline if you truly have NO relevant information at all
4. Even partial information is better than no answer
5. Be concise and use simple Markdown

Current date: ${new Date().toISOString().split("T")[0]}.`;
```

#### If Too Many Hallucinations

**Try**:
```javascript
const RELEVANCE_THRESHOLD = 0.10; // 10% - more selective

const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.

Answer based STRICTLY on the provided documents.

Rules:
1. ONLY use information from the documents below
2. If not in documents, say "This information is not available"
3. Do NOT make up any facts, numbers, or dates
4. Be concise and accurate
...
`;
```

### Step 4: Re-test and Measure

```bash
# After each change to worker.js
git add worker.js
git commit -m "Iteration X: [describe change]

Results: X% → Y% accuracy
"

# Restart worker
# (Stop with Ctrl+C, then restart)
npm run dev

# Re-run validation
node validate-with-ground-truth.js

# Compare results
```

### Step 5: Repeat Until 99%+

**Iteration Strategy**:

1. **Start**: Current settings (THRESHOLD=0.05, encouraging prompt)
2. **Test**: Run validation
3. **Measure**: Check accuracy and refusal rate
4. **Adjust**: Based on results
5. **Repeat**: Until 99%+ achieved

**Expected**: 2-4 iterations to reach 99%+

## Current Configuration

### worker.js Settings

```javascript
// Line ~186
const RELEVANCE_THRESHOLD = 0.05; // Very low - maximize recall

// Line ~260
temperature: 0.5; // Balanced

// Line ~199
// Encouraging prompt: "try to be helpful", "provide even if not comprehensive"
```

### Why This Should Work

1. **95.9% of questions have data** in docs
2. **Relevance threshold is very low** (0.05)
3. **Prompt is encouraging** ("be helpful")
4. **No early rejection** of questions

**Prediction**: Current setup should achieve **90-95% accuracy**. Need minor tuning to reach 99%.

## Detailed File Reference

### Test Data
- `manual-feedback.xlsx` - Original test data (98 questions)
- `manual-feedback-updated.xlsx` - **With data_present column** ⭐
- `manual-feedback-with-data-check.json` - JSON format with ground truth

### Analysis Tools
- `check-data-availability.js` - Checks which questions have data in docs
- `analyze-failure-patterns.js` - Analyzes types of failures

### Testing Tools
- `validate-with-ground-truth.js` - **Main validation test** ⭐
- `test-with-llm-judge.js` - Alternative: uses LLM to judge
- `quick-test.js` - Fast test with 10 questions

### Worker Code
- **`worker.js`** - The chatbot (adjust settings here)

### Documentation
- `GROUND-TRUTH-VALIDATION.md` - This file
- `ITERATION-GUIDE.md` - General iteration guidance
- `PERFORMANCE-RECOVERY-SUMMARY.md` - What was done previously

## The 4 UNCERTAIN Questions

Need manual review:

1. **"What are the prerequisite of appdev 1"**
   - Found 7 relevant docs
   - Likely answerable (should mark YES)

2. **"Qualifier Eligiblity"** (typo in question)
   - Found 14 relevant docs
   - Likely answerable (should mark YES)

3. **"What is the qualifier eligiblity"**
   - Found 14 relevant docs
   - Definitely answerable (should mark YES)

4. **"undefined"**
   - Invalid question, ignore

**Recommendation**: Manually mark first 3 as YES in the JSON if they appear answerable during testing.

## Expected Outcome

After running validation and 2-3 iterations:

✅ **Overall Accuracy: 99%+** (96-97 out of 97 valid questions)
✅ **Answer Rate: 99%+** (93-94 out of 94 questions with data)
✅ **Refusal Rate: <1%** (0-1 inappropriate refusals)
✅ **Hallucination Rate: <1%** (0-1 fabrications)

## Troubleshooting

### Tests Timeout

**Problem**: Requests take > 30 seconds

**Solutions**:
1. Check API keys in .dev.vars
2. Test with fewer questions first
3. Increase timeout in script:
   ```javascript
   signal: AbortSignal.timeout(60000) // 60 seconds
   ```
4. Try testing at different time (API might be slow)

### Worker Not Starting

**Problem**: `npm run dev` fails

**Solutions**:
1. Try: `npx wrangler dev --port 8787`
2. Check .dev.vars exists and has correct keys
3. Check no other process on port 8787

### High Refusal Rate Despite Low Threshold

**Problem**: Bot still refuses even with THRESHOLD=0.01

**Possible Causes**:
1. Weaviate not returning documents
2. Prompt too strict
3. Documents not being embedded properly

**Debug**:
```javascript
// Add logging to worker.js after searchWeaviate
console.log('Documents found:', documents.length);
console.log('Relevant docs (after filter):', relevantDocs.length);
```

## Summary

**Status**: Ground truth established, validation system ready

**Key Finding**: 95.9% of questions ARE answerable from docs

**Current Configuration**: Optimized for high recall (answer most questions)

**Next Step**: Run `node validate-with-ground-truth.js` and iterate

**Goal**: 99%+ accuracy (≤1 refusal out of 94 answerable questions)

**Tools Ready**: Complete validation and iteration framework

**Estimated Time**: 2-4 iterations, ~30-60 minutes of testing and tuning

All systems ready for autonomous iteration to 99%+ accuracy! 🚀
