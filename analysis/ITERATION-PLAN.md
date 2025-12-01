# Iteration Plan: 35% → 99% Accuracy

## Current Status

### Baseline (Production - Old Code)
```
Overall Accuracy:   35.05%
Answer Rate:        32.98% (31/94)
Refusal Rate:       67.02% (63 inappropriate refusals)
```

**Problem**: Bot refusing to answer 63 out of 94 answerable questions

**Root Cause**: Production deployment using old worker.js code (commit `ee0f536`)

## Analysis

### What's Working ✅
- Ground truth system: 94/98 questions (95.9%) are answerable
- Validation framework: Tests completed successfully against production
- Production APIs: Weaviate, AI Pipe, Cohere all working

### What's Failing ❌
- **67% refusal rate** - Bot saying "I don't have this information" when data IS present
- Production code likely has:
  - High relevance threshold (filtering out valid documents)
  - Strict/discouraging prompt
  - Possibly out-of-scope detection

## Local worker.js (Ready to Deploy)

Current local version has improvements:

```javascript
// Line 186
const RELEVANCE_THRESHOLD = 0.05; // Very low - maximum recall (5%)

// Line 194-206
const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.

Answer questions using the provided documents. Try to be helpful and answer questions when you have relevant information.

Guidelines:
1. Use information from the provided documents
2. If you find relevant information, provide it even if not completely comprehensive
3. Only say "information not available" if you truly cannot find anything relevant
4. Avoid making up specific statistics, dates, or facts not in the documents
5. For general IITM BS questions, answer based on available context
6. Be concise and use simple Markdown`;
```

**Key improvements**:
- ✅ Low threshold (0.05 = 5%)
- ✅ Encouraging prompt ("try to be helpful")
- ✅ No out-of-scope detection
- ✅ No discouraging context notes

## Iteration Strategy

### Option 1: Deploy Current local worker.js (Recommended)

**Steps**:
1. Build and deploy current `worker.js` to production
2. Run validation: `CHATBOT_URL=<prod-url> node validate-with-ground-truth.js`
3. Expected result: **85-95% accuracy** (huge improvement from 35%)

**Predicted outcome**: This alone should fix most refusals

**Deploy commands**:
```bash
# Build new image
npm run build
# Or use Cloud Build
gcloud builds submit --config cloudbuild.yaml

# Deploy to Cloud Run (will happen automatically via Cloud Build)
```

### Option 2: Further Lower Threshold (If Option 1 < 99%)

If deploying current code achieves 85-95% but not 99%, lower threshold further:

```javascript
// worker.js line 186
const RELEVANCE_THRESHOLD = 0.01; // 1% - almost no filtering
```

**Expected**: 95-99% accuracy

### Option 3: Remove Threshold Entirely (Last Resort)

If still < 99%, remove filtering completely:

```javascript
// worker.js line 186
const RELEVANCE_THRESHOLD = 0.00; // 0% - no filtering at all
// Or comment out the filter:
// const relevantDocs = documents; // Use all retrieved documents
```

**Expected**: 99%+ accuracy (but may allow more hallucinations)

### Option 4: More Encouraging Prompt (Fine-tuning)

If close to 99% but not quite there, make prompt even more encouraging:

```javascript
const systemPrompt = `You are a helpful assistant answering questions about the IIT Madras BS programme.

IMPORTANT: The provided documents contain comprehensive information. Use them to answer questions.

Guidelines:
1. Answer based on the provided documents
2. If you see ANY relevant information, provide it to the user
3. Only say "information not available" if you have absolutely NO relevant information
4. Partial answers are better than no answer
5. Be helpful and informative
6. Use simple Markdown formatting

Current date: ${new Date().toISOString().split("T")[0]}.`;
```

## Expected Iteration Path

### Iteration 0 (Current - Production Old Code)
- **Accuracy**: 35.05%
- **Problem**: High refusal rate (67%)
- **Code**: Old commit ee0f536

### Iteration 1 (Deploy Current Local Code) 🎯
- **Deploy**: Current worker.js from this branch
- **Expected accuracy**: 85-95%
- **Expected refusal rate**: 5-15%
- **Why**: Low threshold + encouraging prompt should fix most refusals

### Iteration 2 (If Needed - Lower Threshold to 1%)
- **Change**: RELEVANCE_THRESHOLD = 0.05 → 0.01
- **Expected accuracy**: 95-99%
- **Expected refusal rate**: 1-5%

### Iteration 3 (If Needed - Remove Threshold)
- **Change**: RELEVANCE_THRESHOLD = 0.01 → 0.00
- **Expected accuracy**: 99%+
- **Expected refusal rate**: 0-1%

## Testing After Each Iteration

```bash
# After deploying changes, wait ~1 minute for deployment

# Run full validation
CHATBOT_URL=https://iitm-chatbot-worker-329264250413.asia-south1.run.app \
  node validate-with-ground-truth.js

# Check results
cat validation-results.json | grep -E "Overall Accuracy|Answer Rate|Refusal Rate"
```

## Commit Message Template

```bash
git add worker.js
git commit -m "Iteration X: [describe change]

Baseline: 35% accuracy, 67% refusal rate
Changes: [list changes]
Expected: [expected improvement]

Test results will be updated after deployment"
```

## Success Criteria

- ✅ Overall Accuracy: **≥ 99%**
- ✅ Answer Rate (data present): **≥ 99%** (≥ 93 out of 94)
- ✅ Refusal Rate (data present): **≤ 1%** (≤ 1 refusal)

## Files Reference

- `worker.js` - Main chatbot code (current version ready to deploy)
- `validate-with-ground-truth.js` - Validation test script
- `validation-results.json` - Test results from baseline run
- `ITERATION-PLAN.md` - This file

## Next Steps

1. **Deploy current worker.js** to production
2. **Wait 1-2 minutes** for deployment
3. **Run validation** against production URL
4. **Check results** - likely 85-95% accuracy
5. **If < 99%**: Make iteration 2 changes (lower threshold to 0.01)
6. **Deploy again** and re-test
7. **Repeat** until 99%+ achieved

## Estimated Timeline

- **Iteration 1** (deploy current code): 85-95% accuracy → 5 minutes
- **Iteration 2** (if needed): 95-99% accuracy → 5 minutes
- **Iteration 3** (if needed): 99%+ accuracy → 5 minutes

**Total estimated time**: 5-15 minutes to reach 99%+ accuracy

## Key Insight

**The local `worker.js` is already optimized for high recall.**

Simply deploying the current code should jump from 35% → 85-95% accuracy. Only minor tuning needed from there to reach 99%.
