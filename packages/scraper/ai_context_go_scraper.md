# 🧠 AI Context File — Go Web Scraper (Firecrawl-Speed)

> **Purpose**: This file contains EVERYTHING an AI needs to build the Go scraper project from scratch. Feed this entire file as context. No other files or questions needed.

---

## 1. PROJECT IDENTITY

**Name**: `go-scraper`  
**Language**: Go (1.22+)  
**What it does**: A CLI tool that scrapes web pages and crawls websites at Firecrawl-level speed. It fetches HTML, extracts clean content, converts to Markdown, and outputs to multiple formats.  
**Module path**: `github.com/sujal/go-scraper`

### Modes of Operation

| Mode | Command | What it does |
|------|---------|-------------|
| **scrape** | `go-scraper scrape <url1> [url2] ...` | Scrape specific URLs |
| **crawl** | `go-scraper crawl <startURL> --depth=3 --pages=50` | BFS crawl a website |
| **sitemap** | `go-scraper sitemap <url> --pages=100` | Discover sitemap URLs and scrape them |
| **discover** | `go-scraper discover <url>` | Just discover URLs from sitemap (no scraping) |

---

## 2. COMPLETE DATA FLOW

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        COMPLETE REQUEST LIFECYCLE                        │
└──────────────────────────────────────────────────────────────────────────┘

USER INPUT (URL)
     │
     ▼
┌─────────────────┐
│ CLI (cobra)      │  Parses args, flags, env vars → builds Config struct
│ cmd/scraper/     │  Decides mode: scrape | crawl | sitemap | discover
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Orchestrator     │  For "scrape": sends URLs directly to worker pool
│                  │  For "crawl": seeds BFS queue, manages depth/dedup
│                  │  For "sitemap": fetches sitemap first, then batch scrape
│                  │  For "discover": fetches sitemap, prints URLs, exits
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Worker Pool      │  N goroutines pulling from buffered channel
│ (goroutines)     │  Each worker calls FetchWithEscalation() for one URL
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ RATE LIMITER (per-domain token bucket)               │
│ - Blocks goroutine until domain has available tokens │
│ - Separate limiter per domain                        │
│ - Respects robots.txt crawl-delay                    │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ URL REWRITER (Tier 0 — pre-fetch)                    │
│ - reddit.com → reddit.com/.json                      │
│ - twitter.com/x.com → nitter.net                     │
│ - medium.com → scribe.rip                            │
│ - Returns original URL if no rewrite applies          │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ DOMAIN-AWARE ROUTER                                  │
│ 1. Check domainCache (sync.Map) for saved hint       │
│    - If found: jump directly to known-good tier       │
│    - If not found: start progressive escalation       │
│                                                       │
│ PROGRESSIVE ESCALATION:                               │
│ ┌──────────────────────────────────┐                  │
│ │ Tier 1: net/http GET             │ ~50-200ms        │
│ │ → Quality Check                  │                  │
│ │ → If good content: RETURN ✅     │                  │
│ │ → If garbage: continue ↓         │                  │
│ ├──────────────────────────────────┤                  │
│ │ Tier 2: chromedp headless tab    │ ~500-2000ms      │
│ │ → Navigate, wait for content     │                  │
│ │ → Quality Check                  │                  │
│ │ → If good content: RETURN ✅     │                  │
│ │ → If garbage: continue ↓         │                  │
│ ├──────────────────────────────────┤                  │
│ │ Tier 3: chromedp stealth tab     │ ~1000-3000ms     │
│ │ → Inject anti-detection JS       │                  │
│ │ → Mouse movement, scrolling      │                  │
│ │ → Wait for CF challenge resolve  │                  │
│ │ → Quality Check                  │                  │
│ │ → If good content: RETURN ✅     │                  │
│ │ → If garbage: continue ↓         │                  │
│ ├──────────────────────────────────┤                  │
│ │ Tier 4: stealth + scroll + wait  │ ~2000-5000ms     │
│ │ → Same as Tier 3 + autoScroll    │                  │
│ │ → Extended wait (5s cap)         │                  │
│ │ → RETURN whatever we got         │                  │
│ └──────────────────────────────────┘                  │
│                                                       │
│ After success: cache.Set(domain, winningTier)         │
└────────┬────────────────────────────────────────────┘
         │
         │  Raw HTML string
         ▼
┌─────────────────────────────────────────────────────┐
│ CONTENT EXTRACTION PIPELINE                          │
│                                                       │
│ Step 1: DUAL-ENGINE TEXT EXTRACTION                   │
│   ├─ go-readability (article extraction)             │
│   └─ goquery fallback (strips tags, keeps structure) │
│   → Pick winner: if readability returns >500 chars   │
│     AND >30% of fallback length, use readability.    │
│     Otherwise use fallback.                          │
│                                                       │
│ Step 2: HTML → MARKDOWN (html-to-markdown lib)       │
│   → Strip: script, style, nav, footer, noscript,     │
│     iframe, svg                                       │
│   → Preserve: headings, lists, links, code blocks,   │
│     tables, bold, italic                              │
│   → Add title header + source URL line               │
│                                                       │
│ Step 3: METADATA EXTRACTION (from <head>)            │
│   → description, keywords[], ogTitle, ogDescription, │
│     ogImage, canonical, lang, author,                │
│     publishedDate, modifiedDate                       │
│                                                       │
│ Step 4: JSON-LD EXTRACTION                           │
│   → Find all <script type="application/ld+json">     │
│   → Parse each as JSON, collect into []any           │
│                                                       │
│ Step 5: LINK EXTRACTION                              │
│   → Find all <a href="...">                          │
│   → Resolve relative → absolute URLs                 │
│   → Filter: same-domain only, http/https only        │
│   → Skip: .pdf, .jpg, .png, .gif, .svg, .zip,       │
│     .css, .js, .mp4, .mp3                            │
│   → Strip #fragments to avoid duplicates             │
└────────┬────────────────────────────────────────────┘
         │
         │  ScrapeResult struct
         ▼
