// Package cache stores successful scrape results on disk so repeat scrapes of a URL within
// MaxAge return instantly (Firecrawl's maxAge). Entries live in the user cache dir, shared by
// every output directory.
package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sujal/go-scraper/internal/types"
)

// maxEntryBytes skips caching pages whose raw HTML is unreasonably large
const maxEntryBytes = 5 << 20

type entry struct {
	URL       string             `json:"url"`
	FetchedAt time.Time          `json:"fetched_at"`
	Result    types.ScrapeResult `json:"result"`
}

var (
	dirOnce  sync.Once
	cacheDir string
)

func dir() string {
	dirOnce.Do(func() {
		base, err := os.UserCacheDir()
		if err != nil || base == "" {
			base = os.TempDir()
		}
		cacheDir = filepath.Join(base, "go-scraper", "results")
		_ = os.MkdirAll(cacheDir, 0755)
	})
	return cacheDir
}

func pathFor(url string) string {
	sum := sha256.Sum256([]byte(url))
	return filepath.Join(dir(), hex.EncodeToString(sum[:16])+".json")
}

// Get returns the cached result for url if it was fetched within maxAge
func Get(url string, maxAge time.Duration) (*types.ScrapeResult, bool) {
	if maxAge <= 0 {
		return nil, false
	}
	data, err := os.ReadFile(pathFor(url))
	if err != nil {
		return nil, false
	}
	var e entry
	if err := json.Unmarshal(data, &e); err != nil || e.URL != url || !e.Result.Success {
		return nil, false
	}
	if time.Since(e.FetchedAt) > maxAge {
		return nil, false
	}
	res := e.Result
	return &res, true
}

// Put stores a successful result. Failures are never cached.
func Put(res *types.ScrapeResult) {
	if res == nil || !res.Success || len(res.HTML) > maxEntryBytes {
		return
	}
	data, err := json.Marshal(entry{URL: res.URL, FetchedAt: time.Now(), Result: *res})
	if err != nil {
		return
	}
	// Write-then-rename so a reader never sees a half-written entry
	path := pathFor(res.URL)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// Clear removes every cached result and reports how many were deleted
func Clear() (int, error) {
	entries, err := os.ReadDir(dir())
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".json" {
			if os.Remove(filepath.Join(dir(), e.Name())) == nil {
				n++
			}
		}
	}
	return n, nil
}
