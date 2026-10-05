package extract

import (
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// ExtractContent runs the dual-engine pipeline: go-readability vs goquery fallback
func ExtractContent(htmlStr string, pageURL string) (title string, text string) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return "", ""
	}
	return ExtractContentDoc(doc, CleanDocument(doc), pageURL)
}

// ExtractContentDoc is ExtractContent over a shared parse: doc is the pristine tree, cleaned is CleanDocument(doc)
func ExtractContentDoc(doc, cleaned *goquery.Document, pageURL string) (title string, text string) {
	fallbackTitle, fallbackText := ExtractTitleDoc(doc), ExtractTextDoc(cleaned)
	readTitle, readText, readOk := ExtractWithReadabilityDoc(doc, pageURL)

	if readOk && len(readText) > 500 && float64(len(readText)) > float64(len(fallbackText))*0.3 {
		t := readTitle
		if t == "" {
			t = fallbackTitle
		}
		return t, readText
	}

	t := fallbackTitle
	if t == "" {
		t = readTitle
	}

	// If fallbackText is too short but readability got something, use readability
	if len(fallbackText) < 200 && readOk && len(readText) > len(fallbackText) {
		return t, readText
	}

	return t, fallbackText
}
