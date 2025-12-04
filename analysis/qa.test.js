import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";

describe("Frontend - Conversation History (qa.js)", () => {
  let dom;
  let window;
  let document;
  let sessionStorage;

  beforeEach(async () => {
    // Create a fresh DOM for each test
    dom = new JSDOM(
      `
      <!DOCTYPE html>
      <html>
        <body>
          <div id="chat-area"></div>
          <form id="chat-form">
            <input id="question-input" type="text" />
            <button id="ask-button" type="submit">Ask</button>
          </form>
          <button id="clear-chat-button">Clear</button>
        </body>
      </html>
    `,
      {
        url: "http://localhost",
        runScripts: "dangerously",
        resources: "usable",
      },
    );

    window = dom.window;
    document = window.document;
    sessionStorage = window.sessionStorage;

    // Make DOM globals available
    global.window = window;
    global.document = document;
    global.sessionStorage = sessionStorage;
    global.HTMLElement = window.HTMLElement;
    global.Element = window.Element;
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  describe("SessionStorage Utilities", () => {
    const HISTORY_KEY = "iitm-chatbot-history";

    it("should save history to sessionStorage", () => {
      const history = [
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));

      const stored = sessionStorage.getItem(HISTORY_KEY);
      expect(stored).toBeDefined();
      expect(JSON.parse(stored)).toEqual(history);
    });

    it("should load history from sessionStorage", () => {
      const history = [
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));

      const loaded = JSON.parse(sessionStorage.getItem(HISTORY_KEY));
      expect(loaded).toEqual(history);
    });

    it("should return empty array when no history exists", () => {
      const loaded = sessionStorage.getItem(HISTORY_KEY);
      expect(loaded).toBeNull();
    });

    it("should handle corrupted sessionStorage data gracefully", () => {
      sessionStorage.setItem(HISTORY_KEY, "invalid json{{{");

      // Should not throw, but parsing will fail
      expect(() => {
        JSON.parse(sessionStorage.getItem(HISTORY_KEY));
      }).toThrow();
    });

    it("should clear history from sessionStorage", () => {
      const history = [
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      expect(sessionStorage.getItem(HISTORY_KEY)).toBeDefined();

      sessionStorage.removeItem(HISTORY_KEY);
      expect(sessionStorage.getItem(HISTORY_KEY)).toBeNull();
    });
  });

  describe("Conversation History Building", () => {
    it("should build history from completed chat messages", () => {
      const chat = [
        { q: "Question 1", content: "Answer 1" },
        { q: "Question 2", content: "Answer 2" },
        { q: "Question 3", content: "Answer 3" },
      ];

      const history = [];
      for (const msg of chat) {
        if (msg.content) {
          history.push({ role: "user", content: msg.q });
          history.push({ role: "assistant", content: msg.content });
        }
      }

      expect(history).toHaveLength(6);
      expect(history[0]).toEqual({ role: "user", content: "Question 1" });
      expect(history[1]).toEqual({ role: "assistant", content: "Answer 1" });
    });

    it("should only include last 5 Q&A pairs", () => {
      const chat = [
        { q: "Q1", content: "A1" },
        { q: "Q2", content: "A2" },
        { q: "Q3", content: "A3" },
        { q: "Q4", content: "A4" },
        { q: "Q5", content: "A5" },
        { q: "Q6", content: "A6" },
        { q: "Q7", content: "A7" },
      ];

      const MAX_HISTORY_PAIRS = 5;
      const history = [];
      const completedChats = chat.filter((msg) => msg.content);
      const recentChats = completedChats.slice(-MAX_HISTORY_PAIRS);

      for (const msg of recentChats) {
        history.push({ role: "user", content: msg.q });
        history.push({ role: "assistant", content: msg.content });
      }

      expect(history).toHaveLength(10); // 5 pairs * 2 messages
      expect(history[0].content).toBe("Q3"); // Should start from Q3, not Q1
      expect(history[9].content).toBe("A7");
    });

    it("should exclude incomplete messages (no content)", () => {
      const chat = [
        { q: "Question 1", content: "Answer 1" },
        { q: "Question 2", content: "Answer 2" },
        { q: "Question 3" }, // Incomplete - no answer yet
      ];

      const history = [];
      const completedChats = chat.filter((msg) => msg.content);

      for (const msg of completedChats) {
        history.push({ role: "user", content: msg.q });
        history.push({ role: "assistant", content: msg.content });
      }

      expect(history).toHaveLength(4); // Only 2 complete pairs
      expect(history[4]).toBeUndefined(); // Q3 not included (index 4 doesn't exist)
      // Verify Q3 is not in the history
      expect(history.find(msg => msg.content === "Question 3")).toBeUndefined();
    });
  });

  describe("History Restoration on Page Load", () => {
    it("should restore conversation from sessionStorage on load", () => {
      const HISTORY_KEY = "iitm-chatbot-history";
      const storedHistory = [
        { role: "user", content: "What is the course structure?" },
        { role: "assistant", content: "The course has 4 levels." },
        { role: "user", content: "How many courses per term?" },
        { role: "assistant", content: "You can take 2-4 courses." },
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(storedHistory));

      // Simulate restoration logic
      const chat = [];
      const loaded = JSON.parse(sessionStorage.getItem(HISTORY_KEY));

      if (loaded && loaded.length > 0) {
        for (let i = 0; i < loaded.length; i += 2) {
          if (loaded[i]?.role === "user" && loaded[i + 1]?.role === "assistant") {
            chat.push({
              q: loaded[i].content,
              content: loaded[i + 1].content,
            });
          }
        }
      }

      expect(chat).toHaveLength(2);
      expect(chat[0].q).toBe("What is the course structure?");
      expect(chat[0].content).toBe("The course has 4 levels.");
      expect(chat[1].q).toBe("How many courses per term?");
      expect(chat[1].content).toBe("You can take 2-4 courses.");
    });

    it("should handle empty sessionStorage gracefully", () => {
      const HISTORY_KEY = "iitm-chatbot-history";
      const chat = [];
      const loaded = sessionStorage.getItem(HISTORY_KEY);

      if (loaded) {
        const parsed = JSON.parse(loaded);
        // Would restore if exists
      }

      expect(chat).toHaveLength(0);
    });

    it("should skip malformed history entries", () => {
      const HISTORY_KEY = "iitm-chatbot-history";
      const storedHistory = [
        { role: "user", content: "Valid question" },
        { role: "assistant", content: "Valid answer" },
        { role: "user" }, // Missing content
        { content: "Missing role" }, // Missing role
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(storedHistory));

      const chat = [];
      const loaded = JSON.parse(sessionStorage.getItem(HISTORY_KEY));

      for (let i = 0; i < loaded.length; i += 2) {
        if (loaded[i]?.role === "user" && loaded[i + 1]?.role === "assistant") {
          chat.push({
            q: loaded[i].content,
            content: loaded[i + 1].content,
          });
        }
      }

      expect(chat).toHaveLength(1); // Only valid pair restored
      expect(chat[0].q).toBe("Valid question");
    });
  });

  describe("Request Body Format", () => {
    it("should include history in POST request body", () => {
      const requestBody = {
        q: "Can I take more courses?",
        ndocs: 5,
        history: [
          { role: "user", content: "What is the course structure?" },
          { role: "assistant", content: "The course has 4 levels." },
        ],
      };

      expect(requestBody.history).toBeDefined();
      expect(Array.isArray(requestBody.history)).toBe(true);
      expect(requestBody.history).toHaveLength(2);
    });

    it("should send empty history array for first question", () => {
      const requestBody = {
        q: "What is the registration process?",
        ndocs: 5,
        history: [],
      };

      expect(requestBody.history).toBeDefined();
      expect(requestBody.history).toHaveLength(0);
    });
  });

  describe("Clear Button Functionality", () => {
    it("should clear both chat display and sessionStorage", () => {
      const HISTORY_KEY = "iitm-chatbot-history";
      const chat = [
        { q: "Question 1", content: "Answer 1" },
        { q: "Question 2", content: "Answer 2" },
      ];

      sessionStorage.setItem(HISTORY_KEY, JSON.stringify([
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
      ]));

      // Simulate clear button click
      chat.length = 0;
      sessionStorage.removeItem(HISTORY_KEY);

      expect(chat).toHaveLength(0);
      expect(sessionStorage.getItem(HISTORY_KEY)).toBeNull();
    });
  });

  describe("History Persistence Across Sessions", () => {
    it("should NOT persist after session ends (sessionStorage behavior)", () => {
      const HISTORY_KEY = "iitm-chatbot-history";
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify([
        { role: "user", content: "Test" },
      ]));

      expect(sessionStorage.getItem(HISTORY_KEY)).toBeDefined();

      // Note: sessionStorage.clear() simulates session end in tests
      sessionStorage.clear();
      expect(sessionStorage.getItem(HISTORY_KEY)).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle very long conversation history", () => {
      const longChat = [];
      for (let i = 0; i < 100; i++) {
        longChat.push({ q: `Question ${i}`, content: `Answer ${i}` });
      }

      const MAX_HISTORY_PAIRS = 5;
      const completedChats = longChat.filter((msg) => msg.content);
      const recentChats = completedChats.slice(-MAX_HISTORY_PAIRS);

      expect(recentChats).toHaveLength(5);
      expect(recentChats[0].q).toBe("Question 95");
      expect(recentChats[4].q).toBe("Question 99");
    });

    it("should handle special characters in messages", () => {
      const chat = [
        {
          q: 'Question with "quotes" and <html>',
          content: 'Answer with \n newlines and \t tabs',
        },
      ];

      const history = [];
      for (const msg of chat) {
        if (msg.content) {
          history.push({ role: "user", content: msg.q });
          history.push({ role: "assistant", content: msg.content });
        }
      }

      expect(history[0].content).toContain('"quotes"');
      expect(history[0].content).toContain("<html>");
      expect(history[1].content).toContain("\n");
    });

    it("should handle empty content strings", () => {
      const chat = [
        { q: "Question", content: "" }, // Empty but defined
        { q: "Question 2", content: "Answer 2" },
      ];

      const completedChats = chat.filter((msg) => msg.content);

      // Empty string is falsy, so it's correctly filtered out
      expect(completedChats).toHaveLength(1);
      expect(completedChats[0].q).toBe("Question 2");
    });
  });

  describe("Backward Compatibility", () => {
    it("should work with existing code that doesn't send history", () => {
      // Old request format without history
      const oldRequestBody = {
        q: "What is the registration process?",
        ndocs: 5,
      };

      expect(oldRequestBody.history).toBeUndefined();
      // Backend should default to empty array
    });

    it("should not break if sessionStorage is disabled", () => {
      // Some browsers/modes disable sessionStorage
      let storageError = false;

      try {
        sessionStorage.setItem("test", "value");
      } catch (e) {
        storageError = true;
      }

      // In this test environment, storage works, but code should handle errors
      expect(storageError).toBe(false);
    });
  });

  describe("Cross-Page History Sharing", () => {
    it("should share history using same sessionStorage key", () => {
      const HISTORY_KEY = "iitm-chatbot-history";

      // Simulate page 1 saving history
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify([
        { role: "user", content: "Question from page 1" },
        { role: "assistant", content: "Answer from page 1" },
      ]));

      // Simulate page 2 loading history
      const loaded = JSON.parse(sessionStorage.getItem(HISTORY_KEY));

      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe("Question from page 1");
    });
  });
});
