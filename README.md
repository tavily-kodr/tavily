# Tavily AI Search & Web Intelligence Engine

A production-grade, TypeScript-native Tavily-like AI Search & Web Intelligence Engine. This module delivers end-to-end web search retrieval, safe and robust webpage scraping, HTML noise filtering and main content extraction, multi-factor relevance and freshness ranking, deduplication, grounded AI answering with source citations, and real-time search monitoring triggers with WebSocket / SSE updates.

---

## Architecture

```text
                                  USER
                                    ↓
                         Next.js Search UI & API
                                    ↓
                              SearchService
                                    ↓
             ┌──────────────────────┴──────────────────────┐
             ↓                                             ↓
     Basic Search Mode                            Advanced Search Mode
  (Single Direct Query)                   (Query Expansion & Multi-Angle Search)
             ↓                                             ↓
             └──────────────────────┬──────────────────────┘
                                    ↓
                        SearchProvider Abstraction
                (DuckDuckGo / Tavily / Brave / SearXNG)
                                    ↓
                              Candidate URLs
                                    ↓
                     Domain & Tracking Filter / Normalizer
                                    ↓
                         URL Deduplication Layer
                                    ↓
                       Scraper & Content Extraction
                  (Robots.txt, Timeout, Cheerio, Clean Text)
                                    ↓
                     Content Similarity Deduplication
                                    ↓
                     Relevance & Freshness Ranking
              (Title, Snippet, Authority, Freshness, Quality)
                                    ↓
                       Grounded AI Answer Service
                     (Citations [1], [2] to Sources)
                                    ↓
                          Deterministic Cache
                                    ↓
                    JSON Response / Live UI Display
```

---

## Tech Stack

- **Language**: TypeScript (strict mode, zero `any` policy)
- **Framework**: Next.js 14 (App Router) + Custom Node.js Server with WebSockets (`ws`)
- **HTML Parsing & Content Extraction**: Cheerio, OpenGraph, Schema.org JSON-LD parser
- **Networking**: Safe Fetch with SSRF protection, timeout abort controllers, and robots.txt compliance
- **Concurrency**: Custom semaphore concurrency limiter for scraping pools
- **Real-Time Layer**: EventBus, WebSocket Server, and Server-Sent Events (SSE) stream
- **Testing**: Automated test suite with Vitest / Node test runner

---

## Project Structure

