package extract

import (
	"net/url"
	"path"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

var skippedExtensions = map[string]bool{
	".pdf":   true,
	".jpg":   true,
	".jpeg":  true,
	".png":   true,
	".gif":   true,
	".svg":   true,
	".zip":   true,
	".tar":   true,
	".gz":    true,
	".css":   true,
	".js":    true,
	".mp4":   true,
	".mp3":   true,
	".ico":   true,
	".webp":  true,
	".woff":  true,
	".woff2": true,
	".ttf":   true,
	".eot":   true,
	".dmg":   true,
	".exe":   true,
}

// ExtractLinks discovers, normalizes, and filters same-domain outbound links
func ExtractLinks(htmlStr string, rawBaseURL string) []string {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return nil
	}
	return ExtractLinksDoc(doc, rawBaseURL)
}

// ExtractLinksDoc extracts same-domain links from an already-parsed document (read-only)
func ExtractLinksDoc(doc *goquery.Document, rawBaseURL string) []string {
	var links []string
	seen := make(map[string]bool)

	baseParsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return links
	}

	doc.Find("a[href]").Each(func(i int, s *goquery.Selection) {
		href, exists := s.Attr("href")
		if !exists {
			return
		}
		href = strings.TrimSpace(href)
		if href == "" || strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "mailto:") || strings.HasPrefix(href, "tel:") {
			return
		}

		u, err := url.Parse(href)
		if err != nil {
			return
		}

		resolved := baseParsed.ResolveReference(u)
		if resolved.Scheme != "http" && resolved.Scheme != "https" {
			return
		}

		// Only same hostname
		if strings.ToLower(resolved.Hostname()) != strings.ToLower(baseParsed.Hostname()) {
			return
		}

		// Skip static file extensions
		ext := strings.ToLower(path.Ext(resolved.Path))
		if skippedExtensions[ext] {
			return
		}

		// Strip fragment
		resolved.Fragment = ""

		canonicalURL := resolved.String()
		if !seen[canonicalURL] {
			seen[canonicalURL] = true
			links = append(links, canonicalURL)
		}
	})

	return links
}
