import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleFeedback, structuredLog, findSynonymMatch, detectLanguage, translateMessage, getCannotAnswerMessage } from "./worker.js";

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

// ============================================================================
// Task 5: Standardized "Can't Answer" Message with Language Detection
// ============================================================================

describe("CANNOT_ANSWER_MESSAGE content (via getCannotAnswerMessage)", () => {
  // getCannotAnswerMessage returns the English message when history is empty
  // This tests the actual constant from worker.js

  it("should be a non-empty string", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  it("should contain apology", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("I'm sorry");
  });

  it("should mention rephrasing", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("rephrase");
  });

  it("should reference official website", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("official IITM BS degree program website");
  });

  it("should mention feedback option", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("feedback");
  });

  it("should include support email", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("support@study.iitm.ac.in");
  });

  it("should include support phone number", async () => {
    const message = await getCannotAnswerMessage([], {});
    expect(message).toContain("7850999966");
  });
});

describe("detectLanguage()", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return English when history is empty", async () => {
    const result = await detectLanguage([], {});
    expect(result).toBe("English");
  });

  it("should return English when history is null", async () => {
    const result = await detectLanguage(null, {});
    expect(result).toBe("English");
  });

  it("should return English when history is undefined", async () => {
    const result = await detectLanguage(undefined, {});
    expect(result).toBe("English");
  });

  it("should call API with correct structure for non-empty history", async () => {
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hindi" } }]
        })
      };
    });

    const history = [
      { role: "user", content: "नमस्ते, मुझे IITM के बारे में बताओ" },
      { role: "assistant", content: "IITM BS degree program..." }
    ];

    await detectLanguage(history, { OPENAI_API_KEY: "test-key" });

    expect(global.fetch).toHaveBeenCalled();
    expect(capturedBody.model).toBe("gpt-4o-mini");
    expect(capturedBody.messages[0].role).toBe("system");
    expect(capturedBody.messages[0].content).toContain("language detector");
  });

  it("should return detected language from API response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hindi" } }]
      })
    });

    const history = [{ role: "user", content: "कुछ भी" }];
    const result = await detectLanguage(history, { OPENAI_API_KEY: "test-key" });

    expect(result).toBe("Hindi");
  });

  it("should return English on API error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500
    });

    const history = [{ role: "user", content: "कुछ भी" }];
    const result = await detectLanguage(history, { OPENAI_API_KEY: "test-key" });

    expect(result).toBe("English");
  });

  it("should return English on fetch exception", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const history = [{ role: "user", content: "test" }];
    const result = await detectLanguage(history, { OPENAI_API_KEY: "test-key" });

    expect(result).toBe("English");
  });

  it("should use last 4 messages for detection", async () => {
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "English" } }]
        })
      };
    });

    const history = [
      { role: "user", content: "Message 1" },
      { role: "assistant", content: "Response 1" },
      { role: "user", content: "Message 2" },
      { role: "assistant", content: "Response 2" },
      { role: "user", content: "Message 3" },
      { role: "assistant", content: "Response 3" }
    ];

    await detectLanguage(history, { OPENAI_API_KEY: "test-key" });

    // Should only include last 4 messages
    const userMessage = capturedBody.messages[1].content;
    expect(userMessage).toContain("Message 2");
    expect(userMessage).toContain("Response 2");
    expect(userMessage).toContain("Message 3");
    expect(userMessage).toContain("Response 3");
    expect(userMessage).not.toContain("Message 1");
  });
});

describe("translateMessage()", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return original message when target language is English", async () => {
    const message = "Hello world";
    const result = await translateMessage(message, "English", {});
    expect(result).toBe(message);
  });

  it("should return original message when target language is english (lowercase)", async () => {
    const message = "Hello world";
    const result = await translateMessage(message, "english", {});
    expect(result).toBe(message);
  });

  it("should call API for non-English target language", async () => {
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "मैं माफी चाहता हूं..." } }]
        })
      };
    });

    await translateMessage("I'm sorry...", "Hindi", { OPENAI_API_KEY: "test-key" });

    expect(global.fetch).toHaveBeenCalled();
    expect(capturedBody.model).toBe("gpt-4o-mini");
    expect(capturedBody.messages[0].content).toContain("Hindi");
    expect(capturedBody.messages[1].content).toBe("I'm sorry...");
  });

  it("should return translated message from API", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Mensaje traducido" } }]
      })
    });

    const result = await translateMessage("Original message", "Spanish", { OPENAI_API_KEY: "test-key" });
    expect(result).toBe("Mensaje traducido");
  });

  it("should return original message on API error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500
    });

    const message = "Original message";
    const result = await translateMessage(message, "Hindi", { OPENAI_API_KEY: "test-key" });
    expect(result).toBe(message);
  });

  it("should return original message on fetch exception", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const message = "Original message";
    const result = await translateMessage(message, "Hindi", { OPENAI_API_KEY: "test-key" });
    expect(result).toBe(message);
  });
});

describe("getCannotAnswerMessage()", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return English message for empty history", async () => {
    const result = await getCannotAnswerMessage([], {});
    // Verify it returns the standardized message (not translated)
    expect(result).toContain("I'm sorry");
    expect(result).toContain("support@study.iitm.ac.in");
  });

  it("should return English message when language is detected as English", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "English" } }]
      })
    });

    const history = [{ role: "user", content: "What is IITM?" }];
    const result = await getCannotAnswerMessage(history, { OPENAI_API_KEY: "test-key" });

    // Verify it returns the standardized message (not translated since English)
    expect(result).toContain("I'm sorry");
    expect(result).toContain("support@study.iitm.ac.in");
  });

  it("should return translated message for non-English history", async () => {
    // First call: detect language -> Hindi
    // Second call: translate message -> translated text
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "Hindi" } }]
          })
        };
      } else {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "मुझे खेद है, मेरे पास इस प्रश्न का उत्तर देने की जानकारी नहीं है।" } }]
          })
        };
      }
    });

    const history = [{ role: "user", content: "IITM क्या है?" }];
    const result = await getCannotAnswerMessage(history, { OPENAI_API_KEY: "test-key" });

    expect(callCount).toBe(2); // Both detectLanguage and translateMessage called
    expect(result).toBe("मुझे खेद है, मेरे पास इस प्रश्न का उत्तर देने की जानकारी नहीं है।");
  });

  it("should make two separate API calls for safety", async () => {
    const capturedBodies = [];
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: capturedBodies.length === 1 ? "Tamil" : "Translated text" } }]
        })
      };
    });

    const history = [{ role: "user", content: "IITM என்றால் என்ன?" }];
    await getCannotAnswerMessage(history, { OPENAI_API_KEY: "test-key" });

    expect(capturedBodies.length).toBe(2);

    // First call: language detection (contains user content)
    expect(capturedBodies[0].messages[0].content).toContain("language detector");

    // Second call: translation (contains only standardized message, no user content)
    expect(capturedBodies[1].messages[0].content).toContain("translator");
    // Verify the translation receives the standardized message (not user content)
    expect(capturedBodies[1].messages[1].content).toContain("I'm sorry");
    expect(capturedBodies[1].messages[1].content).toContain("support@study.iitm.ac.in");
  });
});
