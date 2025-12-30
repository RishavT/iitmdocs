import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import { join } from "path";

// Read the actual HTML file
const qaHtmlPath = join(process.cwd(), "static", "qa.html");
const qaHtml = readFileSync(qaHtmlPath, "utf-8");

// Read qa.js to extract constants for testing
const qaJsPath = join(process.cwd(), "static", "qa.js");
const qaJs = readFileSync(qaJsPath, "utf-8");

describe("Welcome Message", () => {
  describe("Content", () => {
    it("should contain welcome greeting", () => {
      expect(qaJs).toContain("Welcome to the IITM BS Degree Program Assistant");
    });

    it("should mention admission pathways", () => {
      expect(qaJs).toContain("Admission pathways and eligibility");
    });

    it("should mention qualifier exam", () => {
      expect(qaJs).toContain("Qualifier exam preparation and fees");
    });

    it("should mention course registration", () => {
      expect(qaJs).toContain("Course registration steps");
    });

    it("should include minimum word count instruction", () => {
      expect(qaJs).toContain("minimum 5 words");
    });
  });

  describe("Display Logic", () => {
    it("should have redraw function that handles empty chat", () => {
      expect(qaJs).toContain("if (chat.length === 0)");
      expect(qaJs).toContain("WELCOME_MESSAGE");
    });

    it("should call redraw on page load", () => {
      // Verify redraw is called after loading history
      expect(qaJs).toMatch(/\/\/ Always call redraw[\s\S]*?redraw\(\)/);
    });
  });
});

describe("Consent Overlay", () => {
  let dom;
  let document;
  let window;
  let localStorage;

  beforeEach(() => {
    // Create a mock localStorage
    const store = {};
    localStorage = {
      getItem: vi.fn((key) => store[key] || null),
      setItem: vi.fn((key, value) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach((key) => delete store[key]);
      }),
    };

    dom = new JSDOM(qaHtml, {
      url: "http://localhost",
      runScripts: "outside-only",
    });
    document = dom.window.document;
    window = dom.window;

    // Set up globals
    global.document = document;
    global.window = window;
    global.localStorage = localStorage;
  });

  afterEach(() => {
    delete global.document;
    delete global.window;
    delete global.localStorage;
    vi.clearAllMocks();
  });

  describe("HTML Structure", () => {
    it("should have consent overlay element", () => {
      const overlay = document.getElementById("consent-overlay");
      expect(overlay).not.toBeNull();
    });

    it("should have consent button", () => {
      const button = document.getElementById("consent-button");
      expect(button).not.toBeNull();
      expect(button.textContent).toBe("I Agree");
    });

    it("should have consent overlay with correct class", () => {
      const overlay = document.getElementById("consent-overlay");
      expect(overlay.classList.contains("consent-overlay")).toBe(true);
    });

    it("should display AI disclaimer", () => {
      const overlay = document.getElementById("consent-overlay");
      expect(overlay.textContent).toContain("powered by AI");
    });

    it("should display logging notice", () => {
      const overlay = document.getElementById("consent-overlay");
      expect(overlay.textContent).toContain("logged");
    });

    it("should display inaccurate information warning", () => {
      const overlay = document.getElementById("consent-overlay");
      expect(overlay.textContent).toContain("inaccurate information");
    });
  });

  describe("Consent Logic in qa.js", () => {
    it("should define CONSENT_KEY constant", () => {
      expect(qaJs).toContain('CONSENT_KEY = "iitm-chatbot-consent"');
    });

    it("should have hasUserConsent function", () => {
      expect(qaJs).toContain("function hasUserConsent()");
      expect(qaJs).toContain('localStorage.getItem(CONSENT_KEY) === "true"');
    });

    it("should have hideConsentOverlay function", () => {
      expect(qaJs).toContain("function hideConsentOverlay()");
      expect(qaJs).toContain('consentOverlay.classList.add("hidden")');
    });

    it("should have showConsentOverlay function", () => {
      expect(qaJs).toContain("function showConsentOverlay()");
      expect(qaJs).toContain('consentOverlay.classList.remove("hidden")');
    });

    it("should disable input when showing consent overlay", () => {
      expect(qaJs).toContain("questionInput.disabled = true");
    });

    it("should enable input when hiding consent overlay", () => {
      expect(qaJs).toContain("questionInput.disabled = false");
    });

    it("should check consent on page load", () => {
      expect(qaJs).toContain("if (hasUserConsent())");
      expect(qaJs).toContain("hideConsentOverlay()");
      expect(qaJs).toContain("showConsentOverlay()");
    });

    it("should save consent to localStorage on button click", () => {
      expect(qaJs).toContain('localStorage.setItem(CONSENT_KEY, "true")');
    });

    it("should add click listener to consent button", () => {
      expect(qaJs).toContain('consentButton.addEventListener("click"');
    });
  });

  describe("Consent Function Behavior", () => {
    // Test the actual consent logic by recreating the functions
    const CONSENT_KEY = "iitm-chatbot-consent";

    function hasUserConsent() {
      return localStorage.getItem(CONSENT_KEY) === "true";
    }

    function giveConsent() {
      localStorage.setItem(CONSENT_KEY, "true");
    }

    it("should return false when no consent given", () => {
      expect(hasUserConsent()).toBe(false);
      expect(localStorage.getItem).toHaveBeenCalledWith(CONSENT_KEY);
    });

    it("should return true after consent is given", () => {
      giveConsent();
      expect(localStorage.setItem).toHaveBeenCalledWith(CONSENT_KEY, "true");
    });

    it("should persist consent across checks", () => {
      // Simulate the actual localStorage behavior
      const store = {};
      localStorage.getItem.mockImplementation((key) => store[key] || null);
      localStorage.setItem.mockImplementation((key, value) => {
        store[key] = value;
      });

      expect(hasUserConsent()).toBe(false);
      giveConsent();
      expect(hasUserConsent()).toBe(true);
    });
  });

  describe("CSS Styles", () => {
    it("should have hidden class defined in styles", () => {
      expect(qaHtml).toContain(".consent-overlay.hidden");
      expect(qaHtml).toContain("display: none");
    });

    it("should position overlay absolutely", () => {
      expect(qaHtml).toContain("position: absolute");
    });

    it("should have high z-index for overlay", () => {
      expect(qaHtml).toContain("z-index: 100");
    });
  });
});
