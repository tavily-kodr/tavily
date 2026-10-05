package extract

import (
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

var whitespaceRegex = regexp.MustCompile(`\s+`)

// noiseSelector lists elements that never carry main content (shared by text and markdown extraction)
const noiseSelector = "script, style, noscript, nav, footer, header, svg, iframe, form, button, aside, dialog, canvas, link, meta"

// CleanDocument returns a deep copy of doc with noisy elements removed. doc itself is not modified.
func CleanDocument(doc *goquery.Document) *goquery.Document {
	cleaned := goquery.NewDocumentFromNode(doc.Selection.Clone().Nodes[0])
	cleaned.Find(noiseSelector).Remove()
	return cleaned
}

// ExtractTitleDoc picks <title>, then og:title, then the first <h1>
func ExtractTitleDoc(doc *goquery.Document) string {
	if t := strings.TrimSpace(doc.Find("title").First().Text()); t != "" {
		return t
	}
	if ogTitle, exists := doc.Find(`meta[property="og:title"]`).Attr("content"); exists && strings.TrimSpace(ogTitle) != "" {
		return strings.TrimSpace(ogTitle)
	}
	return strings.TrimSpace(doc.Find("h1").First().Text())
}

// ExtractTextDoc extracts collapsed plain text from a CleanDocument, preferring <main> or <article>
func ExtractTextDoc(cleaned *goquery.Document) string {
	var mainSelection *goquery.Selection
	if main := cleaned.Find("main"); main.Length() > 0 && len(strings.TrimSpace(main.Text())) > 200 {
		mainSelection = main
	} else if article := cleaned.Find("article"); article.Length() > 0 && len(strings.TrimSpace(article.Text())) > 200 {
		mainSelection = article
	} else {
		mainSelection = cleaned.Find("body")
	}

	collapsed := whitespaceRegex.ReplaceAllString(mainSelection.Text(), " ")
	return strings.TrimSpace(collapsed)
}

// ExtractWithGoquery performs fallback DOM extraction using goquery
func ExtractWithGoquery(htmlStr string) (title string, text string) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return "", ""
	}
	return ExtractTitleDoc(doc), ExtractTextDoc(CleanDocument(doc))
}
