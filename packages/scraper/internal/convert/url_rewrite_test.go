package convert

import (
	"testing"
)

func TestGetAlternativeURL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "reddit post",
			input:    "https://www.reddit.com/r/golang/comments/12345/best_practices",
			expected: "https://www.reddit.com/r/golang/comments/12345/best_practices.json",
		},
		{
			name:     "reddit post already json",
			input:    "https://www.reddit.com/r/golang/comments/12345/best_practices.json",
			expected: "https://www.reddit.com/r/golang/comments/12345/best_practices.json",
		},
		{
			name:     "twitter profile",
			input:    "https://twitter.com/golang",
			expected: "https://nitter.net/golang",
		},
		{
			name:     "x.com tweet",
			input:    "https://x.com/golang/status/12345",
			expected: "https://nitter.net/golang/status/12345",
		},
		{
			name:     "medium article",
			input:    "https://medium.com/@author/my-post",
			expected: "https://scribe.rip/@author/my-post",
		},
		{
			name:     "standard site unchanged",
			input:    "https://example.com/blog/article",
			expected: "https://example.com/blog/article",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := GetAlternativeURL(tt.input)
			if result != tt.expected {
				t.Errorf("GetAlternativeURL(%q) = %q, expected %q", tt.input, result, tt.expected)
			}
		})
	}
}
