# Scraping & Crawling Engine Documentation

This document describes the high-performance, AI-native Crawler, URL Mapper, and Markdown Extractor implemented under [`domains/scraping`](file:///c:/Users/chhet/OneDrive/Desktop/Final/tavily/domains/scraping).

---

## 1. Quick Setup Guide for Other Teams

This quick-start is designed for Backend, Frontend, AI/ML, and DevOps teams integrating with or developing the Scraping service.

### Prerequisites

- **Node.js**: v20.x or v22.x+
- **pnpm**: `pnpm@12.9.1` (`npm install -g pnpm@12.9.1`)
- **Docker Desktop**: Running locally (provides SearXNG on port `8080` for search queries)

### 1.1 Easy Setup Commands

From the repository root:

```bash
# 1. Install workspace dependencies
pnpm install

# 2. (Optional) Install Playwright Chromium for JS-rendered SPA fallback
npx playwright install chromium

# 3. Start Search Engine Infrastructure (Docker)
pnpm docker:up

# 4. Start Development Server
# Option A: Full Unified Orchestrator (Port 4000 - recommended)
pnpm dev

# Option B: Standalone Scraping API only (Port 3001)
pnpm dev:scrape
```

### 1.2 Troubleshooting Common Setup Issues

#### Issue: `Bind for 0.0.0.0:8080 failed: port is already allocated`

- **Cause:** A SearXNG container (e.g. `searxng-core`) or another service is already running on port `8080`.
- **Solution:** SearXNG is likely already running and healthy. Verify with `docker ps`. If you want to recreate it using the repo's compose setup:
  ```bash
  docker stop searxng-core
  pnpm docker:up
  ```

#### Issue: Docker is not installed or running

- **Resilience Behavior:** The engine automatically fails over to an **organic DuckDuckGo search resolver** if Docker/SearXNG is unreachable. Crawling and scraping will continue functioning.

---

## 2. System Overview & Performance Guardrails

The `@tavily/scraping` domain provides web crawling, sitemap discovery, and high-fidelity HTML-to-Markdown extraction. It operates autonomously or unified via `apps/api`.

### 2.1 Sub-3-Second Performance Architecture

The engine incorporates 5 critical performance guardrails to keep batch crawls (5–10 pages across distinct internet domains) **consistently between 2.4s and 3.0s**:

1. **Instant Worker Cancellation (`crawlAbortController`)**:
   As soon as the target page count (`limit`) is fulfilled, in-flight background worker requests are aborted in **0ms**. The crawler returns immediately without waiting for slow stragglers.
2. **Full Stream Timeout Protection**:
   Undici requests enforce `headersTimeout` (1400ms) and `bodyTimeout` (1400ms) across the entire stream. Stalling or slow-drip servers are terminated cleanly without hanging.
3. **Concurrent Robots.txt Pre-Warming**:
   Robots rules for all seed URLs are queried concurrently in parallel at startup with a **250ms race limit** and instant permissive fallback.
4. **In-Memory DNS Cache**:
   SSRF validation caches resolved DNS lookups in memory for 5 minutes, preventing libuv threadpool exhaustion on Windows/Linux during concurrent fetches.
5. **Fast Engine Pairing**:
   Upstream search resolution uses `google,duckduckgo` fast responders instead of unconfigured or slow search engines.

---

## 3. Single Consolidated Markdown File Architecture

To prevent disk clutter and eliminate heavy synchronous file I/O (especially in cloud-synced environments like OneDrive), the engine uses a **Single-File Markdown Architecture**:

### 3.1 Storage Layout

```text
storage/
├── latest_crawl.md          # Single consolidated markdown file from latest crawl
└── crawls/
    └── <crawl_id>/
        ├── crawl.md         # Per-crawl consolidated markdown archive
        └── manifest.json    # Crawl metadata, stats, and full page array
```

> **Note:** Individual fragmented files (`page-0001.md`, `page-0001.json`, etc.) are **not** generated. All pages are cleanly merged into one unified document.

### 3.2 Structure of `latest_crawl.md`

```markdown
# Unified Crawl Data Archive

- **Crawl ID:** `crawl_1791608875484_22df96a5`
- **Date:** 2026-10-10T05:07:58.505Z
- **Total Pages:** 5
- **Crawled Successfully:** 5
- **Duration:** 3011ms

---

## Page 1: <Article Title>

- **Source URL:** https://example.com/page-1
- **Status Code:** 200 | **Depth:** 0
- **Description:** Summary description...

# Article Heading

Article markdown content here...

---

## Page 2: <Next Title>

- **Source URL:** https://example.org/page-2
- **Status Code:** 200 | **Depth:** 0

Content...

---
```

### 3.3 Consuming the Markdown File via HTTP

The API exposes the latest crawl directly:

```bash
# Fetch latest markdown text directly
curl http://localhost:4000/latest_crawl.md
```

---

## 4. Architecture & Data Flow

```text
Client Query / Target URL
       │
       ▼
Unified Orchestrator (apps/api :4000) OR Fastify API (:3001) / CLI
       │
       ▼
CrawlerEngine (core/engine.ts)
  │
  ├──► Robots Pre-warming (core/robots.ts) [250ms race + cache]
  ├──► InMemoryFrontier (core/frontier.ts) [FIFO BFS Queue]
  ├──► Deduplicator (core/deduplicator.ts) [Canonical URLs + SHA-256]
  │
  ├──► 16-Worker Parallel Pool with crawlAbortController
  │      │
  │      ├──► SSRF Defense (url/ssrf.ts) [In-memory DNS Cache + Private IP Block]
  │      ├──► HttpFetcher (fetcher/client.ts) [Undici Pool + 1400ms Stream Timeout]
  │      ├──► HtmlExtractor (extractor/engine.ts)
  │      │      ├──► DOM Sanitization (scripts, styles, ads stripped)
  │      │      ├──► Content Density Selector (<main>, <article>)
  │      │      ├──► SPA Detector (isSpaPage -> Playwright fallback)
  │      │      └──► Turndown GFM Markdown Converter
  │      │
  │      └──► On target limit reached: Abort stragglers in 0ms!
  │
  └──► FileSystemStorage (storage/file.storage.ts)
         ├──► Writes storage/latest_crawl.md
         ├──► Writes storage/crawls/<id>/crawl.md
         └──► Writes storage/crawls/<id>/manifest.json
```

---

## 5. API Reference

### 5.1 Unified API Orchestrator (Port 4000)

#### 1. Search + Parallel Crawl (Recommended)

Executes multi-domain search, crawls top pages concurrently, and updates `storage/latest_crawl.md`.

- **Route:** `GET /?q=<query>&crawl=true&max_url=5&max_depth=5`
- **Example:**
  ```bash
  curl "http://localhost:4000/?q=LLM&crawl=true&max_url=5&max_depth=5"
  ```

#### 2. Direct Crawl

Crawls a specific seed URL or comma-separated URLs.

- **Route:** `POST /crawl`
- **Payload:**
  ```json
  {
    "url": "https://example.com",
    "limit": 5,
    "max_depth": 2
  }
  ```

#### 3. Search Only

Executes search and extracts page content for top results.

- **Route:** `POST /search`
- **Payload:**
  ```json
  {
    "query": "artificial intelligence",
    "max_results": 5
  }
  ```

#### 4. Latest Crawl Markdown

- **Route:** `GET /latest_crawl.md`
- **Returns:** `text/markdown; charset=utf-8`

---

### 5.2 Standalone Scraping Domain API (Port 3001)

When running `@tavily/scraping` standalone (`pnpm dev:scrape`):

- **Swagger Documentation:** `http://localhost:3001/docs`
- **`POST /v1/extract`**: Batch HTML-to-Markdown extraction for explicit URL lists.
- **`POST /v1/map`**: Fast sitemap & shallow link topology mapping without heavy payloads.
- **`POST /v1/crawl`**: Standalone deep recursive BFS crawler.
- **`GET /health`**: Readiness probe.

---

## 6. Cross-Team Integration Patterns

### 6.1 AI / LLM / Data Engineering Teams

To ingest web data into an LLM context or RAG vector pipeline:

```python
import requests

# 1. Trigger search & crawl
res = requests.get("http://localhost:4000/", params={"q": "LLM architectures", "crawl": "true", "max_url": 5})
data = res.json()

# 2. Ingest the single consolidated markdown file directly
md_response = requests.get("http://localhost:4000/latest_crawl.md")
clean_markdown = md_response.text

# Pass clean_markdown directly into your embedding or LLM prompt pipeline!
```

### 6.2 Frontend Teams

Consume pure JSON without parsing HTML:

```typescript
const response = await fetch("http://localhost:4000/?q=Next.js&crawl=true&max_url=5");
const { data } = await response.json();

console.log("Crawl duration:", data.tookMs);
console.log("Pages crawled:", data.crawl.stats.totalCrawled);
// Each page includes: url, title, markdown, tookMs
```

### 6.3 DevOps / Platform Teams

- **Health check endpoint:** `GET /health` (HTTP 200)
- **Containerization:** Built on `node:22-bookworm-slim`
- **Storage mounting:** Mount `/app/storage` as a persistent volume if long-term crawl history is needed.

---

## 7. CLI Tool Reference

A standalone CLI is included under `domains/scraping/src/cli.ts`:

```bash
# 1. Scrape single URL
pnpm scrape:cli extract https://example.com

# 2. Scrape top results from a search query
pnpm scrape:cli extract --query "machine learning algorithms"

# 3. Map sitemaps and links
pnpm scrape:cli map https://example.com --depth 2 --limit 50

# 4. Crawl and output to storage
pnpm scrape:cli crawl https://example.com --limit 10 --depth 2
```

---

## 8. Verification & Test Commands

```bash
# Run all unit and integration tests
pnpm --filter @tavily/scraping test

# Type-check TypeScript
pnpm --filter @tavily/scraping typecheck

# Full monorepo verification
pnpm test
pnpm typecheck
```