```text
src/
├── app/                                 # Next.js App Router
│   ├── layout.tsx                       # Root layout
│   ├── page.tsx                         # Interactive Search & Monitor Dashboard
│   ├── globals.css                      # Modern dark theme styles
│   └── api/
│       ├── search/route.ts              # POST /api/search (and /search)
│       ├── scrape/route.ts              # POST /api/scrape (and /scrape)
│       └── triggers/
│           ├── route.ts                 # GET /api/triggers, POST /api/triggers
│           ├── [id]/route.ts            # GET, POST (run), DELETE /api/triggers/[id]
│           └── stream/route.ts          # GET /api/triggers/stream (SSE Feed)
├── server.ts                            # Custom Node.js + WebSocket server
└── search/                              # Core Search & Intelligence Module
    ├── index.ts                         # Public module exports
    ├── models/                          # Strict TypeScript types
    │   ├── search.types.ts
    │   ├── scraper.types.ts
    │   ├── ranking.types.ts
    │   └── trigger.types.ts
    ├── providers/                       # Search provider abstraction & implementations
    │   ├── search-provider.interface.ts
    │   ├── duckduckgo.provider.ts       # Zero-config real web search
    │   ├── tavily.provider.ts           # Upstream Tavily API support
    │   ├── brave.provider.ts            # Brave Search API support
    │   ├── searxng.provider.ts          # SearXNG instance support
    │   ├── composite.provider.ts        # Fallback provider chain
    │   └── provider-factory.ts
    ├── services/                        # Business logic services
    │   ├── search.service.ts            # Master search pipeline coordinator
    │   ├── scraper.service.ts           # Safe web scraper with robots.txt & SSRF guards
    │   ├── extraction.service.ts        # HTML noise stripper & metadata extractor
    │   ├── deduplication.service.ts     # URL & content similarity deduplicator
    │   ├── ranking.service.ts           # Multi-factor relevance scoring
    │   ├── answer.service.ts            # Grounded AI answer generator with citations
    │   ├── cache.service.ts             # Deterministic TTL cache
    │   ├── trigger.service.ts           # Real-time search monitor & diff detector
    │   └── event-bus.service.ts         # Pub/Sub event emitter
    ├── utils/                           # Helper utilities
    │   ├── url.utils.ts                 # Normalization, tracking strip, SSRF check
    │   ├── text.utils.ts                # Tokenizer, Jaccard similarity, date parser
    │   ├── robots.utils.ts              # Robots.txt parser and policy checker
    │   └── concurrency.utils.ts         # Parallel task concurrency limiter
    └── tests/                           # Real automated test suites
        ├── search.service.test.ts
        ├── scraper.service.test.ts
        ├── ranking.service.test.ts
        ├── deduplication.service.test.ts
        ├── trigger.service.test.ts
        └── run-all-tests.ts             # Master test runner
```

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_PROVIDER` | `duckduckgo` | Default search provider (`duckduckgo`, `tavily`, `brave`, `searxng`) |
| `TAVILY_API_KEY` | *(Optional)* | Tavily API Key if using Tavily as upstream provider |
| `BRAVE_API_KEY` | *(Optional)* | Brave Search API Key |
| `SEARXNG_URL` | *(Optional)* | URL of self-hosted SearXNG instance |
| `OPENAI_API_KEY` | *(Optional)* | OpenAI API Key for LLM grounded answer generation |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI Model ID |
| `MAX_RESULTS_LIMIT` | `20` | Hard cap on results returned |
| `MAX_PAGES_TO_SCRAPE` | `15` | Maximum candidate pages scraped per query |
| `SCRAPER_TIMEOUT_MS` | `10000` | Webpage fetch timeout (10 seconds) |
| `SCRAPER_CONCURRENCY` | `5` | Maximum concurrent page scrapers |
| `CACHE_ENABLED` | `true` | Enable search result caching |
| `CACHE_TTL_SECONDS` | `600` | Cache retention duration (10 minutes) |
| `PORT` | `3000` | Server HTTP/WebSocket port |

> **Note**: Even with **zero API keys configured**, the search engine works immediately out of the box using the built-in DuckDuckGo web provider and grounded extractive answer synthesis!

---

## Installation & Running

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Run with Native WebSockets
```bash
npm run server
```
Runs Next.js alongside native `ws://localhost:3000` WebSocket server.

### 4. Run Automated Tests
```bash
npm test
```
Or with Vitest:
```bash
npm run test:vitest
```

---

## API Documentation

### 1. Search Endpoint
```http
POST /search
Content-Type: application/json
```
*(Also accessible via `POST /api/search`)*

#### Request Body
```json
{
  "query": "latest developments in renewable energy",
  "search_depth": "advanced",
  "max_results": 5,
  "include_domains": ["nature.com", "energy.gov"],
  "exclude_domains": ["spam-site.com"],
  "include_answer": true,
  "include_raw_content": false,
  "time_range": "month"
}
```

#### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `query` | string | **Yes** | Search query string |
| `search_depth` | string | No | `'basic'` (fast) or `'advanced'` (query expansion + deep retrieval). Default `'basic'` |
| `max_results` | number | No | Number of results to return (1 - 20). Default `10` |
| `include_domains` | string[] | No | Only keep results from these domains |
| `exclude_domains` | string[] | No | Remove results from these domains |
| `include_answer` | boolean | No | Generate a grounded AI answer with citations. Default `true` |
| `include_raw_content`| boolean | No | Include raw scraped HTML in response. Default `false` |
| `time_range` | string | No | Filter by publication freshness: `'day'`, `'week'`, `'month'`, `'year'` |

