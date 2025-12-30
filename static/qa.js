import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2";
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";

const chatArea = document.getElementById("chat-area");
const chatForm = document.getElementById("chat-form");
const askButton = document.getElementById("ask-button");
const questionInput = document.getElementById("question-input");
const clearChatButton = document.getElementById("clear-chat-button");
const minWordsHint = document.getElementById("min-words-hint");
const usernameInput = document.getElementById("username-input");

const chat = [];
const MIN_WORD_COUNT = 5;
const WELCOME_MESSAGE = `👋 **Welcome to the IITM BS Degree Program Assistant!**

I can help you with questions about:
- Admission pathways and eligibility
- Qualifier exam preparation and fees
- Course registration steps
- And more!

Please type your question below (minimum 5 words).`;
const SESSION_ID_KEY = "iitm-chatbot-session-id";
const USERNAME_KEY = "iitm-chatbot-username";

/**
 * Gets or creates a unique session ID stored in localStorage.
 * This persists across page reloads and tabs for the same browser.
 * @returns {string} - The session ID (UUID format)
 */
function getOrCreateSessionId() {
  let sessionId = localStorage.getItem(SESSION_ID_KEY);
  if (!sessionId) {
    // Generate a UUID v4
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_ID_KEY, sessionId);
    console.log("[Session] Created new session ID:", sessionId);
  }
  return sessionId;
}

// Initialize session ID on page load
const sessionId = getOrCreateSessionId();

// Initialize username: URL param takes priority, then localStorage
const urlParams = new URLSearchParams(window.location.search);
const urlUsername = urlParams.get("username");
if (urlUsername) {
  usernameInput.value = urlUsername;
  localStorage.setItem(USERNAME_KEY, urlUsername);
} else {
  usernameInput.value = localStorage.getItem(USERNAME_KEY) || "";
}
usernameInput.addEventListener("input", () => {
  localStorage.setItem(USERNAME_KEY, usernameInput.value);
});

// Feedback categories for the report form
const FEEDBACK_CATEGORIES = [
  { value: "wrong_info", label: "Wrong information" },
  { value: "outdated", label: "Outdated information" },
  { value: "unhelpful", label: "Unhelpful response" },
  { value: "other", label: "Other" },
];

/**
 * Submits feedback to the backend
 * @param {Object} feedbackData - The feedback data to submit
 * @throws {Error} If the request fails or returns non-OK status
 */
