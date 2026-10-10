import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@tavily/errors";
import { HttpFetcher, type HttpRequestContext, type HttpTransportFn } from "@tavily/scraping";
import { SearchService } from "../src/services/search.service.js";
import { SearxngClient } from "../src/clients/searxng.client.js";
import type { SearxngRawResponse } from "../src/types/search.types.js";

function createMockClient(rawResponse: SearxngRawResponse): SearxngClient {
  return {
    search: async () => rawResponse,
  } as unknown as SearxngClient;
}

function createMockTransport(pagesMap: Record<string, string | number>): HttpTransportFn {
  return async (ctx: HttpRequestContext) => {
    const val = pagesMap[ctx.url];
    if (val === undefined || val === 404) {
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 404,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>404 Not Found</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    }
    if (val === 500) {
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 500,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>500 Server Error</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    }
    return {
      requestedUrl: ctx.url,
      finalUrl: ctx.url,
      statusCode: 200,
      contentType: "text/html",
      headers: { "content-type": "text/html" },
      body: String(val),
      resolvedIp: ctx.pinnedIp,
    };
  };
}

describe("SearchService - Pre-Crawl Normalization", () => {
  it("rejects missing or empty queries with INVALID_QUERY AppError", async () => {
    const service = new SearchService({
      client: createMockClient({ results: [] }),
      crawlCandidates: false,
    });

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

    const service = new SearchService({
      client: createMockClient(mockResponse),
      crawlCandidates: false,
    });
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

    const service = new SearchService({
      client: createMockClient(mockResponse),
      crawlCandidates: false,
    });
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

    const service = new SearchService({
      client: createMockClient(mockResponse),
      crawlCandidates: false,
    });
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

    const service = new SearchService({
      client: createMockClient(mockResponse),
      maxResults: 10,
      crawlCandidates: false,
    });
    const output = await service.search("many results");

    assert.equal(output.results.length, 10);
    assert.equal(output.results[0]?.title, "Result 1");
    assert.equal(output.results[9]?.title, "Result 10");
  });

  it("caps results according to configured maxResults", async () => {
    const fifteenResults = Array.from({ length: 15 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/page/${i + 1}`,
      content: `Description for ${i + 1}`,
      score: 10 - i * 0.5,
    }));

    const mockResponse: SearxngRawResponse = {
      results: fifteenResults,
    };

    const service = new SearchService({
      client: createMockClient(mockResponse),
      maxResults: 5,
      crawlCandidates: false,
    });
    const output = await service.search("capped results");

    assert.equal(output.results.length, 5);
    assert.equal(output.results[0]?.title, "Result 1");
    assert.equal(output.results[4]?.title, "Result 5");
  });

  it("handles empty results array without error", async () => {
    const mockResponse: SearxngRawResponse = {
      results: [],
    };

    const service = new SearchService({
      client: createMockClient(mockResponse),
      crawlCandidates: false,
    });
    const output = await service.search("non-existent query");

    assert.equal(output.results.length, 0);
    assert.deepEqual(output.results, []);
  });
});

describe("SearchService - Integrated Candidate Crawling & Enrichment", () => {
  it("crawls candidate URLs and enriches results with page content, title, and canonicalUrl", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "typescript tutorial",
      results: [
        {
          title: "Initial Title",
          url: "https://example.com/ts",
          content: "Old search snippet",
          score: 0.95,
        },
      ],
    };

    const pagesMap: Record<string, string> = {
      "https://example.com/ts": `
        <html>
          <head>
            <title>TypeScript Handbook</title>
            <link rel="canonical" href="https://example.com/canonical-ts" />
          </head>
          <body>
            <h1>TypeScript Tutorial</h1>
            <p>TypeScript extends JavaScript by adding types.</p>
          </body>
        </html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("typescript tutorial");

    assert.equal(output.results.length, 1);
    const first = output.results[0]!;
    assert.equal(first.title, "TypeScript Handbook");
    assert.equal(first.canonicalUrl, "https://example.com/canonical-ts");
    assert.equal(first.sourceUrl, "https://example.com/ts");
    assert.equal(first.snippet, "Old search snippet");
    assert(first.content.includes("TypeScript extends JavaScript by adding types"));
    assert.equal(first.score, 0.95);
  });

  it("handles partial fetch failures gracefully by falling back to search snippet without failing whole search", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "mixed candidates",
      results: [
        {
          title: "Good Page",
          url: "https://example.com/ok",
          content: "Good snippet",
          score: 1.0,
        },
        {
          title: "Failed 404 Page",
          url: "https://example.com/missing",
          content: "Fallback snippet 404",
          score: 0.8,
        },
        {
          title: "Server Error Page",
          url: "https://example.com/error500",
          content: "Fallback snippet 500",
          score: 0.6,
        },
      ],
    };

    const pagesMap: Record<string, string | number> = {
      "https://example.com/ok": `
        <html><head><title>Good Page Live</title></head><body><p>Clean crawled content</p></body></html>
      `,
      "https://example.com/missing": 404,
      "https://example.com/error500": 500,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("mixed candidates");

    assert.equal(output.results.length, 3);
    // Successful page has crawled content
    assert.equal(output.results[0]?.title, "Good Page Live");
    assert.equal(output.results[0]?.content, "Clean crawled content");

    // Failed 404 page falls back to snippet
    assert.equal(output.results[1]?.title, "Failed 404 Page");
    assert.equal(output.results[1]?.content, "Fallback snippet 404");

    // Failed 500 page falls back to snippet
    assert.equal(output.results[2]?.title, "Server Error Page");
    assert.equal(output.results[2]?.content, "Fallback snippet 500");
  });

  it("enforces SSRF protection by discarding loopback candidate URLs upfront", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "ssrf test",
      results: [
        {
          title: "SSRF Localhost",
          url: "http://localhost:8080/admin",
          content: "secret",
          score: 1.0,
        },
        {
          title: "SSRF Loopback",
          url: "http://127.0.0.1:3000/env",
          content: "keys",
          score: 0.9,
        },
        {
          title: "Legitimate Page",
          url: "https://example.com/safe",
          content: "safe snippet",
          score: 0.8,
        },
      ],
    };

    const pagesMap: Record<string, string> = {
      "https://example.com/safe": `
        <html><head><title>Safe Page</title></head><body><p>Safe content</p></body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("ssrf test");

    // Only the legitimate page should be returned; loopbacks are filtered out safely
    assert.equal(output.results.length, 1);
    assert.equal(output.results[0]?.url, "https://example.com/safe");
    assert.equal(output.results[0]?.title, "Safe Page");
  });

  it("deduplicates candidate pages that resolve to identical canonical URLs", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "duplicate canonicals",
      results: [
        {
          title: "First Version",
          url: "https://example.com/page-v1",
          content: "Snippet 1",
          score: 1.0,
        },
        {
          title: "Second Version",
          url: "https://example.com/page-v2",
          content: "Snippet 2",
          score: 0.8,
        },
      ],
    };

    // Both pages declare the same canonical URL
    const pagesMap: Record<string, string> = {
      "https://example.com/page-v1": `
        <html>
          <head><link rel="canonical" href="https://example.com/main-article" /><title>Article</title></head>
          <body><p>Shared Article Content</p></body>
        </html>
      `,
      "https://example.com/page-v2": `
        <html>
          <head><link rel="canonical" href="https://example.com/main-article" /><title>Article Copy</title></head>
          <body><p>Shared Article Content</p></body>
        </html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("duplicate canonicals");

    // Deduplication should keep only the higher-ranked occurrence
    assert.equal(output.results.length, 1);
    assert.equal(output.results[0]?.canonicalUrl, "https://example.com/main-article");
  });

  it("calculates transparent baseline relevance score when upstream score is 0", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "python machine learning",
      results: [
        {
          title: "Python Machine Learning Guide",
          url: "https://example.com/ml",
          content: "Introductory machine learning guide in python",
          score: 0, // No score from upstream engine
        },
      ],
    };

    const pagesMap: Record<string, string> = {
      "https://example.com/ml": `
        <html><head><title>Python Machine Learning</title></head><body><p>Machine learning tutorials</p></body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("python machine learning");

    assert.equal(output.results.length, 1);
    assert(output.results[0]!.score > 0);
  });

  it("supports crawl depth > 0 with CrawlerService", async () => {
    const mockResponse: SearxngRawResponse = {
      query: "deep crawl test",
      results: [
        {
          title: "Seed Article",
          url: "https://example.com/seed",
          content: "Seed snippet",
          score: 1.0,
        },
      ],
    };

    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html>
          <head><title>Root Seed Article</title></head>
          <body>
            <h1>Root Content</h1>
            <a href="https://example.com/child">Child Link</a>
          </body>
        </html>
      `,
      "https://example.com/child": `
        <html><head><title>Child Page</title></head><body><h1>Child Content</h1></body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const service = new SearchService({
      client: createMockClient(mockResponse),
      fetcher,
      crawlCandidates: true,
    });

    const output = await service.search("deep crawl test", { crawlDepth: 1 });

    assert.equal(output.results.length, 1);
    assert.equal(output.results[0]?.title, "Root Seed Article");
    assert(output.results[0]!.content.includes("Root Content"));
  });
});
