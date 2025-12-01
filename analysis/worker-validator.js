/**
 * Worker-compatible Response Validator
 * Lightweight validation for Cloudflare Workers environment
 */

/**
 * Patterns that indicate potential hallucinations
 */
export const HALLUCINATION_PATTERNS = [
  // Specific statistics without attribution
  {
    pattern: /(\d+%\s+(of|students)|(\d{2,}|thousands?|millions?)\s+(students|applicants|graduates))(?!.*\b(document|according|mentioned|from)\b)/gi,
    severity: 'high',
  },

  // Guarantees and absolute claims
  {
    pattern: /\b(guaranteed|definitely will|100%|certainly will|assured|promise)\b(?!.*\b(not|cannot|no)\b)/gi,
    severity: 'medium',
  },

  // Specific salary/compensation figures
  {
    pattern: /\b(salary|compensation|package|CTC|pay)\s+(of|around|approximately)?\s*[₹$€£]\s*\d+/gi,
    severity: 'high',
  },
];

/**
 * Out-of-scope keywords
 */
export const OUT_OF_SCOPE_KEYWORDS = [
  'capital', 'country', 'cook', 'recipe', 'weather', 'sports',
  'movie', 'music', 'celebrity', 'politics', 'quantum', 'physics',
  'chemistry', 'biology', 'fix.*car', 'lose.*weight', 'stock', 'cryptocurrency',
  'programming language', 'world cup', 'pizza', 'guitar'
];

/**
 * Quick validation for streaming responses
 * Returns true if response appears safe, false if suspicious
 */
export function quickValidate(responseChunk, question = '', hasRelevantDocs = true) {
  // For very short chunks, allow through
  if (responseChunk.length < 20) {
    return true;
  }

  // Check for high-severity patterns in this chunk
  for (const { pattern, severity } of HALLUCINATION_PATTERNS) {
    if (severity === 'high' && pattern.test(responseChunk)) {
      return false;
    }
  }

  // If no relevant docs but giving detailed answer, be suspicious
  if (!hasRelevantDocs && responseChunk.length > 100) {
    const admitsUnknown = /(I don't have|not available|cannot provide|outside.*scope)/i.test(responseChunk);
    if (!admitsUnknown) {
      return false;
    }
  }

  // Check if question appears out of scope
  const questionLower = question.toLowerCase();
  const isLikelyOutOfScope = OUT_OF_SCOPE_KEYWORDS.some(keyword =>
    new RegExp(keyword, 'i').test(questionLower)
  );

  if (isLikelyOutOfScope) {
    const admitsLimitation = /(I don't have|not available|cannot answer|outside|not mentioned)/i.test(responseChunk);
    // If out of scope and not admitting limitation and response is substantial, flag it
    if (!admitsLimitation && responseChunk.length > 50) {
      return false;
    }
  }

  return true;
}

/**
 * Validate complete response
 */
export function validateResponse(response, question = '', documents = []) {
  const hasRelevantDocs = documents && documents.length > 0;
  const issues = [];

  // Skip validation for very short responses
  if (response.length < 10) {
    return { valid: true, issues: [] };
  }

  // Check for hallucination patterns
  for (const { pattern, severity } of HALLUCINATION_PATTERNS) {
    const matches = response.match(pattern);
    if (matches && severity === 'high') {
      issues.push({
        type: 'hallucination_pattern',
        severity,
        matches: matches.slice(0, 2)
      });
    }
  }

  // Check: long response with no relevant documents
  if (!hasRelevantDocs && response.length > 100) {
    const admitsNoInfo = /(I don't have|not available|cannot find|don't know)/i.test(response);
    if (!admitsNoInfo) {
      issues.push({
        type: 'no_source',
        severity: 'high'
      });
    }
  }

  // Check: answering out-of-scope questions
  const questionLower = question.toLowerCase();
  const isLikelyOutOfScope = OUT_OF_SCOPE_KEYWORDS.some(keyword =>
    new RegExp(keyword, 'i').test(questionLower)
  );

  if (isLikelyOutOfScope) {
    const admitsLimitation = /(I don't have|not available|cannot answer|outside|not mentioned|don't know)/i.test(response);
    if (!admitsLimitation && response.length > 50) {
      issues.push({
        type: 'out_of_scope',
        severity: 'high'
      });
    }
  }

  const valid = issues.filter(i => i.severity === 'high').length === 0;

  return { valid, issues };
}

/**
 * Get safe fallback response
 */
export function getSafeFallbackResponse() {
  return "I don't have sufficient information in the available documentation to answer this question accurately. Please refer to the official IIT Madras BS programme documentation or contact the programme administrators.";
}
