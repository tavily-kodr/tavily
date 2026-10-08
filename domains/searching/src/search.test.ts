import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { refineQuery } from "./query-refiner.js";
import { searxngRawResponseSchema } from "./types.js";

// ─── Query Refinement Tests ────────────────────────────────────────

describe("refineQuery", () => {
  it("should strip conversational filler phrases", () => {
    assert.equal(refineQuery("can you tell me about TypeScript"), "TypeScript");
  });

  it("should strip multiple filler phrases", () => {
    assert.equal(refineQuery("please tell me about JavaScript"), "JavaScript");
  });

  it("should remove duplicate words", () => {
    assert.equal(refineQuery("node node express"), "node express");
  });

  it("should remove trailing punctuation", () => {
    assert.equal(refineQuery("what is TypeScript?"), "TypeScript");
  });

  it("should collapse multiple spaces", () => {
    assert.equal(refineQuery("hello    world"), "hello world");
  });

  it("should return trimmed original query when empty after refinement", () => {
    assert.equal(refineQuery("please"), "please");
  });

  it("should return empty string for empty input", () => {
    assert.equal(refineQuery(""), "");
    assert.equal(refineQuery("   "), "");
  });

  it("should leave clean queries unchanged", () => {
    assert.equal(refineQuery("TypeScript generics"), "TypeScript generics");
  });

  it("should handle complex conversational queries", () => {
    const result = refineQuery("i want to know about how to use React hooks");
    assert.ok(!result.includes("i want to know about"));
    assert.ok(result.includes("React hooks"));
  });
});

// ─── maxResults Validation Tests ───────────────────────────────────

describe("search – maxResults validation", () => {
  // We test the validation logic by importing search and providing
  // invalid maxResults values. The search function should reject them
  // before hitting the network.

  // Dynamic import to allow mocking dependencies
  let searchModule: typeof import("./search.js");

  beforeEach(async () => {
    // We need to clear the module cache and mock the client so no
    // real HTTP requests are made.
    searchModule = await import("./search.js");
    searchModule.resetClient();
  });

  it("should reject maxResults = 0", async () => {
    await assert.rejects(
      () => searchModule.search("test query", { maxResults: 0 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "SEARCH_INVALID_MAX_RESULTS");
        return true;
      },
    );
  });

  it("should reject negative maxResults", async () => {
    await assert.rejects(
      () => searchModule.search("test query", { maxResults: -1 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "SEARCH_INVALID_MAX_RESULTS");
        return true;
      },
    );
  });

  it("should reject fractional maxResults", async () => {
    await assert.rejects(
      () => searchModule.search("test query", { maxResults: 2.5 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "SEARCH_INVALID_MAX_RESULTS");
        return true;
      },
    );
  });

  it("should reject empty query", async () => {
    await assert.rejects(
      () => searchModule.search(""),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "SEARCH_EMPTY_QUERY");
        return true;
      },
    );
  });

  it("should reject whitespace-only query", async () => {
    await assert.rejects(
      () => searchModule.search("   "),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "SEARCH_EMPTY_QUERY");
        return true;
      },
    );
  });
});

// ─── Response Validation Tests (Zod Schema) ───────────────────────

describe("searxngRawResponseSchema", () => {
  function makeValidResponse(overrides: Record<string, unknown> = {}) {
    return {
      query: "test",
      number_of_results: 1,
      results: [
        {
          title: "Test Result",
          url: "https://example.com",
          content: "Test content",
          engines: ["google"],
          score: 1.5,
          category: "general",
        },
      ],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsive_engines: [],
      ...overrides,
    };
  }

  it("should accept a valid SearXNG response", () => {
    const data = makeValidResponse();
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(result.success, "Expected valid response to parse successfully");
  });

  it("should accept response with optional result fields", () => {
    const data = makeValidResponse({
      results: [
        {
          title: "Test",
          url: "https://example.com",
          content: "Content",
          engines: ["bing"],
          score: 2.0,
          category: "general",
          thumbnail: "https://example.com/thumb.jpg",
          publishedDate: "2024-01-15",
          parsed_url: ["https", "example.com", "/path", "", "", ""],
        },
      ],
    });
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(result.success, "Response with optional fields should parse");
  });

  it("should reject response with missing required fields", () => {
    const data = { query: "test" }; // missing most fields
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(!result.success, "Expected validation to fail for incomplete response");
  });

  it("should reject response when results have wrong types", () => {
    const data = makeValidResponse({
      results: [
        {
          title: 123, // should be string
          url: "https://example.com",
          content: "Content",
          engines: ["google"],
          score: 1.0,
          category: "general",
        },
      ],
    });
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(!result.success, "Expected validation to fail for wrong result types");
  });

  it("should reject completely invalid data", () => {
    const result = searxngRawResponseSchema.safeParse("not an object");
    assert.ok(!result.success);
  });

  it("should reject null", () => {
    const result = searxngRawResponseSchema.safeParse(null);
    assert.ok(!result.success);
  });

  it("should reject when results is not an array", () => {
    const data = makeValidResponse({ results: "not-an-array" });
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(!result.success);
  });

  it("should accept response with empty results array", () => {
    const data = makeValidResponse({ results: [] });
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(result.success, "Empty results should be valid");
  });

  it("should accept response with infoboxes", () => {
    const data = makeValidResponse({
      infoboxes: [
        {
          infobox: "Test Infobox",
          id: "test-id",
          content: "Some info",
          urls: [{ title: "Wikipedia", url: "https://en.wikipedia.org" }],
          engine: "wikipedia",
        },
      ],
    });
    const result = searxngRawResponseSchema.safeParse(data);
    assert.ok(result.success, "Response with infoboxes should parse");
  });
});
