package detect

import (
	"regexp"
	"strings"
)

var (
	scriptRegex     = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>`)
	styleRegex      = regexp.MustCompile(`(?is)<style\b[^>]*>.*?</style>`)
	htmlTagRegex    = regexp.MustCompile(`(?s)<[^>]*>`)
	whitespaceRegex = regexp.MustCompile(`\s+`)

	spaShellRegexes = []*regexp.Regexp{
		regexp.MustCompile(`(?i)<div\s+id=["']root["']`),
		regexp.MustCompile(`(?i)<div\s+id=["']app["']`),
		regexp.MustCompile(`(?i)<div\s+id=["']__next["']`),
		regexp.MustCompile(`(?i)<div\s+id=["']__nuxt["']`),
		regexp.MustCompile(`(?i)window\.__NEXT_DATA__`),
		regexp.MustCompile(`(?i)window\.__NUXT__`),
	}

	botChallengeRegexes = []*regexp.Regexp{
		regexp.MustCompile(`(?i)verify.*(?:human|robot|browser)`),
		regexp.MustCompile(`(?i)prove.*(?:human|your)`),
		regexp.MustCompile(`(?i)are\s*you\s*a?\s*(?:human|robot|bot)`),
		regexp.MustCompile(`(?i)complete\s*the\s*(?:action|challenge|captcha)`),
		regexp.MustCompile(`(?i)cf-browser-verification`),
		regexp.MustCompile(`(?i)challenge-platform`),
		regexp.MustCompile(`(?i)challenge-running`),
		regexp.MustCompile(`(?i)just\s*a\s*moment`),
		regexp.MustCompile(`(?i)checking\s*(?:.*?)?\s*(?:browser|connection|site)`),
		regexp.MustCompile(`(?i)please\s*wait.*redirect`),
		regexp.MustCompile(`(?i)access\s*denied`),
		regexp.MustCompile(`(?i)enable\s*javascript.*continue`),
		regexp.MustCompile(`(?i)please\s*enable\s*cookies`),
		regexp.MustCompile(`(?i)one\s*more\s*step`),
		regexp.MustCompile(`(?i)security\s*check`),
		regexp.MustCompile(`(?i)before\s*you\s*(?:proceed|continue)`),
		regexp.MustCompile(`(?i)blocked.*(?:firewall|security|waf)`),
		regexp.MustCompile(`(?i)turnstile`),
		regexp.MustCompile(`(?i)hcaptcha`),
		regexp.MustCompile(`(?i)recaptcha`),
	}
)

// StripHTMLTags removes script, style, and HTML tags, returning normalized plain text
func StripHTMLTags(html string) string {
	noScript := scriptRegex.ReplaceAllString(html, " ")
	noStyle := styleRegex.ReplaceAllString(noScript, " ")
	noTags := htmlTagRegex.ReplaceAllString(noStyle, " ")
	collapsed := whitespaceRegex.ReplaceAllString(noTags, " ")
	return strings.TrimSpace(collapsed)
}

// HasRealContent determines if HTML has meaningful content or is a shell/blocked page
func HasRealContent(html string, minLength int) bool {
	if minLength <= 0 {
		minLength = 200
	}

	stripped := StripHTMLTags(html)
	strippedLen := len(stripped)

	// Length check
	if strippedLen < minLength {
		return false
	}

	// Prepare raw HTML prefix for challenge/shell checks
	rawPrefix := html
	if len(rawPrefix) > 5000 {
		rawPrefix = rawPrefix[:5000]
	}

	// SPA shell detection: if shell detected and stripped text < 500 chars
	if strippedLen < 500 {
		// Client-rendered page: little visible text but large inline scripts holding the data
		scriptBytes := 0
		for _, s := range scriptRegex.FindAllString(html, -1) {
			scriptBytes += len(s)
		}
		if scriptBytes > 2000 && scriptBytes > strippedLen*10 {
			return false
		}

		for _, re := range spaShellRegexes {
			if re.MatchString(rawPrefix) || re.MatchString(stripped) {
				return false
			}
		}
	}

	// Bot challenge detection: if challenge indicators match and stripped text < 2000 chars
	if strippedLen < 2000 {
		for _, re := range botChallengeRegexes {
			if re.MatchString(rawPrefix) || re.MatchString(stripped) {
				return false
			}
		}
	}

	return true
}
