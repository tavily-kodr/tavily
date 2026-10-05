# CLAUDE.md

Guidance for working in this repo. Go CLI web scraper/crawler (`github.com/sujal/go-scraper`, Go 1.27, Windows-first dev environment).

## Commands

```bash
go build -o go-scraper.exe ./cmd/scraper   # what the .bat scripts expect (repo root)
make build                                  # → bin/go-scraper (Makefile also has test, bench, clean)
go test ./...                               # tests exist only in convert, detect, output
go test ./internal/detect -run TestHasRealContent
go vet ./...
```

Run: `go-scraper.exe {scrape <url...> | crawl <url> | sitemap <url> | discover <url>} [flags]`.
`scrape.bat`, `crawl.bat`, `run.bat` auto-build `go-scraper.exe` if missing (via `build.bat`). Output goes to `output/` (gitignored).

This package is the scraping half of the Tavily monorepo (`tavily/packages/scraper`). The search API in `packages/app` (Node/Express) calls it over HTTP: `go run ./cmd/server` (or `make run-server`) serves `POST /scrape {"urls": [...]}` and `GET /health` on `SCRAPER_PORT` (8081). Handlers live in `internal/api`; they call `orchestrator.ScrapeURLs`, which is `RunScrape` minus the file output. The server honours the same env vars as the CLI plus `SCRAPER_PORT`, `SCRAPER_MAX_URLS` (20), `SCRAPER_BATCH_TIMEOUT_SEC` (30).

## Architecture

Request flow: `cmd/scraper/main.go` (cobra) → `orchestrator` → `worker` pool or `crawl.CrawlSite` → `ratelimit` wait → `fetch.FetchWithEscalation` → `extract`/`convert` → `output.AsyncWriter`.

