/**
 * Response Validator
 * Validates LLM responses for hallucinations and inappropriate content
 */

/**
 * Patterns that indicate potential hallucinations
 */
const HALLUCINATION_PATTERNS = [
  // Specific dates that might be fabricated (unless mentioned in question)
  {
    pattern: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi,
    severity: 'medium',
    description: 'Specific dates that may be fabricated'
  },

  // Specific made-up names
  {
    pattern: /Professor\s+([A-Z][a-z]+\s+){1,2}[A-Z][a-z]+(?!\s+(mentioned|states|from|in the))/gi,
    severity: 'high',
    description: 'Specific professor names not from documents'
  },

  // Specific statistics without attribution
  {
    pattern: /(\d+%\s+(of|students)|(\d{2,}|thousands?|millions?)\s+(students|applicants|graduates))(?!.*\b(document|according|mentioned|from)\b)/gi,
    severity: 'high',
    description: 'Statistics without source attribution'
  },

  // Guarantees and absolute claims
  {
    pattern: /\b(guaranteed|definitely will|100%|certainly will|assured|promise)\b(?!.*\b(not|cannot|no)\b)/gi,
    severity: 'medium',
    description: 'Inappropriate guarantees or absolute claims'
  },

  // Specific building/room numbers
  {
    pattern: /\b(building|room|hall|auditorium)\s+[A-Z]?-?\d+/gi,
    severity: 'medium',
    description: 'Specific building/room numbers'
  },

  // Specific salary/compensation figures
  {
    pattern: /\b(salary|compensation|package|CTC|pay)\s+(of|around|approximately)?\s*[₹$€£]\s*\d+/gi,
    severity: 'high',
    description: 'Specific salary figures'
  },

  // Made-up URLs or email addresses
  {
    pattern: /\b[a-zA-Z0-9._%+-]+@(?!study\.iitm\.ac\.in)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gi,
    severity: 'medium',
    description: 'Email addresses not from official domain'
  },

  // Specific company names in placement context (without attribution)
  {
    pattern: /\b(Google|Microsoft|Amazon|Facebook|Apple|Netflix)\s+(will|has|offers|recruits)(?!.*\b(may|might|document|mentioned)\b)/gi,
    severity: 'medium',
    description: 'Specific company claims without attribution'
  },
];

/**
 * Patterns that indicate good responses
 */
const GOOD_PATTERNS = [
  {
    pattern: /(I don't have|not available|cannot provide|outside.*scope|don't have.*information|not mentioned)/gi,
    score: 10,
    description: 'Admits limitations appropriately'
  },
  {
    pattern: /(according to|based on|document states|mentioned in|from the)/gi,
    score: 5,
    description: 'References source documents'
  },
  {
    pattern: /(may|might|could|typically|generally|usually|possibly)/gi,
    score: 3,
    description: 'Uses hedging language'
  },
  {
    pattern: /please (check|refer|see|visit|contact)/gi,
    score: 5,
    description: 'Directs to authoritative sources'
  },
];

/**
 * Validate a response for hallucinations
 * @param {string} response - The LLM response to validate
 * @param {string} question - The original question
 * @param {Array} documents - The source documents provided
 * @param {boolean} hasRelevantDocs - Whether relevant documents were found
 * @returns {Object} Validation result
 */