async function submitFeedback(feedbackData) {
  const response = await fetch("./feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      ...feedbackData,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Counts words in a string (splits by whitespace)
 * @param {string} text - Text to count words in
 * @returns {number} - Number of words
 */
function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Updates the ask button state and hint visibility based on word count
 */
function updateInputValidation() {
  const wordCount = countWords(questionInput.value);
  const isValid = wordCount >= MIN_WORD_COUNT;

  askButton.disabled = !isValid;
  minWordsHint.style.display = isValid ? "none" : "block";
}

// Add input listener for real-time validation
questionInput.addEventListener("input", updateInputValidation);
const marked = new Marked();
const HISTORY_KEY = "iitm-chatbot-history";
const MAX_HISTORY_PAIRS = 5;
let requestCounter = 0; // Track requests to prevent race conditions

/**
 * Loads conversation history from sessionStorage
 * @returns {Array} Array of message objects with role and content
 */
function loadHistoryFromStorage() {
  try {
    const stored = sessionStorage.getItem(HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Failed to load history from sessionStorage:", e);
    return [];
  }
}

/**
 * Saves conversation history to sessionStorage
 * @param {Array} history - Array of message objects to save
 */
function saveHistoryToStorage(history) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save history to sessionStorage:", e);
  }
}

/**
 * Builds conversation history from completed chat messages
 * Only includes last MAX_HISTORY_PAIRS Q&A pairs
 * @returns {Array} Array of message objects with role and content
 */
function buildConversationHistory() {
  // Build history from last N Q&A pairs (excluding current incomplete exchange)
  const history = [];
  const completedChats = chat.filter((msg) => msg.content); // Only completed Q&A pairs
  const recentChats = completedChats.slice(-MAX_HISTORY_PAIRS);

  for (const msg of recentChats) {
    history.push({ role: "user", content: msg.q });
    history.push({ role: "assistant", content: msg.content });
  }

  return history;
}

// Auto-scroll state - must be declared before redraw() is called
let autoScroll = true;
chatArea.addEventListener("scroll", () => {
  const atBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 10;
  autoScroll = atBottom;
});

// Initialize chat from sessionStorage on page load
const storedHistory = loadHistoryFromStorage();
if (storedHistory.length > 0) {
  // Rebuild chat array from stored history
  for (let i = 0; i < storedHistory.length; i += 2) {
    if (storedHistory[i]?.role === "user" && storedHistory[i + 1]?.role === "assistant") {
      chat.push({
        q: storedHistory[i].content,
        content: storedHistory[i + 1].content,
      });
    }
  }
}
// Always call redraw - shows welcome message if empty, or restored conversation
redraw();
if (chat.length > 0) {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function redraw() {
  // Show welcome message if chat is empty
  if (chat.length === 0) {
    render(
      html`<div class="my-3">${unsafeHTML(marked.parse(WELCOME_MESSAGE))}</div>`,
      chatArea,
    );
    return;
  }

  render(
    chat.map(
      ({ q, content, tools, messageId, feedback, showReportForm }) => html`
        <div class="bg-light border rounded p-2">${q}</div>
        <div class="my-3">
          ${content ? unsafeHTML(marked.parse(content)) : html`<span class="ms-4 spinner-border"></span>`}
        </div>
        ${tools
          ? html`<details class="my-3 px-2" open>
              <summary>References</summary>
              <ul class="list-unstyled ms-3 py-1">
                ${tools?.map?.(({ args }) => {
                  const { name, link } = JSON.parse(args);
                  return html`<li><a href="${link}" target="_blank">${name}</a></li>`;
                })}
              </ul>
            </details>`
          : ""}
        ${content && messageId
          ? html`
              ${feedback === "submitted"
                ? html`<div class="feedback-thanks"><i class="bi bi-check-circle"></i> Thanks for your feedback!</div>`
                : html`
                    <div class="feedback-buttons">
                      <button
                        class="feedback-btn ${feedback === "up" ? "active-up" : ""}"
                        title="Helpful"
                        @click=${() => handleThumbsFeedback(messageId, "up", q, content)}
                      >
                        <i class="bi bi-hand-thumbs-up"></i>
                      </button>
                      <button
                        class="feedback-btn ${feedback === "down" ? "active-down" : ""}"
                        title="Not helpful"
                        @click=${() => handleThumbsFeedback(messageId, "down", q, content)}
                      >
                        <i class="bi bi-hand-thumbs-down"></i>
                      </button>
                      <button
                        class="feedback-btn report"
                        title="Report incorrect answer"
                        @click=${() => toggleReportForm(messageId)}
                      >
                        <i class="bi bi-flag"></i> Report
                      </button>
                    </div>
                    ${showReportForm
                      ? html`
                          <div class="feedback-form">
                            <select id="feedback-category-${messageId}">
                              <option value="">Select issue type...</option>
                              ${FEEDBACK_CATEGORIES.map(
                                (cat) => html`<option value="${cat.value}">${cat.label}</option>`,
                              )}
                            </select>
                            <textarea
                              id="feedback-text-${messageId}"
                              placeholder="Optional: Tell us more about the issue..."
                              maxlength="1000"
                            ></textarea>
                            <div class="feedback-form-buttons">
                              <button class="btn btn-sm btn-outline-secondary" @click=${() => toggleReportForm(messageId)}>
                                Cancel
                              </button>
                              <button
                                class="btn btn-sm btn-warning"
                                @click=${() => handleReportSubmit(messageId, q, content)}
                              >
                                Submit Report
                              </button>
                            </div>
                          </div>
                        `
                      : ""}
                  `}
            `
          : ""}
      `,
    ),
    chatArea,
  );
  if (autoScroll) chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Handles thumbs up/down feedback
 * Includes race condition protection and error handling
 */
async function handleThumbsFeedback(messageId, type, question, response) {
  const msg = chat.find((m) => m.messageId === messageId);
  if (!msg) return;

  // Race condition protection: prevent duplicate submissions
  if (msg.feedback && msg.feedback !== "error") return;

  const previousFeedback = msg.feedback;
  msg.feedback = type;
  redraw();

  try {
    await submitFeedback({
      message_id: messageId,
      question,
      response,
      feedback_type: type,
      feedback_category: null,
      feedback_text: null,
    });
  } catch (error) {
    // Reset feedback state on error
    msg.feedback = previousFeedback || "error";
    redraw();
    console.error("Failed to submit feedback:", error);
  }
}

/**
 * Toggles the report form visibility
 */
function toggleReportForm(messageId) {
  const msg = chat.find((m) => m.messageId === messageId);
  if (msg) {
    msg.showReportForm = !msg.showReportForm;
    redraw();
  }
}

/**
 * Handles report form submission
 * Includes error handling and submission state management
 */
async function handleReportSubmit(messageId, question, response) {
  const categorySelect = document.getElementById(`feedback-category-${messageId}`);
  const textArea = document.getElementById(`feedback-text-${messageId}`);
  const category = categorySelect?.value || null;
  const text = textArea?.value?.trim() || null;

  const msg = chat.find((m) => m.messageId === messageId);
  if (!msg) return;

  // Prevent duplicate report submissions
  if (msg.feedback === "submitted") return;

  msg.feedback = "submitted";
  msg.showReportForm = false;
  redraw();

  try {
    await submitFeedback({
      message_id: messageId,
      question,
      response,
      feedback_type: "report",
      feedback_category: category,
      feedback_text: text,
    });
  } catch (error) {
    // Reset to allow retry on error
    msg.feedback = "error";
    msg.showReportForm = true;
    redraw();
    console.error("Failed to submit report:", error);
  }
}

/**
 * Handles asking a question and streaming the response
 * Prevents race conditions by tracking request order
 * @param {Event} e - Submit event from the form
 */
async function askQuestion(e) {
  if (e) e.preventDefault();

  const q = questionInput.value.trim();
  if (!q || countWords(q) < MIN_WORD_COUNT) return;

  questionInput.value = "";
  askButton.disabled = true;
  minWordsHint.style.display = "block"; // Show hint again after clearing input
  askButton.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  // Create unique message ID for feedback tracking
  const messageId = crypto.randomUUID();
  chat.push({ q, messageId, feedback: null, showReportForm: false });
  redraw();

  // Track this request to prevent race conditions
  const currentRequest = ++requestCounter;

  // Build conversation history from previous exchanges (before current question)
  const history = buildConversationHistory();

  try {
    for await (const event of asyncLLM("./answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, ndocs: 5, history, session_id: sessionId, message_id: messageId, username: usernameInput.value || undefined }),
    })) {
      Object.assign(chat.at(-1), event);
      redraw();
    }

    // Only save history if this is still the most recent request
    // This prevents out-of-order saves if multiple requests were somehow triggered
    if (currentRequest === requestCounter) {
      saveHistoryToStorage(buildConversationHistory());
    }
  } finally {
    askButton.innerHTML = "Ask";
    updateInputValidation(); // Re-check validation state after response
  }
}
questionInput.focus();

chatForm.addEventListener("submit", askQuestion);

clearChatButton.addEventListener("click", function () {
  chat.length = 0;
  sessionStorage.removeItem(HISTORY_KEY);
  redraw();
});

// Fullscreen toggle functionality
const fullscreenButton = document.getElementById("fullscreen-button");
const fullscreenIcon = document.getElementById("fullscreen-icon");
let isFullscreen = false;

fullscreenButton.addEventListener("click", function () {
  isFullscreen = !isFullscreen;
  fullscreenIcon.className = isFullscreen ? "bi bi-fullscreen-exit" : "bi bi-fullscreen";
  // Send message to parent window to toggle fullscreen
  window.parent.postMessage({ type: "toggle-fullscreen", isFullscreen }, "*");
});
