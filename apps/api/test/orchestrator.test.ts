import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { OrchestratorService } from "../src/services/orchestrator.service.js";
import type { SearchService } from "@tavily/searching";
import type { CrawlerEngine } from "@tavily/scraping";

describe("Unified API Orchestrator", () => {
  test("GET /health returns 200 ok", async () => {
    // Start local ephemeral listener for supertest-free express test
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as { status: string };
      assert.equal(data.status, "ok");
    } finally {
      server.close();
    }
  });

  test("POST /api/search rejects missing query with 400 INVALID_REQUEST", async () => {
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const data = (await res.json()) as { success: boolean; error: { code: string } };
      assert.equal(data.success, false);
      assert.equal(data.error.code, "INVALID_REQUEST");
    } finally {
      server.close();
    }
  });

  test("OrchestratorService merges search ranking with scraped markdown", async () => {
    // Mock SearchService
    const mockSearchService = {
      search: async (query: string) => ({
        query,
        took_ms: 100,
        results: [
          {
            title: "Mock Search Result",
            url: "https://example.com/doc",
            content: "Mock snippet from Google",
            score: 1,
          },
        ],
      }),
    } as unknown as SearchService;

    // Mock CrawlerEngine
    const mockCrawlerEngine = {
      extract: async () => ({
        success: true,
        total: 1,
        tookMs: 150,
        results: [
          {
            url: "https://example.com/doc",
            normalizedUrl: "https://example.com/doc",
            title: "Mock Search Result",
            markdown: "# Extracted Title\n\nFull article markdown body.",
            metadata: {
              title: "Mock Search Result",
              contentHash: "hash123",
              byteSize: 500,
              isSpa: false,
              usedPlaywright: false,
            },
            outboundLinks: [],
            tookMs: 150,
          },
        ],
        errors: [],
      }),
    } as unknown as CrawlerEngine;

    const orchestrator = new OrchestratorService(mockSearchService, mockCrawlerEngine);
    const response = await orchestrator.searchAndScrape({ query: "test query" });

    assert.equal(response.query, "test query");
    assert.equal(response.resultsCount, 1);
    assert.equal(response.results[0]?.title, "Mock Search Result");
    assert.equal(response.results[0]?.snippet, "Mock snippet from Google");
    assert.ok(response.results[0]?.markdown.includes("Full article markdown body."));
    assert.ok(response.timings.searchTookMs >= 0);
    assert.ok(response.timings.scrapeTookMs >= 0);
    assert.ok(response.timings.totalTookMs >= 0);
  });

  test("GET /benchmark?format=json runs and returns benchmark metrics", async () => {
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/benchmark?url=https://example.com&combinations=2:1&format=json`,
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        success: boolean;
        data: {
          targetUrl: string;
          results: Array<{ maxUrl: number; maxDepth: number; durationMs: number }>;
        };
      };
      assert.equal(data.success, true);
      assert.equal(data.data.results.length, 1);
      assert.equal(data.data.results[0]?.maxUrl, 2);
      assert.equal(data.data.results[0]?.maxDepth, 1);
      assert.ok(data.data.results[0]?.durationMs >= 0);
    } finally {
      server.close();
    }
  });

  test("GET / with crawl=true parameters parses max_url and max_depth defaults correctly", async () => {
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/?q=https://example.com&crawl=true&max_url=2&max_depth=1`,
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        success: boolean;
        data: { seedUrl: string; crawl: { stats: { totalCrawled: number } } };
      };
      assert.equal(data.success, true);
      assert.equal(data.data.seedUrl, "https://example.com");
      assert.ok(data.data.crawl.stats.totalCrawled >= 1);
    } finally {
      server.close();
    }
  });

  test("GET /benchmark with multiple comma-separated URLs tests across distinct domains", async () => {
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/benchmark?url=https://example.com,https://example.org&combinations=2:1&format=json`,
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        success: boolean;
        data: {
          targetUrls: string[];
          allDomainsCrawled: string[];
          results: Array<{ domainsCrawledCount: number }>;
        };
      };
      assert.equal(data.success, true);
      assert.equal(data.data.targetUrls.length, 2);
      assert.ok(data.data.allDomainsCrawled.includes("example.com"));
      assert.ok(data.data.allDomainsCrawled.includes("example.org"));
    } finally {
      server.close();
    }
  });
});