#### Example Response
```json
{
  "query": "latest developments in renewable energy",
  "answer": "Recent developments in renewable clean energy highlight major advancements in perovskite-silicon tandem solar cells achieving over 33% efficiency [1]. Governmental initiatives from the Department of Energy have accelerated grid integration [2].",
  "results": [
    {
      "title": "Perovskite Solar Cell Efficiency Breakthroughs",
      "url": "https://nature.com/articles/solar-2026",
      "content": "Scientists have achieved record-breaking tandem efficiency exceeding 33% while maintaining stability under high thermal stress...",
      "domain": "nature.com",
      "score": 0.94,
      "published_date": "2026-09-24T10:00:00.000Z",
      "source": "DuckDuckGo",
      "author": "Dr. Sarah Lin"
    }
  ],
  "response_time": 1.45,
  "status": "success",
  "search_depth": "advanced",
  "total_found": 1
}
```

#### Example cURL Command
```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest developments in renewable energy",
    "search_depth": "advanced",
    "max_results": 5,
    "include_answer": true
  }'
```

---

### 2. Web Scraper Endpoint
```http
POST /scrape
Content-Type: application/json
```
*(Also accessible via `POST /api/scrape`)*

#### Request Body
```json
{
  "url": "https://example.com/article",
  "extract_raw_html": false,
  "timeout_ms": 10000
}
```

#### Response
```json
{
  "url": "https://example.com/article",
  "canonicalUrl": "https://example.com/article",
  "title": "Article Title",
  "description": "Article summary meta description",
  "content": "Clean extracted readable text without ads or navigation noise...",
  "author": "Author Name",
  "publishedDate": "2026-08-10T14:30:00.000Z",
  "status": "success",
  "statusCode": 200,
  "responseTimeMs": 342
}
```

For blocked/forbidden pages:
```json
{
  "url": "https://example.com/restricted",
  "status": "blocked",
  "reason": "Access restricted or rate limited (HTTP 403)",
  "statusCode": 403,
  "responseTimeMs": 150
}
```

---

### 3. Real-Time Triggers Endpoints

#### Create Trigger
```http
POST /triggers
Content-Type: application/json

{
  "query": "latest AI regulations",
  "frequency": "hourly",
  "search_depth": "basic"
}
```

#### List Triggers
```http
GET /triggers
```

#### Run Trigger Now
```http
POST /api/triggers/{id}
```

#### Delete Trigger
```http
DELETE /api/triggers/{id}
```

#### Real-Time SSE Event Stream
```http
GET /api/triggers/stream
Accept: text/event-stream
```
Streams live events when search results change:
```json
{
  "type": "SEARCH_UPDATE",
  "triggerId": "trg_1727780000_abc12",
  "query": "latest AI regulations",
  "changes": [
    {
      "type": "NEW_RESULT",
      "url": "https://eur-lex.europa.eu/ai-act",
      "title": "Official EU AI Act Enforcement Guidelines",
      "details": "New result found in search rankings: \"Official EU AI Act Enforcement Guidelines\"",
      "detected_at": "2026-10-01T11:00:00.000Z"
    }
  ]
}
```

---

## Relevance & Ranking Formula

The ranking engine scores candidate results using a balanced multi-factor model:

$$\text{Final Score} = (\text{TitleRel} \times 0.35) + (\text{ContentRel} \times 0.25) + (\text{SourceQuality} \times 0.15) + (\text{Freshness} \times 0.15) + (\text{ContentQuality} \times 0.10)$$

- **Title Relevance**: Checks exact phrase matching and token coverage in page title.
- **Content Relevance**: BM25-inspired term density and snippet matching.
- **Source Quality**: Domain authority weighting (`.gov`, `.edu`, `.org`, and verified high-authority domain registries).
- **Freshness**: Exponential decay curve calibrated to days elapsed since `published_date`, adjusted by user's requested `time_range`.
- **Content Quality**: Penalizes empty stubs; rewards comprehensive, structured articles.
- **Normalized Range**: All scores are normalized into `[0.05, 0.99]`.

---

## Known Limitations & Security Considerations

1. **Access Controls**: The scraper respects `robots.txt`, detects WAFs, and never attempts to bypass CAPTCHAs or paywalls. Blocked pages fail gracefully and are reported in `failed_sources` without crashing the search.
2. **SSRF Guard**: Fetch requests to internal IP addresses (e.g. `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, `localhost`) are automatically blocked.
3. **External Rate Limits**: When using free upstream providers like DuckDuckGo under heavy burst traffic, rate limits may occur; configuring `TAVILY_API_KEY` or `BRAVE_API_KEY` provides commercial SLAs.