┌─────────────────────────────────────────────────────┐
│ OUTPUT PIPELINE                                      │
│                                                       │
│ Per-page outputs (based on config.OutputFormats):     │
│  • .md   → "# {title}\n> Source: {url}\n\n{body}"   │
│  • .json → {url, title, text, metadata, timing, ...}│
│  • .txt  → "Title: ...\nURL: ...\n───\n{text}"      │
│  • .html → raw HTML as-is                            │
│                                                       │
│ Batch outputs:                                        │
│  • results.csv → url,title,success,method,length,... │
│  • SUMMARY.md  → stats table + per-page results      │
│  • CRAWL_INDEX.md → (crawl mode only) depth + links  │
│                                                       │
│ Filename: URL → sanitize → lowercase → truncate 100  │
│   "https://example.com/page" → "example_com_page.md" │
└─────────────────────────────────────────────────────┘
```

---

## 3. PROJECT STRUCTURE

```
go-scraper/
├── cmd/
│   └── scraper/
│       └── main.go                 # cobra CLI entry point
│
├── internal/
│   ├── config/
│   │   └── config.go               # Config struct, defaults, env/flag parsing
│   │
│   ├── orchestrator/
│   │   └── orchestrator.go         # Mode dispatcher: scrape/crawl/sitemap/discover
│   │
│   ├── worker/
│   │   └── pool.go                 # Generic goroutine worker pool
│   │
│   ├── fetch/
│   │   ├── http.go                 # Tier 1: net/http with keep-alive connection pool
│   │   ├── browser.go              # Tier 2: chromedp standard headless
│   │   ├── stealth.go              # Tier 3: chromedp with stealth JS patches
│   │   ├── pipeline.go             # FetchWithEscalation() + domain cache
│   │   ├── browser_pool.go         # Chrome instance pool (3-5 browsers)
│   │   └── useragent.go            # UA rotation + browser headers
│   │
│   ├── extract/
│   │   ├── readability.go          # go-readability wrapper
│   │   ├── goquery.go              # goquery-based fallback extraction
│   │   ├── content.go              # Combined dual-engine: readability vs goquery
│   │   ├── jsonld.go               # JSON-LD <script> block extraction
│   │   ├── metadata.go             # <head> meta tag extraction
│   │   └── links.go                # <a href> link discovery + normalization
│   │
│   ├── detect/
│   │   ├── site_type.go            # Detect: static | spa | api-backed | infinite-scroll | auth-required
│   │   ├── bot_protection.go       # Detect: Cloudflare | Akamai | DataDome | PerimeterX | CAPTCHA
│   │   └── quality.go              # HasRealContent() — smart content validation
│   │
│   ├── convert/
│   │   ├── markdown.go             # HTML → Markdown conversion
│   │   └── url_rewrite.go          # Smart URL rewriting for known hard sites
│   │
│   ├── crawl/
│   │   ├── bfs.go                  # BFS crawler with concurrent workers
│   │   ├── robots.go               # robots.txt fetch + parse + compliance
│   │   └── sitemap.go              # Sitemap XML fetch + parse (handles indexes)
│   │
│   ├── ratelimit/
│   │   ├── limiter.go              # Per-domain token bucket (x/time/rate)
│   │   └── proxy.go                # Proxy rotation with failure tracking
│   │
│   ├── output/
│   │   ├── writer.go               # Output dispatcher: picks format, calls writers
│   │   ├── markdown.go             # .md writer
│   │   ├── json.go                 # .json writer
│   │   ├── csv.go                  # .csv batch writer
│   │   ├── text.go                 # .txt writer
│   │   └── summary.go              # SUMMARY.md + CRAWL_INDEX.md generator
│   │
│   └── types/
│       └── types.go                # ALL shared types (see section 4)
│
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

---

## 4. ALL TYPES (exact Go structs to implement)

