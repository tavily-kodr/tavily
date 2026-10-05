package types

import "time"

// ─── Core Result ───

type ScrapeResult struct {
	URL            string       `json:"url"`
	Success        bool         `json:"success"`
	Method         string       `json:"method"` // "http" | "browser" | "stealth" | ""
	Title          string       `json:"title"`
	Text           string       `json:"text"`           // plain text content
	Markdown       string       `json:"markdown"`       // full markdown document
	HTML           string       `json:"html,omitempty"` // raw HTML (omitted from output unless specifically requested)
	StructuredData []any        `json:"structured_data"`
	Metadata       PageMetadata `json:"metadata"`
	Links          []string     `json:"links"` // same-domain outbound links
	Error          string       `json:"error,omitempty"`
	Cached         bool         `json:"cached,omitempty"` // served from the result cache (see --max-age)
	Timing         Timing       `json:"timing"`
}

type Timing struct {
	FetchMs   int64 `json:"fetch_ms"`
	ExtractMs int64 `json:"extract_ms"`
	TotalMs   int64 `json:"total_ms"`
}

type PageMetadata struct {
	Description   string   `json:"description,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	OGTitle       string   `json:"og_title,omitempty"`
	OGDescription string   `json:"og_description,omitempty"`
	OGImage       string   `json:"og_image,omitempty"`
	Canonical     string   `json:"canonical,omitempty"`
	Lang          string   `json:"lang,omitempty"`
	Author        string   `json:"author,omitempty"`
	PublishedDate string   `json:"published_date,omitempty"`
	ModifiedDate  string   `json:"modified_date,omitempty"`
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
	HasProtection bool   `json:"has_protection"`
	Provider      string `json:"provider,omitempty"` // "Cloudflare" | "Akamai" | "DataDome" | "PerimeterX" | "CAPTCHA" | "Generic" | ""
}

// ─── Configuration ───

type Config struct {
	// Fetching
	MinContentLength int           `json:"min_content_length"`
	MaxRetries       int           `json:"max_retries"`
	Concurrency      int           `json:"concurrency"`
	RequestTimeout   time.Duration `json:"request_timeout"`
	BrowserTimeout   time.Duration `json:"browser_timeout"`

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

	// Performance
	FastMode bool          `json:"fast_mode"` // If true, force ultra-fast pure HTTP mode (skip browser tiers)
	MaxAge   time.Duration `json:"max_age"`   // Serve cached results younger than this; 0 disables the cache

	// Anti-bot
	UseStealth      bool          `json:"use_stealth"`
	RotateUA        bool          `json:"rotate_ua"`
	Proxies         []ProxyConfig `json:"proxies"`
	BrowserPoolSize int           `json:"browser_pool_size"`
	NoDaemon        bool          `json:"no_daemon"` // If true, launch a private Chrome instead of using the shared background daemon

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
	MinContentLength:      80, // Lowered threshold to prevent false browser escalation on compact pages
	MaxRetries:            3,
	Concurrency:           30,
	RequestTimeout:        10 * time.Second,
	BrowserTimeout:        20 * time.Second,
	DelayBetweenRequests:  0, // Instant by default for maximum throughput
	RespectRobotsTxt:      true,
	MaxRequestsPerMinute:  600,
	MaxPages:              50,
	MaxDepth:              3,
	FollowExternalLinks:   false,
	OutputDir:             "output",
	OutputFormats:         []string{"markdown", "json"},
	FastMode:              false,
	MaxAge:                48 * time.Hour, // Same default as Firecrawl's maxAge
	UseStealth:            true,
	RotateUA:              true,
	BrowserPoolSize:       1, // The shared daemon; more adds locally launched instances
	NoDaemon:              false,
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
