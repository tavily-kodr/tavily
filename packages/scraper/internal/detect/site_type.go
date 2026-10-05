package detect

import (
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/sujal/go-scraper/internal/types"
)

var (
	authKeywordsRegex = regexp.MustCompile(`(?i)(sign\s*in|log\s*in|create\s*account|forgot\s*password)`)
	frameworkScriptRegex = regexp.MustCompile(`(?i)(react|vue|angular|next|nuxt|svelte|webpack|chunk)`)
	infiniteScrollRegex = regexp.MustCompile(`(?i)(infinite.?scroll|lazy.?load|load.?more|IntersectionObserver|sentinel)`)
	apiScriptRegex = regexp.MustCompile(`(?i)(fetch\s*\(|axios\.|XMLHttpRequest|\$\.ajax|\.json\(\))`)
)

// DetectSiteType categorizes the web page structure to assist tier escalation
func DetectSiteType(htmlStr string) types.SiteType {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return types.SiteUnknown
	}

	bodyText := strings.TrimSpace(doc.Find("body").Text())
	bodyLen := len(bodyText)

	// 1. Auth wall detection
	hasLoginForm := doc.Find(`form[action*="login"]`).Length() > 0
	hasPasswordInput := doc.Find(`input[type="password"]`).Length() > 0
	if (hasLoginForm || hasPasswordInput) && authKeywordsRegex.MatchString(bodyText) && bodyLen < 2000 {
		return types.SiteAuthRequired
	}

	// 2. SPA detection
	hasSPARoot := doc.Find("#root, #app, #__next, #__nuxt, [data-reactroot], [ng-app], [data-v-app]").Length() > 0
	hasFrameworkScript := false
	doc.Find("script[src]").Each(func(i int, s *goquery.Selection) {
		if src, ok := s.Attr("src"); ok && frameworkScriptRegex.MatchString(src) {
			hasFrameworkScript = true
		}
	})

	if hasSPARoot && (bodyLen < 200 || hasFrameworkScript) {
		return types.SiteSPA
	}

	// 3. Infinite scroll detection
	allScripts := ""
	doc.Find("script:not([src])").Each(func(i int, s *goquery.Selection) {
		allScripts += s.Text() + "\n"
	})

	if infiniteScrollRegex.MatchString(allScripts) {
		return types.SiteInfiniteScroll
	}

	// 4. API-backed detection
	if apiScriptRegex.MatchString(allScripts) && bodyLen < 200 {
		return types.SiteAPIBacked
	}

	return types.SiteStatic
}
