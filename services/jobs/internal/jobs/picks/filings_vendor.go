package picks

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// The vendor context the filing gates read (plan fundamentals-coverage.md
// §4.2 gates 4, 6, 7, 8 and 9): a code's vendor rows, its balance month and
// its reporting currency, all taken from the VENDOR rows. The June balance
// date and the AUD currency the ingest used to assume for a company with no
// vendor rows are gone: without vendor context there are no filing rows
// (skipped_no_vendor), because every cross-check below needs a reference.

// vendorRow is one non-filing stock_fundamentals row (annual or ttm; quarter
// balance snapshots are not read) as the filing gates see it.
type vendorRow struct {
	// PeriodType is periodAnnual or periodTTM; "" reads as annual (the
	// phase-0 test fixtures predate the field).
	PeriodType string
	PeriodEnd  time.Time
	Currency   string
	Source     string
	Revenue    *float64
	NetIncome  *float64
	EPSBasic   *float64
	EPSDiluted *float64
	Shares     *float64
	// FieldSources is the row's field_sources (nil before 000132). A value
	// marked asx-filing-extraction was filled FROM a filing, so it is never a
	// vendor reference for one.
	FieldSources map[string]string
	// FXConverted / NativeCurrency are the code's persisted FX verdict
	// (stock_fundamentals_sync.fx_converted / native_currency, plan §2.3):
	// the same fact valuation withholds P/E and P/B on. The same on every
	// row of a code; false / "" when unmeasured or before the columns exist.
	FXConverted    bool
	NativeCurrency string
}

// vendorAnnual is vendorRow's phase-0 name. It stays an alias so the shared
// test fake (fundamentals_test.go, vendor stream) compiles unchanged.
type vendorAnnual = vendorRow

func (v vendorRow) periodType() string {
	if v.PeriodType == "" {
		return periodAnnual
	}
	return v.PeriodType
}

// own returns x unless field_sources marks column col as filing-filled.
func (v vendorRow) own(col string, x *float64) *float64 {
	if x == nil || v.FieldSources[col] == sourceFiling {
		return nil
	}
	return x
}

func (v vendorRow) revenue() *float64    { return v.own("revenue", v.Revenue) }
func (v vendorRow) netIncome() *float64  { return v.own("net_income", v.NetIncome) }
func (v vendorRow) epsBasic() *float64   { return v.own("eps_basic", v.EPSBasic) }
func (v vendorRow) epsDiluted() *float64 { return v.own("eps_diluted", v.EPSDiluted) }

// vendorContext is one code's vendor context.
type vendorContext struct {
	annual []vendorRow // sorted by period_end ascending
	ttm    []vendorRow // sorted by period_end ascending
	// currency is the vendor reporting currency every filing value must be in
	// (gate 7); "" when it cannot be trusted (fxNote says why).
	currency string
	fxNote   string
	// fye is the balance-date month, from the latest vendor annual row.
	fye time.Month
}

func newVendorContext(rows []vendorRow) vendorContext {
	var vc vendorContext
	for _, r := range rows {
		if r.Source == sourceFiling || r.PeriodEnd.IsZero() {
			continue
		}
		switch r.periodType() {
		case periodAnnual:
			vc.annual = append(vc.annual, r)
		case periodTTM:
			vc.ttm = append(vc.ttm, r)
		}
	}
	byEnd := func(s []vendorRow) {
		sort.SliceStable(s, func(i, j int) bool { return s[i].PeriodEnd.Before(s[j].PeriodEnd) })
	}
	byEnd(vc.annual)
	byEnd(vc.ttm)
	if n := len(vc.annual); n > 0 {
		vc.fye = vc.annual[n-1].PeriodEnd.AddDate(0, 0, effectiveMonthShift).Month()
	}
	vc.currency, vc.fxNote = resolveVendorCurrency(append(append([]vendorRow(nil), vc.annual...), vc.ttm...))
	return vc
}

func (vc vendorContext) hasAnnual() bool { return len(vc.annual) > 0 }

