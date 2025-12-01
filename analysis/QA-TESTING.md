# QA Testing Guide for IITM BS Chatbot

## Overview

This document describes the comprehensive QA testing framework for detecting and preventing hallucinations in the IITM BS chatbot.

## Hallucination Prevention Strategy

### Multi-Layer Defense

1. **Early Detection Layer** (worker.js)
   - Detects obviously out-of-scope questions before LLM call
   - Returns safe response immediately
   - Keywords: weather, cooking, sports, finance, etc.

2. **Prompt Engineering Layer** (worker.js)
   - Strict system prompt with explicit rules
   - Document-only responses required
   - Temperature set to 0.3 for deterministic output
   - Relevance threshold filtering (30%)

3. **Validation Layer** (worker-validator.js, response-validator.js)
   - Pattern-based hallucination detection
   - Out-of-scope question validation
   - Confidence scoring
   - Safe fallback responses

## Testing Framework

### Components

1. **generate-test-prompts.js**
   - Generates comprehensive test datasets
   - Categories: answerable, unanswerable, tricky, edge cases
   - Includes variations and edge cases
   - Usage: `node generate-test-prompts.js 1000`

2. **hallucination-test.js**
   - Basic hallucination detection tests
   - Predefined test queries
   - Pattern-based detection
   - Usage: `node hallucination-test.js http://localhost:8787`

3. **run-comprehensive-tests.js**
   - Full test suite with batching
   - Detailed reporting and analytics
   - Validation integration
   - Usage: `node run-comprehensive-tests.js test-prompts.json 100`

4. **response-validator.js**
   - Standalone validation module
   - Can be integrated into other tools
   - Detailed pattern matching
   - Report generation

### Test Categories

#### Answerable Questions (Should answer correctly)
- Questions about admissions, courses, fees
- Academic policies and procedures
- Timeline and calendar questions
- Programme structure questions

Example:
```javascript
{
  question: "What is the admission process?",
  expected: "answer",
  category: "admissions"
}
```

#### Unanswerable Questions (Should decline)
- General knowledge questions
- Topics outside IITM BS scope
- Personal advice questions

Example:
```javascript
{
  question: "What is the capital of France?",
  expected: "decline",
  category: "out_of_scope"
}
```

#### Tricky Questions (Should handle carefully)
- Comparison questions
- Future predictions
- Opinion-based questions
- Guarantee-seeking questions

Example:
```javascript
{
  question: "Will I definitely get a job after this?",
  expected: "careful",
  category: "placement"
}
```

#### Edge Cases
- Empty strings
- Very long inputs
- Nonsense inputs
- Single-word queries

## Running Tests

### Quick Test (50 queries)
```bash
node run-comprehensive-tests.js test-prompts.json 50
```

### Full Test Suite (all prompts)
```bash
node run-comprehensive-tests.js test-prompts.json
```

### Generate New Test Data
```bash
# Generate 1000 prompts
node generate-test-prompts.js 1000

# Generate 500 prompts
node generate-test-prompts.js 500
```

### Test Against Running Worker

1. Start the worker:
   ```bash
   npm run dev
   # or
   docker-compose up worker
   ```

2. Run tests:
   ```bash
   node run-comprehensive-tests.js test-prompts.json 100
   ```

## Interpreting Results

### Hallucination Rate
- **< 1%**: Excellent - production ready
- **1-5%**: Good - minor improvements needed
- **5-10%**: Fair - needs work
- **> 10%**: Poor - major improvements required

### Success Metrics

Good results should show:
- Clean responses: > 95%
- Hallucination rate: < 1%
- Error rate: < 5%
- Proper declination of out-of-scope: > 90%
- Average latency: < 3000ms

### Example Good Report
```
📊 COMPREHENSIVE TEST REPORT
======================================================================
Total tests:        100
Successful:         98 (98%)
Errors:             2 (2%)
Clean responses:    97
Hallucinations:     1 (1.02%)

🎉 EXCELLENT! Hallucination rate is below 1%
```

### Example Problem Report
```
📊 COMPREHENSIVE TEST REPORT
======================================================================
Total tests:        100
Successful:         95 (95%)
Clean responses:    85
Hallucinations:     10 (10.53%)

⚠️ TOP HALLUCINATION REASONS:
   1. Should have said 'I don't know' for out-of-scope question (5x)
   2. Long answer with no source documents (3x)
   3. Specific statistics without attribution (2x)

❌ CRITICAL. Hallucination rate is too high, needs significant work
```

