package extract

import (
	"encoding/json"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// ExtractJsonLD finds and parses all application/ld+json scripts in the page
func ExtractJsonLD(htmlStr string) []any {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return nil
	}
	return ExtractJsonLDDoc(doc)
}

// ExtractJsonLDDoc parses JSON-LD blocks from an already-parsed document (read-only)
func ExtractJsonLDDoc(doc *goquery.Document) []any {
	var results []any

	doc.Find(`script[type="application/ld+json"]`).Each(func(i int, s *goquery.Selection) {
		text := strings.TrimSpace(s.Text())
		if text == "" {
			return
		}

		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err == nil {
			if arr, ok := parsed.([]any); ok {
				results = append(results, arr...)
			} else {
				results = append(results, parsed)
			}
		}
	})

	return results
}