// fxFraction: a monetary value in whole currency units with a fractional part
// above this was converted from another currency (plan §3.4).
const fxFraction = 0.001

// currencyWindowYears: currencies of vendor rows older than this relative to
// the code's latest vendor row do not count as "mixed" (a reporting currency
// changed years ago is history, not ambiguity).
const currencyWindowYears = 2

// resolveVendorCurrency decides the currency a filing value must be in, from
// the vendor rows' own state (plan §3.4, §4.2 gates 6-7).
//
// The vendor stream decides fx_converted when it fetches (a monetary raw value
// with a fractional part rejects that code's monetary fields) and persists it
// on the sync row with Markit's native currency. A persisted verdict decides
// first: the persisted native currency, else a Markit row's currency, else
// unknown (no filing rows). Otherwise the state is re-derived from the rows, erring towards
// "unknown", which also catches rows written before the vendor gate existed:
//
//   - any non-Markit vendor row carries a fractional revenue or net income
//     (a value written before the vendor gate existed): fx_converted;
//   - the non-Markit rows of the last two years carry more than one currency:
//     mixed, ambiguous;
//   - non-Markit rows exist but none carries a revenue or net income of its
//     own (the vendor gate rejected them, or the vendor only publishes EPS):
//     the currency label cannot be checked against a figure.
//
// In each of those cases the Markit row's currency (curCode, the native
// currency) is used when a Markit row exists; otherwise the currency is
// unknown and the code gets no filing rows. With no non-Markit rows at all,
// Markit's currency is the currency.
func resolveVendorCurrency(rows []vendorRow) (currency, note string) {
	persistedFX := false
	for _, r := range rows {
		if !r.FXConverted {
			continue
		}
		if native := strings.ToUpper(strings.TrimSpace(r.NativeCurrency)); native != "" {
			return native, "fx_converted (persisted); the native currency used"
		}
		persistedFX = true
	}
	var markitCur string
	var markitEnd time.Time
	var others []vendorRow
	for _, r := range rows {
		if r.Source == sourceMarkit {
			if r.Currency != "" && !r.PeriodEnd.Before(markitEnd) {
				markitCur, markitEnd = r.Currency, r.PeriodEnd
			}
			continue
		}
		others = append(others, r)
	}
	if persistedFX {
		if markitCur != "" {
			return markitCur, "fx_converted (persisted); Markit's native currency used"
		}
		return "", "fx_converted (persisted), native currency unknown"
	}
	if len(others) == 0 {
		if markitCur == "" {
			return "", "no vendor currency"
		}
		return markitCur, ""
	}
	var latest time.Time
	for _, r := range others {
		if r.PeriodEnd.After(latest) {
			latest = r.PeriodEnd
		}
	}
	window := latest.AddDate(-currencyWindowYears, 0, 0)
	currencies := map[string]bool{}
	fx, anyMonetary := false, false
	for _, r := range others {
		if !r.PeriodEnd.Before(window) && r.Currency != "" {
			currencies[r.Currency] = true
		}
		for _, v := range []*float64{r.revenue(), r.netIncome()} {
			if v == nil {
				continue
			}
			anyMonetary = true
			if math.Abs(*v-math.Round(*v)) > fxFraction {
				fx = true
			}
		}
	}
	switch {
	case fx:
		note = "fx_converted (fractional vendor monetary values)"
	case len(currencies) > 1:
		note = "mixed vendor currencies"
	case !anyMonetary:
		note = "no vendor monetary value to check the currency label against"
	case len(currencies) == 0:
		note = "no vendor currency"
	default:
		for c := range currencies {
			return c, ""
		}
	}
	if markitCur != "" {
		return markitCur, note + "; Markit's native currency used"
	}
	return "", note
}

// monthEndOffset is the month end n months after the month end e (n may be
// negative).
func monthEndOffset(e time.Time, n int) time.Time {
	first := time.Date(e.Year(), e.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, n, 0)
	return lastDayOfMonth(first.Year(), first.Month())
}

