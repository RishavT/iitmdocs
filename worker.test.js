import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReadableStream } from "node:stream/web";

// Mock the worker module
const mockEnv = {
  WEAVIATE_URL: "https://test-weaviate.com",
  WEAVIATE_API_KEY: "test-weaviate-key",
  OPENAI_API_KEY: "test-openai-key",
  GITHUB_REPO_URL: "https://github.com/test/repo",
  CHAT_API_ENDPOINT: "https://api.openai.com/v1/chat/completions",
  CHAT_MODEL: "gpt-4o-mini",
  EMBEDDING_PROVIDER: "openai",
};

// Mock fetch for Weaviate and OpenAI responses
global.fetch = vi.fn();

// Helper to create a proper Request object
function createRequest(url, options = {}) {
  const body = options.body || null;
  return new Request(url, {
    ...options,
    body,
  });
}

// Import worker after mocks are set up
const workerModule = await import("./worker.js");
const worker = workerModule.default;

describe("Worker - Conversation History", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /answer - Basic Functionality", () => {
    it("should accept request without history (backward compatibility)", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "What is the registration process?",
          ndocs: 5,
        }),
      });

      // Mock Weaviate response
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Get: {
              Document: [
                {
                  filename: "registration.md",
                  filepath: "src/registration.md",
                  content: "Registration process details...",
                  file_size: 1000,
                  _additional: { distance: 0.1 },
                },
              ],
            },
          },
        }),
      });

      // Mock OpenAI streaming response with ReadableStream
      const mockReadableStream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Response"}}]}\n\n'));
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
      });

      const mockAssets = {
        fetch: vi.fn(),
      };

      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Consume the stream to ensure async operations complete
      const reader = response.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
      }

      // Verify fetch was called twice (Weaviate + OpenAI)
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Verify OpenAI was called with correct message structure (no history)
      const openAICall = global.fetch.mock.calls.find((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || call[0];
        return typeof url === "string" && url.includes("chat/completions");
      });

      if (!openAICall) {
        console.log("All fetch calls:", global.fetch.mock.calls.map((c, i) => ({ index: i, arg0: c[0], arg0Type: typeof c[0], url: c[0]?.url })));
      }
      expect(openAICall).toBeDefined();

      const openAIBody = JSON.parse(openAICall[1].body);
      expect(openAIBody.messages).toHaveLength(3); // system, context, question
      expect(openAIBody.messages[0].role).toBe("system");
      expect(openAIBody.messages[1].role).toBe("assistant");
      expect(openAIBody.messages[2].role).toBe("user");
      expect(openAIBody.messages[2].content).toBe("What is the registration process?");
    });

    it("should accept request with empty history array", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "What is the registration process?",
          ndocs: 5,
          history: [],
        }),
      });

      // Mock responses
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { Get: { Document: [] } } }),
      });

      const mockReadableStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);

      // Consume the stream to ensure async operations complete
      const reader = response.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
      }

      const openAICall = global.fetch.mock.calls.find((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || "";
        return url.includes("chat/completions");
      });
      const openAIBody = JSON.parse(openAICall[1].body);
      expect(openAIBody.messages).toHaveLength(3); // No history added
    });

    it("should include conversation history in API call", async () => {
      const conversationHistory = [
        { role: "user", content: "What is the course structure?" },
        { role: "assistant", content: "The course has 4 levels..." },
        { role: "user", content: "How many courses per term?" },
        { role: "assistant", content: "You can take 2-4 courses per term." },
      ];

      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "Can I take more courses?",
          ndocs: 5,
          history: conversationHistory,
        }),
      });

      // Mock responses
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Get: {
              Document: [
                {
                  filename: "courses.md",
                  content: "Course details...",
                  _additional: { distance: 0.1 },
                },
              ],
            },
          },
        }),
      });

      const mockReadableStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);

      // Consume the stream to ensure async operations complete
      const reader = response.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
      }

      // Verify history was included in OpenAI call
      const openAICall = global.fetch.mock.calls.find((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || "";
        return url.includes("chat/completions");
      });
      const openAIBody = JSON.parse(openAICall[1].body);

      // Should have: system, context, 4 history messages, current question = 7 total
      expect(openAIBody.messages).toHaveLength(7);
      expect(openAIBody.messages[2].role).toBe("user");
      expect(openAIBody.messages[2].content).toBe("What is the course structure?");
      expect(openAIBody.messages[3].role).toBe("assistant");
      expect(openAIBody.messages[3].content).toBe("The course has 4 levels...");
      expect(openAIBody.messages[6].content).toBe("Can I take more courses?");
    });
  });

  describe("POST /answer - History Validation", () => {
    it("should filter out invalid history messages", async () => {
      const invalidHistory = [
        { role: "user", content: "Valid message" },
        { role: "assistant", content: "Valid response" },
        { role: "user" }, // Missing content
        { content: "Missing role" }, // Missing role
        { role: "user", content: 123 }, // Non-string content
        null,
        undefined,
        "not an object",
      ];

      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "Test question?",
          ndocs: 5,
          history: invalidHistory,
        }),
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { Get: { Document: [] } } }),
      });

      const mockReadableStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);

      // Consume the stream to ensure async operations complete
      const reader = response.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
      }

      // Verify only valid messages were included
      const openAICall = global.fetch.mock.calls.find((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || "";
        return url.includes("chat/completions");
      });
      const openAIBody = JSON.parse(openAICall[1].body);

      // Should have: system, context, 2 valid history messages, current question = 5 total
      expect(openAIBody.messages).toHaveLength(5);
      expect(openAIBody.messages[2].content).toBe("Valid message");
      expect(openAIBody.messages[3].content).toBe("Valid response");
    });

    it("should handle non-array history gracefully", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "Test question?",
          ndocs: 5,
          history: "not an array",
        }),
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { Get: { Document: [] } } }),
      });

      const mockReadableStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);

      // Consume the stream to ensure async operations complete
      const reader = response.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
      }

      // Should work with no history
      const openAICall = global.fetch.mock.calls.find((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || "";
        return url.includes("chat/completions");
      });
      const openAIBody = JSON.parse(openAICall[1].body);
      expect(openAIBody.messages).toHaveLength(3); // No history added
    });
  });

  describe("POST /answer - Error Handling", () => {
    it("should return 400 if question is missing", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ndocs: 5,
          history: [],
        }),
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing "q" parameter');
    });

    it("should validate ndocs parameter", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: "Test?",
          ndocs: 100, // Too high
        }),
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Invalid "ndocs" parameter');
    });
  });

  describe("CORS Handling", () => {
    it("should handle OPTIONS preflight request", async () => {
      const request = createRequest("http://localhost/answer", {
        method: "OPTIONS",
      });

      const mockAssets = { fetch: vi.fn() };
      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    });
  });

  describe("Static Asset Handling", () => {
    it("should serve static assets for non-POST /answer requests", async () => {
      const request = createRequest("http://localhost/qa.html", {
        method: "GET",
      });

      const mockAssetResponse = new Response("HTML content", { status: 200 });
      const mockAssets = {
        fetch: vi.fn().mockResolvedValue(mockAssetResponse),
      };

      const response = await worker.fetch(request, { ...mockEnv, ASSETS: mockAssets });

      expect(mockAssets.fetch).toHaveBeenCalledWith(request);
      expect(response).toBe(mockAssetResponse);
    });
  });
});
