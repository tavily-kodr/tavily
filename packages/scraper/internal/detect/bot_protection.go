package detect

import (
	"regexp"
	"strings"

	"github.com/sujal/go-scraper/internal/types"
)

var genericChallengeRegex = regexp.MustCompile(`(?i)(challenge|verify.{0,20}human|are\s*you\s*a\s*robot|access\s*denied)`)

// DetectBotProtection scans HTML for signatures of common anti-bot / WAF providers
func DetectBotProtection(htmlStr string) types.BotProtection {
	lower := strings.ToLower(htmlStr)

	// Check Cloudflare
	if strings.Contains(lower, "cf-browser-verification") || strings.Contains(lower, "cloudflare") || strings.Contains(lower, "challenge-platform") {
		return types.BotProtection{HasProtection: true, Provider: "Cloudflare"}
	}

	// Check Akamai
	if strings.Contains(lower, "akamai") || strings.Contains(lower, "_abck") || strings.Contains(lower, "edgesuite.net") {
		return types.BotProtection{HasProtection: true, Provider: "Akamai"}
	}

	// Check DataDome
	if strings.Contains(lower, "datadome") {
		return types.BotProtection{HasProtection: true, Provider: "DataDome"}
	}

	// Check PerimeterX
	if strings.Contains(lower, "perimeterx") || strings.Contains(lower, "px-captcha") {
		return types.BotProtection{HasProtection: true, Provider: "PerimeterX"}
	}

	// Check CAPTCHA
	if strings.Contains(lower, "recaptcha") || strings.Contains(lower, "hcaptcha") || strings.Contains(lower, "turnstile") {
		return types.BotProtection{HasProtection: true, Provider: "CAPTCHA"}
	}

	// Check Generic challenge / block
	if genericChallengeRegex.MatchString(htmlStr) {
		return types.BotProtection{HasProtection: true, Provider: "Generic"}
	}

	return types.BotProtection{HasProtection: false, Provider: ""}
}
