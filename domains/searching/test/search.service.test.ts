import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@tavily/errors";
import { SearchService } from "../src/services/search.service.js";
import { SearxngClient } from "../src/clients/searxng.client.js";
import type { SearxngRawResponse } from "../src/types/search.types.js";

function createMockClient(rawResponse: SearxngRawResponse): SearxngClient {
  return {
    search: async () => rawResponse,
  } as unknown as SearxngClient;
}

describe("SearchService", () => {
  it("rejects missing or empty queries with INVALID_QUERY AppError", async () => {
    const service = new SearchService({ client: createMockClient({ results: [] }) });

    await assert.rejects(
      async () => service.search(""),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_QUERY");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );

    await assert.rejects(
      async () => service.search("    "),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_QUERY");
        return true;
      },
    );

    await assert.rejects(
      async () => service.search(null as unknown as string),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_QUERY");
        return true;
      },
    );
  });

  it("normalizes valid SearXNG results and preserves ranking order", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "nodejs",
      results: [
        {
          title: "Node.js Official",
          url: "https://nodejs.org/en",
          content: "Node.js JavaScript runtime",
          score: 1.5,
          engine: "google",
        },
        {
          title: "Node.js GitHub",
          url: "https://github.com/nodejs/node",
          content: "Node.js open source repo",
          score: 1.2,
          engine: "google",
        },
      ],
    };

    const service = new SearchService({ client: createMockClient(mockResponse) });
    const output = await service.search("nodejs");

    assert.equal(output.query, "nodejs");
    assert.equal(output.results.length, 2);
    assert.deepEqual(output.results[0], {
      title: "Node.js Official",
      url: "https://nodejs.org/en",
      content: "Node.js JavaScript runtime",
      score: 1.5,
    });
    assert.deepEqual(output.results[1], {
      title: "Node.js GitHub",
      url: "https://github.com/nodejs/node",
      content: "Node.js open source repo",
      score: 1.2,
    });
  });

  it("filters out invalid URLs", async () => {
    const mockResponse: SearxngRawResponse = {
      results: [
        { title: "Invalid 1", url: "not-a-valid-url", content: "test" },
        { title: "Invalid 2", url: "ftp://files.example.com", content: "test" },
        { title: "Invalid 3", url: "javascript:alert(1)", content: "test" },
        { title: "Valid 1", url: "https://example.com/page", content: "test", score: 0.9 },
      ],
    };

    const service = new SearchService({ client: createMockClient(mockResponse) });
    const output = await service.search("test query");

    assert.equal(output.results.length, 1);
    assert.equal(output.results[0]?.url, "https://example.com/page");
  });

  it("removes duplicate URLs while preserving ranking of the first occurrence", async () => {
    const mockResponse: SearxngRawResponse = {
      results: [
        {
          title: "First Occurrence",
          url: "https://example.com/docs",
          content: "First",
          score: 1.0,
        },
        { title: "Other Domain", url: "https://another.com/page", content: "Other", score: 0.8 },
        {
          title: "Duplicate Occurrence",
          url: "https://example.com/docs/",
          content: "Duplicate",
          score: 0.6,
        },
      ],
    };

    const service = new SearchService({ client: createMockClient(mockResponse) });
    const output = await service.search("docs");

    assert.equal(output.results.length, 2);
    assert.equal(output.results[0]?.url, "https://example.com/docs");
    assert.equal(output.results[0]?.title, "First Occurrence");
    assert.equal(output.results[1]?.url, "https://another.com/page");
  });

  it("caps results at a maximum of 10 items", async () => {
    const fifteenResults = Array.from({ length: 15 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/page/${i + 1}`,
      content: `Description for ${i + 1}`,
      score: 10 - i * 0.5,
    }));

    const mockResponse: SearxngRawResponse = {
      results: fifteenResults,
    };

    const service = new SearchService({ client: createMockClient(mockResponse) });
    const output = await service.search("many results");

    assert.equal(output.results.length, 10);
    assert.equal(output.results[0]?.title, "Result 1");
    assert.equal(output.results[9]?.title, "Result 10");
  });

  it("handles empty results array without error", async () => {
    const mockResponse: SearxngRawResponse = {
      results: [],
    };

    const service = new SearchService({ client: createMockClient(mockResponse) });
    const output = await service.search("non-existent query");

    assert.equal(output.results.length, 0);
    assert.deepEqual(output.results, []);
  });
});
