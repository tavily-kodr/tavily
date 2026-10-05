package fetch

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/chromedp/chromedp"
)

// tabsPerBrowser bounds concurrent tabs per Chrome instance; beyond this, tabs just fight for CPU
const tabsPerBrowser = 8

// BrowserPool manages N persistent Chrome instances for tab re-use. Instance 0 is normally the
// shared background daemon (see daemon.go); any further instances are launched locally.
type BrowserPool struct {
	mu        sync.Mutex
	initOnce  sync.Once
	contexts  []context.Context
	cancels   []context.CancelFunc
	idx       int
	poolSize  int
	useDaemon bool
	closed    bool
	tabSem    chan struct{}
}

// NewBrowserPool creates a pool of size instances with lazy initialization
func NewBrowserPool(size int, useDaemon bool) *BrowserPool {
	if size <= 0 {
		size = 1
	}

	return &BrowserPool{
		poolSize:  size,
		useDaemon: useDaemon,
		tabSem:    make(chan struct{}, size*tabsPerBrowser),
	}
}

// chromeFlags is the shared launch configuration for local instances and the daemon
func chromeFlags() []chromedp.ExecAllocatorOption {
	return append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.Flag("disable-features", "IsolateOrigins,site-per-process"),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-background-timer-throttling", true),
		chromedp.Flag("disable-backgrounding-occluded-windows", true),
		// Headless tabs are never "focused"; without these Chrome deprioritizes their JS and IPC
		chromedp.Flag("disable-renderer-backgrounding", true),
		chromedp.Flag("disable-ipc-flooding-protection", true),
		chromedp.Flag("disable-hang-monitor", true),
		chromedp.Flag("disable-popup-blocking", true),
		chromedp.Flag("disable-prompt-on-repost", true),
		chromedp.Flag("disable-client-side-phishing-detection", true),
		chromedp.Flag("disable-breakpad", true),
		chromedp.Flag("disable-component-update", true),
		chromedp.Flag("disable-default-apps", true),
		chromedp.Flag("disable-domain-reliability", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("disable-translate", true),
		chromedp.Flag("metrics-recording-only", true),
		chromedp.Flag("mute-audio", true),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("safebrowsing-disable-auto-update", true),
		chromedp.Flag("blink-settings", "imagesEnabled=false"),
		chromedp.WindowSize(1920, 1080),
	)
}

// Warm connects/launches in the background so the first browser fetch skips startup cost
func (bp *BrowserPool) Warm() {
	go bp.ensureInit()
}

func (bp *BrowserPool) ensureInit() {
	bp.initOnce.Do(func() {
		bp.init()
	})
}

func launchLocalChrome(index int) (context.Context, context.CancelFunc, bool) {
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), chromeFlags()...)
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	cancel := func() {
		cancelBrowser()
		cancelAlloc()
	}
	// Force launch of browser instance
	if err := chromedp.Run(browserCtx); err != nil {
		slog.Warn("failed to initialize chrome instance", "index", index, "error", err)
		return nil, cancel, false
	}
	return browserCtx, cancel, true
}

func (bp *BrowserPool) init() {
	// Held for the whole launch so Shutdown waits instead of racing a half-started pool
	bp.mu.Lock()
	defer bp.mu.Unlock()
	if bp.closed {
		return
	}

	contexts := make([]context.Context, bp.poolSize)
	cancels := make([]context.CancelFunc, bp.poolSize)
	ok := make([]bool, bp.poolSize)

	// Connect/launch all instances in parallel
	var wg sync.WaitGroup
	for i := 0; i < bp.poolSize; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i == 0 && bp.useDaemon {
				ctx, cancel, err := connectDaemon(context.Background())
				if err == nil {
					contexts[i], cancels[i], ok[i] = ctx, cancel, true
					return
				}
				slog.Warn("browser daemon unavailable, launching local chrome", "error", err)
			}
			contexts[i], cancels[i], ok[i] = launchLocalChrome(i)
		}(i)
	}
	wg.Wait()

	for i := range contexts {
		if ok[i] {
			bp.contexts = append(bp.contexts, contexts[i])
		}
		bp.cancels = append(bp.cancels, cancels[i])
	}
}

// Acquire returns a parent browser context in round-robin order
func (bp *BrowserPool) Acquire() context.Context {
	bp.ensureInit()
	bp.mu.Lock()
	defer bp.mu.Unlock()

	if len(bp.contexts) == 0 {
		return context.Background()
	}

	ctx := bp.contexts[bp.idx%len(bp.contexts)]
	bp.idx++
	return ctx
}

// OpenTab waits for a free tab slot and opens a new tab in a persistent browser instance.
// The tab is closed when release is called or when ctx is cancelled, whichever comes first.
func (bp *BrowserPool) OpenTab(ctx context.Context) (context.Context, func(), error) {
	select {
	case bp.tabSem <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}

	parent := bp.Acquire()
	if parent == context.Background() {
		<-bp.tabSem
		return nil, nil, errors.New("no chrome instance available")
	}

	tabCtx, cancelTab := chromedp.NewContext(parent)
	stop := context.AfterFunc(ctx, cancelTab)

	var once sync.Once
	release := func() {
		once.Do(func() {
			stop()
			cancelTab()
			<-bp.tabSem
		})
	}
	return tabCtx, release, nil
}

// Shutdown disconnects from the daemon and terminates any locally launched Chrome instances
func (bp *BrowserPool) Shutdown() {
	bp.mu.Lock()
	defer bp.mu.Unlock()

	bp.closed = true
	for _, cancel := range bp.cancels {
		cancel()
	}
	bp.contexts = nil
	bp.cancels = nil
}
