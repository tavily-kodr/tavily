# Scraper Service

The scraper is the second half of the Tavily search flow.

```text
User query → SearXNG (20 URLs) → Scraper (this) → page content → API response
```

The search API (`packages/app`) sends it the top 20 result URLs. It fetches all of them
at once, pulls out the title and main text of each page, and sends them back. Pages that
fail (404, blocked, timeout) are reported in place with an error — one bad page never
fails the whole search. Pages that need JavaScript are rendered in Chrome automatically.

The original Go CLI (`cmd/scraper`) still works unchanged. The HTTP server is `cmd/server`.

## Start

From the repo root, `pnpm dev` starts this together with SearXNG and the API.

On its own:

```bash
cd packages/scraper
go run ./cmd/server
```

You should see `scraper server listening addr=:8081`.

To skip Chrome entirely (faster, no Chrome needed, but JS-only pages come back empty):

```bash
FAST=true go run ./cmd/server
```

## Try it

```bash
curl http://localhost:8081/health

curl -X POST http://localhost:8081/scrape \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com", "https://go.dev"]}'
```

Response: `{"results": [...], "took_ms": 1234}`, one result per URL, in the same order.
Each result has `url`, `success`, `title`, `text`, `markdown`, `metadata`, and `error`
when `success` is false.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `SCRAPER_PORT` | `8081` | Port to listen on |
| `SCRAPER_MAX_URLS` | `20` | Max URLs per request |
| `SCRAPER_BATCH_TIMEOUT_SEC` | `30` | Give up on a request after this long |
| `FAST` | `false` | `true` = plain HTTP only, never launch Chrome |
| `TIMEOUT_SEC` | `10` | Timeout for a single page fetch |
| `CONCURRENCY` | `30` | How many pages are fetched at the same time |

## Code map

- `cmd/server/main.go` — starts the HTTP server
- `internal/api/server.go` — `/scrape` and `/health` handlers, input validation
- `internal/orchestrator/orchestrator.go` — `ScrapeURLs()` runs the batch
- `internal/fetch/pipeline.go` — fetches one page (HTTP first, Chrome if needed)
- `internal/extract/` — turns HTML into title, text, markdown, metadata

Full CLI docs: `README.md`. Deeper architecture notes: `CLAUDE.md`.
