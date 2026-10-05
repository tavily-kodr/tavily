# Tavily

A Tavily-like search API: a query goes to SearXNG, the top results are scraped,
and the response carries the page content rather than bare links.

```text
GET /search?q=…
      │
      ▼
packages/app  (Express, TypeScript)  ── the API, orchestrates the two services below
      │
      ├─► packages/searxng   SearXNG in Docker        → ranked result URLs (up to 20)
      │
      └─► packages/scraper   Go scraper, HTTP server   → title + content for each URL
```

## Layout

```text
tavily/
├── infrastructure/docker-compose.yml   SearXNG + Valkey
├── packages/
│   ├── app/        Search API (Express). Services: search.service.ts (SearXNG client),
│   │               scraper.service.ts (scraper client); the controller joins them.
│   ├── searxng/    SearXNG config and .env
│   ├── scraper/    Go scraper. `cmd/scraper` is the standalone CLI, `cmd/server` is the
│   │               HTTP service the API talks to. See packages/scraper/README.md.
│   └── ui/
└── docs/guidlines/
```

## Running

Prerequisites: Docker, Go 1.27, Node 24, pnpm. Chrome is used for JS-heavy pages
(set `FAST=true` to skip it).

First time only:

```bash
pnpm install
cd packages/app && pnpm install && cp .env.example .env && cd ../..
cp packages/searxng/.env.example packages/searxng/.env   # set SEARXNG_SECRET
```

Then, from the repo root, one command starts everything:

```bash
pnpm dev
```

This brings up SearXNG in Docker (`:8080`), the Go scraper service (`:8081`) and the
search API (`:3000`), with prefixed logs for the last two. Ctrl+C stops the scraper and
API; `pnpm stop:search` stops the Docker containers. Wait for `scraper server listening`
before the first search — the first request after a cold start also pays for launching
Chrome (~15s), later ones take a few seconds.

Each service can also be started on its own: `pnpm dev:search`, `pnpm dev:scraper`,
`pnpm dev:api`.

### Configuration

`packages/app/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `BASE_URL` | `http://localhost:8080` | SearXNG |
| `SCRAPER_URL` | `http://localhost:8081` | Scraper service |
| `MAX_SCRAPE_URLS` | `20` | Search results scraped per query (≤ scraper's `SCRAPER_MAX_URLS`) |
| `SCRAPER_TIMEOUT_MS` | `35000` | Client deadline per scrape batch (> scraper's `SCRAPER_BATCH_TIMEOUT_SEC`) |

Scraper-side variables (`SCRAPER_PORT`, `SCRAPER_MAX_URLS`, `SCRAPER_BATCH_TIMEOUT_SEC`,
`FAST`, `CONCURRENCY`, `TIMEOUT_SEC`, …) are documented in `packages/scraper/README.md`.

## Endpoint

```bash
GET /search?q=react
```

```bash
curl "http://localhost:3000/search?q=react"
```

### Response

Results keep SearXNG's ranking. A page that could not be scraped is still returned, with
`success: false`, its error, and the SearXNG snippet as `content`, so one bad site never
fails the search. If the scraper service itself is unreachable the API answers `502`.

```json
{
  "statusCode": 200,
  "message": "Search successful",
  "data": {
    "query": "react",
    "total": 20,
    "scraped": 18,
    "failed": 2,
    "results": [
      {
        "url": "https://react.dev/",
        "title": "React",
        "content": "React is the library for web and native user interfaces…",
        "description": "The library for web and native user interfaces",
        "success": true,
        "scrape_method": "http",
        "scrape_ms": 412
      },
      {
        "url": "https://example.com/blocked",
        "title": "Some page",
        "content": "…snippet from the search engine…",
        "success": false,
        "error": "terminal fetch error: http status 403"
      }
    ]
  },
  "success": true
}
```

| Field | Notes |
|---|---|
| `content` | Extracted main text of the page; the search snippet when the scrape failed |
| `description` | Meta / OpenGraph description, when present |
| `published_date` | From page metadata, when present |
| `scrape_method` | `http`, `stealth` (Chrome), prefixed `cached` when served from the scraper's result cache |
| `scrape_ms` | Time the scraper spent on that URL |
