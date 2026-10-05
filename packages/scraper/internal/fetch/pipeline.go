package fetch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/sujal/go-scraper/internal/cache"
	"github.com/sujal/go-scraper/internal/convert"
	"github.com/sujal/go-scraper/internal/detect"
	"github.com/sujal/go-scraper/internal/extract"
	"github.com/sujal/go-scraper/internal/types"
)

// speculativeSlots bounds how many first-seen-domain fetches may race a browser alongside their
// HTTP probe at once. Uncapped, a crawl's first wave of 30 jobs would saturate Chrome and starve
// the HTTP probes that would have won anyway.
var speculativeSlots = make(chan struct{}, 2)

// DomainCache caches the winning tier method per domain to skip unnecessary escalations
var (
	DomainCache      sync.Map // map[string]string: domain -> "http" | "stealth"
	cacheInitOnce    sync.Once
	domainCacheDirty atomic.Bool
)

const cacheFileName = ".domain_cache.json"

func getCacheFilePath(outputDir string) string {
	if outputDir == "" {
		outputDir = "output"
	}
	return filepath.Join(outputDir, cacheFileName)
}

func loadDomainCache(outputDir string) {
	cacheInitOnce.Do(func() {
		data, err := os.ReadFile(getCacheFilePath(outputDir))
		if err != nil {
			return
		}
		var m map[string]string
		if err := json.Unmarshal(data, &m); err == nil {
			for k, v := range m {
				DomainCache.Store(k, v)
			}
		}
	})
}

func recordDomainTier(domain, method string) {
	if domain == "" || method == "" {
		return
	}
	if prev, ok := DomainCache.Load(domain); ok && prev == method {
		return
	}
	DomainCache.Store(domain, method)
	domainCacheDirty.Store(true)
}

// SaveDomainCache persists learned domain tiers once, at shutdown, instead of rewriting the file per page
func SaveDomainCache(outputDir string) {
	if !domainCacheDirty.Swap(false) {
		return
	}
	path := getCacheFilePath(outputDir)
	_ = os.MkdirAll(filepath.Dir(path), 0755)

	m := make(map[string]string)
	DomainCache.Range(func(key, value any) bool {
		if k, ok := key.(string); ok {
			if v, ok := value.(string); ok {
				m[k] = v
			}
		}
		return true
	})

	if data, err := json.Marshal(m); err == nil {
		_ = os.WriteFile(path, data, 0644)
	}
}

