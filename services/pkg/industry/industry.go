// Package industry is the Go side of two web helpers: the URL slug of a GICS
// industry name and the placeholder industries that are not industries at all.
// The API canonicalises alert targets with it, and the alerts evaluator matches
// companies to a target with it, so both must agree with the web.
//
// Ported from web/src/@/lib/industry-slug.ts (createSlug) and
// web/src/@/lib/industry-placeholder.ts (industryLabel, isPlaceholderIndustrySlug).
package industry

import "strings"

// placeholders are the industry names the ASX uses for "none": a security it
// does not classify, an ETF or trust, or a classification still pending.
var placeholders = map[string]struct{}{
	"not applic":     {},
	"not applicable": {},
	"class pend":     {},
	"other":          {},
}

// Slug is createSlug: lower case, every run of characters outside [a-z0-9]
// becomes one "-", and leading and trailing "-" are trimmed.
//
// Non-ASCII letters fall outside [a-z0-9] and become "-", as they do on the web.
// The web lower-cases with the JavaScript rules, which differ from Go's only for
// a few characters (such as "İ") that no ASX industry name contains.
func Slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// IsPlaceholder reports whether name is not an industry: blank, or one of the
// placeholder names, matched whole and in any case. "Not Applic Holdings" is an
// industry; "Not Applic" is not.
func IsPlaceholder(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "" {
		return true
	}
	_, ok := placeholders[n]
	return ok
}

// IsPlaceholderSlug is IsPlaceholder for a caller that holds only a Slug. An empty
// slug is a placeholder, as it is on the web.
func IsPlaceholderSlug(slug string) bool {
	if slug == "" {
		return true
	}
	for name := range placeholders {
		if Slug(name) == slug {
			return true
		}
	}
	return false
}