```go
package types

import "time"

// ─── Core Result ───

type ScrapeResult struct {
    URL            string        `json:"url"`
    Success        bool          `json:"success"`
    Method         string        `json:"method"`          // "http" | "browser" | "stealth" | ""
    Title          string        `json:"title"`
    Text           string        `json:"text"`            // plain text content
    Markdown       string        `json:"markdown"`        // full markdown document
    HTML           string        `json:"html"`            // raw HTML
    StructuredData []any         `json:"structured_data"` // JSON-LD blocks
    Metadata       PageMetadata  `json:"metadata"`
    Links          []string      `json:"links"`           // same-domain outbound links
    Error          string        `json:"error"`
    Timing         Timing        `json:"timing"`
}

type Timing struct {
    FetchMs   int64 `json:"fetch_ms"`
    ExtractMs int64 `json:"extract_ms"`
    TotalMs   int64 `json:"total_ms"`
}

type PageMetadata struct {
    Description   string   `json:"description"`
    Keywords      []string `json:"keywords"`
    OGTitle       string   `json:"og_title"`
    OGDescription string   `json:"og_description"`
    OGImage       string   `json:"og_image"`
    Canonical     string   `json:"canonical"`
    Lang          string   `json:"lang"`
    Author        string   `json:"author"`
    PublishedDate string   `json:"published_date"`
    ModifiedDate  string   `json:"modified_date"`
}

// ─── Fetch Types ───

type FetchResult struct {
    HTML    string
    Method  string
    FetchMs int64
    Status  int
}

// ─── Site Detection ───

type SiteType string

const (
    SiteStatic         SiteType = "static"
    SiteSPA            SiteType = "spa"
    SiteAPIBacked      SiteType = "api-backed"
    SiteInfiniteScroll SiteType = "infinite-scroll"
    SiteAuthRequired   SiteType = "auth-required"
    SiteUnknown        SiteType = "unknown"
)

type BotProtection struct {
    HasProtection bool
    Provider      string // "Cloudflare" | "Akamai" | "DataDome" | "PerimeterX" | "CAPTCHA" | "Generic" | ""
}

// ─── Configuration ───

type Config struct {
    // Fetching
    MinContentLength    int           `json:"min_content_length"`
    MaxRetries          int           `json:"max_retries"`
    Concurrency         int           `json:"concurrency"`
    RequestTimeout      time.Duration `json:"request_timeout"`
    BrowserTimeout      time.Duration `json:"browser_timeout"`

    // Rate limiting
    DelayBetweenRequests time.Duration `json:"delay_between_requests"`
    RespectRobotsTxt     bool          `json:"respect_robots_txt"`
    MaxRequestsPerMinute int           `json:"max_requests_per_minute"`

    // Crawling
    MaxPages            int    `json:"max_pages"`
    MaxDepth            int    `json:"max_depth"`
    FollowExternalLinks bool   `json:"follow_external_links"`
    IncludePaths        string `json:"include_paths"` // regex pattern
    ExcludePaths        string `json:"exclude_paths"` // regex pattern

    // Output
    OutputDir     string   `json:"output_dir"`
    OutputFormats []string `json:"output_formats"` // "markdown","json","text","html","csv"

    // Anti-bot
    UseStealth     bool          `json:"use_stealth"`
    RotateUA       bool          `json:"rotate_ua"`
    Proxies        []ProxyConfig `json:"proxies"`
    BrowserPoolSize int          `json:"browser_pool_size"`

    // Content
    ExtractStructuredData bool `json:"extract_structured_data"`
    ExtractMetadata       bool `json:"extract_metadata"`
    ExtractLinks          bool `json:"extract_links"`
}

type ProxyConfig struct {
    Host     string `json:"host"`
    Port     int    `json:"port"`
    Username string `json:"username,omitempty"`
    Password string `json:"password,omitempty"`
    Protocol string `json:"protocol"` // "http" | "https" | "socks5"
}

// ─── Default Config ───

var DefaultConfig = Config{
    MinContentLength:     200,
    MaxRetries:           3,
    Concurrency:          20,
    RequestTimeout:       15 * time.Second,
    BrowserTimeout:       30 * time.Second,
    DelayBetweenRequests: 100 * time.Millisecond,
    RespectRobotsTxt:     true,
    MaxRequestsPerMinute: 300,
    MaxPages:             50,
    MaxDepth:             3,
    FollowExternalLinks:  false,
    OutputDir:            "output",
    OutputFormats:        []string{"markdown", "json"},
    UseStealth:           true,
    RotateUA:             true,
    BrowserPoolSize:      3,
    ExtractStructuredData: true,
    ExtractMetadata:       true,
    ExtractLinks:          true,
}

// ─── Crawl Types ───

type CrawlPageResult struct {
    ScrapeResult
    Depth int `json:"depth"`
}

type SitemapEntry struct {
    URL        string  `json:"url"`
    LastMod    string  `json:"lastmod,omitempty"`
    ChangeFreq string  `json:"changefreq,omitempty"`
    Priority   float64 `json:"priority,omitempty"`
}

// ─── Worker Types ───

type Job struct {
    URL   string
    Depth int
}

type WorkerResult struct {
    Job    Job
    Result ScrapeResult
    Links  []string // discovered links for crawler to enqueue
}
```

---

## 5. FILE-BY-FILE CONTRACTS

### `cmd/scraper/main.go`
**Responsibility**: CLI entry point using `cobra`.  
**Must**:
- Define root command `go-scraper`
- Define subcommands: `scrape`, `crawl`, `sitemap`, `discover`
- Parse flags: `--concurrency`, `--depth`, `--pages`, `--output`, `--formats`, `--stealth`, `--delay`
- Parse env vars: `OUTPUT_DIR`, `FORMATS`, `CONCURRENCY`, `MAX_DEPTH`, `MAX_PAGES`, `DELAY_MS`, `STEALTH`
- Print banner on startup
- Call orchestrator with parsed config
- Handle graceful shutdown on SIGINT/SIGTERM

