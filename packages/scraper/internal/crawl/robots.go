package crawl

import (
	"bufio"
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ParseRobotsTxt fetches and parses the robots.txt file for the given baseURL
func ParseRobotsTxt(ctx context.Context, baseURL string) (disallowed []string, sitemaps []string, crawlDelay *time.Duration, err error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, nil, nil, err
	}

	robotsURL := parsed.Scheme + "://" + parsed.Host + "/robots.txt"
	req, err := http.NewRequestWithContext(ctx, "GET", robotsURL, nil)
	if err != nil {
		return nil, nil, nil, nil
	}
	req.Header.Set("User-Agent", "*")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		// Treat unreachable as no restrictions
		return nil, nil, nil, nil
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	isRelevantAgent := false

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if idx := strings.Index(line, "#"); idx != -1 {
			line = strings.TrimSpace(line[:idx])
		}
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.ToLower(strings.TrimSpace(parts[0]))
		val := strings.TrimSpace(parts[1])

		switch key {
		case "user-agent":
			isRelevantAgent = (val == "*" || strings.Contains(strings.ToLower(val), "bot"))

		case "disallow":
			if isRelevantAgent && val != "" {
				disallowed = append(disallowed, val)
			}

		case "sitemap":
			if val != "" {
				sitemaps = append(sitemaps, val)
			}

		case "crawl-delay":
			if isRelevantAgent {
				if sec, err := strconv.ParseFloat(val, 64); err == nil && sec > 0 {
					dur := time.Duration(sec * float64(time.Second))
					crawlDelay = &dur
				}
			}
		}
	}

	return disallowed, sitemaps, crawlDelay, nil
}

// IsPathAllowed checks if the targetPath is permitted according to disallowed rules
func IsPathAllowed(targetPath string, disallowed []string) bool {
	for _, rule := range disallowed {
		if rule == "/" {
			return false
		}
		if strings.HasPrefix(targetPath, rule) {
			return false
		}
	}
	return true
}
