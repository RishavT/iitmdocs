import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2";
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";

const chatArea = document.getElementById("chat-area");
const chatForm = document.getElementById("chat-form");
const askButton = document.getElementById("ask-button");
const questionInput = document.getElementById("question-input");
const clearChatButton = document.getElementById("clear-chat-button");
const historyToggle = document.getElementById("history-toggle");
const newChatButton = document.getElementById("new-chat");
const sessionList = document.getElementById("session-list");
const historyModal = new bootstrap.Modal(document.getElementById('historyModal'));

const chat = [];
const marked = new Marked();
let sessionId = localStorage.getItem('currentSessionId') || crypto.randomUUID();
const sessions = JSON.parse(localStorage.getItem('chatSessions') || '{}');
let lastResponseId = null;

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

  for await (const event of asyncLLM("/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      q, 
      ndocs: 5, 
      session_id: sessionId,
      previous_response_id: lastResponseId 
    }),
  })) {
    Object.assign(chat.at(-1), event);
    if (event.id) lastResponseId = event.id; // Capture response ID
    redraw();
  }
  
  // Save session
  sessions[sessionId] = [...chat];
  localStorage.setItem('chatSessions', JSON.stringify(sessions));
  localStorage.setItem('currentSessionId', sessionId);

  askButton.disabled = false;
  askButton.innerHTML = "Ask";
}
questionInput.focus();

chatForm.addEventListener("submit", askQuestion);

function updateSessionList() {
  const sessionEntries = Object.entries(sessions).map(([id, msgs]) => {
    const firstQ = msgs[0]?.q || 'Empty chat';
    const msgCount = msgs.length;
    const date = new Date(parseInt(id.slice(0,8), 16) * 1000).toLocaleDateString();
    return `
      <div class="d-flex justify-content-between align-items-center p-2 border-bottom session-item ${id === sessionId ? 'bg-light' : ''}" 
           style="cursor: pointer;" data-session-id="${id}">
        <div>
          <div class="fw-medium">${firstQ.slice(0, 40)}${firstQ.length > 40 ? '...' : ''}</div>
          <small class="text-muted">${msgCount} messages • ${date}</small>
        </div>
        <button class="btn btn-sm btn-outline-danger delete-session" data-session-id="${id}">
          <i class="bi bi-trash"></i>
        </button>
      </div>
    `;
  }).join('');
  
  sessionList.innerHTML = sessionEntries || '<div class="text-muted text-center p-3">No chat history</div>';
}

historyToggle.addEventListener("click", () => {
  updateSessionList();
  historyModal.show();
});

sessionList.addEventListener("click", function(e) {
  const sessionItem = e.target.closest('.session-item');
  const deleteBtn = e.target.closest('.delete-session');
  
  if (deleteBtn) {
    const id = deleteBtn.dataset.sessionId;
    delete sessions[id];
    localStorage.setItem('chatSessions', JSON.stringify(sessions));
    updateSessionList();
    return;
  }
  
  if (sessionItem) {
    const id = sessionItem.dataset.sessionId;
    sessionId = id;
    chat.splice(0, chat.length, ...sessions[sessionId]);
    lastResponseId = sessions[sessionId]?.at(-1)?.id || null;
    localStorage.setItem('currentSessionId', sessionId);
    redraw();
    historyModal.hide();
  }
});

newChatButton.addEventListener("click", () => {
  chat.length = 0;
  sessionId = crypto.randomUUID();
  lastResponseId = null;
  localStorage.setItem('currentSessionId', sessionId);
  redraw();
  historyModal.hide();
});

clearChatButton.addEventListener("click", function () {
  chat.length = 0;
  sessionId = crypto.randomUUID();
  lastResponseId = null;
  localStorage.setItem('currentSessionId', sessionId);
  redraw();
});

// Load existing session on startup
if (sessions[sessionId]) {
  chat.push(...sessions[sessionId]);
  lastResponseId = sessions[sessionId]?.at(-1)?.id || null;
  redraw();
}
