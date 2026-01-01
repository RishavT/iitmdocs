export const chatbotCSS = /* css */ `
/* Chatbot CSS Variables */
:root {
  --chatbot-primary: #2563eb;
  --chatbot-primary-hover: #1d4ed8;
  --chatbot-text-on-primary: #ffffff;
}

/* Chatbot styles */
.chatbot-toggler {
  z-index:1000;
  position: fixed;
  bottom: 30px;
  right: 90px;
  outline: none;
  border: 2px solid rgba(255,255,255,0.9);
  height: 48px;
  padding: 0 20px;
  display: flex;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 24px;
  background: var(--chatbot-primary);
  box-shadow: 0 0 0 3px rgba(255,255,255,0.8), 0 4px 16px rgba(0,0,0,0.3), 0 0 20px rgba(255,255,255,0.3);
  transition: all 0.2s ease;
}

.chatbot-toggler:hover {
  transform: scale(1.05);
  box-shadow: 0 0 0 4px rgba(255,255,255,0.9), 0 6px 20px rgba(0,0,0,0.4), 0 0 25px rgba(255,255,255,0.4);
}

.chatbot-toggler-open {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #fff;
}

.chatbot-toggler-open span.material-symbols-rounded {
  font-size: 22px;
}

.chatbot-toggler-label {
  font-size: 14px;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  white-space: nowrap;
}

.chatbot-toggler .chatbot-toggler-close {
  color: #fff;
  display: none !important;
  font-size: 24px;
}

body.show-chatbot .chatbot-toggler .chatbot-toggler-close {
  display: block !important;
}

body.show-chatbot .chatbot-toggler {
  padding: 0;
  width: 48px;
  border-radius: 50%;
}

body.show-chatbot .chatbot-toggler-open {
  display: none;
}

.chatbot {
  z-index:1000;
  position: fixed;
  right: 90px;
  bottom: 90px;
  width: 420px;
  height: 70vh;
  max-height: 600px;
  min-height: 400px;
  background: #fff;
  border: 2px solid var(--chatbot-primary);
  border-radius: 15px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.5);
  transform-origin: bottom right;
  box-shadow: 0 0 128px 0 rgba(0, 0, 0, 0.1),
              0 32px 64px -48px rgba(0, 0, 0, 0.5);
  transition: all 0.1s ease;
}

body.show-chatbot .chatbot {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}

.chatbot .chatbox {
  overflow-y: hidden;
  height: 100%;
  padding: 0;
}

.chatbot :where(.chatbox, textarea)::-webkit-scrollbar {
  width: 6px;
}

.chatbot :where(.chatbox, textarea)::-webkit-scrollbar-track {
  background: #fff;
  border-radius: 25px;
}

.chatbot :where(.chatbox, textarea)::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 25px;
}

@media (max-width: 490px) {
  .chatbot-toggler {
    right: 20px;
    bottom: 20px;
    padding: 0;
    width: 48px;
    border-radius: 50%;
  }

  .chatbot-toggler-label {
    display: none;
  }

  .chatbot {
    right: 0;
    bottom: 0;
    height: 100%;
    border-radius: 0;
    width: 100%;
  }

  .chatbot .chatbox {
    height: 100%;
    padding: 0;
  }
}

/* Fullscreen state */
body.chatbot-fullscreen::before {
  content: '';
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

body.chatbot-fullscreen .chatbot {
  width: 95vw;
  height: calc(100vh - 100px);
  max-height: none;
  right: 2.5vw;
  bottom: 90px;
  border-radius: 10px;
}
`;

export function addChatbotStyles() {
  const styleId = "chatbot-styles";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.innerHTML = chatbotCSS;
  document.head.appendChild(style);
}

/**
 * Gets the base URL of where chatbot.js was loaded from.
 * This allows the chatbot to be embedded on any site while loading resources from the correct origin.
 * @returns {string} Base URL (e.g., "https://chatbot.example.com/")
 */
function getChatbotBaseUrl() {
  // Find the script tag that loaded this file
  const scripts = document.getElementsByTagName('script');
  for (const script of scripts) {
    if (script.src && script.src.includes('chatbot.js')) {
      // Extract base URL (everything before 'chatbot.js')
      return script.src.replace(/chatbot\.js.*$/, '');
    }
  }
  // Fallback to current origin if script not found
  return window.location.origin + '/';
}

export function getChatbotHTML(baseUrl, parentOrigin) {
  // Pass parent origin to iframe so it can use explicit targetOrigin in postMessage
  const iframeSrc = `${baseUrl}qa.html${parentOrigin ? `?parentOrigin=${encodeURIComponent(parentOrigin)}` : ''}`;
  return /* html */ `
  <button class="chatbot-toggler">
    <span class="chatbot-toggler-open">
      <span class="material-symbols-rounded">contact_support</span>
      <span class="chatbot-toggler-label">Need Help?</span>
    </span>
    <span class="material-symbols-outlined chatbot-toggler-close">close</span>
  </button>
  <div class="chatbot">
    <div class="chatbox">
      <iframe src="${iframeSrc}" style="width: 100%; height: 100%; border: none;"></iframe>
    </div>
  </div>
`;
}

export const googleIconsHTML = /* html */ `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@48,400,1,0">
`;

export function initChatbot() {
  addChatbotStyles();
  const baseUrl = getChatbotBaseUrl();
  const parentOrigin = window.location.origin;
  document.body.insertAdjacentHTML("beforeend", getChatbotHTML(baseUrl, parentOrigin));

  const chatbotToggler = document.querySelector(".chatbot-toggler");
  chatbotToggler.addEventListener("click", () => document.body.classList.toggle("show-chatbot"));

  // Determine the expected origin for postMessage validation
  // If embedded cross-origin, accept messages from the chatbot's origin
  const chatbotOrigin = new URL(baseUrl).origin;

  // Listen for fullscreen toggle messages from the iframe
  window.addEventListener("message", (event) => {
    // Only accept messages from the chatbot iframe's origin
    if (event.origin !== chatbotOrigin) return;

    if (event.data?.type === "toggle-fullscreen") {
      if (event.data.isFullscreen) {
        document.body.classList.add("chatbot-fullscreen");
      } else {
        document.body.classList.remove("chatbot-fullscreen");
      }
    }

    if (event.data?.type === "close-chatbot") {
      document.body.classList.remove("show-chatbot");
      document.body.classList.remove("chatbot-fullscreen");
    }
  });

  document.head.insertAdjacentHTML("beforeend", googleIconsHTML);
}

// Auto-initialize when DOM is ready (for browser usage)
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("DOMContentLoaded", initChatbot);
}