### `internal/config/config.go`
**Responsibility**: Config struct + merge logic.  
**Must**:
- Define `Config` struct (see types above)
- Provide `DefaultConfig` variable
- Function `MergeWithFlags(cfg *Config, flags map[string]any)` — applies CLI flag overrides
- Function `MergeWithEnv(cfg *Config)` — reads env vars and applies

### `internal/orchestrator/orchestrator.go`
**Responsibility**: Dispatch based on mode.  
**Must**:
- Function `RunScrape(urls []string, cfg Config)` — batch scrape, calls worker pool
- Function `RunCrawl(startURL string, cfg Config)` — starts BFS crawler
- Function `RunSitemap(baseURL string, cfg Config)` — discovers sitemap then batch scrapes
- Function `RunDiscover(baseURL string, cfg Config)` — discovers sitemap, prints URLs, saves JSON
- Initialize shared resources: BrowserPool, RateLimiter, OutputWriter
- Cleanup on completion: close browser pool, print summary

### `internal/worker/pool.go`
**Responsibility**: Generic goroutine worker pool.  
**Must**:
- Accept `N` (worker count) and `processFn func(Job) WorkerResult`
- Use buffered `chan Job` for input, `chan WorkerResult` for output
- `Start()` → spawns N goroutines
- `Submit(job Job)` → sends job to channel
- `Close()` → closes job channel, waits for all workers, closes result channel
- `Results() <-chan WorkerResult` → returns output channel for consumer

### `internal/fetch/http.go`
**Responsibility**: Tier 1 fast HTTP fetch.  
**Must**:
- Create ONE global `http.Client` with:
  - `MaxIdleConns: 200`, `MaxIdleConnsPerHost: 50`, `MaxConnsPerHost: 50`
  - `IdleConnTimeout: 90s`, `TLSHandshakeTimeout: 5s`
  - `ForceAttemptHTTP2: true`
  - `KeepAlive: 30s` on dialer
- Function `FetchHTTP(ctx context.Context, url string) (*FetchResult, error)`
- Set realistic browser headers (see Section 7)
- Rotate User-Agent per request
- Handle redirects (up to 10)
- Handle gzip/br decompression
- If response is `application/json`, wrap in `<html><pre>...</pre></html>`
- Return `nil` for non-HTML, non-JSON content types

### `internal/fetch/browser_pool.go`
**Responsibility**: Manage persistent Chrome instances.  
**Must**:
- `NewBrowserPool(size int) *BrowserPool` — launches N Chrome instances at startup
- `Acquire() context.Context` — round-robin returns a browser context
- `NewTab(parentCtx context.Context) (context.Context, context.CancelFunc)` — creates tab in existing browser
- `Shutdown()` — closes all browsers
- Chrome flags: `--headless`, `--disable-gpu`, `--no-sandbox`, `--disable-blink-features=AutomationControlled`, `--window-size=1920,1080`
- Use `chromedp.NewExecAllocator` for each browser, `chromedp.NewContext` for each tab

### `internal/fetch/browser.go`
**Responsibility**: Tier 2 standard headless browser fetch.  
**Must**:
- Function `FetchBrowser(ctx context.Context, url string, pool *BrowserPool, cfg *Config) (*FetchResult, error)`
- Acquire browser from pool → create new tab → navigate → wait for content → get HTML → close tab
- Block font files: `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot` (use `chromedp.ListenTarget` for network events)
- Use `WaitForContent()` instead of blind `time.Sleep` (poll every 200ms, max 5s)
- Set viewport: 1920×1080

### `internal/fetch/stealth.go`
**Responsibility**: Tier 3 stealth browser with anti-bot evasion.  
**Must**:
- Function `FetchStealth(ctx context.Context, url string, pool *BrowserPool, cfg *Config, scroll bool) (*FetchResult, error)`
- Inject stealth JavaScript BEFORE navigation (see Section 8 for exact JS)
- Simulate mouse movement: random coordinates, 10 steps
- Simulate small scroll: `window.scrollBy(0, 200-500)`
- Detect Cloudflare challenge selectors and wait for resolution (max 15s)
- If `scroll=true`, call `autoScroll()` — scroll to bottom in increments
- Use `WaitForContent()` polling

### `internal/fetch/pipeline.go`
**Responsibility**: Progressive tier escalation with domain caching.  
**Must**:
- `domainCache` using `sync.Map` — maps `domain → "http"|"browser"|"stealth"`
- Function `FetchWithEscalation(url string, pool *BrowserPool, cfg *Config) *ScrapeResult`
- FAST PATH: if domain has cached hint, go directly to that tier
- SLOW PATH: Tier 1 → quality check → Tier 2 → quality check → Tier 3 → quality check → Tier 4
- On success: `domainCache.Store(domain, winningMethod)`
- Build full `ScrapeResult` (call all extractors)
- Record timing for each phase

