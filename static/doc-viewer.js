/**
 * Document Viewer Module
 * Displays GitHub markdown documents in a full-screen modal popup
 */

// Import marked from CDN (same as qa.js uses)
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";

const marked = new Marked();

const MODAL_HTML = `
<div class="doc-viewer-overlay" id="doc-viewer-overlay">
  <div class="doc-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="doc-viewer-title">
    <div class="doc-viewer-header">
      <h2 class="doc-viewer-title" id="doc-viewer-title">Document</h2>
      <div class="doc-viewer-actions">
        <a class="doc-viewer-btn" id="doc-viewer-external" href="#" target="_blank" title="Open in GitHub">
          <i class="bi bi-box-arrow-up-right"></i>
        </a>
        <button class="doc-viewer-btn" id="doc-viewer-close" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="doc-viewer-content" id="doc-viewer-content">
    </div>
  </div>
</div>
`;

class DocViewer {
  constructor() {
    this.overlay = null;
    this.content = null;
    this.title = null;
    this.externalLink = null;
    this.initialized = false;
  }

  /**
   * Initialize the document viewer
   * Injects modal HTML and sets up event listeners
   */
  init() {
    if (this.initialized) return;

    // Inject modal HTML
    document.body.insertAdjacentHTML("beforeend", MODAL_HTML);

    // Cache DOM references
    this.overlay = document.getElementById("doc-viewer-overlay");
    this.content = document.getElementById("doc-viewer-content");
    this.title = document.getElementById("doc-viewer-title");
    this.externalLink = document.getElementById("doc-viewer-external");
    const closeBtn = document.getElementById("doc-viewer-close");

    // Close button click
    closeBtn.addEventListener("click", () => this.close());

    // Click outside modal to close
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Escape key to close
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.overlay.classList.contains("visible")) {
        this.close();
      }
    });

    // Intercept clicks on reference links
    document.addEventListener("click", (e) => {
      const link = e.target.closest(".ref-doc-link");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("href");
        const name = link.textContent || link.dataset.name || "Document";
        this.open(href, name);
      }
    });

    this.initialized = true;
  }

  /**
   * Convert GitHub blob URL to raw content URL
   * @param {string} url - GitHub blob URL
   * @returns {string} - Raw content URL
   */
  convertToRawUrl(url) {
    // Convert: github.com/user/repo/blob/branch/path
    // To: raw.githubusercontent.com/user/repo/branch/path
    return url.replace(
      /github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\//,
      "raw.githubusercontent.com/$1/$2/$3/"
    );
  }

  /**
   * Format document title from filename
   * @param {string} name - Document name or filename
   * @returns {string} - Formatted title
   */
  formatTitle(name) {
    return name
      .replace(/\.md$/i, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Open the document viewer with content from URL
   * @param {string} url - GitHub document URL
   * @param {string} name - Document name
   */
  async open(url, name) {
    if (!this.initialized) this.init();

    // Set title and external link
    this.title.textContent = this.formatTitle(name);
    this.externalLink.href = url;

    // Show loading state
    this.content.innerHTML = `
      <div class="doc-viewer-loading">
        <div class="doc-viewer-spinner"></div>
        <div>Loading document...</div>
      </div>
    `;

    // Show modal
    this.overlay.classList.add("visible");
    document.body.style.overflow = "hidden";

    try {
      // Fetch raw markdown
      const rawUrl = this.convertToRawUrl(url);
      const response = await fetch(rawUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch document (${response.status})`);
      }

      const markdown = await response.text();

      // Render markdown
      this.content.innerHTML = marked.parse(markdown);
    } catch (error) {
      console.error("DocViewer error:", error);
      this.content.innerHTML = `
        <div class="doc-viewer-error">
          <div class="doc-viewer-error-icon"><i class="bi bi-exclamation-triangle"></i></div>
          <div class="doc-viewer-error-message">
            <p><strong>Could not load document</strong></p>
            <p>${error.message}</p>
          </div>
          <a class="doc-viewer-error-btn" href="${url}" target="_blank">
            Open in GitHub <i class="bi bi-box-arrow-up-right"></i>
          </a>
        </div>
      `;
    }
  }

  /**
   * Close the document viewer
   */
  close() {
    if (this.overlay) {
      this.overlay.classList.remove("visible");
      document.body.style.overflow = "";
    }
  }
}

// Export singleton instance
export const docViewer = new DocViewer();
