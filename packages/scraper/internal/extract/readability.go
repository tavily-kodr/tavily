package extract

import (
	"net/url"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/go-shiori/go-readability"
)

// ExtractWithReadability uses Mozilla Readability port to extract article title and text
func ExtractWithReadability(htmlStr string, pageURL string) (title string, text string, ok bool) {
	parsedURL, err := url.Parse(pageURL)
	if err != nil {
		parsedURL = &url.URL{Scheme: "http", Host: "example.com"}
	}

	reader := strings.NewReader(htmlStr)
	article, err := readability.FromReader(reader, parsedURL)
	if err != nil {
		return "", "", false
	}
	return readabilityResult(article)
}

// ExtractWithReadabilityDoc runs readability on an already-parsed document. readability clones
// the tree internally, so doc is left untouched.
func ExtractWithReadabilityDoc(doc *goquery.Document, pageURL string) (title string, text string, ok bool) {
	parsedURL, err := url.Parse(pageURL)
	if err != nil {
		parsedURL = &url.URL{Scheme: "http", Host: "example.com"}
	}
	if len(doc.Nodes) == 0 {
		return "", "", false
	}
	article, err := readability.FromDocument(doc.Nodes[0], parsedURL)
	if err != nil {
		return "", "", false
	}
	return readabilityResult(article)
}

func readabilityResult(article readability.Article) (title string, text string, ok bool) {
	title = strings.TrimSpace(article.Title)
	text = strings.TrimSpace(article.TextContent)

	if len(text) == 0 {
		return title, "", false
	}

	return title, text, true
}
