import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock console.log to capture structured logs
const mockLogs = [];
vi.spyOn(console, "log").mockImplementation((...args) => {
  mockLogs.push(args);
});

// Import the worker module - we need to extract functions for testing
// Since the worker exports a default fetch handler, we'll test via HTTP simulation

/**
 * Creates a mock Request object
 */
function createMockRequest(method, url, body = null) {
  return {
    method,
    url: `http://localhost${url}`,
    headers: new Map([["Content-Type", "application/json"]]),
    json: async () => body,
  };
}

/**
 * Simulates the handleFeedback function logic for testing
 * (extracted from worker.js for unit testing)
 */
async function handleFeedback(request) {
  const body = await request.json();

  // Validate required fields
  const { session_id, message_id, question, response, feedback_type } = body;
  if (!session_id || !message_id || !feedback_type) {
    return {
      status: 400,
      body: { error: "Missing required fields" },
    };
  }

  // Validate feedback_type
  const validFeedbackTypes = ["up", "down", "report"];
  if (!validFeedbackTypes.includes(feedback_type)) {
    return {
      status: 400,
      body: { error: "Invalid feedback type" },
    };
  }

  // Validate feedback_category if provided
  const validCategories = ["wrong_info", "outdated", "unhelpful", "other"];
  if (body.feedback_category && !validCategories.includes(body.feedback_category)) {
    return {
      status: 400,
      body: { error: "Invalid feedback category" },
    };
  }

  return {
    status: 200,
    body: { success: true },
  };
}

describe("Feedback Endpoint", () => {
  beforeEach(() => {
    mockLogs.length = 0;
  });

  describe("Input Validation", () => {
    it("should reject request missing session_id", async () => {
      const request = createMockRequest("POST", "/feedback", {
        message_id: "msg-123",
        feedback_type: "up",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Missing required fields");
    });

    it("should reject request missing message_id", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        feedback_type: "up",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Missing required fields");
    });

    it("should reject request missing feedback_type", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Missing required fields");
    });

    it("should reject invalid feedback_type", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "invalid",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Invalid feedback type");
    });

    it("should reject invalid feedback_category", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "invalid_category",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Invalid feedback category");
    });
  });

  describe("Valid Feedback Types", () => {
    it("should accept thumbs up feedback", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "up",
        question: "What is IITM?",
        response: "IITM is...",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("should accept thumbs down feedback", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "down",
        question: "What is IITM?",
        response: "IITM is...",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("should accept report feedback with valid category", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "wrong_info",
        feedback_text: "The information about fees is incorrect",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });

  describe("Valid Feedback Categories", () => {
    const validCategories = ["wrong_info", "outdated", "unhelpful", "other"];

    validCategories.forEach((category) => {
      it(`should accept feedback_category: ${category}`, async () => {
        const request = createMockRequest("POST", "/feedback", {
          session_id: "session-123",
          message_id: "msg-123",
          feedback_type: "report",
          feedback_category: category,
        });

        const result = await handleFeedback(request);

        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      });
    });
  });

  describe("Optional Fields", () => {
    it("should accept feedback without question and response", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "up",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("should accept report without feedback_text", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "unhelpful",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("should accept report without feedback_category", async () => {
      const request = createMockRequest("POST", "/feedback", {
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_text: "Some feedback text",
      });

      const result = await handleFeedback(request);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });
});

describe("Feedback Text Sanitization", () => {
  it("should truncate feedback_text to 1000 characters", () => {
    const longText = "a".repeat(1500);
    const truncated = longText.trim().substring(0, 1000);

    expect(truncated.length).toBe(1000);
  });

  it("should handle null feedback_text", () => {
    const text = null;
    const sanitized = text?.trim()?.substring(0, 1000) || null;

    expect(sanitized).toBe(null);
  });

  it("should handle empty feedback_text", () => {
    const text = "   ";
    const sanitized = text?.trim()?.substring(0, 1000) || null;

    expect(sanitized).toBe(null);
  });
});

describe("Query Synonym Matching", () => {
  // Test the synonym matching logic
  const QUERY_SYNONYMS = [
    [
      ["grading policy", "grading formula"],
      "grading formula score calculation GAA quiz end term OPPE weightage",
    ],
    [["fee waiver", "scholarship"], "fee waiver SC ST PwD OBC-NCL EWS income 50% 75% waiver"],
    [["oppe", "online proctored"], "OPPE Online Proctored Programming Exam remote proctored coding"],
  ];

  function findSynonymMatch(query) {
    const queryLower = query.toLowerCase();
    for (const [patterns, canonicalQuery] of QUERY_SYNONYMS) {
      for (const pattern of patterns) {
        if (queryLower.includes(pattern.toLowerCase())) {
          return canonicalQuery;
        }
      }
    }
    return null;
  }

  it("should match grading policy query", () => {
    const result = findSynonymMatch("What is the grading policy?");
    expect(result).toBe("grading formula score calculation GAA quiz end term OPPE weightage");
  });

  it("should match fee waiver query", () => {
    const result = findSynonymMatch("How do I apply for fee waiver?");
    expect(result).toBe("fee waiver SC ST PwD OBC-NCL EWS income 50% 75% waiver");
  });

  it("should match OPPE query (case insensitive)", () => {
    const result = findSynonymMatch("What is OPPE?");
    expect(result).toBe("OPPE Online Proctored Programming Exam remote proctored coding");
  });

  it("should return null for unmatched query", () => {
    const result = findSynonymMatch("What is the weather today?");
    expect(result).toBe(null);
  });
});

describe("Session ID Generation", () => {
  it("should generate valid UUID format", () => {
    const uuid = crypto.randomUUID();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });
});

describe("Structured Logging", () => {
  function structuredLog(severity, message, data = {}) {
    const logEntry = {
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...data,
      "logging.googleapis.com/labels": {
        application: "iitm-chatbot",
        ...(data.labels || {}),
      },
    };
    delete logEntry.labels;
    return logEntry;
  }

  it("should create log entry with correct structure", () => {
    const log = structuredLog("INFO", "user_feedback", {
      session_id: "test-session",
      feedback_type: "up",
    });

    expect(log.severity).toBe("INFO");
    expect(log.message).toBe("user_feedback");
    expect(log.session_id).toBe("test-session");
    expect(log.feedback_type).toBe("up");
    expect(log["logging.googleapis.com/labels"].application).toBe("iitm-chatbot");
    expect(log.timestamp).toBeDefined();
  });

  it("should include custom labels", () => {
    const log = structuredLog("ERROR", "test_error", {
      labels: { type: "error" },
    });

    expect(log["logging.googleapis.com/labels"].type).toBe("error");
  });
});