### `internal/fetch/useragent.go`
**Responsibility**: UA rotation and header constants.  
**Must provide these exact UAs**:
```go
var UserAgents = []string{
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
}
```
**Must provide these exact browser headers**:
```go
var BrowserHeaders = map[string]string{
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept-Encoding":           "gzip, deflate, br",
    "Cache-Control":             "max-age=0",
    "Connection":                "keep-alive",
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "none",
    "Sec-Fetch-User":            "?1",
    "Upgrade-Insecure-Requests": "1",
}
```

### `internal/detect/quality.go`
**Responsibility**: Determine if HTML has real content or is garbage.  
**Function**: `HasRealContent(html string, minLength int) bool`  
**Logic** (EXACT port from TypeScript):
1. Strip `<script>...</script>` and `<style>...</style>` tags
2. Strip all remaining HTML tags
3. Collapse whitespace, trim
4. If stripped length < `minLength` (default 200): return `false`
5. **SPA shell detection** — if any of these match AND stripped < 500 chars: return `false`
   - `id="root"` or `id="app"` or `id="__next"` or `id="__nuxt"` with empty content
   - `<div id="root"></div>`
   - `window.__NEXT_DATA__`
   - `window.__NUXT__`
6. **Bot challenge detection** — if any of these match AND stripped < 2000 chars: return `false`
   - `verify.*(?:human|robot|browser)`
   - `prove.*(?:human|your)`
   - `are\s*you\s*a?\s*(?:human|robot|bot)`
   - `complete\s*the\s*(?:action|challenge|captcha)`
   - `cf-browser-verification`
   - `challenge-platform`
   - `just\s*a\s*moment`
   - `checking\s*(?:your|if|the)\s*(?:browser|connection|site)`
   - `please\s*wait.*redirect`
   - `access\s*denied`
   - `enable\s*javascript.*continue`
   - `please\s*enable\s*cookies`
   - `one\s*more\s*step`
   - `security\s*check`
   - `before\s*you\s*(?:proceed|continue)`
   - `blocked.*(?:firewall|security|waf)`
   - `turnstile`, `hcaptcha`, `recaptcha`
7. Check against BOTH stripped text AND first 5000 chars of raw HTML
8. If none of above triggered: return `true`

### `internal/detect/site_type.go`
**Responsibility**: Detect site type from HTML.  
**Function**: `DetectSiteType(html string) SiteType`  
**Logic** (EXACT port):
1. Parse with goquery
2. **Auth wall**: check for `form[action*="login"]`, `input[type="password"]` + keywords "sign in/log in/create account/forgot password" + body text < 2000 chars → return `"auth-required"`
3. **SPA**: check for roots `#root, #app, #__next, #__nuxt, [data-reactroot], [ng-app], [data-v-app]` + body text < 200 chars or framework script src matching `react|vue|angular|next|nuxt|svelte|webpack|chunk` → return `"spa"`
4. **Infinite scroll**: script content matching `infinite.?scroll|lazy.?load|load.?more|IntersectionObserver|sentinel` → return `"infinite-scroll"`
5. **API-backed**: script content matching `fetch\s*\(|axios\.|XMLHttpRequest|\$\.ajax|\.json\(\)` AND body text < 200 → return `"api-backed"`
6. Otherwise → return `"static"`

### `internal/detect/bot_protection.go`
**Responsibility**: Detect WAF/bot protection.  
**Function**: `DetectBotProtection(html string) BotProtection`  
**Logic**: Check HTML (case-insensitive) for:
- `cf-browser-verification` or `cloudflare` → Cloudflare
- `akamai` or `_abck` or `edgesuite.net` → Akamai
- `datadome` → DataDome
- `perimeterx` or `px-captcha` → PerimeterX
- `recaptcha` or `hcaptcha` → CAPTCHA
- `challenge|verify.{0,20}human|are you a robot|access denied` → Generic

### `internal/extract/content.go`
**Responsibility**: Combined dual-engine extraction.  
**Function**: `ExtractContent(html string, url string) (title string, text string)`  
**Logic**:
1. Run `goquery` fallback extraction → get `fallbackTitle`, `fallbackText`
2. Run `go-readability` → get `readTitle`, `readText`
3. If readability succeeded AND `len(readText) > 500` AND `len(readText) > len(fallbackText) * 0.3`:
   - Return readability result
4. Otherwise: return fallback result

### `internal/extract/jsonld.go`
**Function**: `ExtractJsonLD(html string) []any`  
**Logic**: Find all `<script type="application/ld+json">` → parse JSON → collect. Handle both single objects and arrays.

### `internal/extract/metadata.go`
**Function**: `ExtractMetadata(html string) PageMetadata`  
**Logic**: Use goquery to extract meta tags. For each field, try multiple selectors:
- `description`: `meta[name="description"]` → `meta[property="og:description"]` → `meta[property="twitter:description"]`
- `keywords`: `meta[name="keywords"]` → split by comma
- `ogTitle`: `meta[property="og:title"]` → `meta[name="twitter:title"]`
- `canonical`: `link[rel="canonical"]` href
- `lang`: `html` lang attr → `meta[name="language"]` → `meta[name="dc.language"]`
- `author`: `meta[name="author"]` → `meta[name="dc.creator"]` → `meta[property="article:author"]`
- `publishedDate`: `meta[property="article:published_time"]` → `meta[name="dc.date"]` → `meta[name="date"]`
- `modifiedDate`: `meta[property="article:modified_time"]` → `meta[name="dc.date.modified"]`

