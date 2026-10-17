package picks

import "regexp"

// Results-filing detection, ported verbatim from
// scripts/take-writer/src/results-watch.ts (classifyResultsFiling). The
// regexes live there first; keep the two in step. Every case in
// filings_test.go is a real asx_announcements headline carried over from
// results-watch.test.ts.
//
// Headline-based on purpose, NEVER announcement_type: measured on prod
// 2026-08-24, 89% of 'earnings' rows were dividend notices and 4,106 Appendix
// 4D/4E rows were classified 'other'.
//
// Here a filing only re-orders the fundamentals queue: a code that just filed
// its 4D/4E is fetched first, whatever its last attempt, because that is when
// its growth numbers change (and Yahoo lags small caps by weeks, so it is
// re-asked daily while the filing is recent).

// filingKind mirrors the TypeScript FilingKind.
type filingKind string

const (
	filingAppendix4DE   filingKind = "appendix_4de"
	filingAnnualReport  filingKind = "annual_report"
	filingPeriodResults filingKind = "period_results"
)

// notAFiling: headlines that contain results language but are not a results
// release (scheduling notices, webinars, AGM outcomes, dividend admin).
var notAFiling = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bresults?\s+date\b`),
	regexp.MustCompile(`(?i)\bwebinar\b`),
	regexp.MustCompile(`(?i)\bto\s+present\b`),
	regexp.MustCompile(`(?i)\bconference\s+call\b`),
	regexp.MustCompile(`(?i)\bbriefing\s+(?:details|invitation)\b`),
	regexp.MustCompile(`(?i)\binvestor\s+(?:day|briefing)\b`),
	regexp.MustCompile(`(?i)^notice\s+of\b`),
	regexp.MustCompile(`(?i)\bnotice\s+of\s+(?:agm|meeting)\b`),
	regexp.MustCompile(`(?i)\bregistration\s+details\b`),
	regexp.MustCompile(`(?i)\bdial[-\s]?in\b`),
	regexp.MustCompile(`(?i)\bresults?\s+of\s+(?:the\s+)?(?:\d{4}\s+)?(?:annual\s+general\s+|general\s+|extraordinary\s+)?meeting\b`),
	regexp.MustCompile(`(?i)\btranscript\b`),
	regexp.MustCompile(`(?i)^(?:update\s*-\s*)?dividend/distribution\b`),
	regexp.MustCompile(`(?i)^confirmation of .*dividend`),
}

// filingPatterns: positive patterns, most specific first.
var filingPatterns = []struct {
	kind filingKind
	rx   *regexp.Regexp
}{
	{filingAppendix4DE, regexp.MustCompile(`(?i)\bappendix\s*4[de]\b`)},
	{filingAnnualReport, regexp.MustCompile(`(?i)\bannual\s+report\b`)},
	{filingPeriodResults, regexp.MustCompile(`(?i)\b(?:fy\s?\d{2,4}|hy\s?\d{2,4}|\d\s?h\s?\d{2,4}|full[-\s]?year|half[-\s]?year|half[-\s]?yearly|interim|preliminary\s+final)\b[^.]{0,40}\b(?:results?|financial\s+report|financial\s+statements?|report\s+and\s+accounts)\b`)},
	{filingPeriodResults, regexp.MustCompile(`(?i)\b(?:half[-\s]?yearly|yearly)\s+report\b`)},
	{filingPeriodResults, regexp.MustCompile(`(?i)\b(?:results?|financial\s+report)\b[^.]{0,30}\bfor\s+(?:the\s+)?(?:year|half[-\s]?year|period)\b`)},
}

// strongFiling: markers strong enough to override an exclusion ("FY26
// Financial Results Release and Webinar" is a real filing).
var strongFiling = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bappendix\s*4[de]\b`),
	regexp.MustCompile(`(?i)\bresults?\s+(?:release|announcement|summary)\b`),
	regexp.MustCompile(`(?i)\bfinancial\s+results?\s+(?:release|announcement|summary)\b`),
	regexp.MustCompile(`(?i)\bfinancial\s+report\s+for\b`),
}

// classifyResultsFiling returns the kind of results document a headline
// describes, or "" when it is not one (the common case).
func classifyResultsFiling(headline string) filingKind {
	if headline == "" {
		return ""
	}
	strong := false
	for _, rx := range strongFiling {
		if rx.MatchString(headline) {
			strong = true
			break
		}
	}
	if !strong {
		for _, rx := range notAFiling {
			if rx.MatchString(headline) {
				return ""
			}
		}
	}
	for _, p := range filingPatterns {
		if p.rx.MatchString(headline) {
			return p.kind
		}
	}
	return ""
}

// filingPrefilterSQL is the cheap Postgres over-selection the classifier then
// refines (the same split results-watch.ts uses: SQL narrows, the regexes
// decide). It is wider than the TypeScript prefilter on purpose: that one
// misses "Half Yearly Report and Accounts" (DroneShield's statutory half-year
// title) and "Appendix4E" written without a space.
const filingPrefilterSQL = `headline ~* '(appendix\s*4[de]|report|result)'`
