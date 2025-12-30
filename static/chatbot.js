export const chatbotCSS = /* css */ `
/* Chatbot styles */
.chatbot-toggler {
  position: fixed;
  bottom: 30px;
  right: 90px;
  outline: none;
  border: none;
  height: 50px;
  width: 50px;
  display: flex;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #800020;
  transition: all 0.2s ease;
}

body.show-chatbot .chatbot-toggler {
  transform: rotate(90deg);
}

.chatbot-toggler span {
  color: #fff;
  position: absolute;
}

.chatbot-toggler span:last-child,
body.show-chatbot .chatbot-toggler span:first-child {
  opacity: 0;
}

body.show-chatbot .chatbot-toggler span:last-child {
  opacity: 1;
}

.chatbot {
  position: fixed;
  right: 90px;
  bottom: 90px;
  width: 420px;
  height: 70vh;
  max-height: 600px;
  min-height: 400px;
  background: #fff;
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

export function getChatbotHTML(baseUrl) {
  return /* html */ `
  <button class="chatbot-toggler">
    <span class="material-symbols-rounded">mode_comment</span>
    <span class="material-symbols-outlined">close</span>
  </button>
  <div class="chatbot">
    <div class="chatbox">
      <iframe src="${baseUrl}qa.html" style="width: 100%; height: 100%; border: none;"></iframe>
    </div>
  </div>
`;
}

// Legacy export for backwards compatibility
export const chatbotHTML = getChatbotHTML('');

export const googleIconsHTML = /* html */ `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@48,400,1,0">
`;

export function initChatbot() {
  addChatbotStyles();
  const baseUrl = getChatbotBaseUrl();
  document.body.insertAdjacentHTML("beforeend", getChatbotHTML(baseUrl));

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
  });

  document.head.insertAdjacentHTML("beforeend", googleIconsHTML);
}

// Auto-initialize when DOM is ready (for browser usage)
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("DOMContentLoaded", initChatbot);
}
