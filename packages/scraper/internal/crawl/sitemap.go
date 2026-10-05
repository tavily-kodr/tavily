package crawl

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sujal/go-scraper/internal/types"
)

type urlSetXML struct {
	XMLName xml.Name  `xml:"urlset"`
	URLs    []urlItem `xml:"url"`
}

type urlItem struct {
	Loc        string  `xml:"loc"`
	LastMod    string  `xml:"lastmod"`
	ChangeFreq string  `xml:"changefreq"`
	Priority   float64 `xml:"priority"`
}

type sitemapIndexXML struct {
	XMLName  xml.Name      `xml:"sitemapindex"`
	Sitemaps []sitemapItem `xml:"sitemap"`
}

type sitemapItem struct {
	Loc string `xml:"loc"`
}

var commonSitemapPaths = []string{
	"/sitemap.xml",
	"/sitemap_index.xml",
	"/sitemap/sitemap.xml",
	"/wp-sitemap.xml",
}

// DiscoverSitemapURLs crawls sitemaps (including nested index sitemaps) for a domain
func DiscoverSitemapURLs(ctx context.Context, baseURL string) ([]types.SitemapEntry, error) {
	_, robotsSitemaps, _, _ := ParseRobotsTxt(ctx, baseURL)

	var candidates []string
	candidates = append(candidates, robotsSitemaps...)

	parsed, err := url.Parse(baseURL)
	if err == nil {
		origin := parsed.Scheme + "://" + parsed.Host
		for _, p := range commonSitemapPaths {
			candidates = append(candidates, origin+p)
		}
	}

	seenSitemaps := make(map[string]bool)
	seenURLs := make(map[string]bool)
	var entries []types.SitemapEntry

	client := &http.Client{Timeout: 15 * time.Second}

	var fetchSitemap func(sitemapURL string, depth int)
	fetchSitemap = func(sitemapURL string, depth int) {
		if depth > 3 || len(entries) >= 500 || seenSitemaps[sitemapURL] {
			return
		}
		seenSitemaps[sitemapURL] = true

		req, err := http.NewRequestWithContext(ctx, "GET", sitemapURL, nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")

		resp, err := client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			return
		}
		defer resp.Body.Close()

		bodyBytes, err := io.ReadAll(resp.Body)
		if err != nil {
			return
		}

		// Try parsing as sitemap index first
		var sIndex sitemapIndexXML
		if err := xml.Unmarshal(bodyBytes, &sIndex); err == nil && len(sIndex.Sitemaps) > 0 {
			for _, sm := range sIndex.Sitemaps {
				if sm.Loc != "" {
					fetchSitemap(strings.TrimSpace(sm.Loc), depth+1)
				}
			}
			return
		}

		// Try parsing as standard urlset
		var uSet urlSetXML
		if err := xml.Unmarshal(bodyBytes, &uSet); err == nil && len(uSet.URLs) > 0 {
			for _, u := range uSet.URLs {
				cleanLoc := strings.TrimSpace(u.Loc)
				if cleanLoc != "" && !seenURLs[cleanLoc] {
					seenURLs[cleanLoc] = true
					entries = append(entries, types.SitemapEntry{
						URL:        cleanLoc,
						LastMod:    u.LastMod,
						ChangeFreq: u.ChangeFreq,
						Priority:   u.Priority,
					})
					if len(entries) >= 500 {
						return
					}
				}
			}
		}
	}

	for _, cand := range candidates {
		fetchSitemap(cand, 0)
		if len(entries) > 0 {
			break
		}
	}

	return entries, nil
}