### `internal/extract/links.go`
**Function**: `ExtractLinks(html string, baseURL string) []string`  
**Logic**: Find all `<a href>` → resolve relative URLs → filter:
- Only `http://` or `https://`
- Only same hostname as baseURL
- Skip files: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.svg`, `.zip`, `.css`, `.js`, `.mp4`, `.mp3`
- Strip `#fragment`
- Deduplicate

### `internal/convert/markdown.go`
**Function**: `HTMLToMarkdown(html string) string` — uses `html-to-markdown` lib  
**Function**: `BuildMarkdownDocument(title, url, html string) string` — wraps with header + source line  
**Must strip**: `<script>`, `<style>`, `<nav>`, `<footer>`, `<noscript>`, `<iframe>`, `<svg>`  
**Output format**:
```
# {title}

> Source: {url}

{markdown body}
```

### `internal/convert/url_rewrite.go`
**Function**: `GetAlternativeURL(url string) string` — returns rewritten URL or original  
**Rules**:
- `www.reddit.com` / `reddit.com` / `old.reddit.com` → append `.json` to pathname
- `twitter.com` / `x.com` → replace with `nitter.net`
- `medium.com` / `*.medium.com` → replace with `scribe.rip`

### `internal/crawl/robots.go`
**Function**: `ParseRobotsTxt(baseURL string) (disallowed []string, sitemaps []string, crawlDelay *float64, err error)`  
**Function**: `IsPathAllowed(path string, disallowed []string) bool`  
**Logic**: Fetch `{origin}/robots.txt`, parse line by line. Track `User-agent: *` blocks. Extract `Disallow:`, `Sitemap:`, `Crawl-delay:` directives.

### `internal/crawl/sitemap.go`
**Function**: `DiscoverSitemapURLs(baseURL string) ([]SitemapEntry, error)`  
**Logic**:
1. Get sitemap URLs from robots.txt
2. If none found, try: `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap/sitemap.xml`, `/wp-sitemap.xml`
3. Parse XML sitemap (handle `<sitemapindex>` recursively)
4. Deduplicate results, cap at 500 entries

### `internal/crawl/bfs.go`
**Function**: `CrawlSite(startURL string, cfg Config) []CrawlPageResult`  
**Logic**: BFS with goroutine workers (see Section 6 for concurrency model). Use `sync.Map` for visited URLs. Enforce `maxPages`, `maxDepth`. Respect robots.txt disallowed paths. Filter by include/exclude regex patterns.

### `internal/ratelimit/limiter.go`
**Implementation**: Per-domain token bucket using `golang.org/x/time/rate`.  
**Function**: `Wait(domain string)` — blocks until token available  
**Function**: `SetDelay(domain string, delay time.Duration)` — adjusts rate for robots.txt crawl-delay

### `internal/ratelimit/proxy.go`
**Struct**: `ProxyRotator` with round-robin rotation  
**Function**: `GetNext() *ProxyConfig` — returns next proxy, skipping failed ones  
**Function**: `ReportFailure(proxy ProxyConfig)` — increments failure count (max 3 before skip)  
**Function**: `HasProxies() bool`

### `internal/output/writer.go`
**Function**: `URLToFilename(url string, ext string) string` — sanitize URL → safe filename (max 100 chars)  
**Function**: `SaveResult(result ScrapeResult, outputDir string, formats []string) []string` — saves in all requested formats, returns list of saved files

### `internal/output/summary.go`
**Function**: `SaveSummary(results []ScrapeResult, elapsed time.Duration, outputDir string) string`  
**Function**: `SaveCrawlIndex(results []CrawlPageResult, startURL string, outputDir string) string`  
**Output**: Markdown tables with stats (total, succeeded, failed, success rate, avg time, methods used)

---

## 6. CONCURRENCY MODEL

```
                        ┌──────────────────┐
                        │  Main Goroutine   │
                        │  (orchestrator)   │
                        └────────┬─────────┘
                                 │
                    submits jobs to channel
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    Buffered Channel     │
                    │  chan Job (cap: N*10)   │
                    └────────────┬───────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
              ▼                  ▼                   ▼
        ┌───────────┐    ┌───────────┐       ┌───────────┐
        │ Worker G1  │    │ Worker G2  │  ...  │ Worker GN  │
        │            │    │            │       │            │
        │ 1. Wait on │    │ 1. Wait on │       │ 1. Wait on │
        │    rate     │    │    rate     │       │    rate     │
        │    limiter  │    │    limiter  │       │    limiter  │
        │            │    │            │       │            │
        │ 2. Fetch   │    │ 2. Fetch   │       │ 2. Fetch   │
        │    with     │    │    with     │       │    with     │
        │    escalate │    │    escalate │       │    escalate │
        │            │    │            │       │            │
        │ 3. Extract │    │ 3. Extract │       │ 3. Extract │
        │            │    │            │       │            │
        │ 4. Send    │    │ 4. Send    │       │ 4. Send    │
        │    result   │    │    result   │       │    result   │
        └─────┬──────┘    └─────┬──────┘       └──────┬─────┘
              │                  │                     │
              ▼                  ▼                     ▼
        ┌─────────────────────────────────────────────────┐
        │           Results Channel (buffered)             │
        └──────────────────────┬──────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Collector Goroutine │
                    │  (reads results,     │
                    │   writes output,     │
                    │   enqueues links     │
                    │   for crawl mode)    │
                    └─────────────────────┘

SHARED RESOURCES (thread-safe):
  • Browser Pool    → sync.Mutex protects round-robin index
  • Domain Cache    → sync.Map (lock-free reads)
  • Rate Limiter    → per-domain rate.Limiter (internally synchronized)
  • Visited Set     → sync.Map (for crawler dedup)
```

