# go-scraper — Implementation Guide

This document explains how the scraper works as it is **actually implemented** in this repository, why each technical decision was made, where the speed comes from, and where the limits are. Everything below is based on the code in `cmd/` and `internal/` as of the current tree (≈4,200 lines of Go). Where a feature is only planned, or where code exists but is not wired in, that is stated explicitly.

Measurements quoted here were taken on the development machine (Windows 11, 8 cores, home broadband, Go 1.27, Chrome stable) on 2026-10-03/04. They show *relative* effects and orders of magnitude; your numbers will differ. Section 8 explains how to re-measure.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Data extraction process](#3-data-extraction-process)
4. [Performance optimization](#4-performance-optimization)
5. [Approaches selected](#5-approaches-selected)
6. [Package and dependency analysis](#6-package-and-dependency-analysis)
7. [Code walkthrough](#7-code-walkthrough)
8. [Performance and bottlenecks](#8-performance-and-bottlenecks)
9. [Error handling and edge cases](#9-error-handling-and-edge-cases)
10. [Trade-offs and future improvements](#10-trade-offs-and-future-improvements)

---

## 1. System overview

### What it does

`go-scraper` is a command-line tool that turns web pages into clean, structured content: Markdown, plain text, JSON (title, text, metadata, JSON-LD, links, timings), and optional raw HTML / CSV. It has four modes:

| Command | What happens |
|---|---|
| `scrape <url...>` | Fetch and extract the given URLs concurrently |
| `crawl <url>` | Breadth-first crawl of a site from a start URL, bounded by `--pages` and `--depth` |
| `sitemap <url>` | Discover the site's sitemap(s), then scrape the listed URLs |
| `discover <url>` | Only list sitemap URLs (dry run) to `discovered_urls.json` |

Two support commands manage the background pieces: `browser status|stop` (the shared headless Chrome) and `cache clear` (the result cache).

### The core idea in one paragraph

Most pages can be read with a plain HTTP request in a few hundred milliseconds. Some pages (JavaScript apps, bot-protected sites) return an empty shell to HTTP and need a real browser, which is 5–20× slower. The scraper therefore runs a **tiered pipeline**: cheap HTTP first, headless Chrome only when the cheap result is not real content, and it **remembers per domain** which tier worked so it never pays the discovery cost twice. Around that core it adds the things that make repeated and bulk work fast: a persistent Chrome kept alive between runs, a result cache, a bounded worker pool, connection reuse, and a single HTML parse shared by all extractors.

### End-to-end workflow

```
 user command
     │
     ▼
 cmd/scraper/main.go ── parse flags/env → types.Config
     │
     ▼
 orchestrator.New ──── creates BrowserPool (unless --fast) + per-domain rate limiter
     │                  BrowserPool.Warm() connects to the Chrome daemon in the background
     │
     ├─ scrape/sitemap ─► worker.Pool (N goroutines) ──┐
     │                                                  │  for each URL:
     └─ crawl ──────────► crawl.CrawlSite (BFS loop) ───┤   1. limiter.Wait(domain)
                                                        │   2. fetch.FetchWithEscalation
                                                        │        cache? → HTTP ⇄ Chrome race → extract
                                                        │   3. result → output.AsyncWriter (disk)
                                                        ▼
                                              SUMMARY.md / results.csv / CRAWL_INDEX.md
```

---

## 2. Architecture

### Package map and responsibilities

```
cmd/scraper/main.go          CLI (cobra). Flags → Config. Commands. Hidden `_browser-daemon`.
internal/
  types/        Shared structs: ScrapeResult, Config (+DefaultConfig), Job, CrawlPageResult …
  config/       Config building: defaults → environment variables → CLI flags
  orchestrator/ Owns shared resources (browser pool, limiter); runs the four modes; writes reports
  worker/       Generic bounded goroutine pool (jobs in, results out) used by scrape/sitemap
  crawl/        BFS crawler (own worker loop), robots.txt parser, sitemap discovery
  ratelimit/    Per-domain token-bucket limiter; ProxyRotator (not wired in)
  fetch/        The fetch pipeline:
     pipeline.go     FetchWithEscalation — cache, tier selection, HTTP⇄browser race, domain memory
     http.go         Tier 1: shared http.Client, DNS cache, body limits, terminal-status rules
     browser_pool.go Chrome instances, tab slots, shared Chrome flags
     daemon.go       Background Chrome daemon (spawn, connect, idle exit, stop)
     browser.go      Resource block list, in-page readiness wait, plain browser fetch (unused)
     stealth.go      Tier 2: stealth Chrome fetch (anti-bot JS patches, status tracking, auto-scroll)
     useragent.go    User-Agent pool and realistic headers
  detect/       HasRealContent (is this HTML real content or a shell/challenge?); site-type and
                bot-protection classifiers (not wired in)
  extract/      Title/text (readability + goquery), metadata, JSON-LD, links — all over one parse
  convert/      HTML → Markdown; URL rewriting for scraper-hostile sites
  cache/        Result cache on disk (Firecrawl-style maxAge)
  output/       File naming, per-format writers, AsyncWriter, SUMMARY/CSV/CRAWL_INDEX reports
```

### Data flow for a single URL

```
            ┌──────────────────────────────────────────────────────────────────┐
 URL ──────►│ cache.Get(url, MaxAge)  hit? ──► return stored ScrapeResult (ms) │
            └──────────────┬───────────────────────────────────────────────────┘
                           │ miss
                           ▼
            convert.GetAlternativeURL      reddit → .json, twitter/x → nitter, medium → scribe
                           │
                           ▼
            DomainCache.Load(domain)       "http" | "stealth" | unknown
                           │
      ┌────────────────────┼─────────────────────────┐
      │ "stealth"          │ unknown                 │ "http"
      ▼                    ▼                         ▼
 FetchStealth        FetchHTTP  ∥  FetchStealth   FetchHTTP
 (browser first)     (raced from t=0, if a        (HTTP only; browser
      │               speculative slot is free)    only if HTTP fails)
      └────────────────────┼─────────────────────────┘
                           ▼
            detect.HasRealContent(html)?  first tier to pass wins; loser cancelled
                           │
                           ▼
            buildScrapeResult: parse HTML once → title, text, markdown, metadata, JSON-LD, links
                           │
                           ▼
            cache.Put(result) ──► ScrapeResult (Success, Method, Timing …)
```

### Component interaction: the browser side

```
 CLI process A ──┐                             ┌────────────────────────────────┐
 CLI process B ──┼── NewRemoteAllocator ──────►│ go-scraper _browser-daemon     │
 CLI process C ──┘   (ws://127.0.0.1:PORT)     │   owns one headless Chrome     │
                                               │   --remote-debugging-port=PORT │
   each process: one browser context,          │   polls /json every 2s;        │
   up to 8 tabs at a time (OpenTab semaphore)   │   exits after 10 min idle      │
                                               └────────────────────────────────┘
   info file: %LOCALAPPDATA%\go-scraper\browser.json   log: browser-daemon.log
```

---

## 3. Data extraction process

This section walks one URL through the system, step by step, naming the code that does each part.

### Step 0 — Configuration

`config.NewDefault()` copies `types.DefaultConfig`; `MergeWithEnv` applies environment variables (`OUTPUT_DIR`, `FORMATS`, `CONCURRENCY`, `MAX_DEPTH`, `MAX_PAGES`, `DELAY_MS`, `STEALTH`, `FAST`, `TIMEOUT_SEC`); `MergeWithFlags` applies CLI flags last, so flags win. Important defaults: concurrency 30, request timeout 10s, browser timeout 20s, `MinContentLength` 80, `MaxAge` 48h, one Chrome instance (the daemon), 8 tabs per instance.

### Step 1 — Scheduling and rate limiting

For `scrape`, the orchestrator feeds URLs into a `worker.Pool` of `Concurrency` goroutines. For `crawl`, `crawl.CrawlSite` runs its own loop (see §7). Before every fetch the worker calls `limiter.Wait(ctx, host)` — a per-domain token bucket (`golang.org/x/time/rate`). With the default delay of 0 the bucket allows 100 requests/second per domain with a burst of 20; `--delay` or a robots.txt `Crawl-delay` lowers it.

### Step 2 — Result cache lookup

`FetchWithEscalation` first asks `cache.Get(url, cfg.MaxAge)`. The cache is a directory of JSON files under the user cache directory, one file per URL (keyed by a SHA-256 of the URL). A hit younger than `MaxAge` is returned immediately with `Cached: true`. Failures are never cached, so a page that failed yesterday is retried today.

### Step 3 — URL rewriting (Tier 0)

`convert.GetAlternativeURL` swaps known scraper-hostile hosts for machine-friendly equivalents: `reddit.com/...` → `.../.json`, `twitter.com`/`x.com` → `nitter.net`, `medium.com` → `scribe.rip`. The *original* URL is kept in the result and in file names; only the fetch uses the rewritten one.

### Step 4 — Choosing a tier

The in-memory `DomainCache` (a `sync.Map`, loaded once from `<output>/.domain_cache.json`) says what worked for this domain before:

* **`"stealth"`** — go straight to Chrome. If that render is not real content, fall through to HTTP anyway (sites change).
* **`"http"`** — plain HTTP; start Chrome only if the HTTP result fails the content check.
* **unknown** — start HTTP, and *also* start Chrome at the same moment if one of the two process-wide `speculativeSlots` is free. Whichever returns real content first wins; the other is cancelled through its context.

### Step 5a — Tier 1: HTTP (`fetch/http.go`)

One global `http.Client`/`http.Transport` is reused for the whole process (keep-alive, HTTP/2, up to 200 connections per host). Each request:

1. gets a `context.WithTimeout(cfg.RequestTimeout)`;
2. sends realistic browser headers plus a rotating User-Agent;
3. is dialled through `cachedDialContext`, which resolves the host once, orders IPv4 before IPv6, and tries the addresses in turn;
4. is checked for **terminal statuses** (400, 404, 405, 410, 414, 451, 500, 501, 502, 504) and non-HTML/JSON content types → `ErrTerminal`, meaning "a browser will not help, stop now";
5. reads at most 10 MB of body (`io.LimitReader`), decompressing gzip if the server sent it.

A JSON response (the Reddit case) is wrapped into a minimal HTML document so the rest of the pipeline is uniform.

### Step 5b — Tier 2: stealth Chrome (`fetch/stealth.go`)

`FetchStealth` takes a tab from the pool (`OpenTab`, bounded by the semaphore), then runs one chromedp action list:

1. `network.Enable` + `SetBlockedURLs(BlockPatterns)` — fonts, images, media, analytics and ad hosts are never requested (CSS is allowed, because some apps need it to render);
2. viewport 1920×1080;
3. `AddScriptToEvaluateOnNewDocument(stealthJS)` — before any page script runs, patches `navigator.webdriver`, plugins, languages, platform, hardware/memory hints, `window.chrome`, the permissions API, the WebGL vendor/renderer strings and `Function.prototype.toString`, so common fingerprinting checks see a normal Chrome;
4. `page.Navigate` (returns as soon as the navigation commits — it does not wait for `load`);
5. a small random mouse move;
6. `WaitForContent` (see below);
7. `OuterHTML("html")` and `Location()`.

Throughout, a `ListenTarget` hook records the HTTP status of the **main frame's document** response. After the run: a `chrome-error://` location (DNS failure, refused connection, empty 404 body rendered as Chrome's own error page) or a terminal status becomes `ErrTerminal`. If the render exists but fails `HasRealContent`, the same tab is scrolled (`AutoScroll`, up to 6 viewport steps) to trigger lazy loading, waited on again (2s cap) and re-read — one navigation, not two.

**`WaitForContent`** (`fetch/browser.go`) is one JavaScript promise evaluated in the page rather than a Go-side polling loop. It resolves when all of these hold:

* visible text (`document.body.innerText`) ≥ `MinContentLength` characters;
* `document.readyState !== 'loading'` — the HTML parser has finished, so a large page still streaming in is never snapshotted half-way;
* no DOM node or text mutation for 150 ms (a `MutationObserver` that ignores attribute changes, so CSS-class animations do not count), **or** 500 ms have passed since content first appeared (for pages that mutate forever: tickers, counters);
* the document title does not look like a bot challenge ("Just a moment…", "Attention required", …).

It gives up after 5 s and returns whatever is there. The observer is attached lazily because `document.documentElement` can still be `null` in the instant after a navigation commits. If the evaluation itself fails (the execution context was destroyed by a redirect or a solved challenge) the Go side retries until the deadline.

### Step 6 — Deciding whether a tier "won" (`detect/quality.go`)

`HasRealContent(html, minLen)` strips scripts, styles and tags with regexes and checks:

1. stripped text length ≥ `minLen` (80 by default);
2. if the text is short (< 500 chars): is this an SPA shell? (`<div id="root">`, `#app`, `#__next`, `#__nuxt`, `__NEXT_DATA__`, `__NUXT__`), or a client-rendered page whose inline scripts are > 2 KB and > 10× the visible text (e.g. a page that ships its data in a `<script>` and renders it with jQuery);
3. if the text is < 2000 chars: does it match any of ~17 bot-challenge phrases (Cloudflare, hCaptcha, "verify you are human", "access denied" …)?

Only HTML that passes is accepted; otherwise the pipeline escalates.

### Step 7 — Extraction (`buildScrapeResult`, `fetch/pipeline.go`)

The HTML is parsed **once** into a goquery/`x/net/html` document (`doc`). `extract.CleanDocument(doc)` makes one deep clone with noise removed (`script, style, noscript, nav, footer, header, svg, iframe, form, button, aside, dialog, canvas, link, meta`). Then:

| Output | Function | Input | How |
|---|---|---|---|
| Title + text | `extract.ExtractContentDoc` | `doc` (read-only) and `cleaned` | Runs go-readability over `doc` (readability clones internally) and a structural goquery extraction over `cleaned` (prefers `<main>`/`<article>` if they hold > 200 chars, else `<body>`). Picks readability when it produced > 500 chars and at least 30 % of the structural text; otherwise the structural text, unless it is < 200 chars and readability found more. Title: `<title>` → `og:title` → first `<h1>`. |
| Markdown | `convert.BuildMarkdownDocumentDoc` | `cleaned` | Root = a *single* `<main>`, else a *single* `<article>`, else `<body>` (so listing pages with many articles keep every item); inline `style`/`onclick`/`onload` attributes dropped; converted with html-to-markdown v2 `ConvertNode`; `# title` and `> Source:` header prepended. Falls back to the plain text if the conversion is empty. |
| Metadata | `extract.ExtractMetadataDoc` | `doc` | description, keywords, Open Graph / Twitter title-description-image, canonical, lang, author, published/modified dates from `<meta>`/`<link>` |
| Structured data | `extract.ExtractJsonLDDoc` | `doc` | every `<script type="application/ld+json">` parsed; arrays flattened |
| Links | `extract.ExtractLinksDoc` | `doc` | all `<a href>`, resolved against the page URL, same host only, http(s) only, static-file extensions skipped, fragments stripped, de-duplicated |

Timings (`fetch_ms`, `extract_ms`, `total_ms`) are recorded, the raw HTML is kept in the struct (used by the `html` format and the cache), and `cache.Put` stores the result.

### Step 8 — Output (`internal/output`)

Results flow to an `AsyncWriter` (4 goroutines, 256-deep channel) so disk latency never blocks a scrape worker. File names come from `URLToFilename`: `host + "_" + path`, non-alphanumerics → `_`, lower-cased, truncated to 100 characters. Formats: `markdown`/`md`, `json` (HTML stripped to keep files small), `text`/`txt`, `html`; `csv` is batch-level (`results.csv`). After the run: `SUMMARY.md` (success rate, methods, per-page table) and, for crawls, `CRAWL_INDEX.md`.

### A worked example

`go-scraper scrape https://sheryians.com/` (a React single-page app) on a warm daemon, nothing cached, with `-v`:

```
stealth phase  open_tab      36ms   ← tab slot + createTarget in the daemon's Chrome
stealth phase  setup         63ms   ← network.Enable, block list, viewport, stealth script
stealth phase  navigate      59ms   ← navigation committed (HTML shell is tiny)
stealth phase  wait_content 1225ms  ← the site's ~25 JS bundles download and React renders;
                                       visible text goes 0 → ~11,000 chars at ≈1000ms,
                                       then 150ms of DOM quiet
stealth phase  outer_html     25ms
[OK [stealth] in 1461ms] … (extract 21ms)
```

The HTTP probe ran in parallel, returned `<div id="root"></div>` after ~500 ms, failed `HasRealContent` (SPA shell), and was discarded; the domain was recorded as `"stealth"`. The second run of the same command returned from the cache in 2 ms with byte-identical files.

---

## 4. Performance optimization

Every item below is implemented; the "why" explains the cost it removes.

### 4.1 Concurrency model

* **Bounded worker pool** (`worker/pool.go`): `Concurrency` goroutines read jobs from a buffered channel and write results to another. Goroutines cost a few KB each, so 30 (or 300) concurrent fetches are cheap; the bound keeps us from opening thousands of connections to one site.
* **Crawler is a lock-free BFS** (`crawl/bfs.go`): workers pull from a shared queue channel; a `sync.Map` is the visited set; two atomic counters (`scheduled`, `activeJobs`) implement the page cap and detect completion without a coordinator goroutine. A page's links are enqueued by the worker that fetched it, so discovery and fetching overlap.
* **Results stream out** through an `onResult` callback (crawl) or the results channel (scrape); the orchestrator writes files while other pages are still in flight.

### 4.2 Avoiding the browser

The single biggest factor. A plain HTTP fetch of a typical page costs 100–500 ms; a browser render costs 1–3 s and a lot of CPU.

* **HTTP first** for every unknown domain, with the browser only as a fallback.
* **Domain memory** (`DomainCache`): the first success on a domain records which tier worked; every later URL on that domain skips the discovery. It is persisted to `<output>/.domain_cache.json` once at exit (`SaveDomainCache`) rather than rewritten per page.
* **Terminal errors stop early**: a 404, a PDF, a tarball, Chrome's own error page — none escalate.
* **`--fast`** disables the browser entirely for users who know their sites are static.

### 4.3 Racing instead of waiting

On a first-seen domain the stealth fetch starts at the same instant as the HTTP probe (when a speculative slot is free). For a static site HTTP wins in a few hundred ms and the tab is cancelled; for an SPA the browser result arrives without first waiting for HTTP to come back and fail. The race is capped at 2 concurrent speculative attempts per process because, measured, an uncapped race during a 30-worker crawl saturated Chrome and made *everything* slower — including the HTTP probes that would have won.

### 4.4 Keeping Chrome warm across runs

Measured cost of a cold start: ~600 ms to launch Chrome plus ~280 ms for the first tab. Measured cost of connecting to an already-running Chrome and opening a tab: ~40 ms + ~35 ms. The daemon (`fetch/daemon.go`) is the same binary started detached with a hidden command; it owns one Chrome on a local DevTools port, writes an info file, and exits after 10 idle minutes. CLI runs connect with `chromedp.NewRemoteAllocator`. Side benefit: Chrome's own HTTP cache persists in the daemon's profile, so a site's JS bundles are cached on repeat visits.

### 4.5 Making the browser do less

* **Resource blocking** (`BlockPatterns`): fonts, images, video/audio and ~20 analytics/ad/session-recorder hosts are blocked at the network layer; `--blink-settings=imagesEnabled=false` stops image decoding entirely. None of these affect the DOM text we extract.
* **No blind sleeps**: `WaitForContent` resolves the moment the DOM has settled instead of sleeping a fixed 2–5 s. It runs inside the page, so there is one CDP round trip for the whole wait rather than one per poll.
* **`page.Navigate` without waiting for `load`**: third-party trackers that hang do not hold the fetch.
* **One navigation per page**: a sparse first render is scrolled in the same tab rather than reloaded.
* **Tab slots** (8 per Chrome) prevent CPU thrash from dozens of tabs rendering at once.

### 4.6 Connection and DNS reuse

One `http.Transport` for the process: keep-alive sockets (idle 120 s), HTTP/2 multiplexing, 1000 idle connections, 200 per host. Each new TLS connection costs 1–2 round trips, so reusing them matters most on crawls where hundreds of requests go to one host. DNS answers are cached for the process lifetime (`dnsCache`), IPv4 first so an unreachable IPv6 route cannot burn a dial timeout.

### 4.7 Parse once, extract many

Previously each extractor parsed the HTML itself — six parses per page. Now `buildScrapeResult` parses once; title/metadata/JSON-LD/links read the tree, readability clones it internally, and the markdown converter works on the single cleaned clone (`ConvertNode`, no re-serialize/re-parse). Measured on a 300-page crawl: average `extract_ms` fell from 41.9 ms to 24.8 ms (the live-site numbers), and to ~3–10 ms on a local server with smaller pages.

### 4.8 Result cache

`cache.Get/Put`: a repeat scrape of the same URL within `--max-age` (default 48 h, the same default Firecrawl uses) is answered from disk in low milliseconds with no network and no browser. Writes are write-then-rename so a concurrent reader never sees a half-written file.

### 4.9 Keeping I/O off the hot path

`AsyncWriter` moves file writes to their own goroutines. The output directory on this machine lives in a OneDrive-synced folder, where a synchronous write of three files per page is visibly slow; the cache and daemon files live in `%LOCALAPPDATA%` for the same reason.

### 4.10 Measured effect (same URL set, before vs after this work)

| Scenario | Before | After |
|---|---|---|
| Static page (`docs.python.org` tutorial), fresh, whole command | ~1.2 s | 0.45 s |
| React SPA (`sheryians.com`), fresh, warm daemon | 3.3 s | 1.36 s |
| Same SPA, repeat within 48 h | 3.3 s | 0.11 s (cache) |
| 404 URL | 3.5 s through Chrome, saved as "success" | ~1 s, reported as failure |
| 300-page crawl of a **local** test server (20 ms/page latency, 30 workers) | 7.0 s for 598 pages (ignored `--pages`) | 2.9 s for exactly 300 |
| Average `extract_ms`, 300 live pages | 41.9 ms | 24.8 ms |

"Before" is the tree as it was before the optimization pass; the comparison binaries were built from both trees and run back to back.

---

## 5. Approaches selected

| Decision | Chosen | Why | Advantages | Limitations | Alternatives considered |
|---|---|---|---|---|---|
| Fetch strategy | Tiered HTTP → stealth Chrome with per-domain memory | Most pages do not need a browser; those that do need it every time | Cheap common case; learning removes repeated discovery cost | A mixed site (some pages static, some JS) learns one tier and may escalate per page | Always-browser (simple, 5–20× slower); always-HTTP (fails on SPAs); classify first via `DetectSiteType` (exists, not wired: a wrong guess costs more than a cheap probe) |
| Unknown-domain handling | Race HTTP and Chrome from t=0, 2 speculative slots | Saves the whole HTTP round trip on SPAs | Latency of `min(http, browser)` | Wastes one tab render on static sites (bounded) | Hedge after a delay (tried at 2.5 s — too slow); strict sequential (simplest, slower for SPAs) |
| Browser lifetime | Detached daemon, idle exit | Chrome launch dominates single-URL runs | ~50 ms connect vs ~900 ms cold | A background process the user must know about (`browser status/stop`); RAM while idle | Launch per run (previous behaviour); long-running server mode (bigger change, not needed for a CLI) |
| Readiness signal | In-page `MutationObserver` quiet period + `readyState` + cap | Fixed sleeps are either too long or too short | Resolves as soon as hydration finishes; handles tickers via cap | Content that arrives > 500 ms after first paint (late API calls) can be missed | Network-idle (waits for trackers/API noise); `load` event (fires before SPA render); fixed sleep |
| Content check | Regex-based `HasRealContent` | Cheap enough to run on every candidate | No parse needed; catches shells, inline-data pages, challenges | Heuristics; a text-light legitimate page (image gallery) can be judged "not real" and escalated | DOM-based classification (slower, more precise); machine-learned (overkill) |
| Content extraction | Readability **and** structural goquery, choose by length heuristics | Readability is excellent on articles, poor on listings/docs; structural extraction is the reverse | Good on both page types | Runs both every time; heuristic thresholds (500 chars, 30 %, 200 chars) are hand-tuned | Readability only; structural only; LLM-based cleanup (slow, costly) |
| Markdown root | Single `<main>` → single `<article>` → `<body>` | Multiple `<article>` means a listing; taking the first lost 19 of 20 products | Keeps all items | `<body>` includes sidebars on sites without `<main>` | Readability's article node (good for articles, drops listings) |
| Parsing | One `x/net/html` tree shared by all extractors; one cleaned clone | Six parses per page was pure waste | ~40 % less extract time | Extractors must stay read-only on the shared tree | Separate parses (simpler isolation, slower) |
| Crawler | Hand-rolled BFS over a channel with atomics | Needs page cap + completion detection, which the generic pool does not offer | No coordinator; links enqueued by fetching workers | Duplicates the worker-loop idea in `worker.Pool` (see §10) | Reuse `worker.Pool` + external frontier; `colly` (brings its own fetcher, conflicts with tiers) |
| Rate limiting | Token bucket per domain | Politeness and avoiding bans without global slowdown | Honors `Crawl-delay`; bursts allowed | 100 rps default caps crawl throughput (§8) | Fixed sleep per request (blocks workers); none |
| Caching | Disk JSON per URL, `maxAge` semantics | Firecrawl's model; simple, shared across runs | Instant repeats; no server needed | Stale content within the window; no invalidation besides age or `cache clear` | SQLite/BoltDB (more deps for no gain at this size); HTTP conditional requests (needs ETags; sites rarely honour them for HTML) |
| Output I/O | Async writer goroutines | Disk (and OneDrive) latency was blocking workers | Workers never wait on disk | Process must drain the writer before exit (`Close`) | Synchronous writes |

---

## 6. Package and dependency analysis

Direct dependencies from `go.mod`:

| Package | Used for | Why this one | Alternatives considered |
|---|---|---|---|
| `github.com/spf13/cobra` | CLI commands, flags, help, hidden daemon command | De-facto standard; subcommands + persistent flags + `Hidden` commands out of the box | `flag` stdlib (no subcommands), `urfave/cli` |
| `github.com/chromedp/chromedp` + `chromedp/cdproto` | Driving headless Chrome over the DevTools protocol: exec allocator, remote allocator (daemon), tabs, `Navigate`, `Evaluate`, `OuterHTML`, network blocking, status events | Pure Go, no Node/driver binary; gives raw CDP access (`page.AddScriptToEvaluateOnNewDocument`, `network.SetBlockedURLs`, `EventResponseReceived`) which the stealth and status features need | `playwright-go` (needs a Node driver install), `rod` (similar scope; chromedp has the larger ecosystem), Selenium (heavy) |
| `github.com/PuerkitoBio/goquery` | jQuery-style DOM queries over `x/net/html` trees: cleaning, title, text, metadata, links, JSON-LD, markdown root selection | Thin, fast wrapper over the stdlib-adjacent parser; shares the `*html.Node` tree with readability and html-to-markdown, which is what makes "parse once" possible | Raw `x/net/html` walking (verbose), `htmlquery` (XPath) |
| `github.com/go-shiori/go-readability` | Mozilla Readability port: main-article extraction and title | Well-maintained Go port of the algorithm Firefox Reader View uses; `FromDocument` accepts our parsed tree | `go-trafilatura` (stronger on boilerplate removal, heavier), `goose` (unmaintained) |
| `github.com/JohannesKaufmann/html-to-markdown/v2` | HTML → GitHub-flavored Markdown | v2 has `ConvertNode` (no re-parse), sane defaults for tables/code/links | v1 of the same library (string-only API), `godown`, custom walker |
| `golang.org/x/time/rate` | Per-domain token-bucket limiter | Standard, context-aware `Wait`, correct burst semantics | Hand-rolled ticker; `uber-go/ratelimit` (leaky bucket, no burst) |

Indirect dependencies (`cascadia`, `x/net`, `gobwas/ws`, `go-shiori/dom`, `dateparse`, …) are pulled in by the above.

Standard library pieces that carry real weight: `net/http` (transport pooling, HTTP/2), `context` (every cancellation path), `sync`/`sync/atomic` (pool, visited set, counters), `regexp` (content checks), `encoding/json|xml|csv`, `os/exec` + `syscall` (daemon spawn), `log/slog` (structured logging), `crypto/sha256` (cache keys).

**Not used, deliberately:** no brotli decoder (the transport advertises gzip only; adding `andybalholm/brotli` would shrink some transfers — see §10), no proxy library (`ProxyRotator` exists but is not wired), no database.

---

## 7. Code walkthrough

File references use `path:line` for the current tree.

### 7.1 `cmd/scraper/main.go`

Builds the cobra tree. `buildConfig` assembles `Config` (defaults → env → flags) and returns an `Orchestrator`; `createContext` wires `SIGINT`/`SIGTERM` to a root `context.CancelFunc` so Ctrl+C cancels every in-flight fetch. Commands: `scrape`, `crawl`, `sitemap`, `discover`, `browser {status,stop}`, `cache clear`, and the hidden `_browser-daemon --port --idle` which just calls `fetch.RunBrowserDaemon`. `-v/--verbose` switches `slog` to debug, which enables the per-phase browser timings. Note the daemon command overrides `PersistentPreRun` with a no-op so the ASCII banner is not written to its log file.

### 7.2 `internal/orchestrator/orchestrator.go`

`New` creates the `BrowserPool` (skipped when `--fast`) and calls `pool.Warm()` so the daemon connection happens while the first HTTP probes are already running. The limiter is `rate = 1/delay` or 100 rps when delay is 0, burst 20. `RunScrape` wires `worker.Pool` → `AsyncWriter`; `RunCrawl` passes an `onResult` callback to `CrawlSite` so pages are written as they finish; `RunSitemap` discovers then delegates to `RunScrape`, falling back to a single-URL scrape when no sitemap exists. `Close` persists the domain cache and shuts the pool down.

### 7.3 `internal/fetch/pipeline.go` — the heart

`FetchWithEscalation` ([pipeline.go:123](internal/fetch/pipeline.go#L123)):

```go
// Result cache: a recent successful scrape of this exact URL is returned as-is
if cfg != nil && cfg.MaxAge > 0 {
    if cached, ok := cache.Get(rawURL, cfg.MaxAge); ok { … return cached }
}
effectiveURL := convert.GetAlternativeURL(rawURL)        // Tier 0
…
if (cfg != nil && cfg.FastMode) || pool == nil { … HTTP only … }
hint, _ := DomainCache.Load(domain)
if hint == "stealth" || hint == "browser" { … browser first, fall through on failure … }
```

The race is a `select` loop over two result channels. `startBrowser` is idempotent (`stealthTried`), so the browser is started at most once per URL — either speculatively at t=0 (if a `speculativeSlots` token is available, [pipeline.go:27](internal/fetch/pipeline.go#L27)) or after HTTP fails. Three outcomes are terminal: a passing result (`buildScrapeResult`), an `ErrTerminal` from either side (`failedResult`), or both sides exhausted (last-resort `sparse` browser render, else failure). Two invariants worth remembering:

* `"stealth"` is recorded in `DomainCache` **only if HTTP had already completed and failed** (`!httpPending`). Otherwise a browser that merely out-raced a slow HTTP response would teach the cache that the whole site needs Chrome — exactly the bug observed when the first version of the race turned a 300-page static crawl into 300 browser renders.
* All cancellation flows through contexts: `defer cancelHTTP()` / `defer cancelBrowser()` tear down the loser, and `OpenTab` closes the tab when its context is cancelled.

`buildScrapeResult` ([pipeline.go:276](internal/fetch/pipeline.go#L276)) is the single parse + fan-out described in §3 step 7.

### 7.4 `internal/fetch/http.go`

`defaultTransport`/`globalHTTPClient` (no client-level timeout; timeouts are per request so the flag actually applies). `IsTerminalStatus` ([http.go:113](internal/fetch/http.go#L113)) deliberately **excludes** 401/403/429/503 — those are what WAFs and bot challenges return, and a browser often gets through them. `cachedDialContext` ([http.go:56](internal/fetch/http.go#L56)) implements the IPv4-first multi-address dial.

### 7.5 `internal/fetch/browser_pool.go`, `daemon.go`, `browser.go`, `stealth.go`

* `chromeFlags()` ([browser_pool.go:43](internal/fetch/browser_pool.go#L43)) is the single source of Chrome launch flags for both local instances and the daemon.
* `init` connects instance 0 to the daemon (`connectDaemon`) and launches any extra `--browsers` locally, all in parallel under the pool mutex, so `Shutdown` cannot race a half-started pool.
* `OpenTab` ([browser_pool.go:158](internal/fetch/browser_pool.go#L158)): acquire a semaphore token (or give up if the caller's context is done), pick an instance round-robin, `chromedp.NewContext`, and `context.AfterFunc(ctx, cancelTab)` so a cancelled fetch closes its tab even if `release` is never called.
* `ensureDaemon` ([daemon.go:163](internal/fetch/daemon.go#L163)): read info file → probe `/json/version` (300 ms timeout) → if dead, take `spawn.lock` with `O_EXCL`, spawn, poll until ready (8 s cap); a second process that loses the lock polls the info file instead. `RunBrowserDaemon` ([daemon.go:222](internal/fetch/daemon.go#L222)) is the daemon loop: every 2 s it lists Chrome's targets; any page that is not `about:blank` counts as activity; 10 idle minutes or 3 consecutive failed probes → exit (which kills Chrome through the exec allocator's cancel). `StopDaemon` sends CDP `Browser.close` and falls back to killing the PID.
* `waitForContentJS` ([browser.go:71](internal/fetch/browser.go#L71)) is the readiness promise described in §3; `WaitForContent` retries it on execution-context loss.
* `FetchStealth` ([stealth.go:110](internal/fetch/stealth.go#L110)) — action list, main-frame status tracking keyed by the `FrameID` returned from `page.Navigate`, `chrome-error://` detection, sparse-render scroll, and `mark()` debug timings.

### 7.6 `internal/crawl/bfs.go`

`CrawlSite` ([bfs.go:19](internal/crawl/bfs.go#L19)). Per worker iteration: wait on the limiter → `FetchWithEscalation` → append result → `onResult` → if `depth < MaxDepth` and under the page cap, filter each discovered link (same host unless `--follow-external`, robots.txt, `--include`/`--exclude` regex, not already visited via `visited.LoadOrStore`) → `scheduled++` (reject and stop scanning this page's links once it would exceed `MaxPages`) → `activeJobs++` → enqueue. After processing, `activeJobs--`; whoever brings it to 0 closes the queue and every worker exits. The queue buffer is `MaxPages*5+100`, large enough that enqueuing never blocks in practice. `robots.go` is a small parser (rules for `*` or agents containing "bot", `Disallow` prefix matching, `Crawl-delay`, `Sitemap`); `sitemap.go` tries robots-declared sitemaps then four common paths, follows sitemap indexes to depth 3, caps at 500 URLs.

### 7.7 `internal/extract`, `internal/convert`, `internal/detect`

Covered in §3. The string-taking functions (`ExtractContent`, `ExtractMetadata`, `HTMLToMarkdown`, …) still exist as compatibility wrappers around the `*Doc` variants; the pipeline only uses the `*Doc` ones.

### 7.8 `internal/cache/cache.go` and `internal/output`

`Get` validates URL equality and `Success` before honouring an entry; `Put` skips results whose HTML exceeds 5 MB. `output.SaveResult` is per-format; `AsyncWriter` ([writer.go:119](internal/output/writer.go#L119)) is the fan-out. `summary.go` and `csv.go` are straightforward report writers.

---

## 8. Performance and bottlenecks

### What dominates, by scenario

| Scenario | Dominant cost | Our overhead |
|---|---|---|
| Static page, single URL | Server TTFB + transfer (100–700 ms) | Process start + connect ≈ 100 ms, extract 5–30 ms |
| JS app, single URL, warm daemon | The site's own JS bundles and render (sheryians.com: ~1000 ms until anything is visible) | tab + setup + navigate ≈ 160 ms, quiet period 150 ms, extract ~20 ms |
| JS app, cold daemon | + Chrome launch (~600 ms) + empty browser cache | one-time per idle period |
| Crawl of a static site | Server response time × pages ÷ concurrency | ≈10 ms/page on a local server |
| Repeat of anything within `--max-age` | Disk read of one JSON file | 1–3 ms |

### Things that slow the system down (measured or by construction)

1. **The site itself.** This cannot be stressed enough: `books.toscrape.com` varied between 0.4 s and 3.7 s average response during this work; `quotes.toscrape.com` between 0.3 s and 1 s. Benchmark against a local server (see below) before blaming the code.
2. **The default rate limit caps crawls at 100 pages/s per domain.** With `--delay 0` the orchestrator still builds a 100 rps / burst-20 bucket. The local benchmark (300 pages in 2.9 s) sits almost exactly on that ceiling. For sites that can take more, this is the first knob to raise; see §10.
3. **Memory grows with the run.** `RunScrape`/`RunCrawl` keep every `ScrapeResult` in a slice until the end for the reports, and each result holds the raw HTML (needed for the `html` format and the cache). 300 pages × ~100 KB is fine; 50,000 pages is not.
4. **Chrome CPU.** Eight concurrent tabs rendering heavy pages saturate an 8-core machine; the semaphore keeps it from getting worse, but browser-heavy crawls are CPU-bound, not network-bound.
5. **Readability runs on every page** and clones the whole tree, even when the structural extraction is clearly sufficient.
6. **`HasRealContent` runs its regexes over the full HTML** and is called more than once for the same HTML on some paths (pipeline check and the sparse check inside `FetchStealth`).
7. **No brotli.** Servers that would send `br` fall back to gzip or identity; transfer sizes are somewhat larger than necessary.
8. **Shutdown waits for pool init.** `Shutdown` takes the pool mutex, so a run that finishes while the daemon is still being spawned (first run after idle, static page) waits for the spawn (~700 ms) before exiting.

### How to measure

* Per page: `timing.fetch_ms` / `extract_ms` / `total_ms` in each JSON file; `SUMMARY.md` aggregates them; `results.csv` (with `-f ...,csv`) is convenient for spreadsheets.
* Browser phases: `-v` logs `open_tab`, `setup`, `navigate`, `wait_content`, `outer_html`, `sparse_scroll` per URL.
* A/B: build the previous tree to another binary, run both on the same URL list into fresh `-o` directories with `--max-age 0`, alternate the order, repeat, and compare `.md` files with `cmp` as the quality gate. Never run two benchmarks at once — they share one Chrome.
* Remove the network: a 40-line Go HTTP server that serves synthetic linked pages with a fixed `time.Sleep` gives stable numbers; that is how the 2.9 s / 7.0 s crawl comparison above was produced.
* Go-level profiling: `go test -bench` on `HasRealContent`, `ExtractContentDoc`, `HTMLToMarkdownDoc` with saved HTML fixtures would isolate CPU costs; none exist yet.

### Where further optimization is realistic

* Raise or remove the limiter when `--delay` is 0 (biggest crawl win, trivial).
* Drop `HTML` from results after they are written and cached, unless the `html` format is requested (memory).
* Pre-open and pre-configure one tab during `Warm()` so the first browser fetch skips ~100 ms of `open_tab`+`setup`.
* Run readability, markdown conversion and the metadata/links/JSON-LD extractors concurrently within `buildScrapeResult` (safe: they read the tree or their own clone; `stripInlineAttrs` must run before text extraction or on its own clone). Helps single-URL latency, not crawl throughput, which is already CPU-saturated.
* Brotli decoding.
* `Shutdown` should not wait for a daemon connection that is still in progress (only for local Chrome launches, which must be killed).

---

## 9. Error handling and edge cases

### Cancellation and timeouts

| Mechanism | Where | Effect |
|---|---|---|
| Ctrl+C / SIGTERM | `createContext` in `main.go` | Cancels the root context → workers stop taking jobs, in-flight HTTP requests abort, tabs close via `context.AfterFunc`, queue closes |
| `--timeout` (10 s) | `FetchHTTP` per-request `context.WithTimeout` | Slow servers fail the HTTP tier; the pipeline may still try the browser |
| `BrowserTimeout` (20 s) | `FetchStealth` tab context | The whole browser attempt is bounded |
| `WaitForContent` 5 s (2 s after scroll) | in-page deadline | Returns whatever is rendered; `HasRealContent` then decides |
| Transport timeouts | dial 4 s, TLS 4 s, response headers 8 s | Hanging sockets are released |
| Daemon ready 8 s, probe 300 ms | `daemon.go` | A daemon that fails to start falls back to a locally launched Chrome |

### Retries

There is **no retry loop** at the HTTP level: `Config.MaxRetries` exists but is not used. Escalation acts as the retry (a different method, not the same request again). A domain hinted `"stealth"` whose render fails still falls through to HTTP, so a wrong hint is self-correcting for that URL.

### Failure classification

* **Terminal** (`ErrTerminal`): 400/404/405/410/414/451/500/501/502/504, non-HTML/JSON content types, Chrome error pages (`chrome-error://`). Result: `Success: false` with the error text; no browser attempt; never cached; crawl continues with other pages.
* **Possibly bot-protection** (401/403/429/503, challenge HTML, SPA shells): HTTP result rejected, browser attempted.
* **Sparse browser render** (page exists but little text): scrolled once; if still sparse and HTTP also failed, the sparse render is returned as a last resort — the user gets *something*, marked `Success: true`. This is a deliberate choice that can produce thin files for image-heavy pages.
* **All tiers exhausted / no Chrome available**: `Success: false` with the last error (`"all fetch tiers exhausted"` if none).

### Invalid or odd inputs

* Unparseable start URL in `crawl`: logged, empty result set.
* Invalid `--include`/`--exclude` regex: **silently ignored** (`regexp.Compile` error dropped), so the filter simply does not apply. This is a sharp edge worth fixing (§10).
* `robots.txt` unreachable or non-200: treated as "no restrictions". Only `User-agent: *` or agents containing "bot" are honoured.
* No sitemap found: `sitemap` falls back to scraping the base URL; `discover` prints 0 URLs.
* URLs whose host differs after rewriting (Reddit → `.json`): output keeps the original URL; JSON is wrapped as `<pre>` inside HTML.
* Pages > 10 MB: body truncated at 10 MB (may fail the content check); results with HTML > 5 MB are not cached.
* Two URLs that differ only by query string (`/search?q=a` vs `/search?q=b`) map to the **same output filename** — the query is not part of `URLToFilename`, so the second overwrites the first. The cache and JSON `url` field are unaffected (they use the full URL).
* Concurrent CLI runs while no daemon exists: the `spawn.lock` ensures one spawns and the others wait on the info file; a lock older than 15 s is treated as stale.
* Daemon dies (Chrome crash, user kills it): `daemonAlive` fails on the next run → a new daemon is spawned; a running CLI whose tabs disappear gets chromedp errors on that fetch and reports failure for that URL.
* Chrome not installed: local launch logs a warning, `OpenTab` returns "no chrome instance available", every browser attempt fails, HTTP-only behaviour results.

### Logging

`log/slog` text handler on stdout. Info level: one line per page (`[OK [http] in 205ms] url -> title`, `[OK [cached stealth] …]`, `[FAILED: …]`), job start/end, report paths. Debug (`-v`): browser phase timings and `wait_content` retries. The daemon logs to `%LOCALAPPDATA%\go-scraper\browser-daemon.log`.

---

## 10. Trade-offs and future improvements

### Compromises made, knowingly

| Compromise | Why we accepted it | What it costs |
|---|---|---|
| A background Chrome process that outlives the command | ~850 ms saved on every run that needs a browser | Users must know about `browser stop`; ~100–200 MB RAM while idle (≤10 min) |
| 48 h result cache on by default | Same default as Firecrawl; most repeat scrapes want the cached answer | Stale content unless `--max-age 0`; disk usage in the user cache dir |
| Speculative Chrome on unknown domains | Faster SPAs | One wasted render per unknown static domain (bounded to 2 at a time) |
| 150 ms quiet / 500 ms cap readiness | No fixed sleeps | Late-arriving content (> 500 ms after first paint) may be missed |
| Last-resort sparse render counts as success | Return something rather than nothing | Thin output for image-first pages |
| Readability + structural extraction both run | Quality across page types | Extra CPU per page |
| Heuristic content checks | Speed and simplicity | Occasional misjudgement on text-light pages |

### Code that is unused, redundant, or worth simplifying

Implemented but **not wired into the pipeline** (dead code today): `fetch.FetchBrowser` (non-stealth browser tier), `detect.DetectSiteType`, `detect.DetectBotProtection`, `ratelimit.ProxyRotator`, `Config.MaxRetries`, `Config.MaxRequestsPerMinute`, `Config.UseStealth` / `--stealth` (parsed, never read; the browser tier is always stealth), `Config.Proxies`, the `SiteType` and `BotProtection` types. Either wire them in with a purpose or delete them; keeping them suggests behaviour that does not exist.

Redundancy: the noise selector list exists twice (`extract.noiseSelector` and `convert.noiseSelector`, differing only in order); `crawl/bfs.go` re-implements the worker loop that `worker.Pool` provides; the string-taking extractor wrappers are only used by tests; `robots.go` and `sitemap.go` each build their own `http.Client` instead of using the shared transport (and `robots.go` sends `User-Agent: *`, which is not a real agent string).

### Practical improvements, in rough priority order

1. **Rate limiter default**: skip the limiter (or use a very high rate) when `--delay` is 0 and no `Crawl-delay` was found. Largest crawl throughput gain for one line of code.
2. **Fail loudly on invalid `--include`/`--exclude`** instead of silently disabling the filter.
3. **Include a hash of the query string in `URLToFilename`** to stop collisions.
4. **Free HTML after use** (write + cache, then drop) to make large crawls memory-flat; compute report rows as results arrive instead of keeping full results.
5. **HTTP retries with backoff** for transient network errors and 429/503 — `MaxRetries` is already in `Config`.
6. **Brotli** (`Accept-Encoding: br, gzip` + `andybalholm/brotli`).
7. **Pre-warmed tab** during `Warm()`; make `Shutdown` not wait on an in-progress daemon connection.
8. **Decide the fate of the dead code** above; if `DetectSiteType`/`DetectBotProtection` stay, use them to pick the first tier when no domain hint exists.
9. **Tests**: the repo has unit tests only for `convert`, `detect`, `output`. The highest-value additions are an `httptest`-based test of `FetchWithEscalation` (static page, SPA shell, 404, terminal content type) and benchmarks for `HasRealContent` / `ExtractContentDoc` / `HTMLToMarkdownDoc` on fixture HTML.
10. **Cache invalidation helpers**: per-URL or per-domain `cache clear <pattern>`, and honouring `Cache-Control`/`ETag` when servers provide them.
11. **Proxy support** via the existing `ProxyRotator` (per-request `Transport.Proxy` for HTTP; `--proxy-server` for Chrome) if blocked IPs become a problem.

### What this system is not (yet)

It is a CLI, not a service: there is no HTTP API, no job queue, no distributed crawling, no screenshotting or PDF rendering, no LLM-based extraction, no JavaScript "actions" (click/type) — all of which Firecrawl offers. The design does not preclude them (the fetch pipeline is already independent of the CLI), but none exist in this tree.
