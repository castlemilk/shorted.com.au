package instrument

import "regexp"

// ETPFundTypes are the ownership_funds fund types that make a listed code an
// exchange-traded product: the ETP set is the codes with one of these types and
// an asx_code. The set is the caller's to read; this package takes it as input.
var ETPFundTypes = []string{"etf", "lic"}

// Reasons a code is outside the ordinary, fresh universe on a session. They are
// the snapshot's ineligible_reason values that this package decides.
const (
	ReasonNoBarOnSession        = "no_bar_on_session"
	ReasonExchangeTradedProduct = "exchange_traded_product"
	ReasonDebtOrHybrid          = "debt_or_hybrid"
	ReasonSecondaryLine         = "secondary_line"
)

// etpNamePattern matches a company name that names an exchange-traded product.
var etpNamePattern = regexp.MustCompile(`(?i)\b(etf|etp|managed fund|exchange traded)\b`)

// IsOrdinary reports whether a code is an ordinary share, from the ETP set and
// the names the two sources carry. It does not look at whether the code traded
// on a session; IneligibleReason does that as well.
//
// A code in etpSet is never ordinary. A code that appeared in an ASIC report
// (asicProduct is set) is ordinary when ClassifySecurity calls it so, using
// its shares on issue. Any other code is ordinary when it has at most four
// characters and its company name does not name an ETP. A code with no name
// from either source is ordinary only when it has three characters; that
// fallback is counted as unclassified (see Unclassified).
func IsOrdinary(code, asicProduct, companyName string, shares float64, etpSet map[string]bool) bool {
	return IneligibleReason(code, asicProduct, companyName, shares, etpSet, true) == ""
}

// IneligibleReason returns why a code is outside the ordinary, fresh universe
// on a session, or "" when it is in. barOnSession is whether the code has a bar
// dated on the session with a positive close: a code without one is stale.
// Ineligible codes are still written to the snapshot with this reason, so the
// stock page can say why.
func IneligibleReason(code, asicProduct, companyName string, shares float64, etpSet map[string]bool, barOnSession bool) string {
	if !barOnSession {
		return ReasonNoBarOnSession
	}
	if etpSet[code] {
		return ReasonExchangeTradedProduct
	}
	if asicProduct != "" {
		switch ClassifySecurity(asicProduct, code, shares) {
		case SecurityTypeOrdinary:
			return ""
		case SecurityTypeETF:
			return ReasonExchangeTradedProduct
		case SecurityTypeDebt:
			return ReasonDebtOrHybrid
		default:
			return ReasonSecondaryLine
		}
	}
	if companyName == "" {
		// A nameless code of another length is most often a secondary line, the
		// case rule 3 below applies to every named code.
		if len(code) == 3 {
			return ""
		}
		return ReasonSecondaryLine
	}
	if len(code) > 4 {
		return ReasonSecondaryLine
	}
	if etpNamePattern.MatchString(companyName) {
		return ReasonExchangeTradedProduct
	}
	return ""
}

// Unclassified reports whether a code is included only on its length: it has
// no name from either source, so it is counted as unclassified in the
// diagnostics of the run that includes it.
func Unclassified(code, asicProduct, companyName string) bool {
	return asicProduct == "" && companyName == "" && len(code) == 3
}