func extractDomain(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

type fetchAttempt struct {
	res *types.FetchResult
	err error
}

func failedResult(rawURL string, err error, startTotal time.Time) *types.ScrapeResult {
	errMsg := "all fetch tiers exhausted"
	if err != nil {
		errMsg = err.Error()
	}
	return &types.ScrapeResult{
		URL:     rawURL,
		Success: false,
		Error:   errMsg,
		Timing: types.Timing{
			TotalMs: time.Since(startTotal).Milliseconds(),
		},
	}
}

// FetchWithEscalation coordinates the progressive tier escalation pipeline
func FetchWithEscalation(ctx context.Context, rawURL string, pool *BrowserPool, cfg *types.Config) *types.ScrapeResult {
	startTotal := time.Now()

	// Result cache: a recent successful scrape of this exact URL is returned as-is
	if cfg != nil && cfg.MaxAge > 0 {
		if cached, ok := cache.Get(rawURL, cfg.MaxAge); ok {
			cached.Cached = true
			cached.Timing = types.Timing{TotalMs: time.Since(startTotal).Milliseconds()}
			return cached
		}
	}

	// Tier 0: URL Rewriter (Reddit JSON, Nitter, Scribe)
	effectiveURL := convert.GetAlternativeURL(rawURL)
	domain := extractDomain(effectiveURL)

	outputDir := "output"
	if cfg != nil && cfg.OutputDir != "" {
		outputDir = cfg.OutputDir
	}
	loadDomainCache(outputDir)

	minLen := 80
	if cfg != nil && cfg.MinContentLength > 0 {
		minLen = cfg.MinContentLength
	}

	// ULTRA-FAST MODE: Pure HTTP (if user explicitly requests FastMode)
	if (cfg != nil && cfg.FastMode) || pool == nil {
		fetchRes, err := FetchHTTP(ctx, effectiveURL, cfg)
		if err == nil && len(fetchRes.HTML) > 0 && (fetchRes.Status < 400 || detect.HasRealContent(fetchRes.HTML, minLen)) {
			return buildScrapeResult(rawURL, fetchRes, cfg, startTotal)
		}
		if err == nil {
			err = fmt.Errorf("http status %d without usable content", fetchRes.Status)
		}
		return failedResult(rawURL, err, startTotal)
	}

	hint, _ := DomainCache.Load(domain)

	// FAST PATH: domain known to need a browser -> go straight there
	stealthTried := false
	var sparse *types.FetchResult
	var lastErr error
	if hint == "stealth" || hint == "browser" {
		stealthTried = true
		fetchRes, err := FetchStealth(ctx, effectiveURL, pool, cfg)
		if err == nil && detect.HasRealContent(fetchRes.HTML, minLen) {
			return buildScrapeResult(rawURL, fetchRes, cfg, startTotal)
		}
		if err == nil && len(fetchRes.HTML) > 0 {
			sparse = fetchRes
		}
		lastErr = err
		// Site may have changed: fall through to HTTP
	}

	// TIER 1: HTTP probe. On a first-seen domain the stealth browser is raced against it from the
	// start: whichever passes the content check first wins and the loser is cancelled. Static
	// sites win on HTTP in a few hundred ms and the browser tab is discarded; SPAs skip the wasted
	// HTTP round trip entirely. Once the domain's tier is cached, only that tier runs.
	httpCtx, cancelHTTP := context.WithCancel(ctx)
	defer cancelHTTP()
	browserCtx, cancelBrowser := context.WithCancel(ctx)
	defer cancelBrowser()

	httpCh := make(chan fetchAttempt, 1)
	go func() {
		r, e := FetchHTTP(httpCtx, effectiveURL, cfg)
		httpCh <- fetchAttempt{r, e}
	}()

	var browserCh chan fetchAttempt
	startBrowser := func() bool {
		if stealthTried {
			return false
		}
		stealthTried = true
		browserCh = make(chan fetchAttempt, 1)
		go func() {
			r, e := FetchStealth(browserCtx, effectiveURL, pool, cfg)
			browserCh <- fetchAttempt{r, e}
		}()
		return true
	}

	httpPending, browserPending := true, false
	if hint == nil {
		select {
		case speculativeSlots <- struct{}{}:
			defer func() { <-speculativeSlots }()
			if startBrowser() {
				browserPending = true
			}
		default:
			// Chrome is busy with other speculative attempts: HTTP first, browser only if it fails
		}
	}

	for httpPending || browserPending {
		select {
		case <-ctx.Done():
			return failedResult(rawURL, ctx.Err(), startTotal)

		case a := <-httpCh:
			httpPending = false
			if a.err == nil && detect.HasRealContent(a.res.HTML, minLen) {
				recordDomainTier(domain, "http")
				return buildScrapeResult(rawURL, a.res, cfg, startTotal)
			}
			if errors.Is(a.err, ErrTerminal) {
				// 404s, PDFs etc: a browser will not do better
				return failedResult(rawURL, a.err, startTotal)
			}
			if a.err != nil {
				lastErr = a.err
			}
			// TIER 2: stealth browser for SPAs, JS rendering, and WAF challenges
			if startBrowser() {
				browserPending = true
			}

		case a := <-browserCh:
			browserPending = false
			if errors.Is(a.err, ErrTerminal) {
				// Chrome saw a 404/5xx or its own error page: HTTP will not do better
				return failedResult(rawURL, a.err, startTotal)
			}
			if a.err == nil && detect.HasRealContent(a.res.HTML, minLen) {
				// Only learn "stealth" when HTTP demonstrably failed the content check. A browser that
				// merely out-raced a slow HTTP response says nothing about what the site needs.
				if !httpPending {
					recordDomainTier(domain, "stealth")
				}
				return buildScrapeResult(rawURL, a.res, cfg, startTotal)
			}
			if a.err == nil && len(a.res.HTML) > 0 {
				sparse = a.res
			} else if a.err != nil {
				lastErr = a.err
			}
		}
	}

	// Last resort: a browser render that never passed the content check but did produce a page
	if sparse != nil {
		recordDomainTier(domain, "stealth")
		return buildScrapeResult(rawURL, sparse, cfg, startTotal)
	}
	return failedResult(rawURL, lastErr, startTotal)
}

func buildScrapeResult(rawURL string, fetchRes *types.FetchResult, cfg *types.Config, startTotal time.Time) *types.ScrapeResult {
	startExtract := time.Now()

	// Parse once; every extractor shares this tree (read-only) or a cleaned clone of it
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(fetchRes.HTML))
	if err != nil {
		doc, _ = goquery.NewDocumentFromReader(strings.NewReader(""))
	}
	cleaned := extract.CleanDocument(doc)

	title, text := extract.ExtractContentDoc(doc, cleaned, rawURL)
	markdownDoc := convert.BuildMarkdownDocumentDoc(title, rawURL, cleaned, fetchRes.HTML)
	if strings.TrimSpace(markdownDoc) == fmt.Sprintf("# %s\n\n> Source: %s", title, rawURL) {
		markdownDoc = fmt.Sprintf("# %s\n\n> Source: %s\n\n%s\n", title, rawURL, text)
	}

	var metadata types.PageMetadata
	if cfg == nil || cfg.ExtractMetadata {
		metadata = extract.ExtractMetadataDoc(doc)
	}

	var structuredData []any
	if cfg == nil || cfg.ExtractStructuredData {
		structuredData = extract.ExtractJsonLDDoc(doc)
	}

	var links []string
	if cfg == nil || cfg.ExtractLinks {
		links = extract.ExtractLinksDoc(doc, rawURL)
	}

	extractMs := time.Since(startExtract).Milliseconds()
	totalMs := time.Since(startTotal).Milliseconds()

	res := &types.ScrapeResult{
		URL:            rawURL,
		Success:        true,
		Method:         fetchRes.Method,
		Title:          title,
		Text:           text,
		Markdown:       markdownDoc,
		HTML:           fetchRes.HTML,
		StructuredData: structuredData,
		Metadata:       metadata,
		Links:          links,
		Timing: types.Timing{
			FetchMs:   fetchRes.FetchMs,
			ExtractMs: extractMs,
			TotalMs:   totalMs,
		},
	}
	if cfg != nil && cfg.MaxAge > 0 {
		cache.Put(res)
	}
	return res
}
