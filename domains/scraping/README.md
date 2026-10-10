# @tavily/scraping

High-performance, SSRF-protected web crawling, single-page scraping, and semantic HTML extraction package for the Tavily search engine monorepo.

> [!NOTE]
> For the comprehensive engineering architecture, request lifecycles, security safeguards, configuration references, and manager review checklist, see the **[Crawling & Scraping Engine Guide](./docs/crawling-and-scraping.md)**.

---

## Features

- **Single-Page Scraper (`ScraperService`)**: High-throughput webpage retrieval and semantic HTML cleaning.
- **Multi-Page BFS Crawler (`CrawlerService`)**: Autonomous graph traversal with bounded depth, max pages, queue limits, and per-origin rate limiting (`OriginRateLimiter`).
- **Low-Level HTTP Client (`HttpFetcher`)**: Streaming Node.js `http`/`https` client with DNS pinning (`createPinnedLookup`), TLS SNI preservation, 5 MB stream size caps, and `AbortSignal` timeout handling.
- **Industrial SSRF Protection (`ssrf-guard`)**: Validates IPv4 (RFC 1122, 1918, 3927, 6598, 6890), IPv6, cloud metadata (`169.254.169.254`), and enforces anti-round-robin multi-IP DNS checks.
- **Zero-Dependency HTML Extractor (`html-extractor`)**: Strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>`, ads, and comments. Decodes entities and returns clean, LLM-ready semantic text.
- **RFC 9309 Robots Parser (`RobotsPolicy`)**: Longest-match rule precedence with `Crawl-delay` support.
- **Standalone Crawl Microservice (`app.ts` / `server.ts`)**: Express API exposing `POST /crawl` and `GET /health` on port `3001`.

---

## Quick Start

### Installation

From the monorepo root:

```bash
pnpm install
```

### Running Tests

```bash
pnpm --filter @tavily/scraping test
```

_Executes all 147 unit and integration tests across 34 suites._

### Programmatic Usage

```typescript
import { ScraperService, HttpFetcher } from "@tavily/scraping";

const fetcher = new HttpFetcher();
const scraper = new ScraperService(fetcher);

// Scrape a single webpage safely with SSRF protection
const page = await scraper.scrape("https://example.com", {
  timeoutMs: 5000,
});

console.log("Title:", page.title);
console.log("Canonical URL:", page.canonicalUrl);
console.log("Cleaned Text:", page.text);
```

### Multi-Page Traversal

```typescript
import { CrawlerService } from "@tavily/scraping";

const crawler = new CrawlerService();

const crawlResult = await crawler.crawl("https://example.com", {
  maxPages: 5,
  maxDepth: 1,
  sameDomainOnly: true,
  concurrency: 2,
});

console.log(`Crawled ${crawlResult.pages.length} pages:`);
for (const page of crawlResult.pages) {
  console.log(`- [Depth ${page.depth}] ${page.title} (${page.url})`);
}
```

### Standalone API Server

Run as an independent microservice on port `3001`:

```bash
pnpm --filter @tavily/scraping start
```

Trigger a crawl:

```bash
curl -X POST http://localhost:3001/crawl \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","max_pages":3,"max_depth":1}'
```

---

## Detailed Documentation

- **[Architecture & Engineering Guide](./docs/crawling-and-scraping.md)**
- **[Configuration Reference](./docs/crawling-and-scraping.md#4-configuration-reference)**
- **[Security & SSRF Safeguards](./docs/crawling-and-scraping.md#5-security--error-handling-safeguards)**
- **[Benchmarking & Reports](./docs/crawling-and-scraping.md#7-benchmarking--performance-harness)**
- **[Manager PR Review Checklist](./docs/crawling-and-scraping.md#9-pr-review-checklist--suggested-review-order)**
