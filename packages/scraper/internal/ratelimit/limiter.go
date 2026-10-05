package ratelimit

import (
	"context"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// PerDomainLimiter manages token bucket rate limiters per domain
type PerDomainLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	rps      float64
	burst    int
}

// New creates a new PerDomainLimiter
func New(rps float64, burst int) *PerDomainLimiter {
	if rps <= 0 {
		rps = 10.0
	}
	if burst <= 0 {
		burst = 5
	}
	return &PerDomainLimiter{
		limiters: make(map[string]*rate.Limiter),
		rps:      rps,
		burst:    burst,
	}
}

// getLimiter retrieves or creates a rate limiter for domain
func (l *PerDomainLimiter) getLimiter(domain string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()

	limiter, ok := l.limiters[domain]
	if !ok {
		limiter = rate.NewLimiter(rate.Limit(l.rps), l.burst)
		l.limiters[domain] = limiter
	}
	return limiter
}

// Wait blocks until the domain token bucket permits a request or ctx is cancelled
func (l *PerDomainLimiter) Wait(ctx context.Context, domain string) error {
	limiter := l.getLimiter(domain)
	return limiter.Wait(ctx)
}

// SetDelay configures a custom crawl-delay for a specific domain
func (l *PerDomainLimiter) SetDelay(domain string, delay time.Duration) {
	if delay <= 0 {
		return
	}
	rps := 1.0 / delay.Seconds()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.limiters[domain] = rate.NewLimiter(rate.Limit(rps), 1)
}
