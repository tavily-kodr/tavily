package detect

import (
	"strings"
	"testing"
)

func TestHasRealContent(t *testing.T) {
	tests := []struct {
		name      string
		html      string
		minLength int
		expected  bool
	}{
		{
			name:      "empty page",
			html:      "<html><body></body></html>",
			minLength: 200,
			expected:  false,
		},
		{
			name:      "short page",
			html:      "<html><body><p>Hello world</p></body></html>",
			minLength: 200,
			expected:  false,
		},
		{
			name:      "spa shell root",
			html:      `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`,
			minLength: 10,
			expected:  false,
		},
		{
			name:      "bot challenge cloudflare",
			html:      `<html><body><div id="challenge-running">Checking if the site connection is secure. Please wait...</div></body></html>`,
			minLength: 50,
			expected:  false,
		},
		{
			name:      "client-rendered page with inline data",
			html:      `<html><body><h1>Quotes</h1><a href="/login">Login</a><p>Made with love by a small team of people</p><script>var data = [` + strings.Repeat(`{"text": "a quote that is rendered by javascript", "author": "someone"},`, 60) + `];</script></body></html>`,
			minLength: 50,
			expected:  false,
		},
		{
			name: "good content page",
			html: `<html><head><title>Test Article</title></head><body>
				<article>
					<h1>A Substantial Article Title</h1>
					<p>This is a paragraph with plenty of genuine content to satisfy the length threshold required for high-quality scraped documents. It discusses various technical aspects of web scraping, concurrency models, and architecture design in Go.</p>
					<p>Another paragraph providing even more details, demonstrating how goroutines scale efficiently compared to event loops and threads, providing Firecrawl-class extraction performance.</p>
				</article>
			</body></html>`,
			minLength: 200,
			expected:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := HasRealContent(tt.html, tt.minLength)
			if result != tt.expected {
				t.Errorf("HasRealContent() = %v, expected %v", result, tt.expected)
			}
		})
	}
}