function validateResponse(response, question = '', documents = [], hasRelevantDocs = true) {
  const issues = [];
  const warnings = [];
  let goodScore = 0;

  // Skip validation for very short responses
  if (response.length < 10) {
    return {
      valid: true,
      score: 0,
      issues: [],
      warnings: [],
      recommendation: 'Response too short to validate meaningfully'
    };
  }

  // Check for hallucination patterns
  for (const { pattern, severity, description } of HALLUCINATION_PATTERNS) {
    const matches = response.match(pattern);
    if (matches) {
      const issue = {
        type: 'hallucination',
        severity,
        description,
        matches: matches.slice(0, 3), // Limit to first 3 matches
        pattern: pattern.toString()
      };

      if (severity === 'high') {
        issues.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  // Check for good patterns
  for (const { pattern, score, description } of GOOD_PATTERNS) {
    if (pattern.test(response)) {
      goodScore += score;
    }
  }

  // Special check: long response with no relevant documents
  if (!hasRelevantDocs && response.length > 100) {
    issues.push({
      type: 'no_source',
      severity: 'high',
      description: 'Long answer provided without relevant source documents',
      recommendation: 'Should say "I don\'t know" instead'
    });
  }

  // Special check: answering out-of-scope questions
  const outOfScopeKeywords = [
    'capital', 'country', 'cook', 'recipe', 'weather', 'sports',
    'movie', 'music', 'celebrity', 'politics', 'quantum', 'physics',
    'chemistry', 'biology', 'fix.*car', 'lose.*weight'
  ];

  const questionLower = question.toLowerCase();
  const isLikelyOutOfScope = outOfScopeKeywords.some(keyword =>
    new RegExp(keyword, 'i').test(questionLower)
  );

  const admitsLimitation = GOOD_PATTERNS[0].pattern.test(response);

  if (isLikelyOutOfScope && !admitsLimitation && response.length > 50) {
    issues.push({
      type: 'out_of_scope',
      severity: 'high',
      description: 'Appears to answer out-of-scope question without disclaimer',
      recommendation: 'Should decline or state limitation'
    });
  }

  // Calculate overall validity
  const hasHighSeverityIssues = issues.some(i => i.severity === 'high');
  const valid = !hasHighSeverityIssues;

  return {
    valid,
    score: goodScore,
    issues,
    warnings,
    confidence: calculateConfidence(goodScore, issues.length, warnings.length),
    recommendation: valid ? 'Response appears safe' : 'Response may contain hallucinations'
  };
}

/**
 * Calculate confidence score (0-100)
 */
function calculateConfidence(goodScore, issueCount, warningCount) {
  let confidence = 50; // Start at neutral
  confidence += Math.min(goodScore * 2, 30); // Up to +30 for good patterns
  confidence -= issueCount * 25; // -25 per issue
  confidence -= warningCount * 10; // -10 per warning
  return Math.max(0, Math.min(100, confidence));
}

/**
 * Filter/modify response if needed
 * @param {string} response - The LLM response
 * @param {Object} validation - Validation result
 * @returns {Object} Modified response and action taken
 */
function filterResponse(response, validation) {
  if (validation.valid) {
    return {
      response,
      action: 'none',
      modified: false
    };
  }

  // If high severity issues, replace with safe response
  const highSeverityIssues = validation.issues.filter(i => i.severity === 'high');
  if (highSeverityIssues.length > 0) {
    return {
      response: "I apologize, but I don't have sufficient information in the available documentation to answer this question accurately. Please refer to the official IIT Madras BS programme documentation or contact the programme administrators for accurate information.",
      action: 'replaced',
      modified: true,
      reason: 'High severity validation issues detected',
      issues: highSeverityIssues
    };
  }

  // For medium severity, add disclaimer
  if (validation.warnings.length > 0) {
    const disclaimer = "\n\n*Note: Please verify this information with official IIT Madras BS programme documentation.*";
    return {
      response: response + disclaimer,
      action: 'disclaimer_added',
      modified: true,
      reason: 'Medium severity warnings detected'
    };
  }

  return {
    response,
    action: 'none',
    modified: false
  };
}

/**
 * Generate validation report
 */
function generateReport(validations) {
  const total = validations.length;
  const valid = validations.filter(v => v.valid).length;
  const invalid = total - valid;
  const avgConfidence = validations.reduce((sum, v) => sum + v.confidence, 0) / total;

  const issueTypes = {};
  validations.forEach(v => {
    v.issues.forEach(issue => {
      issueTypes[issue.type] = (issueTypes[issue.type] || 0) + 1;
    });
  });

  return {
    total,
    valid,
    invalid,
    validityRate: (valid / total * 100).toFixed(2),
    avgConfidence: avgConfidence.toFixed(2),
    issueTypes,
    recommendation: invalid === 0 ? 'All responses validated successfully' :
                    invalid < total * 0.05 ? 'Good quality, minor improvements needed' :
                    'Significant validation issues detected'
  };
}

module.exports = {
  validateResponse,
  filterResponse,
  generateReport,
  HALLUCINATION_PATTERNS,
  GOOD_PATTERNS
};
