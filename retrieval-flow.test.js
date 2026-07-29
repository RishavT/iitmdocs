// TEST FLOW
// 1. Send a known grading question through the Worker's /answer route.
// 2. Replace Weaviate, PG FAQ, and chat API calls with local responses.
// 3. Verify both retrieval calls start together.
// 4. Verify either retrieval result still reaches the answer when the other call fails.
//
// Project terms:
// - Retrieval calls: the Weaviate document search and PG FAQ search.
// - Answer context: the retrieved documents and FAQs sent to the chat API.
// ASSUMPTION: "grading policy" uses the local synonym path, so these tests do not
// need to mock a separate query-rewrite API call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./worker.js";

/**
 * Returns a response promise and a function that finishes it.
 * Example: pending.finish(new Response("{}")) resolves pending.response.
 */
function makePendingResponse() {
  let finish;
  const response = new Promise((resolve) => {
    finish = resolve;
  });

  return { response, finish };
}

/**
 * Creates the request used after external APIs are mocked.
 * Returns a POST /answer request for the known "grading policy" synonym.
 */
function makeAnswerRequest() {
  return new Request("https://example.test/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: "grading policy", ndocs: 2 }),
  });
}

/**
 * Returns local-only endpoint settings for the mocked Worker request.
 * No value points to a production or paid service.
 */
function makeEnvironment() {
  return {
    DEPLOYMENT_MODE: "local",
    LOCAL_WEAVIATE_URL: "https://weaviate.test",
    PG_FAQ_API_URL: "https://faqs.test",
    CHAT_API_ENDPOINT: "https://chat.test",
    CHAT_API_KEY: "test-key",
  };
}

function makeWeaviateResponse(documents = []) {
  return new Response(
    JSON.stringify({
      data: {
        Get: {
          Document: documents,
        },
      },
    }),
  );
}

function makeFaqResponse(faqs = []) {
  return new Response(JSON.stringify({ results: faqs }));
}

/**
 * Returns deterministic answer and fact-check responses.
 * Also saves the retrieval context sent during answer generation.
 */
function makeChatResponse(options, answerContexts) {
  const body = JSON.parse(options.body);

  if (body.response_format?.type === "json_object") {
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"approved":"YES","incorrect":[]}' } },
        ],
      }),
    );
  }

  answerContexts.push(body.messages[1].content);
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: "# Grading\nUse the official grading formula." },
        },
      ],
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parallel document and FAQ retrieval", () => {
  it("starts both retrieval calls before either response finishes", async () => {
    const weaviate = makePendingResponse();
    const faqs = makePendingResponse();
    const startedUrls = [];
    const answerContexts = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const address = String(url);
        startedUrls.push(address);

        if (address.endsWith("/v1/graphql")) {
          return weaviate.response;
        }
        if (address.endsWith("/search")) {
          return faqs.response;
        }

        return Promise.resolve(makeChatResponse(options, answerContexts));
      }),
    );

    const response = await worker.fetch(makeAnswerRequest(), makeEnvironment());

    await vi.waitFor(() => {
      expect(startedUrls).toContain("https://weaviate.test/v1/graphql");
      expect(startedUrls).toContain("https://faqs.test/search");
    });

    weaviate.finish(makeWeaviateResponse());
    faqs.finish(makeFaqResponse());

    const responseBody = await response.text();
    expect(responseBody).toContain("# Grading");
  });

  it("uses FAQ context when Weaviate fails", async () => {
    const answerContexts = [];
    const faq = {
      id: "faq-1",
      question: "How is grading calculated?",
      answer: "Use the official grading formula.",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const address = String(url);

        if (address.endsWith("/v1/graphql")) {
          return Promise.reject(new Error("Weaviate unavailable"));
        }
        if (address.endsWith("/search")) {
          return Promise.resolve(makeFaqResponse([faq]));
        }

        return Promise.resolve(makeChatResponse(options, answerContexts));
      }),
    );

    const response = await worker.fetch(makeAnswerRequest(), makeEnvironment());
    await response.text();

    expect(answerContexts).toHaveLength(1);
    expect(answerContexts[0]).toContain('<faq id="faq-1">');
    expect(answerContexts[0]).toContain("Use the official grading formula.");
  });

  it("uses Weaviate documents when PG FAQ retrieval fails", async () => {
    const answerContexts = [];
    const document = {
      filename: "grading.md",
      content: "Official grading details.",
      _additional: { score: 0.9 },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const address = String(url);

        if (address.endsWith("/v1/graphql")) {
          return Promise.resolve(makeWeaviateResponse([document]));
        }
        if (address.endsWith("/search")) {
          return Promise.reject(new Error("PG FAQ unavailable"));
        }

        return Promise.resolve(makeChatResponse(options, answerContexts));
      }),
    );

    const response = await worker.fetch(makeAnswerRequest(), makeEnvironment());
    await response.text();

    expect(answerContexts).toHaveLength(1);
    expect(answerContexts[0]).toContain(
      '<document filename="grading.md">Official grading details.</document>',
    );
  });
});
