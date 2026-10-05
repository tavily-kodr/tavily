package convert

import (
	"net/url"
	"strings"
)

// GetAlternativeURL returns a rewritten URL for known scraper-unfriendly domains (Reddit, Twitter/X, Medium)
func GetAlternativeURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	host := strings.ToLower(parsed.Hostname())

	// Reddit -> append .json to path
	if host == "reddit.com" || host == "www.reddit.com" || host == "old.reddit.com" {
		path := parsed.Path
		if !strings.HasSuffix(path, ".json") {
			if strings.HasSuffix(path, "/") {
				path = strings.TrimSuffix(path, "/")
			}
			parsed.Path = path + ".json"
			return parsed.String()
		}
		return rawURL
	}

	// Twitter / X -> nitter.net
	if host == "twitter.com" || host == "www.twitter.com" || host == "x.com" || host == "www.x.com" {
		parsed.Host = "nitter.net"
		return parsed.String()
	}

	// Medium / *.medium.com -> scribe.rip
	if host == "medium.com" || strings.HasSuffix(host, ".medium.com") {
		parsed.Host = "scribe.rip"
		return parsed.String()
	}

	return rawURL
}
