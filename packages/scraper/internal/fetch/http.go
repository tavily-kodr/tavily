package fetch

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sujal/go-scraper/internal/types"
)

// maxBodyBytes caps response bodies so one huge page cannot stall a worker
const maxBodyBytes = 10 << 20

// ErrTerminal marks fetch failures that no browser tier can fix (404s, PDFs, ...)
var ErrTerminal = errors.New("terminal fetch error")

var (
	dnsCache sync.Map // host -> []string (IPv4 first)
	dialer   = &net.Dialer{
		Timeout:   4 * time.Second,
		KeepAlive: 60 * time.Second,
	}
)

func resolveHost(ctx context.Context, host string) ([]string, error) {
	if cached, ok := dnsCache.Load(host); ok {
		return cached.([]string), nil
	}
	ips, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, err
	}
	// IPv4 first: an unreachable IPv6 route would otherwise burn the whole dial timeout
	ordered := make([]string, 0, len(ips))
	for _, ip := range ips {
		if !strings.Contains(ip, ":") {
			ordered = append(ordered, ip)
		}
	}
	for _, ip := range ips {
		if strings.Contains(ip, ":") {
			ordered = append(ordered, ip)
		}
	}
	dnsCache.Store(host, ordered)
	return ordered, nil
}

func cachedDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) != nil {
		return dialer.DialContext(ctx, network, addr)
	}
	ips, err := resolveHost(ctx, host)
	if err != nil || len(ips) == 0 {
		return dialer.DialContext(ctx, network, addr)
	}
	var lastErr error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

var defaultTransport = &http.Transport{
	// High-throughput connection pool
	MaxIdleConns:        1000,
	MaxIdleConnsPerHost: 200,
	MaxConnsPerHost:     200,
	IdleConnTimeout:     120 * time.Second,

	// Fast cached DNS + TCP
	DialContext: cachedDialContext,

	// TLS handshake timeout
	TLSHandshakeTimeout:   4 * time.Second,
	ResponseHeaderTimeout: 8 * time.Second,

	// Enable HTTP/2 (multiplexed requests over one TCP conn)
	ForceAttemptHTTP2: true,

	// Let standard library handle gzip decompression automatically
	DisableCompression: false,
}

// globalHTTPClient has no client-level timeout; each request gets cfg.RequestTimeout via its context
var globalHTTPClient = &http.Client{
	Transport: defaultTransport,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

// IsTerminalStatus reports HTTP statuses where escalating to a browser cannot help.
// 401/403/429/503 are left out on purpose: WAFs and bot challenges use them.
func IsTerminalStatus(status int) bool {
	switch status {
	case 400, 404, 405, 410, 414, 451, 500, 501, 502, 504:
		return true
	}
	return false
}

// FetchHTTP performs a high-speed Tier 1 fetch reusing TCP connections
func FetchHTTP(ctx context.Context, targetURL string, cfg *types.Config) (*types.FetchResult, error) {
	timeout := 10 * time.Second
	if cfg != nil && cfg.RequestTimeout > 0 {
		timeout = cfg.RequestTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: create request failed: %v", ErrTerminal, err)
	}

	// Realistic browser headers
	for k, v := range BrowserHeaders {
		req.Header.Set(k, v)
	}

	if cfg == nil || cfg.RotateUA {
		req.Header.Set("User-Agent", GetRandomUA())
	} else {
		req.Header.Set("User-Agent", UserAgents[0])
	}

	start := time.Now()
	resp, err := globalHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request error: %w", err)
	}
	defer resp.Body.Close()

	fetchMs := time.Since(start).Milliseconds()

	if IsTerminalStatus(resp.StatusCode) {
		return nil, fmt.Errorf("%w: http status %d", ErrTerminal, resp.StatusCode)
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	// Only accept HTML or JSON
	isHTML := strings.Contains(contentType, "text/html") || strings.Contains(contentType, "application/xhtml+xml")
	isJSON := strings.Contains(contentType, "application/json") || strings.Contains(contentType, "text/json")

	if !isHTML && !isJSON && contentType != "" {
		return nil, fmt.Errorf("%w: unsupported content-type: %s", ErrTerminal, contentType)
	}

	var reader io.Reader = resp.Body
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "gzip":
		gzReader, err := gzip.NewReader(resp.Body)
		if err == nil {
			defer gzReader.Close()
			reader = gzReader
		}
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(reader, maxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to read body: %w", err)
	}

	bodyStr := string(bodyBytes)
	if isJSON {
		bodyStr = fmt.Sprintf("<!DOCTYPE html><html><head><title>JSON Response</title></head><body><pre>%s</pre></body></html>", bodyStr)
	}

	return &types.FetchResult{
		HTML:    bodyStr,
		Method:  "http",
		FetchMs: fetchMs,
		Status:  resp.StatusCode,
	}, nil
}