// at finds the row in s whose canonical month end is end and whose currency is
// currency.
func at(s []vendorRow, end time.Time, currency string) *vendorRow {
	end = canonicalMonthEnd(end)
	for i := len(s) - 1; i >= 0; i-- {
		if s[i].Currency == currency && canonicalMonthEnd(s[i].PeriodEnd).Equal(end) {
			return &s[i]
		}
	}
	return nil
}

func positive(v *float64) (float64, bool) {
	if v == nil || *v <= 0 {
		return 0, false
	}
	return *v, true
}

// revenueBand is gate 8's revenue reference: [lo, hi] x ref.
type revenueBand struct {
	ref, lo, hi float64
	basis       string
}

func (b revenueBand) contains(v float64) bool { return v >= b.lo*b.ref && v <= b.hi*b.ref }

// upper is the largest revenue the band admits.
func (b revenueBand) upper() float64 { return b.hi * b.ref }

// revenueBand is gate 8's revenue reference for a filing row (plan §4.2):
//
//	half:   [0.25, 0.75] of vendor TTM revenue at the same end, else of the
//	        containing FY's vendor annual, else [0.15, 1.5] of the prior FY's;
//	annual: [0.7, 1.4] of the same-FY vendor annual, else [0.5, 2.5] of the
//	        prior FY's.
//
// Same currency, value > 0, the vendor's own value (never filing-filled).
// false when no reference exists: the revenue is then withheld.
func (vc vendorContext) revenueBand(typ string, end time.Time, currency string) (revenueBand, bool) {
	end = canonicalMonthEnd(end)
	annualRev := func(e time.Time) (float64, bool) {
		if r := at(vc.annual, e, currency); r != nil {
			return positive(r.revenue())
		}
		return 0, false
	}
	switch typ {
	case periodHalf:
		if r := at(vc.ttm, end, currency); r != nil {
			if v, ok := positive(r.revenue()); ok {
				return revenueBand{v, 0.25, 0.75, "ttm at the same end"}, true
			}
		}
		containing := end
		if vc.fye != 0 && end.Month() != vc.fye {
			containing = monthEndOffset(end, 6)
		}
		if v, ok := annualRev(containing); ok {
			return revenueBand{v, 0.25, 0.75, "containing FY"}, true
		}
		if v, ok := annualRev(monthEndOffset(containing, -12)); ok {
			return revenueBand{v, 0.15, 1.5, "prior FY"}, true
		}
	case periodAnnual:
		if v, ok := annualRev(end); ok {
			return revenueBand{v, 0.7, 1.4, "same FY"}, true
		}
		if v, ok := annualRev(monthEndOffset(end, -12)); ok {
			return revenueBand{v, 0.5, 2.5, "prior FY"}, true
		}
	}
	return revenueBand{}, false
}

// sharesMaxGap: a vendor share count further than this from the period end is
// not a reference for its EPS.
const sharesMaxGap = 18 * 31 * 24 * time.Hour

// sharesNear is the vendor share count dated closest to end (annual or ttm),
// within 18 months; 0 when none.
func (vc vendorContext) sharesNear(end time.Time) float64 {
	best, bestGap := 0.0, time.Duration(math.MaxInt64)
	for _, s := range [][]vendorRow{vc.annual, vc.ttm} {
		for _, r := range s {
			v, ok := positive(r.Shares)
			if !ok {
				continue
			}
			gap := r.PeriodEnd.Sub(end)
			if gap < 0 {
				gap = -gap
			}
			if gap <= sharesMaxGap && gap < bestGap {
				best, bestGap = v, gap
			}
		}
	}
	return best
}

// annualNetIncome is the vendor's own net income for the annual period ending
// at end, same currency.
func (vc vendorContext) annualNetIncome(end time.Time, currency string) *float64 {
	if r := at(vc.annual, end, currency); r != nil {
		return r.netIncome()
	}
	return nil
}

