package config

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/sujal/go-scraper/internal/types"
)

// NewDefault returns a copy of DefaultConfig
func NewDefault() types.Config {
	cfg := types.DefaultConfig
	// Make a shallow copy of slices so mutations don't leak
	cfg.OutputFormats = append([]string(nil), types.DefaultConfig.OutputFormats...)
	cfg.Proxies = append([]types.ProxyConfig(nil), types.DefaultConfig.Proxies...)
	return cfg
}

// MergeWithEnv overrides configuration with environment variables if present
func MergeWithEnv(cfg *types.Config) {
	if v := os.Getenv("OUTPUT_DIR"); v != "" {
		cfg.OutputDir = v
	}
	if v := os.Getenv("FORMATS"); v != "" {
		formats := strings.Split(v, ",")
		var cleaned []string
		for _, f := range formats {
			if s := strings.TrimSpace(f); s != "" {
				cleaned = append(cleaned, s)
			}
		}
		if len(cleaned) > 0 {
			cfg.OutputFormats = cleaned
		}
	}
	if v := os.Getenv("CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Concurrency = n
		}
	}
	if v := os.Getenv("MAX_DEPTH"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.MaxDepth = n
		}
	}
	if v := os.Getenv("MAX_PAGES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.MaxPages = n
		}
	}
	if v := os.Getenv("DELAY_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.DelayBetweenRequests = time.Duration(n) * time.Millisecond
		}
	}
	if v := os.Getenv("STEALTH"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.UseStealth = b
		}
	}
	if v := os.Getenv("FAST"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.FastMode = b
		}
	}
	if v := os.Getenv("TIMEOUT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.RequestTimeout = time.Duration(n) * time.Second
		}
	}
}

// MergeWithFlags applies CLI flag overrides
func MergeWithFlags(cfg *types.Config, flags map[string]any) {
	if val, ok := flags["concurrency"].(int); ok && val > 0 {
		cfg.Concurrency = val
	}
	if val, ok := flags["output"].(string); ok && val != "" {
		cfg.OutputDir = val
	}
	if val, ok := flags["formats"].(string); ok && val != "" {
		parts := strings.Split(val, ",")
		var cleaned []string
		for _, p := range parts {
			if s := strings.TrimSpace(p); s != "" {
				cleaned = append(cleaned, s)
			}
		}
		if len(cleaned) > 0 {
			cfg.OutputFormats = cleaned
		}
	}
	if val, ok := flags["stealth"].(bool); ok {
		cfg.UseStealth = val
	}
	if val, ok := flags["delay"].(time.Duration); ok && val >= 0 {
		cfg.DelayBetweenRequests = val
	}
	if val, ok := flags["timeout"].(time.Duration); ok && val > 0 {
		cfg.RequestTimeout = val
	}
	if val, ok := flags["ua-rotate"].(bool); ok {
		cfg.RotateUA = val
	}
	if val, ok := flags["depth"].(int); ok && val >= 0 {
		cfg.MaxDepth = val
	}
	if val, ok := flags["pages"].(int); ok && val > 0 {
		cfg.MaxPages = val
	}
	if val, ok := flags["respect-robots"].(bool); ok {
		cfg.RespectRobotsTxt = val
	}
	if val, ok := flags["include"].(string); ok {
		cfg.IncludePaths = val
	}
	if val, ok := flags["exclude"].(string); ok {
		cfg.ExcludePaths = val
	}
	if val, ok := flags["follow-external"].(bool); ok {
		cfg.FollowExternalLinks = val
	}
	if val, ok := flags["fast"].(bool); ok {
		cfg.FastMode = val
	}
	if val, ok := flags["browsers"].(int); ok && val > 0 {
		cfg.BrowserPoolSize = val
	}
	if val, ok := flags["no-daemon"].(bool); ok {
		cfg.NoDaemon = val
	}
	if val, ok := flags["max-age"].(time.Duration); ok && val >= 0 {
		cfg.MaxAge = val
	}
}
