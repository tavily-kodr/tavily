import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createSearchApp } from "../src/app.js";
import {
  CrawlerService,
  ScraperService,
  HttpFetcher,
  CrawlController,
  createCrawlRouter,
  type HttpRequestContext,
  type HttpTransportFn,
} from "@tavily/scraping";

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

describe("Unified Search & Crawl API Integration", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/start": `
        <html>
          <head><title>Integration Start</title></head>
          <body>
            <h1>Integration Testing</h1>
            <a href="https://example.com/step2">Next Step</a>
          </body>
        </html>
      `,
      "https://example.com/step2": `
        <html><head><title>Step 2</title></head><body><h1>Step 2</h1></body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher), fetcher);

    // Inject mock DNS for deterministic execution
    const originalCrawl = crawler.crawl.bind(crawler);
    crawler.crawl = async (seedUrl, options) => {
      return originalCrawl(seedUrl, {
        dnsLookup: PUBLIC_DNS,
        ...options,
      });
    };

    const customCrawlRouter = createCrawlRouter(new CrawlController(crawler));
    // createSearchApp mounts both customSearchRouter and customCrawlRouter on the unified API
    const app = createSearchApp(undefined, customCrawlRouter);

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

  it("successfully invokes POST /crawl through the search API app", async () => {
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/start",
        max_pages: 5,
        max_depth: 2,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.seed_url, "https://example.com/start");
    assert.equal(body.data.pages.length, 2);
    assert.equal(body.data.pages[0].title, "Integration Start");
    assert.equal(body.data.pages[1].title, "Step 2");
    assert.equal(body.data.metrics.total_discovered, 2);
  });

  it("blocks SSRF loopback requests through the unified search API app", async () => {
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
});
