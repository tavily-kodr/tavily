package fetch

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
	"github.com/sujal/go-scraper/internal/detect"
	"github.com/sujal/go-scraper/internal/types"
)

const stealthJS = `
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
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
};

// 10. Prevent detection via toString
const nativeToString = Function.prototype.toString;
Function.prototype.toString = function() {
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return nativeToString.call(this);
};
`

// AutoScroll scrolls the page downward in increments to trigger lazy-loading
func AutoScroll(ctx context.Context, maxScrolls int) error {
	if maxScrolls <= 0 {
		maxScrolls = 6
	}
	expr := fmt.Sprintf(`
		new Promise((resolve) => {
			let scrolls = 0;
			let lastHeight = document.body ? document.body.scrollHeight : 0;
			const timer = setInterval(() => {
				window.scrollBy(0, window.innerHeight || 800);
				scrolls++;
				const newHeight = document.body ? document.body.scrollHeight : 0;
				if (newHeight === lastHeight || scrolls >= %d) {
					clearInterval(timer);
					resolve();
				}
				lastHeight = newHeight;
			}, 150);
		})
	`, maxScrolls)
	return chromedp.Run(ctx, chromedp.Evaluate(expr, nil))
}

// FetchStealth executes the stealth browser fetch with anti-bot evasion. When the first render is
// sparse it auto-scrolls the same tab to trigger lazy loading instead of navigating a second time.
func FetchStealth(ctx context.Context, targetURL string, pool *BrowserPool, cfg *types.Config) (*types.FetchResult, error) {
	if pool == nil {
		return nil, fmt.Errorf("browser pool is not initialized")
	}

	start := time.Now()

	timeout := 15 * time.Second
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

	// Phase timings, visible with --verbose
	phase := start
	mark := func(name string) {
		now := time.Now()
		slog.Debug("stealth phase", "url", targetURL, "phase", name, "ms", now.Sub(phase).Milliseconds())
		phase = now
	}
	mark("open_tab")

	var htmlContent string
	var finalURL string

	// Track the main document's HTTP status so 404s/5xx rendered by Chrome are not taken as content
	var mainFrame cdp.FrameID
	var status int64 = 200
	var statusMu sync.Mutex
	chromedp.ListenTarget(tabCtx, func(ev any) {
		if resp, ok := ev.(*network.EventResponseReceived); ok && resp.Type == network.ResourceTypeDocument {
			statusMu.Lock()
			if mainFrame == "" || resp.FrameID == mainFrame {
				status = resp.Response.Status
			}
			statusMu.Unlock()
		}
	})

	actions := []chromedp.Action{
		network.Enable(),
		network.SetBlockedURLs().WithURLPatterns(BlockPatterns),
		chromedp.EmulateViewport(1920, 1080),
		// Inject stealth script on new documents before page scripts run
		chromedp.ActionFunc(func(c context.Context) error {
			_, err := page.AddScriptToEvaluateOnNewDocument(stealthJS).Do(c)
			return err
		}),
		// Fast asynchronous navigation: does not block for 15s waiting for third-party trackers
		chromedp.ActionFunc(func(c context.Context) error {
			mark("setup")
			frameID, _, _, _, err := page.Navigate(targetURL).Do(c)
			statusMu.Lock()
			mainFrame = frameID
			statusMu.Unlock()
			mark("navigate")
			return err
		}),
		// Mouse jitter simulation
		chromedp.ActionFunc(func(c context.Context) error {
			rndX := float64(200 + rand.Intn(400))
			rndY := float64(200 + rand.Intn(400))
			return chromedp.MouseEvent("mouseMoved", rndX, rndY).Do(c)
		}),
		// Wait for potential challenge resolution and full hydration
		chromedp.ActionFunc(func(c context.Context) error {
			err := WaitForContent(c, minLen, 5*time.Second)
			mark("wait_content")
			return err
		}),
		chromedp.OuterHTML("html", &htmlContent),
	}

	actions = append(actions, chromedp.Location(&finalURL))

	if err := chromedp.Run(tabCtx, actions...); err != nil {
		return nil, fmt.Errorf("stealth browser fetch error: %w", err)
	}
	mark("outer_html")

	// Chrome's own error page (DNS failure, connection refused, empty 404 body) is not content
	if strings.HasPrefix(finalURL, "chrome-error://") {
		return nil, fmt.Errorf("%w: browser could not load page", ErrTerminal)
	}
	statusMu.Lock()
	docStatus := int(status)
	statusMu.Unlock()
	if IsTerminalStatus(docStatus) {
		return nil, fmt.Errorf("%w: http status %d", ErrTerminal, docStatus)
	}

	// Sparse first render: scroll to trigger lazy loading / finish challenges, then re-read the same tab
	if !detect.HasRealContent(htmlContent, minLen) {
		defer mark("sparse_scroll")
		var scrolled string
		err := chromedp.Run(tabCtx,
			chromedp.ActionFunc(func(c context.Context) error {
				return AutoScroll(c, 6)
			}),
			chromedp.ActionFunc(func(c context.Context) error {
				return WaitForContent(c, minLen, 2*time.Second)
			}),
			chromedp.OuterHTML("html", &scrolled),
		)
		if err == nil && scrolled != "" {
			htmlContent = scrolled
		}
	}

	return &types.FetchResult{
		HTML:    htmlContent,
		Method:  "stealth",
		FetchMs: time.Since(start).Milliseconds(),
		Status:  docStatus,
	}, nil
}