// snapToVendorAnnual moves an annual filing date onto the vendor's date for
// the same year when they are within ten days (a 52/53-week year Yahoo dates
// 2 July), so the conflict policy sees one period, not two.
func (vc vendorContext) snapToVendorAnnual(end time.Time) time.Time {
	for _, r := range vc.annual {
		d := r.PeriodEnd.Sub(end)
		if d < 0 {
			d = -d
		}
		if d <= 10*24*time.Hour {
			return r.PeriodEnd
		}
	}
	return end
}

// companyProfile is what "company-metadata" says about a code: the name gate
// 1 matches document_meta.entity against, and the industry gate 8 reads.
type companyProfile struct {
	Name     string
	Industry string
}

// niCheckExemptIndustries: GICS industry groups whose profit can legitimately
// exceed revenue (REITs and property developers book revaluations through
// profit; listed investment companies book fair-value gains), so gate 8's
// "|net income| <= 1.5 x revenue" does not run for them. "Diversified
// Financials" is the pre-2023 name of "Financial Services".
var niCheckExemptIndustries = map[string]bool{
	"Equity Real Estate Investment Trusts (REITs)": true,
	"Real Estate Management & Development":         true,
	"Financial Services":                           true,
	"Diversified Financials":                       true,
}

// entityStopTokens carry no identity: legal forms and connectives.
var entityStopTokens = map[string]bool{
	"limited": true, "ltd": true, "plc": true, "inc": true, "incorporated": true,
	"corporation": true, "corp": true, "co": true, "company": true, "nl": true,
	"pty": true, "the": true, "of": true, "and": true, "group": true,
	"holdings": true, "holding": true, "trust": true, "fund": true, "fpo": true,
	"stapled": true, "securities": true, "abn": true,
}

// entityGenericTokens identify an industry, not a company: a shared generic
// token alone is not a match ("Quokka Minerals" is not "Northern Minerals").
var entityGenericTokens = map[string]bool{
	"australia": true, "australian": true, "resources": true, "energy": true,
	"minerals": true, "mining": true, "metals": true, "gold": true,
	"lithium": true, "oil": true, "gas": true, "capital": true,
	"technologies": true, "technology": true, "tech": true, "health": true,
	"healthcare": true, "international": true, "global": true, "pacific": true,
	"investments": true, "investment": true, "property": true,
	"properties": true, "industries": true, "bank": true, "financial": true,
	"services": true, "solutions": true, "systems": true, "exploration": true,
	"asia": true, "new": true, "zealand": true,
}

var entityTokenSplit = regexp.MustCompile(`[^a-z0-9]+`)

// entityTokens is a name's identifying token set: Normalise (curly quotes,
// case), apostrophes removed ("Domino's" -> "dominos"), split on anything not
// alphanumeric, stop tokens dropped.
func entityTokens(name string) map[string]bool {
	n := strings.ReplaceAll(extractiontrust.Normalise(name), "'", "")
	out := map[string]bool{}
	for _, t := range entityTokenSplit.Split(n, -1) {
		if t != "" && !entityStopTokens[t] {
			out[t] = true
		}
	}
	return out
}

// entityMatches is gate 1's company check (plan §4.2: "normalised token
// overlap") between document_meta.entity and the code's company name. It
// matches when the two share a token that is not merely an industry word AND
// the shared tokens are a strict majority of the smaller name's tokens. A
// name with no identifying token never matches (withhold rather than guess).
//
//	"BHP Group Limited" / "BHP GROUP LIMITED"               match
//	"Fortescue Ltd" / "FORTESCUE METALS GROUP LTD"          match
//	"Winsome Resources Limited" / "Lifestyle Communities"   no match
//	"Star Entertainment" / "Northern Star Resources"        no match (1 of 2)
func entityMatches(entity, company string) bool {
	a, b := entityTokens(entity), entityTokens(company)
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	shared, distinctive := 0, false
	for t := range a {
		if b[t] {
			shared++
			if !entityGenericTokens[t] {
				distinctive = true
			}
		}
	}
	smaller := len(a)
	if len(b) < smaller {
		smaller = len(b)
	}
	return distinctive && shared*2 > smaller
}
