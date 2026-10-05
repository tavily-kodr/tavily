package ratelimit

import (
	"fmt"
	"sync"

	"github.com/sujal/go-scraper/internal/types"
)

// ProxyRotator manages round-robin proxy rotation and tracks failure counts
type ProxyRotator struct {
	mu       sync.Mutex
	proxies  []types.ProxyConfig
	failures map[string]int
	idx      int
}

// NewProxyRotator creates a proxy rotator from a list of configs
func NewProxyRotator(proxies []types.ProxyConfig) *ProxyRotator {
	return &ProxyRotator{
		proxies:  proxies,
		failures: make(map[string]int),
	}
}

// HasProxies returns true if configured with proxies
func (pr *ProxyRotator) HasProxies() bool {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	return len(pr.proxies) > 0
}

func proxyKey(p types.ProxyConfig) string {
	return fmt.Sprintf("%s:%d", p.Host, p.Port)
}

// GetNext returns the next available proxy that has not exceeded failure limit (3)
func (pr *ProxyRotator) GetNext() *types.ProxyConfig {
	pr.mu.Lock()
	defer pr.mu.Unlock()

	if len(pr.proxies) == 0 {
		return nil
	}

	for i := 0; i < len(pr.proxies); i++ {
		p := pr.proxies[pr.idx%len(pr.proxies)]
		pr.idx++
		if pr.failures[proxyKey(p)] < 3 {
			return &p
		}
	}

	// If all have failed, return the first one as fallback
	return &pr.proxies[0]
}

// ReportFailure increments the failure count for a proxy
func (pr *ProxyRotator) ReportFailure(p types.ProxyConfig) {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	pr.failures[proxyKey(p)]++
}
