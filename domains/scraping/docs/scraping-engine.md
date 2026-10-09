# Scraping & Crawling Engine Documentation

This document describes the high-performance, AI-native Crawler, URL Mapper, and Markdown Extractor implemented under [`domains/scraping`](file:///c:/Users/chhet/OneDrive/Desktop/Final/tavily/domains/scraping).

---

## 1. System Overview

The `@tavily/scraping` domain provides a complete web crawling, site mapping, and high-fidelity HTML-to-Markdown extraction engine built in TypeScript (Node.js 20+). It is strictly decoupled from search engines and operates autonomously, with optional integration to the Search domain (`domains/searching`) for query-driven URL discovery.

### Core Capabilities

- **Resilient Network Fetcher**: Connection pooling via `undici.Agent`, strict streaming byte limits (10MB cap), and manual redirect following with per-hop SSRF validation.
- **Enterprise SSRF Defense**: Asynchronous DNS resolution via `node:dns/promises` blocking loopback, RFC1918 private subnets, carrier-grade NAT, and cloud metadata endpoints (`169.254.169.254`).
- **High-Fidelity Markdown Extraction**: DOM sanitization, OpenGraph metadata parsing, outbound link discovery, content density analysis, and SPA detection with Playwright headless fallback.
- **Dual Deduplication**: Normalized canonical URL tracking and deterministic SHA-256 markdown hashing.
- **Deep BFS Crawler**: Bounded FIFO BFS queue (`InMemoryFrontier`), rate limiting (`CrawlScheduler` with `p-limit`), `robots.txt` longest-prefix rule matching, and recursive XML sitemap traversal (`fast-xml-parser`).
- **Storage Layer**: Directory-traversal protected `FileSystemStorage` outputting `manifest.json`, `page-###.json`, and `page-###.md` with structured YAML frontmatter.
- **Fastify REST API & CLI**: High-throughput REST API with Swagger OpenAPI documentation (`/docs`) and a standalone CLI tool.

---

## 2. Architecture & Data Flow

```text
Client / CLI
  │
  ▼
Fastify API (app.ts) / CLI (cli.ts)
  │
  ▼
CrawlerEngine (core/engine.ts)
  │
  ├──► RobotsManager (core/robots.ts) ──► robots.txt rules + sitemaps
  ├──► SitemapParser (core/sitemap.ts) ──► recursive XML <sitemapindex>
  ├──► InMemoryFrontier (core/frontier.ts) ──► bounded FIFO BFS queue
  ├──► CrawlScheduler (core/scheduler.ts) ──► global & per-host p-limit
  ├──► Deduplicator (core/deduplicator.ts) ──► URLs + SHA-256 hashes
  │
  ├──► HttpFetcher (fetcher/client.ts)
  │      ├──► validateSsrf() (url/ssrf.ts) [on initial + every redirect hop]
  │      └──► Undici streaming response limiter (10MB cap)
  │
  ├──► HtmlExtractor (extractor/engine.ts)
  │      ├──► extractMetadata() (extractor/metadata.ts) [OG tags, canonical]
  │      ├──► extractOutboundLinks() (extractor/links.ts)
  │      ├──► isSpaPage() ──► renderWithPlaywright() (extractor/playwright.ts)
  │      ├──► sanitizeDom() (extractor/sanitizer.ts) [noise, ads, cookies]
  │      ├──► selectDenseContent() (extractor/density.ts) [<main>, <article>]
  │      └──► htmlToMarkdown() (extractor/markdown.ts) [Turndown + GFM]
  │
  └──► CrawlStorage (storage/file.storage.ts)
         ├──► manifest.json
         ├──► page-0001.json
         └──► page-0001.md (YAML frontmatter + markdown)
```

---

## 3. Module Breakdown

### 1. Types & Errors (`src/types/`)

- `CrawlItemState`: State machine (`DISCOVERED`, `QUEUED`, `FETCHING`, `EXTRACTING`, `COMPLETED`, `RETRYABLE_FAILURE`, `PERMANENT_FAILURE`).
- `CrawlError` hierarchy extending `@tavily/errors`'s `AppError`:
  - `InvalidUrlError` (400)
  - `SsrfBlockedError` (403)
  - `FetchTimeoutError` (504)
  - `RobotsBlockedError` (403)
  - `ResponseTooLargeError` (413)
  - `HttpError` (HTTP status code, `retryable` boolean)
  - `RateLimitedError` (429, `retryAfterSeconds`)
- Zod schemas: `ExtractRequestSchema`, `MapRequestSchema`, `CrawlRequestSchema`.

### 2. URL Utilities & SSRF Defense (`src/url/`)

- `normalizeUrl`: Enforces lowercase hostname, strips default ports (`:80`, `:443`), removes hash fragments, removes tracking query parameters (`utm_*`, `gclid`, `fbclid`, etc.), sorts remaining queries, and canonicalizes redundant slashes.
- `matchesPathRules` & `matchesDomainRules`: Evaluates path and domain rules supporting wildcards and regex, with strict **Exclusion over Inclusion** precedence.
- `validateSsrf`: Enterprise SSRF validator resolving DNS asynchronously and blocking:
  - IPv4: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (Cloud metadata `169.254.169.254`), `0.0.0.0/8`, `100.64.0.0/10`, `255.255.255.255`.
  - IPv6: `::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped IPv6 `::ffff:0:0/96`, `::`.

### 3. Resilient HTTP Fetcher (`src/fetcher/`)

- `HttpFetcher`: Built on `undici.Agent` with connection pooling.
- Stream byte limiter: Aborts streams exceeding `maxBytes` (default 10MB) throwing `ResponseTooLargeError`.
- Manual redirect follower: Intercepts `3xx` redirects up to 5 hops and executes `validateSsrf()` on each hop.
- Exponential backoff with full jitter and `Retry-After` header parsing for transient errors (`408`, `429`, `5xx`, timeouts).

### 4. High-Fidelity Extractor (`src/extractor/`)

- `extractMetadata`: Extracts OpenGraph (`og:*`), Twitter tags, `<title>`, meta description, canonical URL, and language before DOM mutation.
- `extractOutboundLinks`: Gathers `<a href>` links before cleanup.
- `sanitizeDom`: Strips scripts, styles, noscript, iframes, SVGs, dialogs, canvas, ads (`[class*='ad-']`), and cookie banners (`.cookie-banner`).
- `selectDenseContent`: Content density analyzer targeting `<main>`, `<article>`, `[role='main']`, `#content`, `.content`.
- `isSpaPage` & `renderWithPlaywright`: Heuristic SPA detection with dynamic Playwright headless browser fallback.
- `htmlToMarkdown`: Turndown converter with GitHub Flavored Markdown (GFM) and deterministic SHA-256 hashing.

### 5. Storage Engine (`src/storage/`)

- `FileSystemStorage`: Directory-traversal protected filesystem persistence:
  - `manifest.json`: Crawl configuration, summary stats, duration, and page counts.
  - `page-####.json`: Complete `PageRecord` JSON structure.
  - `page-####.md`: Clean Markdown prefixed with YAML frontmatter.
- `InMemoryStorage`: Fast, ephemeral in-memory Map storage for testing and memory-only runs.

### 6. Crawler Core Engine (`src/core/`)

- `RobotsManager`: Origin-cached `robots.txt` parser with longest-prefix match rule evaluation and sitemap directive discovery.
- `SitemapParser`: Recursive XML sitemap index traversal (up to 5 levels) extracting all `<loc>` entries using `fast-xml-parser`.
- `InMemoryFrontier`: FIFO BFS queue bounded by `maxDepth`, per-depth `maxBreadth`, and maximum capacity.
- `CrawlScheduler`: Dual concurrency limiter enforcing global concurrency and per-domain limits using `p-limit`.
- `Deduplicator`: Tracks visited canonical URLs and SHA-256 markdown hashes.
- `SearchServiceClient`: Decoupled HTTP client connecting to `domains/searching` (`http://localhost:3000/search`).

---

## 4. API Endpoints

The API server runs on port `3001` (by default) and serves OpenAPI Swagger documentation at `http://localhost:3001/docs`.

### 1. `POST /v1/extract`

Batch scrapes web pages to Markdown.

**Request Body:**

```json
{
  "urls": ["https://example.com/article-1", "https://example.com/article-2"],
  "includeImages": false,
  "fallbackToPlaywright": false
}
```

_Or query-driven extraction using the Search domain:_

```json
{
  "query": "artificial intelligence advances 2026",
  "includeImages": false
}
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "total": 2,
  "results": [
    {
      "url": "https://example.com/article-1",
      "normalizedUrl": "https://example.com/article-1",
      "title": "Article Title",
      "markdown": "# Article Title\n\nContent...",
      "metadata": {
        "title": "Article Title",
        "description": "...",
        "canonicalUrl": "https://example.com/article-1",
        "language": "en",
        "contentHash": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        "byteSize": 15420,
        "isSpa": false,
        "usedPlaywright": false
      },
      "outboundLinks": ["https://example.com/page-2"],
      "tookMs": 240
    }
  ],
  "errors": [],
  "tookMs": 350
}
```

---

### 2. `POST /v1/map`

Discovers URLs across a target domain using sitemaps and shallow BFS without downloading heavy payloads.

**Request Body:**

```json
{
  "url": "https://example.com",
  "maxDepth": 2,
  "maxBreadth": 50,
  "limit": 100,
  "selectPaths": ["/blog/*"],
  "excludePaths": ["/blog/drafts/*"]
}
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "rootUrl": "https://example.com",
  "totalUrls": 42,
  "urls": [
    "https://example.com",
    "https://example.com/blog/intro",
    "https://example.com/blog/deep-dive"
  ],
  "durationMs": 520
}
```

---

### 3. `POST /v1/crawl`

Initiates a deep recursive BFS crawl with frontier queueing, concurrency rate-limiting, and disk persistence.

**Request Body:**

```json
{
  "url": "https://example.com",
  "limit": 50,
  "maxDepth": 2,
  "maxBreadth": 50,
  "crawlTimeoutMs": 60000,
  "selectPaths": ["/docs/*"],
  "excludePaths": ["/docs/v1/*"],
  "allowExternal": false,
  "ignoreRobots": false,
  "enablePlaywrightFallback": false
}
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "crawlId": "crawl_1791465200000_a1b2c3d4",
  "stats": {
    "totalDiscovered": 85,
    "totalCrawled": 50,
    "totalFailed": 0,
    "totalSkipped": 2,
    "totalBytes": 1258400,
    "durationMs": 4820
  },
  "pages": [
    {
      "url": "https://example.com",
      "normalizedUrl": "https://example.com",
      "state": "COMPLETED",
      "depth": 0,
      "statusCode": 200,
      "metadata": { ... },
      "markdown": "...",
      "outboundLinks": [ ... ],
      "tookMs": 140,
      "timestamp": "2026-10-09T15:00:00.000Z"
    }
  ]
}
```

---

### 4. System Endpoints

- `GET /health`: Returns `{"status": "ok"}`
- `GET /ready`: Returns `{"status": "ready"}`
- `GET /metrics`: Returns uptime, memory usage, and Node.js version.

---

## 5. CLI Usage

A standalone CLI tool is included under `src/cli.ts`:

```bash
# 1. Scrape single or multiple URLs
pnpm --filter @tavily/scraping cli extract https://example.com

# 2. Scrape top results from Search service query
pnpm --filter @tavily/scraping cli extract --query "best places to visit in India"

# 3. Map URL topology
pnpm --filter @tavily/scraping cli map https://example.com --depth 2 --limit 50

# 4. Deep crawl and save to disk
pnpm --filter @tavily/scraping cli crawl https://example.com --limit 30 --depth 2 --storage ./storage
```

---

## 6. Development & Testing

From repository root:

```powershell
# Typecheck
pnpm --filter @tavily/scraping typecheck

# Build
pnpm --filter @tavily/scraping build

# Run unit & integration test suite
pnpm --filter @tavily/scraping test

# Start API server in dev/watch mode
pnpm --filter @tavily/scraping dev
```
