import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@tavily/errors";
import { HttpFetcher } from "../src/clients/http-fetcher.js";
import { ScraperService } from "../src/services/scraper.service.js";
import { CrawlerService } from "../src/services/crawler.service.js";
import type { HttpRequestContext, HttpTransportFn } from "../src/types/scraping.types.js";

const PUBLIC_DNS = async () => ["93.184.216.34"];

/**
 * Creates an in-memory transport mapping URLs to HTML content.
 * Completely deterministic with zero socket bindings or external network calls.
 */
function createMockTransport(
  pagesMap: Record<string, string>,
  options: { errorUrls?: Set<string> } = {},
): HttpTransportFn {
  return async (ctx: HttpRequestContext) => {
    if (options.errorUrls?.has(ctx.url)) {
      throw new Error(`Simulated network failure on '${ctx.url}'`);
    }

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

describe("CrawlerService - Validation & Options", () => {
  it("rejects maxPages < 1 with INVALID_OPTIONS", async () => {
    const crawler = new CrawlerService();
    await assert.rejects(
      async () => crawler.crawl("https://example.com", { maxPages: 0, dnsLookup: PUBLIC_DNS }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_OPTIONS");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("rejects maxDepth < 0 with INVALID_OPTIONS", async () => {
    const crawler = new CrawlerService();
    await assert.rejects(
      async () => crawler.crawl("https://example.com", { maxDepth: -1, dnsLookup: PUBLIC_DNS }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_OPTIONS");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("fails the entire crawl if the seed URL is invalid syntax", async () => {
    const crawler = new CrawlerService();
    await assert.rejects(
      async () => crawler.crawl("not-a-valid-url"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("fails the entire crawl if the seed URL resolves to a private IP (SSRF guard)", async () => {
    const crawler = new CrawlerService();
    await assert.rejects(
      async () => crawler.crawl("http://127.0.0.1:8080"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("fails the entire crawl if the seed page itself fails to fetch", async () => {
    const mockTransport = createMockTransport(
      {},
      { errorUrls: new Set(["https://example.com/start"]) },
    );
    const fetcher = new HttpFetcher(mockTransport);
    const scraper = new ScraperService(fetcher);
    const crawler = new CrawlerService(scraper);

    await assert.rejects(
      async () => crawler.crawl("https://example.com/start", { dnsLookup: PUBLIC_DNS }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SEED_FETCH_FAILED");
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
  });
});

describe("CrawlerService - FIFO Queue Order & Traversal", () => {
  it("crawls pages in breadth-first FIFO order (depth 0, then depth 1, then depth 2)", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <h1>Seed Page</h1>
          <a href="https://example.com/depth-1a">Link 1A</a>
          <a href="https://example.com/depth-1b">Link 1B</a>
        </body></html>
      `,
      "https://example.com/depth-1a": `
        <html><body>
          <h1>Page 1A</h1>
          <a href="https://example.com/depth-2a">Link 2A</a>
        </body></html>
      `,
      "https://example.com/depth-1b": `
        <html><body>
          <h1>Page 1B</h1>
          <a href="https://example.com/depth-2b">Link 2B</a>
        </body></html>
      `,
      "https://example.com/depth-2a": "<html><body><h1>Page 2A</h1></body></html>",
      "https://example.com/depth-2b": "<html><body><h1>Page 2B</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      maxDepth: 2,
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 5);
    // Verified breadth-first order:
    // 0: seed (depth 0)
    // 1: depth-1a (depth 1)
    // 2: depth-1b (depth 1)
    // 3: depth-2a (depth 2)
    // 4: depth-2b (depth 2)
    assert.deepEqual(
      result.pages.map((p) => ({ url: p.url, depth: p.depth })),
      [
        { url: "https://example.com/seed", depth: 0 },
        { url: "https://example.com/depth-1a", depth: 1 },
        { url: "https://example.com/depth-1b", depth: 1 },
        { url: "https://example.com/depth-2a", depth: 2 },
        { url: "https://example.com/depth-2b", depth: 2 },
      ],
    );
  });
});

describe("CrawlerService - Deduplication & Canonical URLs", () => {
  it("prevents cyclical and duplicate canonical URLs from being crawled repeatedly", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/page-a": `
        <html><body>
          <h1>Page A</h1>
          <!-- Multiple links to Page B, with varying fragments and trailing slashes -->
          <a href="https://example.com/page-b">Page B</a>
          <a href="https://example.com/page-b#section">Page B with Hash</a>
          <a href="https://example.com/page-b/">Page B with Slash</a>
        </body></html>
      `,
      "https://example.com/page-b": `
        <html><body>
          <h1>Page B</h1>
          <!-- Circular link back to Page A -->
          <a href="https://example.com/page-a">Back to A</a>
        </body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/page-a", {
      maxDepth: 3,
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    // Exactly 2 pages scraped: Page A and Page B
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.url, "https://example.com/page-a");
    assert.equal(result.pages[1]?.url, "https://example.com/page-b");
    assert.equal(result.failedPages.length, 0);
  });
});

describe("CrawlerService - Depth & Page Limits", () => {
  it("strictly enforces maxDepth limit and does not enqueue links beyond maxDepth", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/level-0": `
        <html><body><a href="https://example.com/level-1">L1</a></body></html>
      `,
      "https://example.com/level-1": `
        <html><body><a href="https://example.com/level-2">L2</a></body></html>
      `,
      "https://example.com/level-2": `
        <html><body><a href="https://example.com/level-3">L3</a></body></html>
      `,
      "https://example.com/level-3": `
        <html><body><h1>L3</h1></body></html>
      `,
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/level-0", {
      maxDepth: 1,
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    // Seed (depth 0) + level-1 (depth 1)
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.depth, 0);
    assert.equal(result.pages[1]?.depth, 1);
  });

  it("strictly respects maxDepth = 0 by only crawling the seed page", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <h1>Seed Page</h1>
          <a href="https://example.com/page-1">Page 1</a>
        </body></html>
      `,
      "https://example.com/page-1": "<html><body><h1>Page 1</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      maxDepth: 0,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]?.url, "https://example.com/seed");
    assert.equal(result.pages[0]?.depth, 0);
  });

  it("strictly stops when maxPages limit is reached", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/p1">P1</a>
          <a href="https://example.com/p2">P2</a>
          <a href="https://example.com/p3">P3</a>
          <a href="https://example.com/p4">P4</a>
        </body></html>
      `,
      "https://example.com/p1": "<html><body><h1>P1</h1></body></html>",
      "https://example.com/p2": "<html><body><h1>P2</h1></body></html>",
      "https://example.com/p3": "<html><body><h1>P3</h1></body></html>",
      "https://example.com/p4": "<html><body><h1>P4</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      maxPages: 3,
      maxDepth: 2,
      dnsLookup: PUBLIC_DNS,
    });

    // Exactly 3 pages scraped (seed + p1 + p2)
    assert.equal(result.pages.length, 3);
  });
});

describe("CrawlerService - Fault Isolation (Non-Seed Failures)", () => {
  it("isolates individual page failures and continues crawling remaining pages", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/good-1">Good 1</a>
          <a href="https://example.com/broken-page">Broken Page</a>
          <a href="https://example.com/good-2">Good 2</a>
        </body></html>
      `,
      "https://example.com/good-1": `
        <html><body><h1>Good 1</h1></body></html>
      `,
      // broken-page is simulated as network failure
      "https://example.com/good-2": `
        <html><body><h1>Good 2</h1></body></html>
      `,
    };

    const mockTransport = createMockTransport(pagesMap, {
      errorUrls: new Set(["https://example.com/broken-page"]),
    });
    const fetcher = new HttpFetcher(mockTransport);
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    // Successful pages: seed, good-1, good-2
    assert.equal(result.pages.length, 3);
    assert.deepEqual(
      result.pages.map((p) => p.url),
      ["https://example.com/seed", "https://example.com/good-1", "https://example.com/good-2"],
    );

    // Failed page recorded with depth and error message
    assert.equal(result.failedPages.length, 1);
    assert.equal(result.failedPages[0]?.url, "https://example.com/broken-page");
    assert.equal(result.failedPages[0]?.depth, 1);
    assert(result.failedPages[0]?.error.includes("Simulated network failure"));
  });

  it("handles HTTP 404 on discovered pages without aborting the crawl", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/missing-404">Missing</a>
          <a href="https://example.com/available">Available</a>
        </body></html>
      `,
      "https://example.com/available": "<html><body><h1>Available</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 2);
    assert.equal(result.failedPages.length, 1);
    assert.equal(result.failedPages[0]?.url, "https://example.com/missing-404");
    assert.equal(result.failedPages[0]?.code, "HTTP_ERROR");
  });
});

describe("CrawlerService - Discovered Link Security & SSRF Protection", () => {
  it("rejects unsafe discovered URLs (localhost, private IP, metadata) before queueing", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <h1>Public Page with Unsafe Links</h1>
          <!-- Target 1: Localhost -->
          <a href="http://localhost:8080/admin">Localhost Admin</a>
          <!-- Target 2: Cloud metadata IP -->
          <a href="http://169.254.169.254/latest/meta-data/">Cloud Metadata</a>
          <!-- Target 3: Private RFC 1918 -->
          <a href="http://10.0.0.1/router">Internal Router</a>
          <!-- Target 4: Safe discovered page -->
          <a href="https://example.com/safe-child">Safe Child</a>
        </body></html>
      `,
      "https://example.com/safe-child": "<html><body><h1>Safe Child</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/seed", {
      dnsLookup: PUBLIC_DNS,
      sameDomainOnly: false, // Allow checking out-of-domain SSRF links
    });

    // Only seed and safe-child successfully crawled
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.url, "https://example.com/seed");
    assert.equal(result.pages[1]?.url, "https://example.com/safe-child");

    // All 3 unsafe links are captured in failedPages with SSRF_BLOCKED code
    assert.equal(result.failedPages.length, 3);
    for (const failed of result.failedPages) {
      assert.equal(failed.code, "SSRF_BLOCKED");
    }
  });

  it("strictly filters cross-domain links when sameDomainOnly is true (default)", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/home": `
        <html><body>
          <a href="https://example.com/internal-about">About Us</a>
          <a href="https://external-service.org/docs">External Docs</a>
        </body></html>
      `,
      "https://example.com/internal-about": "<html><body><h1>About</h1></body></html>",
      "https://external-service.org/docs": "<html><body><h1>Docs</h1></body></html>",
    };

    const fetcher = new HttpFetcher(createMockTransport(pagesMap));
    const crawler = new CrawlerService(new ScraperService(fetcher));

    const result = await crawler.crawl("https://example.com/home", {
      sameDomainOnly: true,
      dnsLookup: PUBLIC_DNS,
    });

    // Only example.com pages are crawled
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.url, "https://example.com/home");
    assert.equal(result.pages[1]?.url, "https://example.com/internal-about");
    // External link was skipped
    assert.equal(result.failedPages.length, 0);
  });
});

describe("CrawlerService - Phase 3 Bounded Concurrency & Limits", () => {
  it("enforces bounded concurrency strictly without exceeding limit", async () => {
    let currentInFlight = 0;
    let maxObservedInFlight = 0;

    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/page1">1</a>
          <a href="https://example.com/page2">2</a>
          <a href="https://example.com/page3">3</a>
          <a href="https://example.com/page4">4</a>
        </body></html>
      `,
      "https://example.com/page1": "<html><body><h1>1</h1></body></html>",
      "https://example.com/page2": "<html><body><h1>2</h1></body></html>",
      "https://example.com/page3": "<html><body><h1>3</h1></body></html>",
      "https://example.com/page4": "<html><body><h1>4</h1></body></html>",
    };

    const transport: HttpTransportFn = async (ctx) => {
      currentInFlight++;
      if (currentInFlight > maxObservedInFlight) {
        maxObservedInFlight = currentInFlight;
      }
      // Small delay to allow concurrency overlap
      await new Promise((resolve) => setTimeout(resolve, 25));
      currentInFlight--;

      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: pagesMap[ctx.url] ?? "<h1>404</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const crawler = new CrawlerService(new ScraperService(new HttpFetcher(transport)));
    const result = await crawler.crawl("https://example.com/seed", {
      concurrency: 2,
      maxPages: 5,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 5);
    assert(
      maxObservedInFlight <= 2,
      `Expected max in-flight <= 2, observed ${maxObservedInFlight}`,
    );
    assert(
      maxObservedInFlight >= 2,
      `Expected concurrency to reach 2, observed ${maxObservedInFlight}`,
    );
  });

  it("enforces maxPages strictly under concurrent workers without over-fetching", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/p1">1</a>
          <a href="https://example.com/p2">2</a>
          <a href="https://example.com/p3">3</a>
          <a href="https://example.com/p4">4</a>
          <a href="https://example.com/p5">5</a>
        </body></html>
      `,
      "https://example.com/p1": "<html><body>1</body></html>",
      "https://example.com/p2": "<html><body>2</body></html>",
      "https://example.com/p3": "<html><body>3</body></html>",
      "https://example.com/p4": "<html><body>4</body></html>",
      "https://example.com/p5": "<html><body>5</body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );
    const result = await crawler.crawl("https://example.com/seed", {
      concurrency: 3,
      maxPages: 3,
      dnsLookup: PUBLIC_DNS,
    });

    // Exactly 3 pages returned
    assert.equal(result.pages.length, 3);
  });

  it("enforces maxQueueSize and records discarded links", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/item1">1</a>
          <a href="https://example.com/item2">2</a>
          <a href="https://example.com/item3">3</a>
          <a href="https://example.com/item4">4</a>
          <a href="https://example.com/item5">5</a>
        </body></html>
      `,
      "https://example.com/item1": "<html><body>1</body></html>",
      "https://example.com/item2": "<html><body>2</body></html>",
      "https://example.com/item3": "<html><body>3</body></html>",
      "https://example.com/item4": "<html><body>4</body></html>",
      "https://example.com/item5": "<html><body>5</body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );
    const result = await crawler.crawl("https://example.com/seed", {
      concurrency: 1,
      maxPages: 10,
      maxQueueSize: 2,
      dnsLookup: PUBLIC_DNS,
    });

    // Seed was 1 page, queue held 2 items, remaining 3 links were discarded
    assert.equal(result.pages.length, 3);
    assert.equal(result.queueLimitReached, true);
    assert.equal(result.discardedDueToQueueLimit, 3);
  });

  it("prevents duplicate scheduling when multiple pages discover the same URL", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/child-a">A</a>
          <a href="https://example.com/child-b">B</a>
        </body></html>
      `,
      "https://example.com/child-a": `
        <html><body>
          <a href="https://example.com/shared-target">Target</a>
        </body></html>
      `,
      "https://example.com/child-b": `
        <html><body>
          <a href="https://example.com/shared-target">Target</a>
        </body></html>
      `,
      "https://example.com/shared-target": "<html><body><h1>Target</h1></body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );
    const result = await crawler.crawl("https://example.com/seed", {
      concurrency: 2,
      maxPages: 10,
      dnsLookup: PUBLIC_DNS,
    });

    // Seed, child-a, child-b, shared-target = 4 unique pages
    assert.equal(result.pages.length, 4);
    const targetPages = result.pages.filter((p) => p.url === "https://example.com/shared-target");
    assert.equal(targetPages.length, 1);
  });
});

describe("CrawlerService - Phase 3 Politeness & Delays", () => {
  it("enforces per-origin crawlDelayMs spacing", async () => {
    const requestTimes: number[] = [];

    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/p1">1</a>
          <a href="https://example.com/p2">2</a>
        </body></html>
      `,
      "https://example.com/p1": "<html><body>1</body></html>",
      "https://example.com/p2": "<html><body>2</body></html>",
    };

    const transport: HttpTransportFn = async (ctx) => {
      requestTimes.push(performance.now());
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: pagesMap[ctx.url] ?? "",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const crawler = new CrawlerService(new ScraperService(new HttpFetcher(transport)));
    const delay = 40;
    const result = await crawler.crawl("https://example.com/seed", {
      concurrency: 2,
      crawlDelayMs: delay,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 3);
    assert.equal(requestTimes.length, 3);

    // Verify spacing between successive requests is at least delay (with slight delta tolerance)
    for (let i = 1; i < requestTimes.length; i++) {
      const diff = requestTimes[i]! - requestTimes[i - 1]!;
      assert(diff >= delay - 10, `Expected spacing >= ${delay - 10}ms, got ${diff}ms`);
    }
  });
});

describe("CrawlerService - Phase 3 Cancellation & Timeouts", () => {
  it("aborts crawl immediately when AbortSignal is cancelled", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/seed": `
        <html><body>
          <a href="https://example.com/slow">Slow</a>
        </body></html>
      `,
      "https://example.com/slow": "<html><body>Slow</body></html>",
    };

    const transport: HttpTransportFn = async (ctx) => {
      if (ctx.url.includes("slow")) {
        // Long sleep that should be interrupted
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: pagesMap[ctx.url] ?? "",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const crawler = new CrawlerService(new ScraperService(new HttpFetcher(transport)));
    const controller = new AbortController();

    // Trigger abort shortly after start
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      async () =>
        crawler.crawl("https://example.com/seed", {
          signal: controller.signal,
          dnsLookup: PUBLIC_DNS,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "CRAWL_ABORTED");
        assert.equal(err.statusCode, 499);
        return true;
      },
    );
  });

  it("enforces crawlTimeoutMs overall crawl timeout", async () => {
    const transport: HttpTransportFn = async (ctx) => {
      // Intentionally slow transport to trigger timeout
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<html><body>Content</body></html>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const crawler = new CrawlerService(new ScraperService(new HttpFetcher(transport)));

    await assert.rejects(
      async () =>
        crawler.crawl("https://example.com/seed", {
          crawlTimeoutMs: 30,
          dnsLookup: PUBLIC_DNS,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "CRAWL_TIMEOUT");
        assert.equal(err.statusCode, 504);
        return true;
      },
    );
  });
});

describe("CrawlerService - Phase 3 Robots.txt Compliance", () => {
  it("rejects seed URL upfront if disallowed by robots.txt", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/robots.txt": `
        User-agent: *
        Disallow: /admin
      `,
      "https://example.com/admin": "<html><body><h1>Admin</h1></body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );

    await assert.rejects(
      async () =>
        crawler.crawl("https://example.com/admin", {
          respectRobotsTxt: true,
          dnsLookup: PUBLIC_DNS,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "ROBOTS_DISALLOWED");
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  it("filters discovered URLs disallowed by robots.txt and tracks robotsBlockedCount", async () => {
    const pagesMap: Record<string, string> = {
      "https://example.com/robots.txt": `
        User-agent: *
        Disallow: /blocked-child
      `,
      "https://example.com/home": `
        <html><body>
          <a href="https://example.com/allowed-child">Allowed</a>
          <a href="https://example.com/blocked-child">Blocked</a>
        </body></html>
      `,
      "https://example.com/allowed-child": "<html><body><h1>Allowed</h1></body></html>",
      "https://example.com/blocked-child": "<html><body><h1>Blocked</h1></body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );
    const result = await crawler.crawl("https://example.com/home", {
      respectRobotsTxt: true,
      dnsLookup: PUBLIC_DNS,
    });

    // Home and allowed-child crawled
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.url, "https://example.com/home");
    assert.equal(result.pages[1]?.url, "https://example.com/allowed-child");

    // Blocked link tracked in robotsBlockedCount
    assert.equal(result.robotsBlockedCount, 1);
  });

  it("falls back gracefully to allow-all when robots.txt is 404 Not Found", async () => {
    const pagesMap: Record<string, string> = {
      // No robots.txt entry -> createMockTransport returns 404
      "https://example.com/home": `
        <html><body>
          <a href="https://example.com/doc">Doc</a>
        </body></html>
      `,
      "https://example.com/doc": "<html><body><h1>Doc</h1></body></html>",
    };

    const crawler = new CrawlerService(
      new ScraperService(new HttpFetcher(createMockTransport(pagesMap))),
    );
    const result = await crawler.crawl("https://example.com/home", {
      respectRobotsTxt: true,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 2);
    assert.equal(result.robotsBlockedCount, 0);
  });

  it("adopts Crawl-delay from robots.txt when crawlDelayMs is omitted", async () => {
    const requestTimes: number[] = [];

    const pagesMap: Record<string, string> = {
      "https://example.com/robots.txt": `
        User-agent: *
        Crawl-delay: 0.04
      `,
      "https://example.com/home": `
        <html><body>
          <a href="https://example.com/page1">1</a>
        </body></html>
      `,
      "https://example.com/page1": "<html><body>1</body></html>",
    };

    const transport: HttpTransportFn = async (ctx) => {
      requestTimes.push(performance.now());
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: ctx.url.endsWith(".txt") ? "text/plain" : "text/html",
        headers: { "content-type": ctx.url.endsWith(".txt") ? "text/plain" : "text/html" },
        body: pagesMap[ctx.url] ?? "",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const crawler = new CrawlerService(new ScraperService(new HttpFetcher(transport)));
    const result = await crawler.crawl("https://example.com/home", {
      respectRobotsTxt: true,
      dnsLookup: PUBLIC_DNS,
    });

    assert.equal(result.pages.length, 2);
    // robots.txt request, home request, page1 request
    assert(requestTimes.length >= 3);
  });
});