- **`types`** — all shared structs (`ScrapeResult`, `Config`, `Job`, …) and `DefaultConfig`. Add new config fields here.
- **`config`** — builds `Config`: `NewDefault()` → `MergeWithEnv` (`OUTPUT_DIR`, `FORMATS`, `CONCURRENCY`, `MAX_DEPTH`, `MAX_PAGES`, `DELAY_MS`, `STEALTH`, `FAST`, `TIMEOUT_SEC`) → `MergeWithFlags` (flags passed as a `map[string]any`; new flags must be added to both `main.go`'s map and `MergeWithFlags`). Flags win over env.
- **`orchestrator`** — owns the shared `BrowserPool` (skipped in `--fast` mode, warmed at startup otherwise) and `PerDomainLimiter` (rps = 1/delay, or 100 when delay is 0; burst 20). `Close()` persists the domain cache. `finalizeReports` writes `SUMMARY.md` and optional `results.csv`. `discover` writes `discovered_urls.json`.
- **`cache`** — result cache (Firecrawl's `maxAge`): successful `ScrapeResult`s stored as JSON under `<UserCacheDir>/go-scraper/results/`, keyed by URL hash, shared across output dirs. `FetchWithEscalation` returns a hit (marked `Cached: true`, logged as `[cached <method>]`) before doing anything else. Default `--max-age 48h`; `--max-age 0` disables; `go-scraper cache clear` empties it.
- **`worker`** — generic bounded goroutine pool over buffered channels; used by `scrape`/`sitemap`.
- **`crawl`** — `bfs.go` runs its own worker loop (not `worker.Pool`): `sync.Map` visited set, atomic `scheduled` (total enqueued, capped at `MaxPages`) and `activeJobs` (queued + in-flight, closes the queue at 0) counters, `MaxDepth` cap, same-host filter, robots.txt, `--include`/`--exclude` regexes. Results stream out through the `onResult` callback. `sitemap.go`/`robots.go` handle discovery.
- **`fetch/pipeline.go`** — the core escalation logic, in order:
  1. Tier 0: `convert.GetAlternativeURL` rewrites Reddit → `.json`, Twitter/X → nitter.net, Medium → scribe.rip. Output keeps the *original* URL.
  2. `--fast` (or no pool): plain HTTP only; any HTML with status < 400 is accepted.
  3. Domain cache hint (`DomainCache` sync.Map, loaded once from `<output>/.domain_cache.json`, written once by `SaveDomainCache` at exit). A `stealth` hint goes straight to the browser.
  4. HTTP probe (`http.go`: singleton client, per-request `RequestTimeout`, IPv4-first DNS cache, HTTP/2, 10MB body cap). Errors wrapping `ErrTerminal` (404/410/5xx-except-503, non-HTML content types, Chrome error pages) fail immediately, without a browser. On a first-seen domain the stealth browser is raced against HTTP from t=0, but only while one of the 2 `speculativeSlots` is free (otherwise HTTP first); whichever passes the content check first wins and the loser is cancelled. "stealth" is recorded in the domain cache only when HTTP actually failed the check, never because the browser merely out-raced a slow response.
  5. Stealth chromedp (`stealth.go`): one navigation, then auto-scroll in the same tab only if the render is sparse. Tracks the main frame's HTTP status (terminal statuses → `ErrTerminal`). A sparse-but-non-empty render is the last-resort result. `--verbose` logs per-phase timings (`open_tab`, `setup`, `navigate`, `wait_content`, …).
  A tier "wins" when `detect.HasRealContent(html, MinContentLength)` passes: stripped text length, plus SPA-shell, inline-script-data, and challenge heuristics.
- **`fetch/daemon.go`** — the browser daemon. Instance 0 of the pool is normally a headless Chrome owned by a detached `go-scraper _browser-daemon --port N` process (same binary), so a fresh CLI run connects in ~50ms instead of paying ~900ms for Chrome launch + cold tab. Info file `<UserCacheDir>/go-scraper/browser.json`, log `browser-daemon.log`; a `spawn.lock` stops concurrent runs from double-spawning. The daemon exits after `DefaultDaemonIdle` (10 min) with no non-blank page open, or when Chrome dies. `go-scraper browser status|stop`; `--no-daemon` launches a private Chrome instead.
- **`fetch/browser_pool.go`** — `NewBrowserPool(size, useDaemon)`. `--browsers` (default 1) above 1 adds locally launched instances. `OpenTab(ctx)` limits each instance to `tabsPerBrowser` (8) open tabs and closes the tab when ctx is cancelled. `chromeFlags()` is shared with the daemon: images disabled, renderer backgrounding off; `BlockPatterns` in `browser.go` blocks fonts, media, and trackers. CSS is deliberately not blocked. Requires a local Chrome/Chromium.
- **`fetch/browser.go`** — `WaitForContent` runs one in-page promise: text ≥ minChars, `document.readyState` past `loading` (a still-streaming large page looks quiet between chunks and would be truncated), no DOM node/text mutation for 150ms (attribute changes ignored; 500ms cap for pages that mutate forever), and not on a challenge-titled page. The observer attaches lazily because `documentElement` can be null right after a navigation commits. Retries when navigation destroys the execution context.
- **Extraction (`buildScrapeResult`)** — the HTML is parsed **once**. The pristine `goquery.Document` feeds title, readability (`FromDocument` clones internally), metadata, JSON-LD and links, all read-only. `extract.CleanDocument` makes one cleaned clone that feeds both the text and the markdown output. Keep new extractors on this shared parse (`*Doc` variants); the string-taking functions are compatibility wrappers.
- **`convert/markdown.go`** — content root is a single `<main>`, else a single `<article>`, else `<body>`, so listing pages with many `<article>`s keep every item. Converted with `htmltomarkdown.ConvertNode`.
- **`output`** — per-URL files named by `URLToFilename` (host+path, sanitized, max 100 chars); formats `markdown|md`, `json` (HTML stripped), `text|txt`, `html`; `csv` is batch-only. `AsyncWriter` writes files on 4 background goroutines. Crawl also writes `CRAWL_INDEX.md`.

## Conventions / rules (from `ai_context_go_scraper.md`)

- Reuse the browser pool (`OpenTab` per URL, never a new browser) and the global `http.Client`.
- Never `time.Sleep` to wait for content — use `WaitForContent`.
- Thread `context.Context` through everything; Ctrl+C cancels the root context for graceful shutdown.
- Use `sync.Map` for hot concurrent maps (visited set, domain cache, DNS cache).
- Logging uses `log/slog` (text handler to stdout).

## Verifying changes

Speed changes must not change output. Build the previous version to a separate binary, run both on the same URLs into fresh `-o` dirs (the domain cache lives in the output dir) with `--max-age 0` (or the result cache will answer), and `cmp` the `.md` files. Live sites churn (counters, headlines), so read the diffs. Per-page cost is in each JSON's `timing` (`fetch_ms`, `extract_ms`); `-v` adds browser phase timings. Benchmark the same URL set back to back, twice: demo sites like books.toscrape.com vary 2–3× run to run. Never benchmark two scrapes concurrently — they share one Chrome. `go test -race` needs cgo, which is not available on this machine.

Known floor: a JS-rendered SPA costs what its own bundles cost (sheryians.com: ~1000ms until React paints, ~1.4s total). Only the result cache gets a repeat of such a page under 1s.

## Gotchas (current code vs docs)

- Defaults live in `main.go`/`types.DefaultConfig`: concurrency 30, delay 0, timeout 10s, browsers 1, max-age 48h.
- `--stealth` / `UseStealth` is parsed but never read: the browser tier is always stealth.
- Defined but not wired into the pipeline: `fetch.FetchBrowser` (non-stealth tier), `detect.DetectSiteType`, `detect.DetectBotProtection`, `ratelimit.ProxyRotator`, `Config.MaxRetries`, `Config.MaxRequestsPerMinute`.
- `ai_context_go_scraper.md` and `go_scraper_architecture.md` are the original design specs. They describe intent (e.g. a 4-tier ladder and Go 1.22), and the code has drifted from them. Trust the code.
