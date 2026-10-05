package fetch

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
	"github.com/sujal/go-scraper/internal/types"
)

func blockPattern(p string) *network.BlockPattern {
	return &network.BlockPattern{URLPattern: p, Block: true}
}

// BlockPatterns blocks fonts, media, images and analytics/ad trackers. None of these change the
// DOM text we extract, but they dominate page-load time. CSS is left alone: some sites need it to hydrate.
var BlockPatterns = []*network.BlockPattern{
	// Fonts
	blockPattern("*://*:*/*.woff"),
	blockPattern("*://*:*/*.woff2"),
	blockPattern("*://*:*/*.ttf"),
	blockPattern("*://*:*/*.otf"),
	blockPattern("*://*:*/*.eot"),
	// Images (the <img> tags and src attributes stay in the DOM)
	blockPattern("*://*:*/*.png"),
	blockPattern("*://*:*/*.jpg"),
	blockPattern("*://*:*/*.jpeg"),
	blockPattern("*://*:*/*.gif"),
	blockPattern("*://*:*/*.webp"),
	blockPattern("*://*:*/*.avif"),
	blockPattern("*://*:*/*.ico"),
	// Media
	blockPattern("*://*:*/*.mp4"),
	blockPattern("*://*:*/*.webm"),
	blockPattern("*://*:*/*.mp3"),
	blockPattern("*://*:*/*.m3u8"),
	// Analytics, ads, session recorders
	blockPattern("*://*google-analytics.com:*/*"),
	blockPattern("*://*googletagmanager.com:*/*"),
	blockPattern("*://*doubleclick.net:*/*"),
	blockPattern("*://*googlesyndication.com:*/*"),
	blockPattern("*://*adservice.google.com:*/*"),
	blockPattern("*://*connect.facebook.net:*/*"),
	blockPattern("*://*hotjar.com:*/*"),
	blockPattern("*://*segment.io:*/*"),
	blockPattern("*://*segment.com:*/*"),
	blockPattern("*://*mixpanel.com:*/*"),
	blockPattern("*://*amplitude.com:*/*"),
	blockPattern("*://*clarity.ms:*/*"),
	blockPattern("*://*fullstory.com:*/*"),
	blockPattern("*://*newrelic.com:*/*"),
	blockPattern("*://*nr-data.net:*/*"),
	blockPattern("*://*sentry.io:*/*"),
	blockPattern("*://*intercom.io:*/*"),
	blockPattern("*://*taboola.com:*/*"),
	blockPattern("*://*outbrain.com:*/*"),
}

// waitForContentJS resolves once visible text reaches minChars and the DOM has gone quiet
// (no node/text mutations for quietMs: hydration is done), or when the deadline passes.
// Attribute changes are ignored so CSS-class animations do not keep the page "busy"; pages that
// mutate text forever (counters, tickers) are cut off maxSettleMs after content first appeared.
// The document must also have finished parsing (readyState past 'loading'): a large page that is
// still streaming in can look quiet between chunks, and snapshotting it then would truncate it.
// Runs entirely in-page: no CDP round trip per poll.
const waitForContentJS = `new Promise((resolve) => {
	const minChars = %d, deadline = Date.now() + %d;
	const quietMs = 150, maxSettleMs = 500;
	const challenge = /just a moment|attention required|checking your browser|verify you are human/i;
	let lastMutation = Date.now(), readySince = 0, observing = false;
	const observer = new MutationObserver(() => { lastMutation = Date.now(); });
	const done = (len) => { observer.disconnect(); resolve(len); };
	const tick = () => {
		const now = Date.now();
		// Right after a navigation commits the document may still be empty; attach once it exists
		if (!observing && document.documentElement) {
			observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
			observing = true;
			lastMutation = now;
		}
		const len = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim().length : 0;
		if (len >= minChars && document.readyState !== 'loading' && !challenge.test(document.title || '')) {
			if (!readySince) readySince = now;
			if (now - lastMutation >= quietMs || now - readySince >= maxSettleMs) return done(len);
		} else {
			readySince = 0;
		}
		if (now >= deadline) return done(len);
		setTimeout(tick, 40);
	};
	tick();
})`

func awaitPromise(p *runtime.EvaluateParams) *runtime.EvaluateParams {
	return p.WithAwaitPromise(true)
}

// WaitForContent waits until the page has real, settled content or maxWait expires
func WaitForContent(ctx context.Context, minChars int, maxWait time.Duration) error {
	deadline := time.Now().Add(maxWait)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil
		}
		var textLen int
		err := chromedp.Run(ctx,
			chromedp.Evaluate(fmt.Sprintf(waitForContentJS, minChars, remaining.Milliseconds()), &textLen, awaitPromise),
		)
		if err == nil {
			return nil
		}
		// The execution context is destroyed by navigations (commit, JS redirects, solved challenges): retry
		slog.Debug("wait_content retry", "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(40 * time.Millisecond):
		}
	}
}

// FetchBrowser executes Tier 2 standard headless browser fetch
func FetchBrowser(ctx context.Context, targetURL string, pool *BrowserPool, cfg *types.Config) (*types.FetchResult, error) {
	if pool == nil {
		return nil, fmt.Errorf("browser pool is not initialized")
	}

	start := time.Now()

	timeout := 25 * time.Second
	if cfg != nil && cfg.BrowserTimeout > 0 {
		timeout = cfg.BrowserTimeout
	}

	tabCtx, release, err := pool.OpenTab(ctx)
	if err != nil {
		return nil, fmt.Errorf("open tab failed: %w", err)
	}
	defer release()

	tabCtx, cancelTimeout := context.WithTimeout(tabCtx, timeout)
	defer cancelTimeout()

	minLen := 100
	if cfg != nil && cfg.MinContentLength > 0 {
		minLen = cfg.MinContentLength
	}

	var htmlContent string
	var statusCode int64 = 200

	// Listen for response status
	chromedp.ListenTarget(tabCtx, func(ev any) {
		if resp, ok := ev.(*network.EventResponseReceived); ok {
			if resp.Type == network.ResourceTypeDocument && resp.Response.URL == targetURL {
				statusCode = resp.Response.Status
			}
		}
	})

	err = chromedp.Run(tabCtx,
		network.Enable(),
		network.SetBlockedURLs().WithURLPatterns(BlockPatterns),
		chromedp.EmulateViewport(1920, 1080),
		chromedp.ActionFunc(func(c context.Context) error {
			_, _, _, _, err := page.Navigate(targetURL).Do(c)
			return err
		}),
		chromedp.ActionFunc(func(c context.Context) error {
			return WaitForContent(c, minLen, 5*time.Second)
		}),
		chromedp.OuterHTML("html", &htmlContent),
	)

	if err != nil {
		return nil, fmt.Errorf("chromedp browser fetch failed: %w", err)
	}

	return &types.FetchResult{
		HTML:    htmlContent,
		Method:  "browser",
		FetchMs: time.Since(start).Milliseconds(),
		Status:  int(statusCode),
	}, nil
}
