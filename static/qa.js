import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2";
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";

const chatArea = document.getElementById("chat-area");
const chatForm = document.getElementById("chat-form");
const askButton = document.getElementById("ask-button");
const questionInput = document.getElementById("question-input");
const clearChatButton = document.getElementById("clear-chat-button");

const chat = [];
const marked = new Marked();
const HISTORY_KEY = "iitm-chatbot-history";
const MAX_HISTORY_PAIRS = 5;

// SessionStorage utilities for conversation history
function loadHistoryFromStorage() {
  try {
    const stored = sessionStorage.getItem(HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Failed to load history from sessionStorage:", e);
    return [];
  }
}

function saveHistoryToStorage(history) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save history to sessionStorage:", e);
  }
}

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
  // Render restored conversation
  if (chat.length > 0) {
    redraw();
  }
}

let autoScroll = true;
chatArea.addEventListener("scroll", () => {
  const atBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 10;
  autoScroll = atBottom;
});

function redraw() {
  render(
    chat.map(
      ({ q, content, tools }) => html`
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
      `,
    ),
    chatArea,
  );
  if (autoScroll) chatArea.scrollTop = chatArea.scrollHeight;
}

async function askQuestion(e) {
  if (e) e.preventDefault();

  const q = questionInput.value.trim();
  if (!q) return;

  questionInput.value = "";
  askButton.disabled = true;
  askButton.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  chat.push({ q });
  redraw();

  // Build conversation history from previous exchanges
  const history = buildConversationHistory();

  for await (const event of asyncLLM("./answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, ndocs: 5, history }),
  })) {
    Object.assign(chat.at(-1), event);
    redraw();
  }

  // Save updated conversation history to sessionStorage
  const updatedHistory = buildConversationHistory();
  saveHistoryToStorage(updatedHistory);

  askButton.disabled = false;
  askButton.innerHTML = "Ask";
}
questionInput.focus();

chatForm.addEventListener("submit", askQuestion);

clearChatButton.addEventListener("click", function () {
  chat.length = 0;
  sessionStorage.removeItem(HISTORY_KEY);
  redraw();
});
