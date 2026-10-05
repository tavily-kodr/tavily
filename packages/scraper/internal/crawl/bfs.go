package crawl

import (
	"context"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/sujal/go-scraper/internal/fetch"
	"github.com/sujal/go-scraper/internal/ratelimit"
	"github.com/sujal/go-scraper/internal/types"
)

// CrawlSite executes a high-concurrency BFS crawl starting from startURL.
// onResult (optional) is called from worker goroutines as each page finishes, so callers can stream output.
func CrawlSite(ctx context.Context, startURL string, pool *fetch.BrowserPool, limiter *ratelimit.PerDomainLimiter, cfg types.Config, onResult func(types.CrawlPageResult)) []types.CrawlPageResult {
	var (
		visited    sync.Map
		results    []types.CrawlPageResult
		resultsMu  sync.Mutex
		queue      = make(chan types.Job, cfg.MaxPages*5+100)
		activeJobs int64 // queued + in-flight jobs; the crawl ends when this hits 0
		scheduled  int64 // total jobs ever enqueued; capped at MaxPages
		wg         sync.WaitGroup
		closeOnce  sync.Once
	)

	safeCloseQueue := func() {
		closeOnce.Do(func() {
			close(queue)
		})
	}

	// Pre-compile regex filters if set
	var includeRe, excludeRe *regexp.Regexp
	if cfg.IncludePaths != "" {
		includeRe, _ = regexp.Compile(cfg.IncludePaths)
	}
	if cfg.ExcludePaths != "" {
		excludeRe, _ = regexp.Compile(cfg.ExcludePaths)
	}

	// Parse robots.txt
	var disallowed []string
	if cfg.RespectRobotsTxt {
		d, _, delay, _ := ParseRobotsTxt(ctx, startURL)
		disallowed = d
		if delay != nil && limiter != nil {
			if u, err := url.Parse(startURL); err == nil {
				limiter.SetDelay(u.Hostname(), *delay)
			}
		}
	}

	startParsed, err := url.Parse(startURL)
	if err != nil {
		slog.Error("invalid start URL", "url", startURL, "error", err)
		return nil
	}
	baseHost := strings.ToLower(startParsed.Hostname())

	// Seed queue
	visited.Store(startURL, true)
	atomic.AddInt64(&activeJobs, 1)
	atomic.AddInt64(&scheduled, 1)
	queue <- types.Job{URL: startURL, Depth: 0}

	concurrency := cfg.Concurrency
	if concurrency <= 0 {
		concurrency = 20
	}

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					safeCloseQueue()
					return
				case job, ok := <-queue:
					if !ok {
						return
					}

					// Domain rate limiter wait
					if limiter != nil {
						if parsed, err := url.Parse(job.URL); err == nil {
							_ = limiter.Wait(ctx, parsed.Hostname())
						}
					}

					res := fetch.FetchWithEscalation(ctx, job.URL, pool, &cfg)

					crawlRes := types.CrawlPageResult{
						ScrapeResult: *res,
						Depth:        job.Depth,
					}

					resultsMu.Lock()
					results = append(results, crawlRes)
					currentTotal := len(results)
					resultsMu.Unlock()

					if onResult != nil {
						onResult(crawlRes)
					}

					// Discovered links enqueueing
					if job.Depth < cfg.MaxDepth && currentTotal < cfg.MaxPages {
						for _, link := range res.Links {
							u, err := url.Parse(link)
							if err != nil {
								continue
							}

							// Check domain unless follow external enabled
							if !cfg.FollowExternalLinks && strings.ToLower(u.Hostname()) != baseHost {
								continue
							}

							// Check robots.txt
							if cfg.RespectRobotsTxt && !IsPathAllowed(u.Path, disallowed) {
								continue
							}

							// Regex filtering
							if includeRe != nil && !includeRe.MatchString(link) {
								continue
							}
							if excludeRe != nil && excludeRe.MatchString(link) {
								continue
							}

							if _, alreadySeen := visited.LoadOrStore(link, true); !alreadySeen {
								if atomic.AddInt64(&scheduled, 1) <= int64(cfg.MaxPages) {
									atomic.AddInt64(&activeJobs, 1)
									select {
									case <-ctx.Done():
										safeCloseQueue()
										return
									case queue <- types.Job{URL: link, Depth: job.Depth + 1}:
									}
								} else {
									// Page budget exhausted: stop scanning this page's links
									atomic.AddInt64(&scheduled, -1)
									break
								}
							}
						}
					}

					if atomic.AddInt64(&activeJobs, -1) <= 0 {
						safeCloseQueue()
						return
					}
				}
			}
		}()
	}

	wg.Wait()
	return results
}
