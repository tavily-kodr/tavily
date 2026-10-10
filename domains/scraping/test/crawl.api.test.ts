import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createScrapingApp } from "../src/app.js";
import { createCrawlRouter } from "../src/routes/crawl.routes.js";
import { CrawlController } from "../src/controllers/crawl.controller.js";
import { CrawlerService } from "../src/services/crawler.service.js";
import { ScraperService } from "../src/services/scraper.service.js";
import { HttpFetcher } from "../src/clients/http-fetcher.js";
import type { HttpRequestContext, HttpTransportFn } from "../src/types/scraping.types.js";

const PUBLIC_DNS = async () => ["93.184.216.34"];

function createMockTransport(
  pagesMap: Record<string, string>,
  options: { errorUrls?: Set<string>; slowUrls?: Set<string> } = {},
): HttpTransportFn {
  return async (ctx: HttpRequestContext) => {
    if (options.errorUrls?.has(ctx.url)) {
      throw new Error(`Simulated network failure on '${ctx.url}'`);
    }

    if (options.slowUrls?.has(ctx.url)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const html = pagesMap[ctx.url];
    if (html === undefined) {
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 404,
        contentType: ctx.url.endsWith(".txt") ? "text/plain" : "text/html",
        headers: { "content-type": ctx.url.endsWith(".txt") ? "text/plain" : "text/html" },
        body: "<h1>404 Not Found</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    }

    return {
      requestedUrl: ctx.url,
      finalUrl: ctx.url,
      statusCode: 200,
      contentType: ctx.url.endsWith(".txt") ? "text/plain" : "text/html",
      headers: { "content-type": ctx.url.endsWith(".txt") ? "text/plain" : "text/html" },
      body: html,
      resolvedIp: ctx.pinnedIp,
    };
  };
}

describe("Crawl API Integration Endpoints", () => {
  let server: Server;
  let baseUrl: string;

  const mockPages: Record<string, string> = {
    "https://example.com/seed": `
      <!DOCTYPE html>
      <html>
        <head><title>Seed Title</title><meta name="description" content="Seed description" /></head>
        <body>
          <h1>Welcome to Seed</h1>
          <p>Main content for crawling test.</p>
          <a href="https://example.com/page1">Page 1</a>
          <a href="https://example.com/failed-child">Broken Child</a>
        </body>
      </html>
    `,
    "https://example.com/page1": `
      <!DOCTYPE html>
      <html>
        <head><title>Page One</title></head>
        <body><h1>Page One Content</h1></body>
      </html>
    `,
    "https://example.com/robots.txt": `
      User-agent: *
      Disallow: /admin
    `,
    "https://example.com/admin": `
      <!DOCTYPE html>
      <html><body><h1>Admin Page</h1></body></html>
    `,
  };

  before(async () => {
    const errorUrls = new Set(["https://example.com/failed-child"]);
    const slowUrls = new Set(["https://example.com/slow-seed"]);
    const transport = createMockTransport(mockPages, { errorUrls, slowUrls });
    const fetcher = new HttpFetcher(transport);
    const scraper = new ScraperService(fetcher);
    const crawler = new CrawlerService(scraper, fetcher);

    // Subclass or wrap crawler to inject mock DNS into crawl calls for deterministic testing
    const originalCrawl = crawler.crawl.bind(crawler);
    crawler.crawl = async (seedUrl, options) => {
      return originalCrawl(seedUrl, {
        dnsLookup: PUBLIC_DNS,
        ...options,
      });
    };

    const controller = new CrawlController(crawler);
    const router = createCrawlRouter(controller);
    const app = createScrapingApp(router);

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

  it("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });
  });

  it("POST /crawl handles valid request and returns structured crawl results", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/seed",
        max_pages: 5,
        max_depth: 2,
        concurrency: 2,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.seed_url, "https://example.com/seed");
    assert.equal(body.data.canonical_seed_url, "https://example.com/seed");
    assert(Array.isArray(body.data.pages));
    assert.equal(body.data.pages.length, 2); // seed and page1

    // Check page fields
    const seedPage = body.data.pages[0];
    assert.equal(seedPage.url, "https://example.com/seed");
    assert.equal(seedPage.title, "Seed Title");
    assert.equal(seedPage.description, "Seed description");
    assert.equal(seedPage.status_code, 200);
    assert.equal(typeof seedPage.took_ms, "number");

    // Broken child link was captured in failed_pages
    assert.equal(body.data.failed_pages.length, 1);
    assert.equal(body.data.failed_pages[0].url, "https://example.com/failed-child");

    // Metrics are populated
    assert.equal(typeof body.data.metrics.total_discovered, "number");
    assert.equal(typeof body.data.metrics.total_visited, "number");
    assert.equal(body.data.metrics.queue_limit_reached, false);
    assert.equal(body.data.metrics.discarded_due_to_queue_limit, 0);
    assert.equal(typeof body.data.took_ms, "number");
    assert(body.data.took_ms >= 0);
  });

  it("accepts seedUrl camelCase alias in request body", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seedUrl: "https://example.com/seed",
        maxPages: 1,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.pages.length, 1);
  });

  it("returns 400 INVALID_URL when url field is missing or empty", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_URL");
    assert(body.error.message.includes("url"));
  });

  it("returns 400 INVALID_URL for non-http protocols (e.g. file:// or ftp://)", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_URL");
  });

  it("returns 400 INVALID_REQUEST on malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json: ",
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_REQUEST");
  });

  it("returns 400 INVALID_OPTIONS when max_pages exceeds server-side upper bound", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/seed",
        max_pages: 500, // Exceeds upper limit of 50
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_OPTIONS");
  });

  it("strictly forbids client from disabling SSRF protection (FORBIDDEN_OPTION)", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "http://127.0.0.1:8080",
        allowPrivateNetworks: true,
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "FORBIDDEN_OPTION");
  });

  it("blocks SSRF loopback and private IP seed destinations with 400 SSRF_BLOCKED", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:8080" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "SSRF_BLOCKED");
  });

  it("blocks cloud metadata service destinations with 400 SSRF_BLOCKED", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "SSRF_BLOCKED");
  });

  it("returns 403 ROBOTS_DISALLOWED when seed URL is forbidden by robots.txt", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/admin",
        respect_robots_txt: true,
      }),
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "ROBOTS_DISALLOWED");
  });

  it("returns 504 CRAWL_TIMEOUT when crawl exceeds timeout", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/slow-seed",
        timeout_ms: 100, // triggers timeout on 300ms transport
      }),
    });

    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "CRAWL_TIMEOUT");
  });

  it("returns 404 NOT_FOUND for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "NOT_FOUND");
  });

  it("never exposes internal stack traces or internal secrets on errors", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:8080" }),
    });

    const body = await res.json();
    assert.equal(body.success, false);
    // Ensure no stack trace or sensitive fields exist in response
    assert.equal((body as { stack?: unknown }).stack, undefined);
    assert.equal((body.error as { stack?: unknown }).stack, undefined);
    assert.equal((body.error as { details?: unknown }).details, undefined);
  });
});