## Hallucination Patterns Detected

### High Severity (Block immediately)
- Specific statistics without attribution
- Made-up salary/compensation figures
- Guarantees and absolute promises
- Out-of-scope answers without disclaimer

### Medium Severity (Warning)
- Specific dates without source
- Building/room numbers
- Company-specific claims without attribution

### False Positives
If legitimate information is flagged:
1. Check if it's actually in the source documents
2. Update validation patterns if needed
3. Add exceptions for known good patterns

## Continuous Improvement

### Iteration Process

1. **Run baseline tests**
   ```bash
   node run-comprehensive-tests.js test-prompts.json > baseline.txt
   ```

2. **Identify issues**
   - Review hallucination reasons
   - Check specific failed queries
   - Look for patterns in failures

3. **Make improvements**
   - Update system prompt
   - Adjust relevance threshold
   - Add new validation patterns
   - Improve document quality

4. **Re-test**
   ```bash
   node run-comprehensive-tests.js test-prompts.json > improved.txt
   ```

5. **Compare results**
   ```bash
   diff baseline.txt improved.txt
   ```

6. **Commit if improved**
   ```bash
   git add worker.js
   git commit -m "Reduce hallucination rate from X% to Y%"
   ```

### Adding New Test Cases

When you find a question that causes hallucination:

1. Add to test-prompts.json:
   ```json
   {
     "question": "Your problematic question",
     "type": "specific_category",
     "expected": "decline",
     "source": "production_issue"
   }
   ```

2. Re-run tests to verify fix

3. Keep the test to prevent regression

## Deployment Checklist

Before deploying to production:

- [ ] Run full test suite (all prompts)
- [ ] Hallucination rate < 1%
- [ ] No high-severity validation failures
- [ ] Out-of-scope questions properly declined
- [ ] Average latency acceptable (< 5s)
- [ ] Error rate < 5%
- [ ] Manual spot-check of sample responses
- [ ] Review any new hallucination patterns

## Monitoring in Production

### Ongoing Validation

1. **Regular Testing**
   - Run test suite weekly
   - Track hallucination rate over time
   - Monitor for regressions

2. **User Feedback**
   - Collect problematic queries
   - Add to test suite
   - Iterate on improvements

3. **Log Analysis**
   - Track out-of-scope detection rate
   - Monitor validation failures
   - Identify new patterns

## Troubleshooting

### High Hallucination Rate

1. Check system prompt in worker.js
2. Verify temperature setting (should be 0.3)
3. Check relevance threshold (should be 0.3)
4. Review document quality
5. Test with different LLM models

### False Positives (Good answers flagged as hallucinations)

1. Review validation patterns
2. Check if information is actually in documents
3. Update OUT_OF_SCOPE_KEYWORDS if needed
4. Adjust validation thresholds

### High Error Rate

1. Check API keys and connectivity
2. Verify Weaviate is accessible
3. Check for timeout issues
4. Review input validation

## Advanced Topics

### Custom Validation Rules

Add to worker-validator.js:
```javascript
{
  pattern: /your custom pattern/gi,
  severity: 'high',
  description: 'Description of what this catches'
}
```

### Adjusting Thresholds

In worker.js:
```javascript
const RELEVANCE_THRESHOLD = 0.3; // Increase for stricter matching
```

In generateAnswer:
```javascript
temperature: 0.3, // Decrease for more deterministic (0.1-0.5)
```

### Integration with CI/CD

Add to GitHub Actions or similar:
```yaml
- name: Run Hallucination Tests
  run: |
    node run-comprehensive-tests.js test-prompts.json 200
    if [ $? -ne 0 ]; then
      echo "Hallucination rate too high!"
      exit 1
    fi
```

## Resources

- **Source Code**: worker.js (main chatbot logic)
- **Tests**: hallucination-test.js, run-comprehensive-tests.js
- **Validation**: response-validator.js, worker-validator.js
- **Test Data**: test-prompts.json
- **Generator**: generate-test-prompts.js

## Contact

For questions about QA testing or hallucination prevention, refer to this document or review the source code comments.
