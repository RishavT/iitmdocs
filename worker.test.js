import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleFeedback, structuredLog, findSynonymMatch } from "./worker.js";

// Mock console.log to capture structured logs
const mockLogs = [];
vi.spyOn(console, "log").mockImplementation((...args) => {
  mockLogs.push(args);
});

/**
 * Creates a mock Request object that mimics the Fetch API Request
 */
function createMockRequest(body) {
  return {
    json: async () => body,
  };
}

/**
 * Helper to parse Response body as JSON
 */
async function parseResponse(response) {
  const text = await response.text();
  return JSON.parse(text);
}

describe("Feedback Endpoint - handleFeedback()", () => {
  beforeEach(() => {
    mockLogs.length = 0;
  });

  describe("Input Validation", () => {
    it("should reject request missing session_id", async () => {
      const request = createMockRequest({
        message_id: "msg-123",
        feedback_type: "up",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe("Missing required fields");
    });

    it("should reject request missing message_id", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        feedback_type: "up",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe("Missing required fields");
    });

    it("should reject request missing feedback_type", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe("Missing required fields");
    });

    it("should reject invalid feedback_type", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "invalid",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid feedback type");
    });

    it("should reject invalid feedback_category", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "invalid_category",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid feedback category");
    });
  });

  describe("Valid Feedback Types", () => {
    it("should accept thumbs up feedback", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "up",
        question: "What is IITM?",
        response: "IITM is...",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should accept thumbs down feedback", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "down",
        question: "What is IITM?",
        response: "IITM is...",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should accept report feedback with valid category", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "wrong_info",
        feedback_text: "The information about fees is incorrect",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe("Valid Feedback Categories", () => {
    const validCategories = ["wrong_info", "outdated", "unhelpful", "other"];

    validCategories.forEach((category) => {
      it(`should accept feedback_category: ${category}`, async () => {
        const request = createMockRequest({
          session_id: "session-123",
          message_id: "msg-123",
          feedback_type: "report",
          feedback_category: category,
        });

        const response = await handleFeedback(request);
        const body = await parseResponse(response);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
      });
    });
  });

  describe("Optional Fields", () => {
    it("should accept feedback without question and response", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "up",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should accept report without feedback_text", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_category: "unhelpful",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should accept report without feedback_category", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_text: "Some feedback text",
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe("Feedback Text Sanitization", () => {
    it("should truncate feedback_text to 1000 characters in logs", async () => {
      const longText = "a".repeat(1500);
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_text: longText,
      });

      await handleFeedback(request);

      // Find the log entry for user_feedback
      const feedbackLog = mockLogs.find((log) => {
        try {
          const parsed = JSON.parse(log[0]);
          return parsed.message === "user_feedback";
        } catch {
          return false;
        }
      });

      expect(feedbackLog).toBeDefined();
      const logEntry = JSON.parse(feedbackLog[0]);
      expect(logEntry.feedback_text.length).toBe(1000);
    });

    it("should handle null feedback_text", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "up",
        feedback_text: null,
      });

      const response = await handleFeedback(request);
      const body = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should trim whitespace from feedback_text", async () => {
      const request = createMockRequest({
        session_id: "session-123",
        message_id: "msg-123",
        feedback_type: "report",
        feedback_text: "   some text with spaces   ",
      });

      await handleFeedback(request);

      const feedbackLog = mockLogs.find((log) => {
        try {
          const parsed = JSON.parse(log[0]);
          return parsed.message === "user_feedback";
        } catch {
          return false;
        }
      });

      const logEntry = JSON.parse(feedbackLog[0]);
      expect(logEntry.feedback_text).toBe("some text with spaces");
    });
  });
});

describe("Query Synonym Matching - findSynonymMatch()", () => {
  it("should match grading policy query", () => {
    const result = findSynonymMatch("What is the grading policy?");
    expect(result).toContain("grading");
  });

  it("should match fee waiver query", () => {
    const result = findSynonymMatch("How do I apply for fee waiver?");
    expect(result).toContain("fee waiver");
  });

  it("should match OPPE query (case insensitive)", () => {
    const result = findSynonymMatch("What is OPPE?");
    expect(result).toContain("OPPE");
  });

  it("should return null for unmatched query", () => {
    const result = findSynonymMatch("What is the weather today?");
    expect(result).toBe(null);
  });

  it("should match placement query", () => {
    const result = findSynonymMatch("What is the average salary after placement?");
    expect(result).toContain("placement");
  });

  it("should match eligibility query", () => {
    const result = findSynonymMatch("What is the eligibility for admission?");
    expect(result).toContain("eligibility");
  });
});

describe("Structured Logging - structuredLog()", () => {
  beforeEach(() => {
    mockLogs.length = 0;
  });

  it("should create log entry with correct structure", () => {
    structuredLog("INFO", "test_message", {
      session_id: "test-session",
      feedback_type: "up",
    });

    expect(mockLogs.length).toBe(1);
    const logEntry = JSON.parse(mockLogs[0][0]);

    expect(logEntry.severity).toBe("INFO");
    expect(logEntry.message).toBe("test_message");
    expect(logEntry.session_id).toBe("test-session");
    expect(logEntry.feedback_type).toBe("up");
    expect(logEntry["logging.googleapis.com/labels"].application).toBe("iitm-chatbot");
    expect(logEntry.timestamp).toBeDefined();
  });

  it("should include custom labels", () => {
    structuredLog("ERROR", "test_error", {
      labels: { type: "error" },
    });

    const logEntry = JSON.parse(mockLogs[0][0]);
    expect(logEntry["logging.googleapis.com/labels"].type).toBe("error");
  });

  it("should handle different severity levels", () => {
    const severities = ["DEBUG", "INFO", "WARNING", "ERROR"];

    severities.forEach((severity) => {
      mockLogs.length = 0;
      structuredLog(severity, "test", {});

      const logEntry = JSON.parse(mockLogs[0][0]);
      expect(logEntry.severity).toBe(severity);
    });
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