**Key rules**:
- Never share a `chromedp` tab context between goroutines — each worker creates its own tab
- The `http.Client` is safe for concurrent use (connection pool is internally synchronized)
- `sync.Map` for visited URLs and domain cache (optimized for write-once-read-many patterns)
- Channels for all goroutine communication — no shared mutable state except the above

---

## 7. SMART CONTENT READINESS (replaces blind waits)

**DO NOT use `time.Sleep(3 * time.Second)` or similar blind waits.**

Instead, poll the page for content readiness:

```go
func WaitForContent(ctx context.Context, minChars int, maxWait time.Duration) error {
    deadline := time.Now().Add(maxWait)
    for time.Now().Before(deadline) {
        var textLen int
        if err := chromedp.Evaluate(
            `document.body?.innerText?.replace(/\s+/g, " ").trim().length || 0`,
            &textLen,
        ).Do(ctx); err == nil && textLen > minChars {
            return nil
        }
        time.Sleep(200 * time.Millisecond)
    }
    return fmt.Errorf("timeout waiting for content after %v", maxWait)
}
```

**Why**: A static page renders in 200ms. An SPA hydrates in ~800ms. Blind sleep of 3-6s wastes 2-5s per page.

---

## 8. STEALTH JAVASCRIPT PATCHES

Inject this JavaScript BEFORE page navigation in Tier 3/4:

```javascript
// 1. Hide webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. Fake plugins array
Object.defineProperty(navigator, 'plugins', {
    get: () => {
        const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ];
        arr.length = 3;
        return arr;
    },
});

// 3. Fake languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// 4. Fake platform
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

// 5. Hardware concurrency
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

// 6. Device memory
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

// 7. Chrome runtime object
window.chrome = {
    runtime: {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    },
};

// 8. Override permissions
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
        ? Promise.resolve({ state: 'denied' })
        : originalQuery(parameters);

// 9. WebGL renderer override (hide SwiftShader)
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';        // UNMASKED_VENDOR_WEBGL
    if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameter.call(this, parameter);
};

// 10. Prevent detection via toString
const nativeToString = Function.prototype.toString;
Function.prototype.toString = function() {
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return nativeToString.call(this);
};
```

**Cloudflare challenge selectors to wait for**:
```go
var challengeSelectors = []string{
    "#challenge-running",
    "#challenge-stage",
    ".cf-browser-verification",
    "#cf-challenge-running",
}
```
When detected: wait for element to become hidden (max 15s), then wait 2s more.

---

## 9. AUTO-SCROLL LOGIC

For infinite-scroll pages (Tier 4):

```go
func AutoScroll(ctx context.Context, maxScrolls int) error {
    return chromedp.Evaluate(fmt.Sprintf(`
        new Promise((resolve) => {
            let scrolls = 0;
            let lastHeight = document.body.scrollHeight;
            const timer = setInterval(() => {
                window.scrollBy(0, window.innerHeight);
                scrolls++;
                const newHeight = document.body.scrollHeight;
                if (newHeight === lastHeight || scrolls >= %d) {
                    clearInterval(timer);
                    resolve();
                }
                lastHeight = newHeight;
            }, 800);
        })
    `, maxScrolls), nil).Do(ctx)
}
```

Default `maxScrolls`: 15.

---

## 10. ERROR HANDLING PATTERNS

| Scenario | Action |
|----------|--------|
| HTTP fetch fails (timeout/network) | Return nil, let pipeline escalate to next tier |
| Browser tab crashes | Close tab, log error, return nil for escalation |
| All 4 tiers fail | Return `ScrapeResult{Success: false, Error: "all tiers exhausted"}` |
| robots.txt unreachable | Treat as "no restrictions" (allow everything) |
| Sitemap unreachable/malformed | Return empty list, fall back to link crawling |
| Malformed JSON-LD | Skip that block, continue with others |
| Output write fails | Log error, continue with next format/page |
| Rate limit hit (429 response) | Exponential backoff: 1s → 2s → 4s (up to MaxRetries) |
| Context cancelled (SIGINT) | Graceful shutdown: close browser pool, save partial results |

**Never panic.** Use `slog.Error()` for errors, `slog.Warn()` for recoverable issues, `slog.Info()` for progress.

---

## 11. GO DEPENDENCIES

```
go.mod requires:
  github.com/PuerkitoBio/goquery          # HTML parsing (jQuery-like)
  github.com/go-shiori/go-readability     # Article extraction (Mozilla Readability port)
  github.com/JohannesKaufmann/html-to-markdown/v2  # HTML → Markdown (Turndown equivalent)
  github.com/chromedp/chromedp            # Browser automation via CDP
  github.com/spf13/cobra                  # CLI framework
  golang.org/x/time                       # rate.Limiter (token bucket)
  github.com/temoto/robotstxt             # robots.txt parser (optional, can also hand-parse)
```

