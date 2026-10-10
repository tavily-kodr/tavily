import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createSearchApp } from "../src/app.js";
import { createSearchRouter } from "../src/routes/search.routes.js";
import { SearchController } from "../src/controllers/search.controller.js";
import { SearchService } from "../src/services/search.service.js";
import { SearxngClient } from "../src/clients/searxng.client.js";
import {
  CrawlerService,
  ScraperService,
  HttpFetcher,
  CrawlController,
  createCrawlRouter,
  type HttpRequestContext,
  type HttpTransportFn,
} from "@tavily/scraping";
import type { SearxngRawResponse } from "../src/types/search.types.js";

const PUBLIC_DNS = async () => ["93.184.216.34"];

function createMockTransport(pagesMap: Record<string, string>): HttpTransportFn {
  return async (ctx: HttpRequestContext) => {
    const html = pagesMap[ctx.url];
    if (html === undefined) {
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
    return {
      requestedUrl: ctx.url,
      finalUrl: ctx.url,
      statusCode: 200,
      contentType: "text/html",
      headers: { "content-type": "text/html" },
      body: html,
      resolvedIp: ctx.pinnedIp,
    };
  };
}

describe("Search Pipeline with Integrated Crawling Integration Tests", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/guide": `
        <html>
          <head>
            <title>Complete Web Development Guide</title>
            <link rel="canonical" href="https://example.com/web-dev-guide" />
          </head>
          <body>
            <header><nav><a href="/">Home</a></nav></header>
            <main>
              <h1>Web Development Guide</h1>
              <p>Learn frontend and backend development with modern best practices.</p>
            </main>
            <footer><p>Copyright 2026</p></footer>
          </body>
        </html>
      `,
      "https://example.com/blog": `
        <html>
          <head><title>Engineering Blog</title></head>
          <body><h1>Engineering Insights</h1><p>Articles on distributed systems.</p></body>
        </html>
      `,
      "https://example.com/crawl-seed": `
        <html>
          <head><title>Crawl Seed Page</title></head>
          <body>
            <h1>Seed Section</h1>
            <a href="https://example.com/crawl-subpage">Subpage</a>
          </body>
        </html>
      `,
      "https://example.com/crawl-subpage": `
        <html><head><title>Subpage</title></head><body><h1>Subpage Content</h1></body></html>
      `,
    };

    const mockSearxngClient = {
      search: async (query: string): Promise<SearxngRawResponse> => {
        if (query === "web dev") {
          return {
            query: "web dev",
            results: [
              {
                title: "Web Dev Search Title",
                url: "https://example.com/guide",
                content: "Upstream snippet from Google via SearXNG",
                score: 1.0,
              },
              {
                title: "Engineering Blog Title",
                url: "https://example.com/blog",
                content: "Blog snippet from Google",
                score: 0.8,
              },
              {
                title: "Broken Link",
                url: "https://example.com/missing-page",
                content: "Broken link snippet",
                score: 0.5,
              },
              {
                title: "Loopback Attack",
                url: "http://127.0.0.1:8080/internal",
                content: "internal leak",
                score: 0.2,
              },
            ],
          };
        }

        return { query, results: [] };
      },
    } as unknown as SearxngClient;

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const scraper = new ScraperService(fetcher);
    const crawler = new CrawlerService(scraper, fetcher);

    // Deterministic DNS for crawler
    const originalCrawl = crawler.crawl.bind(crawler);
    crawler.crawl = async (seedUrl, options) => {
      return originalCrawl(seedUrl, {
        dnsLookup: PUBLIC_DNS,
        ...options,
      });
    };

    const searchService = new SearchService({
      client: mockSearxngClient,
      scraper,
      crawler,
      fetcher,
      crawlCandidates: true,
      maxCrawlResults: 5,
      crawlConcurrency: 2,
    });

    const searchController = new SearchController(searchService);
    const crawlController = new CrawlController(crawler);

    const customSearchRouter = createSearchRouter(searchController);
    const customCrawlRouter = createCrawlRouter(crawlController);

    const app = createSearchApp(customSearchRouter, customCrawlRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number; address: string };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POST /search retrieves candidate URLs and crawls content into structured results", async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "web dev" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.query, "web dev");
    assert(typeof body.data.took_ms === "number");

    // Loopback candidate should be excluded, leaving 3 candidates
    assert.equal(body.data.results.length, 3);

    // 1. First candidate: successfully crawled & enriched
    const first = body.data.results[0];
    assert.equal(first.title, "Complete Web Development Guide");
    assert.equal(first.url, "https://example.com/guide");
    assert(
      first.content.includes("Learn frontend and backend development with modern best practices"),
    );
    assert.equal(first.snippet, "Upstream snippet from Google via SearXNG");
    assert.equal(first.canonicalUrl, "https://example.com/web-dev-guide");
    assert.equal(first.sourceUrl, "https://example.com/guide");
    assert.equal(first.score, 1.0);

    // 2. Second candidate: successfully crawled & enriched
    const second = body.data.results[1];
    assert.equal(second.title, "Engineering Blog");
    assert.equal(second.url, "https://example.com/blog");
    assert(second.content.includes("Articles on distributed systems"));
    assert.equal(second.snippet, "Blog snippet from Google");

    // 3. Third candidate: 404 page gracefully falls back to search snippet
    const third = body.data.results[2];
    assert.equal(third.title, "Broken Link");
    assert.equal(third.url, "https://example.com/missing-page");
    assert.equal(third.content, "Broken link snippet");
    assert.equal(third.snippet, "Broken link snippet");
  });

  it("POST /search with crawl: false bypasses page crawling and returns raw snippets", async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "web dev", crawl: false }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.results.length, 3);

    // Without crawl, content is the original SearXNG snippet
    assert.equal(body.data.results[0].content, "Upstream snippet from Google via SearXNG");
    assert.equal(body.data.results[0].title, "Web Dev Search Title");
  });

  it("POST /crawl continues to function on the unified application", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/crawl-seed",
        max_pages: 5,
        max_depth: 2,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.seed_url, "https://example.com/crawl-seed");
    assert.equal(body.data.pages.length, 2);
    assert.equal(body.data.pages[0].title, "Crawl Seed Page");
    assert.equal(body.data.pages[1].title, "Subpage");
  });

  it("blocks SSRF loopback in POST /search and POST /crawl", async () => {
    const crawlRes = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:8080" }),
    });
    assert.equal(crawlRes.status, 400);
    const crawlBody = await crawlRes.json();
    assert.equal(crawlBody.error.code, "SSRF_BLOCKED");
  });
});
