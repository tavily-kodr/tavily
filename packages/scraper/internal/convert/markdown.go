package convert

import (
	"fmt"
	"strings"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
	"github.com/PuerkitoBio/goquery"
)

// noiseSelector mirrors extract.CleanDocument; used when converting from a raw HTML string
const noiseSelector = "script, style, noscript, iframe, svg, nav, footer, header, form, button, link, meta, aside, dialog, canvas"

// markdownTarget picks the content root: a single <main>, else a single <article>, else <body>.
// Pages with several <article>s (listings, product grids) use <body> so no item is dropped.
func markdownTarget(doc *goquery.Document) *goquery.Selection {
	if main := doc.Find("main"); main.Length() == 1 {
		return main
	}
	if article := doc.Find("article"); article.Length() == 1 {
		return article
	}
	if body := doc.Find("body"); body.Length() > 0 {
		return body.First()
	}
	return doc.Selection
}

func stripInlineAttrs(sel *goquery.Selection) {
	sel.Find("[style], [onclick], [onload]").Each(func(i int, s *goquery.Selection) {
		s.RemoveAttr("style")
		s.RemoveAttr("onclick")
		s.RemoveAttr("onload")
	})
}

// CleanHTMLForMarkdown removes elements not suitable for markdown documentation
func CleanHTMLForMarkdown(htmlStr string) string {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return htmlStr
	}
	doc.Find(noiseSelector).Remove()

	target := markdownTarget(doc)
	stripInlineAttrs(target)
	cleaned, err := target.Html()
	if err != nil {
		return htmlStr
	}
	return cleaned
}

// HTMLToMarkdown converts raw HTML to clean GitHub-flavored Markdown
func HTMLToMarkdown(htmlStr string) string {
	cleaned := CleanHTMLForMarkdown(htmlStr)
	md, err := htmltomarkdown.ConvertString(cleaned)
	if err != nil || strings.TrimSpace(md) == "" {
		md, _ = htmltomarkdown.ConvertString(htmlStr)
	}
	return strings.TrimSpace(md)
}

// HTMLToMarkdownDoc converts an already-cleaned document (see extract.CleanDocument) without
// re-serializing and re-parsing it. rawHTML is only used as a fallback when nothing converts.
func HTMLToMarkdownDoc(cleaned *goquery.Document, rawHTML string) string {
	target := markdownTarget(cleaned)
	stripInlineAttrs(target)

	var md string
	if len(target.Nodes) > 0 {
		if out, err := htmltomarkdown.ConvertNode(target.Nodes[0]); err == nil {
			md = string(out)
		}
	}
	if strings.TrimSpace(md) == "" {
		md, _ = htmltomarkdown.ConvertString(rawHTML)
	}
	return strings.TrimSpace(md)
}

// BuildMarkdownDocument builds the complete markdown document with header and metadata source
func BuildMarkdownDocument(title, pageURL, htmlStr string) string {
	bodyMD := HTMLToMarkdown(htmlStr)
	return fmt.Sprintf("# %s\n\n> Source: %s\n\n%s\n", title, pageURL, bodyMD)
}

// BuildMarkdownDocumentDoc is BuildMarkdownDocument over a shared, already-cleaned parse
func BuildMarkdownDocumentDoc(title, pageURL string, cleaned *goquery.Document, rawHTML string) string {
	bodyMD := HTMLToMarkdownDoc(cleaned, rawHTML)
	return fmt.Sprintf("# %s\n\n> Source: %s\n\n%s\n", title, pageURL, bodyMD)
}