---

## 12. CLI FLAG DEFINITIONS

```
go-scraper scrape <url1> [url2...] [flags]
go-scraper crawl <startURL> [flags]
go-scraper sitemap <url> [flags]
go-scraper discover <url>

Global flags:
  --concurrency int      Max concurrent workers (default 20)
  --output string        Output directory (default "output")
  --formats string       Comma-separated: markdown,json,text,html,csv (default "markdown,json")
  --stealth              Enable stealth mode (default true)
  --delay duration       Delay between requests per domain (default 100ms)
  --timeout duration     HTTP request timeout (default 15s)
  --ua-rotate            Rotate user agents (default true)

Crawl-specific flags:
  --depth int            Max crawl depth (default 3)
  --pages int            Max pages to scrape (default 50)
  --respect-robots       Respect robots.txt (default true)
  --include string       Regex: only crawl matching URLs
  --exclude string       Regex: skip matching URLs
  --follow-external      Follow external domain links (default false)
```

---

## 13. CRITICAL RULES

> [!CAUTION]
> **NEVER do these things:**

1. **NEVER launch a new browser for each URL.** Use the browser pool. New tabs are cheap (~5ms), new browsers are expensive (~1s).

2. **NEVER use `time.Sleep()` for waiting on content.** Always poll with `WaitForContent()`. Blind waits waste 2-5s per page.

3. **NEVER create a new `http.Client` per request.** Use the global singleton. Connection reuse saves 200-400ms per request.

4. **NEVER use `sync.Mutex` where `sync.Map` works.** For the visited set and domain cache, `sync.Map` is significantly faster under concurrent read-heavy workloads.

5. **NEVER block the main goroutine waiting for results.** Use channels and a separate collector goroutine.

6. **NEVER ignore context cancellation.** Pass `context.Context` through the entire call chain for graceful shutdown.

7. **NEVER hardcode the User-Agent.** Always rotate from the pool to avoid fingerprinting.

8. **NEVER try all tiers for every URL on the same domain.** After the first URL succeeds, cache the winning tier and go direct for subsequent URLs.

---

## 14. BUILD ORDER (dependency graph)

```
Phase 1 (no dependencies between files):
  types/types.go ──────────────────────┐
  config/config.go ────────────────────┤
  fetch/useragent.go ──────────────────┤
  detect/quality.go ───────────────────┤── can all be built in parallel
  convert/url_rewrite.go ──────────────┤
  output/writer.go ────────────────────┘

Phase 2 (depends on Phase 1):
  fetch/http.go ────────────────── depends on: types, config, useragent
  extract/readability.go ───────── depends on: types
  extract/goquery.go ───────────── depends on: types
  extract/content.go ───────────── depends on: readability, goquery
  extract/jsonld.go ────────────── depends on: types
  extract/metadata.go ──────────── depends on: types
  extract/links.go ─────────────── depends on: types
  convert/markdown.go ──────────── depends on: types
  detect/site_type.go ──────────── depends on: types
  detect/bot_protection.go ─────── depends on: types

Phase 3 (depends on Phase 2):
  fetch/browser_pool.go ────────── depends on: chromedp
  fetch/browser.go ─────────────── depends on: browser_pool, detect, types
  fetch/stealth.go ─────────────── depends on: browser_pool, detect, types
  fetch/pipeline.go ────────────── depends on: http, browser, stealth, all extractors
  ratelimit/limiter.go ─────────── depends on: x/time/rate
  ratelimit/proxy.go ───────────── depends on: types

Phase 4 (depends on Phase 3):
  worker/pool.go ───────────────── depends on: types
  crawl/robots.go ──────────────── depends on: fetch/http, types
  crawl/sitemap.go ─────────────── depends on: fetch/http, types
  crawl/bfs.go ─────────────────── depends on: worker, pipeline, ratelimit, robots
  output/summary.go ────────────── depends on: types

Phase 5 (depends on everything):
  orchestrator/orchestrator.go ─── depends on: all packages
  cmd/scraper/main.go ──────────── depends on: orchestrator, config, cobra
```

---

## 15. TESTING STRATEGY

| Test Type | What | How |
|-----------|------|-----|
| Unit tests | `HasRealContent()`, `DetectSiteType()`, `ExtractLinks()`, `URLToFilename()` | Table-driven tests with HTML fixtures |
| Unit tests | `domainCache`, `ProxyRotator` | Concurrent access tests with goroutines |
| Integration | `FetchHTTP()` | Against `httptest.NewServer()` serving sample HTML |
| Integration | `FetchWithEscalation()` | Against local server that serves static, SPA shell, and challenge pages |
| Benchmark | `HasRealContent()`, `ExtractContent()`, `HTMLToMarkdown()` | `go test -bench` with large HTML fixtures |
| E2E | Full pipeline | `go-scraper scrape https://example.com` → verify output files exist |

---

> [!IMPORTANT]
> **When building, start from the bottom of the dependency graph (Phase 1) and work up. Each phase can be tested independently before moving to the next.**
