package extract

import (
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/sujal/go-scraper/internal/types"
)

// ExtractMetadata extracts rich <head> and OpenGraph metadata from HTML
func ExtractMetadata(htmlStr string) types.PageMetadata {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return types.PageMetadata{}
	}
	return ExtractMetadataDoc(doc)
}

// ExtractMetadataDoc extracts metadata from an already-parsed document (read-only)
func ExtractMetadataDoc(doc *goquery.Document) types.PageMetadata {
	var meta types.PageMetadata

	getMeta := func(selectors ...string) string {
		for _, sel := range selectors {
			if val, exists := doc.Find(sel).Attr("content"); exists && strings.TrimSpace(val) != "" {
				return strings.TrimSpace(val)
			}
		}
		return ""
	}

	meta.Description = getMeta(
		`meta[name="description"]`,
		`meta[property="og:description"]`,
		`meta[name="twitter:description"]`,
	)

	if kw := getMeta(`meta[name="keywords"]`); kw != "" {
		parts := strings.Split(kw, ",")
		for _, p := range parts {
			if trimmed := strings.TrimSpace(p); trimmed != "" {
				meta.Keywords = append(meta.Keywords, trimmed)
			}
		}
	}

	meta.OGTitle = getMeta(
		`meta[property="og:title"]`,
		`meta[name="twitter:title"]`,
	)

	meta.OGDescription = getMeta(
		`meta[property="og:description"]`,
		`meta[name="twitter:description"]`,
	)

	meta.OGImage = getMeta(
		`meta[property="og:image"]`,
		`meta[name="twitter:image"]`,
	)

	if href, exists := doc.Find(`link[rel="canonical"]`).Attr("href"); exists {
		meta.Canonical = strings.TrimSpace(href)
	}

	if lang, exists := doc.Find("html").Attr("lang"); exists && strings.TrimSpace(lang) != "" {
		meta.Lang = strings.TrimSpace(lang)
	} else {
		meta.Lang = getMeta(`meta[name="language"]`, `meta[name="dc.language"]`)
	}

	meta.Author = getMeta(
		`meta[name="author"]`,
		`meta[name="dc.creator"]`,
		`meta[property="article:author"]`,
	)

	meta.PublishedDate = getMeta(
		`meta[property="article:published_time"]`,
		`meta[name="dc.date"]`,
		`meta[name="date"]`,
	)

	meta.ModifiedDate = getMeta(
		`meta[property="article:modified_time"]`,
		`meta[name="dc.date.modified"]`,
	)

	return meta
}
