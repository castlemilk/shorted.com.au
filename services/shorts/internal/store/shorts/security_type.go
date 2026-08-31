package shorts

import (
	"regexp"
	"strings"
)

// SecurityType is a coarse instrument classification.
//
// Short interest is reported as a percent of "shares on issue", but that
// quantity does not mean the same thing across instrument types. A warrant, an
// ETF unit and a bond line all have a denominator, and dividing by it produces
// a number that looks exactly like an ordinary share's short percentage and is
// not comparable to one. The visible symptom is a position over 100% —
// GSBW34 at 132.54%, UYLD at 102.61%, ATBHQ at 100% — but those are only the
// tip: the real problem is the ETF sitting at a plausible single digit,
// indistinguishable from an ordinary share in the response.
type SecurityType string

const (
	SecurityTypeOrdinary SecurityType = "ordinary"
	SecurityTypeETF      SecurityType = "etf"
	SecurityTypeDebt     SecurityType = "debt"  // bonds, notes, hybrids — named by coupon
	SecurityTypeOther    SecurityType = "other" // secondary lines, deferred settlement, micro-instruments
)

var (
	// "ETF" as a whole word: an ETF unit line names itself.
	etfPattern = regexp.MustCompile(`(?i)ETF\b`)
	// A coupon in the product name — "4.35%", "3%" — marks a bond or note.
	couponPattern = regexp.MustCompile(`[0-9]+(\.[0-9]+)?\s*%`)
)

// minOrdinarySharesOnIssue is the floor below which a "percent of shares on
// issue" stops being meaningful. Every ordinary ASX listing has well over 5M
// shares on issue; the instruments that do not are the ones whose tiny
// denominators produce percentages like 102% from 51,303 units over 50,000.
const minOrdinarySharesOnIssue = 5_000_000

// ClassifySecurity labels an instrument from its ASIC product name, code and
// shares on issue.
//
// These are exactly the rules migration 000043 applies when building
// mv_top_shorts, mv_screener_data and mv_treemap_data, which is the point:
// list_top_shorts already told callers "ETFs, bonds and non-equity instruments
// are excluded" while GetMarketByDate returned everything, so the two
// endpoints answered "what is the ASX universe" differently and only one said
// so. A caller could only discover the difference by noticing a warrant at
// 132% short.
//
// It is derived from naming and code shape, not from an authoritative
// instrument register — we do not hold one. It is deliberately coarse for that
// reason: it distinguishes what can be distinguished reliably rather than
// guessing at warrant-versus-stapled, which the data does not support.
func ClassifySecurity(productName, productCode string, sharesOnIssue float64) SecurityType {
	name := strings.TrimSpace(productName)

	if etfPattern.MatchString(name) {
		return SecurityTypeETF
	}
	if couponPattern.MatchString(name) {
		return SecurityTypeDebt
	}
	// 5-6 character codes are interest-rate securities, hybrids and secondary
	// lines (ATBHQ, NWSLV, GSBW34). An ordinary ASX listing is 3-4 characters.
	if len(strings.TrimSpace(productCode)) > 4 {
		return SecurityTypeOther
	}
	if strings.Contains(strings.ToUpper(name), "DEFERRED") {
		return SecurityTypeOther
	}
	// A denominator this small cannot produce a comparable percentage. Unknown
	// (0) is left alone: absent data is not evidence of a micro-instrument.
	if sharesOnIssue > 0 && sharesOnIssue < minOrdinarySharesOnIssue {
		return SecurityTypeOther
	}
	return SecurityTypeOrdinary
}

// IsOrdinary reports whether an instrument is an ordinary share line, i.e. one
// whose short percentage is comparable with other ordinary shares.
func IsOrdinary(productName, productCode string, sharesOnIssue float64) bool {
	return ClassifySecurity(productName, productCode, sharesOnIssue) == SecurityTypeOrdinary
}
