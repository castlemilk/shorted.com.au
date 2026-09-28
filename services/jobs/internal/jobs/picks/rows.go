package picks

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Storable magnitude bounds, identical to the table's
// stock_fundamentals_finite_check (000129, the original seven columns) and
// stock_fundamentals_finite_check_v2 (000132, every column it adds). A value is
// stored when it is zero or finite with 1e-12 <= |v| <= 1e18. NaN and ±Inf
// fail (the key_metrics incident: encoding/json refuses ±Inf and took MCP down
// with it); so do denormal-scale values, which no statement line has and which
// are the only way a growth ratio in mv_fundamentals_growth could overflow.
const (
	minStorableAbs = 1e-12
	maxStorableAbs = 1e18
)

// storable is the write funnel's value check, one rule for EVERY column in
// fundamentalsColumns (sanitizeRows applies it to each). The DB CHECKs are the
// backstop; this keeps a real write from ever tripping one (which would fail
// the whole multi-row upsert for the code).
func storable(v float64) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return false
	}
	if v == 0 {
		return true
	}
	a := math.Abs(v)
	return a >= minStorableAbs && a <= maxStorableAbs
}

var currencyRe = regexp.MustCompile(`^[A-Z]{3,8}$`)

// ---------------------------------------------------------------------------
// PeriodRow helpers: the Rejected mask and the FieldSources exceptions.

// isRejected reports whether a gate refused col for this period.
func (r *PeriodRow) isRejected(col string) bool {
	for _, c := range r.Rejected {
		if c == col {
			return true
		}
	}
	return false
}

// reject nulls col, names it in Rejected (once) and drops any FieldSources
// entry for it: the vendor upsert then writes NULL for it instead of keeping a
// stored value (plan §2.2 rule 2).
func (r *PeriodRow) reject(col string) {
	if c, ok := columnNamed(col); ok {
		c.set(r, nil)
	}
	if r.FieldSources != nil {
		delete(r.FieldSources, col)
	}
	if !r.isRejected(col) {
		r.Rejected = append(r.Rejected, col)
	}
}

// unreject removes col from Rejected: an INDEPENDENT source has supplied the
// value the gate refused from the row's own source (mergeFallback).
func (r *PeriodRow) unreject(col string) {
	out := r.Rejected[:0:0]
	for _, c := range r.Rejected {
		if c != col {
			out = append(out, c)
		}
	}
	r.Rejected = out
	if len(r.Rejected) == 0 {
		r.Rejected = nil
	}
}

// markSource records that col's value came from src, not from the row's
// Source (§2.2: FieldSources holds exceptions only).
func (r *PeriodRow) markSource(col, src string) {
	if src == r.Source {
		if r.FieldSources != nil {
			delete(r.FieldSources, col)
		}
		return
	}
	if r.FieldSources == nil {
		r.FieldSources = map[string]string{}
	}
	r.FieldSources[col] = src
}

// clone copies r deeply enough that the fills can mutate the copy: the value
// pointers are replaced (never written through), the map and slice are
// copied.
func (r PeriodRow) clone() PeriodRow {
	if r.FieldSources != nil {
		fs := make(map[string]string, len(r.FieldSources))
		for k, v := range r.FieldSources {
			fs[k] = v
		}
		r.FieldSources = fs
	}
	if r.Rejected != nil {
		r.Rejected = append([]string(nil), r.Rejected...)
	}
	return r
}

// ---------------------------------------------------------------------------
// The write funnel.

// sanitizeRows is the last step before a write:
//   - a row is dropped when its period type is not one this job writes
//     ('half' only from the filing source, 'quarter' only from a vendor), its
//     currency is not a plausible code, it has no period end, or nothing
//     survives (no value and no Rejected mask to deliver);
//   - a 'quarter' snapshot keeps its balance lines only;
//   - a Rejected column is NULL;
//   - every non-storable value, in any column of fundamentalsColumns, is set
//     to NULL and counted; on a vendor row it is also named in Rejected, so
//     the stored value is nulled rather than kept (principles: a vendor value
//     that fails a check is actively nulled);
//   - FieldSources keeps only the entries of values that are still present.
//
// The input slice is not mutated.
func sanitizeRows(rows []PeriodRow) (out []PeriodRow, rejectedValues int) {
	out = make([]PeriodRow, 0, len(rows))
	for _, in := range rows {
		switch {
		case in.PeriodType == periodAnnual || in.PeriodType == periodTTM:
		case in.PeriodType == periodHalf && in.Source == sourceFiling:
			// Half rows come only from filings; a vendor claiming one is a
			// parser bug, not data.
		case in.PeriodType == periodQuarter && in.Source != sourceFiling && in.Source != "":
			// Balance snapshots come only from a vendor's quarterly series.
		default:
			continue
		}
		if in.PeriodEnd.IsZero() || !currencyRe.MatchString(in.Currency) || in.Source == "" {
			continue
		}
		r := in.clone()
		for _, c := range fundamentalsColumns {
			v := c.get(&r)
			switch {
			case v == nil:
			case r.PeriodType == periodQuarter && c.isFlow():
				c.set(&r, nil)
			case r.isRejected(c.name):
				c.set(&r, nil)
			case !storable(*v):
				c.set(&r, nil)
				rejectedValues++
				if r.Source != sourceFiling {
					r.reject(c.name)
				}
			}
		}
		if len(r.FieldSources) > 0 {
			kept := map[string]string{}
			for col, src := range r.FieldSources {
				if c, ok := columnNamed(col); ok && c.get(&r) != nil && src != "" && src != r.Source {
					kept[col] = src
				}
			}
			r.FieldSources = kept
			if len(kept) == 0 {
				r.FieldSources = nil
			}
		}
		if !r.hasValues() && len(r.Rejected) == 0 {
			continue
		}
		out = append(out, r)
	}
	return out, rejectedValues
}

// ---------------------------------------------------------------------------
// Sanity gates (plan fundamentals-coverage.md §3.4, §3.5). Every rejection is
// counted by reason, logged per code and named in the row's Rejected mask.

// Gate reasons, as they appear in the run summary and the per-code log.
const (
	gateCurrencyConflict  = "currency_conflict"   // a monetary point in another currency than its row (§3.4)
	gateFXConverted       = "fx_converted"        // fractional monetary values: Yahoo converted the statements (§3.4)
	gateStrayTTM          = "stray_ttm"           // a TTM row older than the latest annual end minus 18 months (§3.5)
	gateEPSSignMismatch   = "eps_sign_mismatch"   // basic and diluted EPS of opposite signs (§3.5)
	gateSignViolation     = "sign_violation"      // capex, dividends paid or buybacks > 0 (§3.5)
	gateNonPositiveAssets = "non_positive_assets" // total_assets <= 0 (§3.5)
	gateScaleBreak        = "scale_break"         // a level line below 1/20 of both neighbours (§3.5)
	gateIdentityOutlier   = "identity_outlier"    // k off the code's median k by more than 3x (§3.5)
)

const (
	// fxFractionTolerance: a monetary line is reported in whole currency
	// units, so its raw value is integral. Float noise on Yahoo's side shows
	// as 1e-4 (CSL's 38021999999.9999); a converted value has a real fraction
	// (XRO's 139609739.8266).
	fxFractionTolerance = 0.001
	// strayTTMMonths: a TTM point this far behind the latest annual end is a
	// leftover (BHP and LTR carry 2020/2022 trailing points beside FY26).
	strayTTMMonths = 18
	// scaleBreakFactor: a unit slip (IAG FY25 revenue 5.35m against ~14bn
	// either side) is three orders of magnitude; 20x is far from any real
	// one-period move of a level line.
	scaleBreakFactor = 20
	// identityMinPeriods / identityTolerance: k = NI / (EPS x shares) needs
	// three periods for a median worth trusting; a period off it by more than
	// 3x is a unit or scale error, not a business event.
	identityMinPeriods = 3
	identityTolerance  = 3.0
	// sameFYWindow: two period ends within a week are the same balance date
	// (52/53-week years: Markit dates LOV's FY26 28 June, Yahoo 30 June).
	sameFYWindow = 7 * 24 * time.Hour
)

// scaleBreakColumns are the LEVEL lines the scale-break gate reads. The plan
// (§3.5) says "a monetary value"; read literally over every series it rejects
// real periods, because flows that are legitimately near zero or lumpy
// collapse 20x in one year and recover: LTR's FY25 buyback was $5,000 between
// $11.2m and $9.7m, a dividend skipped for a year, a breakeven profit, cash
// run down before a raise. A unit slip, the defect the gate exists for, moves
// the whole statement at once, and these lines show it without those false
// positives. A break in any of them rejects ALL of the period's monetary
// fields, exactly as the plan says.
var scaleBreakColumns = []string{
	"revenue", "gross_profit",
	"total_assets", "total_liabilities", "current_assets", "current_liabilities",
}

// gateReport is one code's gate outcome.
type gateReport struct {
	counts map[string]int
	// fxConverted: the code's Yahoo statements are FX-converted (§3.4); every
	// monetary field was rejected.
	fxConverted bool
	// medianK is the identity-gate reference, persisted to
	// stock_fundamentals_sync.median_k (§2.3). nil when fewer than
	// identityMinPeriods periods allow it.
	medianK  *float64
	kPeriods int
}

func (g *gateReport) add(reason string, n int) {
	if n <= 0 {
		return
	}
	if g.counts == nil {
		g.counts = map[string]int{}
	}
	g.counts[reason] += n
}

func (g gateReport) total() int {
	n := 0
	for _, v := range g.counts {
		n += v
	}
	return n
}

// String renders the counts in a stable order ("identity_outlier=1 ...").
func (g gateReport) String() string {
	keys := make([]string, 0, len(g.counts))
	for k := range g.counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + strconv.Itoa(g.counts[k])
	}
	return strings.Join(parts, " ")
}

// applyVendorGates runs the §3.4/§3.5 gates over one code's vendor rows (the
// parsed Yahoo rows, before any fill). It returns the surviving rows (stray
// TTM rows removed) and the report. Rejections null the value AND name it in
// Rejected; nothing is guessed back later in the pipeline (every fill skips a
// Rejected field).
//
// Order matters only for counting: fx first (it rejects every monetary field,
// so the others find nothing monetary to act on), then the row-local rules,
// then the cross-period ones.
func applyVendorGates(in []PeriodRow) ([]PeriodRow, gateReport) {
	var rep gateReport
	rows := make([]PeriodRow, len(in))
	for i := range in {
		rows[i] = in[i].clone()
		// The parser already refused monetary points in a foreign currency.
		rep.add(gateCurrencyConflict, len(rows[i].Rejected))
	}

	// FX-converted (§3.4): one fractional monetary value marks the code.
	for i := 0; i < len(rows) && !rep.fxConverted; i++ {
		for _, c := range fundamentalsColumns {
			if v := c.get(&rows[i]); c.isMonetary() && v != nil && math.Abs(*v-math.Round(*v)) > fxFractionTolerance {
				rep.fxConverted = true
				break
			}
		}
	}
	if rep.fxConverted {
		rep.add(gateFXConverted, 1)
		for i := range rows {
			for _, c := range fundamentalsColumns {
				if c.isMonetary() {
					// Every monetary column, present or not: a value kept
					// from an earlier run was converted too.
					rows[i].reject(c.name)
				}
			}
		}
	}

	// Stray TTM (§3.5).
	var latestAnnual time.Time
	for _, r := range rows {
		if r.PeriodType == periodAnnual && r.PeriodEnd.After(latestAnnual) {
			latestAnnual = r.PeriodEnd
		}
	}
	if !latestAnnual.IsZero() {
		cutoff := latestAnnual.AddDate(0, -strayTTMMonths, 0)
		kept := rows[:0]
		for _, r := range rows {
			if r.PeriodType == periodTTM && r.PeriodEnd.Before(cutoff) {
				rep.add(gateStrayTTM, 1)
				continue
			}
			kept = append(kept, r)
		}
		rows = kept
	}

	// Row-local sign rules (§3.5).
	for i := range rows {
		r := &rows[i]
		if r.EPSBasic != nil && r.EPSDiluted != nil && (*r.EPSBasic)*(*r.EPSDiluted) < 0 {
			r.reject("eps_basic")
			r.reject("eps_diluted")
			rep.add(gateEPSSignMismatch, 1)
		}
		for _, c := range fundamentalsColumns {
			if v := c.get(r); c.nonPositive && v != nil && *v > 0 {
				r.reject(c.name)
				rep.add(gateSignViolation, 1)
			}
		}
	}

	// total_assets <= 0 rejects the period's balance fields (§3.5). The share
	// count is not a balance-sheet line and stays.
	var badAssets []time.Time
	for _, r := range rows {
		if r.TotalAssets != nil && *r.TotalAssets <= 0 {
			badAssets = appendDate(badAssets, r.PeriodEnd)
		}
	}
	for _, end := range badAssets {
		rejectPeriod(rows, end, func(c fundamentalsColumn) bool { return c.isMonetary() && c.isBalance() })
		rep.add(gateNonPositiveAssets, 1)
	}

	// Scale break (§3.5), over the level lines.
	for _, end := range scaleBreaks(rows) {
		rejectPeriod(rows, end, fundamentalsColumn.isMonetary)
		rep.add(gateScaleBreak, 1)
	}

	// Identity (§3.5).
	ks := identityKs(rows)
	rep.kPeriods = len(ks)
	if len(ks) >= identityMinPeriods {
		vals := make([]float64, 0, len(ks))
		for _, k := range ks {
			vals = append(vals, k.k)
		}
		m := median(vals)
		rep.medianK = &m
		if m > 0 {
			for _, k := range ks {
				if k.k > m*identityTolerance || k.k < m/identityTolerance {
					rejectPeriod(rows, k.end, fundamentalsColumn.isMonetary)
					rep.add(gateIdentityOutlier, 1)
				}
			}
		}
	}
	return rows, rep
}

// rejectPeriod rejects the columns keep selects on every row (annual, ttm and
// quarter) dated end: a period's figures come from one filing, so a defect in
// one flavour is a defect in all of them (IAG's FY25 quarter snapshot carries
// the same slipped balance sheet as its FY25 annual row).
func rejectPeriod(rows []PeriodRow, end time.Time, keep func(fundamentalsColumn) bool) {
	for i := range rows {
		if !rows[i].PeriodEnd.Equal(end) {
			continue
		}
		for _, c := range fundamentalsColumns {
			if keep(c) {
				rows[i].reject(c.name)
			}
		}
	}
}

// scaleBreaks returns the period ends where a level line (scaleBreakColumns)
// is below 1/scaleBreakFactor of BOTH adjacent points of the same series
// (same period type), all three strictly positive. A negative or zero value is
// a sign change, not a scale slip, and is left to the other gates.
func scaleBreaks(rows []PeriodRow) []time.Time {
	type point struct {
		end time.Time
		v   float64
	}
	var ends []time.Time
	for _, typ := range []string{periodAnnual, periodTTM, periodQuarter} {
		for _, name := range scaleBreakColumns {
			c, _ := columnNamed(name)
			var series []point
			for i := range rows {
				if rows[i].PeriodType != typ {
					continue
				}
				if v := c.get(&rows[i]); v != nil {
					series = append(series, point{rows[i].PeriodEnd, *v})
				}
			}
			sort.Slice(series, func(i, j int) bool { return series[i].end.Before(series[j].end) })
			for i := 1; i+1 < len(series); i++ {
				prev, cur, next := series[i-1].v, series[i].v, series[i+1].v
				if prev > 0 && cur > 0 && next > 0 && cur*scaleBreakFactor < prev && cur*scaleBreakFactor < next {
					ends = appendDate(ends, series[i].end)
				}
			}
		}
	}
	return ends
}

type identityK struct {
	end time.Time
	k   float64
}

// identityKs computes k = net_income / (eps x shares) once per distinct
// annual/TTM period end (an annual row and the TTM row at the same fiscal
// year end are one period, not two votes). NI and EPS come from the same row,
// the annual row first; EPS is basic, else diluted (the plan names basic; the
// two differ by a few percent, far inside the 3x tolerance, and diluted-only
// codes would otherwise never be checked). Shares are the period's own count:
// the annual row's, else the quarter snapshot's at that date.
func identityKs(rows []PeriodRow) []identityK {
	shares := map[time.Time]float64{}
	for _, typ := range []string{periodQuarter, periodAnnual} { // annual wins
		for _, r := range rows {
			if r.PeriodType == typ && r.SharesOutstanding != nil && *r.SharesOutstanding > 0 {
				shares[r.PeriodEnd] = *r.SharesOutstanding
			}
		}
	}
	var ends []time.Time
	for _, r := range rows {
		if r.PeriodType == periodAnnual || r.PeriodType == periodTTM {
			ends = appendDate(ends, r.PeriodEnd)
		}
	}
	sort.Slice(ends, func(i, j int) bool { return ends[i].Before(ends[j]) })
	var out []identityK
	for _, end := range ends {
		sh, ok := shares[end]
		if !ok {
			continue
		}
		for _, typ := range []string{periodAnnual, periodTTM} {
			var found bool
			for _, r := range rows {
				if r.PeriodType != typ || !r.PeriodEnd.Equal(end) || r.NetIncome == nil {
					continue
				}
				eps := r.EPSBasic
				if eps == nil {
					eps = r.EPSDiluted
				}
				if eps == nil || *eps == 0 {
					continue
				}
				out = append(out, identityK{end: end, k: *r.NetIncome / (*eps * sh)})
				found = true
				break
			}
			if found {
				break
			}
		}
	}
	return out
}

func median(vals []float64) float64 {
	s := append([]float64(nil), vals...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func appendDate(ds []time.Time, d time.Time) []time.Time {
	for _, x := range ds {
		if x.Equal(d) {
			return ds
		}
	}
	return append(ds, d)
}

// ---------------------------------------------------------------------------
// Fills (plan §3.2, §3.3, §3.6). Each fills only a NULL, non-Rejected field of
// the same currency, and records where the value came from when that is not
// the row's own source.

// sameBalanceDate reports whether a and b are the same balance date (within
// sameFYWindow).
func sameBalanceDate(a, b time.Time) bool {
	d := a.Sub(b)
	if d < 0 {
		d = -d
	}
	return d <= sameFYWindow
}

// annualNear returns the index of the annual row dated within sameFYWindow of
// end (the nearest date first), or -1. A row whose Source is skipSource is
// not considered ("" considers every row).
func annualNear(rows []PeriodRow, end time.Time, skipSource string) int {
	best, bestGap := -1, time.Duration(math.MaxInt64)
	for i := range rows {
		r := &rows[i]
		if r.PeriodType != periodAnnual || r.Source == skipSource || !sameBalanceDate(r.PeriodEnd, end) {
			continue
		}
		gap := r.PeriodEnd.Sub(end)
		if gap < 0 {
			gap = -gap
		}
		if gap < bestGap {
			best, bestGap = i, gap
		}
	}
	return best
}

// mergeFallback folds the fallback (Markit) rows into the primary (Yahoo)
// rows, per field (§3.6):
//   - a fallback annual row whose balance date matches a primary annual row
//     fills that row's NULL revenue / net income when the currencies match,
//     recorded in FieldSources (Markit carries nothing else we store). That
//     includes a field a gate REJECTED from Yahoo: Markit is an independent
//     source, so its value is evidence, not a guess (IAG's FY25 revenue
//     slipped to 5.35m in Yahoo; Markit has 15.5bn), and an FX-converted
//     code's native figures come only from here. The field then leaves the
//     Rejected mask, because the vendor now supplies it (§2.2 rule 1). The
//     same-source fills (TTM-at-FYE, snapshots, the OCF derivation) never
//     refill a Rejected field;
//   - a fallback year the primary lacks is added as a fallback row, except a
//     year BEFORE the primary's earliest annual: that period is the
//     primary's history (four years is all Yahoo returns), usually stored
//     from an earlier run, and a fallback row must not take its key over.
//
// Yahoo stays authoritative for every value it has, so an EPS-only Yahoo year
// no longer blocks Markit's fresher revenue (MAQ, LOV), and the fallback's
// row is replaced by Yahoo's the run after Yahoo catches up.
func mergeFallback(primary, fallback []PeriodRow) []PeriodRow {
	out := make([]PeriodRow, 0, len(primary)+len(fallback))
	var earliest time.Time
	for _, r := range primary {
		out = append(out, r.clone())
		if r.PeriodType == periodAnnual && (earliest.IsZero() || r.PeriodEnd.Before(earliest)) {
			earliest = r.PeriodEnd
		}
	}
	nPrimary := len(out)
	for _, fb := range fallback {
		if fb.PeriodType != periodAnnual {
			continue
		}
		if i := annualNear(out[:nPrimary], fb.PeriodEnd, fb.Source); i >= 0 {
			p := &out[i]
			if p.Currency != fb.Currency {
				continue
			}
			for _, name := range []string{"revenue", "net_income"} {
				c, _ := columnNamed(name)
				if c.get(p) == nil && c.get(&fb) != nil {
					v := *c.get(&fb)
					c.set(p, &v)
					p.markSource(name, fb.Source)
					p.unreject(name)
				}
			}
			continue
		}
		if !earliest.IsZero() && !fb.PeriodEnd.After(earliest) {
			continue
		}
		out = append(out, fb.clone())
	}
	sortRows(out)
	return out
}

// copyTTMAtFYE: a TTM row dated at the fiscal year end (an annual row within
// sameFYWindow) IS that year's twelve months, so every flow field the annual
// row lacks is copied from it when the currencies match, recorded
// "derived:ttm-at-fye" (§3.6). LTR's FY26 annual row has revenue and profit
// but no EPS; its TTM point at 30 June does.
func copyTTMAtFYE(rows []PeriodRow) {
	for ti := range rows {
		t := &rows[ti]
		if t.PeriodType != periodTTM {
			continue
		}
		ai := annualNear(rows, t.PeriodEnd, "")
		if ai < 0 || rows[ai].Currency != t.Currency {
			continue
		}
		a := &rows[ai]
		for _, c := range fundamentalsColumns {
			if !c.isFlow() || c.get(a) != nil || a.isRejected(c.name) || c.get(t) == nil {
				continue
			}
			v := *c.get(t)
			c.set(a, &v)
			a.markSource(c.name, fieldSourceDerivedTTMAtFYE)
		}
	}
}

// fillAnnualFromSnapshots: a quarter balance snapshot dated at a fiscal year
// end also fills the NULL balance fields (and the share count) of the vendor
// annual row for that date, same source and currency (§3.3).
func fillAnnualFromSnapshots(rows []PeriodRow) {
	for qi := range rows {
		q := &rows[qi]
		if q.PeriodType != periodQuarter {
			continue
		}
		ai := annualNear(rows, q.PeriodEnd, "")
		if ai < 0 || rows[ai].Source != q.Source || rows[ai].Currency != q.Currency {
			continue
		}
		a := &rows[ai]
		for _, c := range fundamentalsColumns {
			if !c.isBalance() || c.get(a) != nil || a.isRejected(c.name) || c.get(q) == nil {
				continue
			}
			v := *c.get(q)
			c.set(a, &v)
		}
	}
}

// deriveOperatingCashFlow fills a missing operating cash flow as
// FreeCashFlow - CapitalExpenditure of the same row (capex is an outflow, so
// this adds it back), recorded "derived:fcf-minus-capex" (§3.2). It never
// overwrites a reported (or direct-method) value, and never fills a Rejected
// one.
func deriveOperatingCashFlow(rows []PeriodRow) {
	for i := range rows {
		r := &rows[i]
		if r.PeriodType == periodQuarter || r.OperatingCashFlow != nil || r.isRejected("operating_cash_flow") ||
			r.FreeCashFlow == nil || r.CapitalExpenditure == nil {
			continue
		}
		v := *r.FreeCashFlow - *r.CapitalExpenditure
		r.OperatingCashFlow = &v
		r.markSource("operating_cash_flow", fieldSourceDerivedFCFMinusCapex)
	}
}

// relabelCurrency sets every row's currency to cur. Used for an FX-converted
// code (§3.4) whose native currency Markit supplies: its Yahoo monetary fields
// are all Rejected, so what the label moves is the EPS / share rows and the
// currency the Markit fill and the downstream gates compare against.
func relabelCurrency(rows []PeriodRow, cur string) {
	for i := range rows {
		rows[i].Currency = cur
	}
}

// fallbackCurrency is the currency of the fallback's latest row ("" when it
// has none): Markit's curCode, the native reporting currency.
func fallbackCurrency(rows []PeriodRow) string {
	var latest time.Time
	cur := ""
	for _, r := range rows {
		if r.Currency != "" && !r.PeriodEnd.Before(latest) {
			latest, cur = r.PeriodEnd, r.Currency
		}
	}
	return cur
}

// ---------------------------------------------------------------------------
// Fiscal years.

// defaultFYEMonth is the ASX default balance date: 30 June.
const defaultFYEMonth = time.June

// effectiveMonthShift folds a 52/53-week year's balance date back into the
// month it belongs to: a year ending Sunday 2 July 2023 is the June 2023 year.
const effectiveMonthShift = -7

// fiscalYearEndMonth is the company's balance-date month, read from its latest
// annual row; June (the ASX default) when there is none.
func fiscalYearEndMonth(rows []PeriodRow) time.Month {
	var latest time.Time
	for _, r := range rows {
		if r.PeriodType == periodAnnual && r.PeriodEnd.After(latest) {
			latest = r.PeriodEnd
		}
	}
	if latest.IsZero() {
		return defaultFYEMonth
	}
	return latest.AddDate(0, 0, effectiveMonthShift).Month()
}

// fiscalYear is the FY a period ending on end belongs to, for a company whose
// year ends in fyeMonth: FYs are named by the calendar year they END in, so a
// period ending after the balance-date month belongs to next year's FY.
//
// With the ASX default (June) this is exactly "month >= 7 -> year+1, else
// year": H1 FY26 ends 31 Dec 2025 and is FY2026. It also gets December
// balance dates right (DRO's year to 31 Dec 2025 is FY2025, where the June
// rule would call it FY2026) and 52/53-week years (see effectiveMonthShift).
func fiscalYear(end time.Time, fyeMonth time.Month) int16 {
	eff := end.AddDate(0, 0, effectiveMonthShift)
	y := eff.Year()
	if eff.Month() > fyeMonth {
		y++
	}
	return int16(y)
}

// assignFiscalYears derives fiscal_year for every row from the company's own
// balance date. The source's period_end is stored untouched.
func assignFiscalYears(rows []PeriodRow) {
	fye := fiscalYearEndMonth(rows)
	for i := range rows {
		fy := fiscalYear(rows[i].PeriodEnd, fye)
		rows[i].FiscalYear = &fy
	}
}

// ---------------------------------------------------------------------------
// When to ask the fallback.

// staleAnnualAfter: when a code's latest annual row is older than this, a
// newer year should have been filed (ASX: the 4E within two months of the
// balance date, the annual report within three), so the fallback is asked
// whether it has one.
const staleAnnualAfter = 15 * 30 * 24 * time.Hour // ~15 months

// needsFallback reports whether the Markit fallback should be asked for this
// code. Knowing Markit's is newer means asking it, so it is asked when
// Yahoo's annual series is visibly behind or incomplete:
//   - Yahoo failed or published nothing;
//   - Yahoo has no annual row at all;
//   - Yahoo already has a TTM point at least a year past its latest annual
//     (the small-cap lag measured on SKS/4DX: trailing to Jun-26, annual still
//     Jun-25);
//   - the latest annual is older than ~15 months; or
//   - the latest annual lacks revenue or net income that no gate refused
//     (the EPS-only Yahoo year: MAQ and LOV carry FY25 EPS and nothing else,
//     which used to block Markit's FY25 revenue, plan §0.3); or
//   - a gate refused revenue or net income on any annual row (Markit may
//     hold the figure Yahoo slipped, see mergeFallback).
//
// fetchCode also asks it for an FX-converted code, for the native currency.
func needsFallback(yahoo []PeriodRow, yahooErr error, now time.Time) bool {
	if yahooErr != nil || len(yahoo) == 0 {
		return true
	}
	var latestTTM time.Time
	latest := -1
	for i, r := range yahoo {
		switch r.PeriodType {
		case periodAnnual:
			if latest < 0 || r.PeriodEnd.After(yahoo[latest].PeriodEnd) {
				latest = i
			}
		case periodTTM:
			if r.PeriodEnd.After(latestTTM) {
				latestTTM = r.PeriodEnd
			}
		}
	}
	if latest < 0 {
		return true
	}
	a := yahoo[latest]
	if !latestTTM.IsZero() && !latestTTM.Before(a.PeriodEnd.AddDate(0, 11, 0)) {
		return true
	}
	if now.Sub(a.PeriodEnd) > staleAnnualAfter {
		return true
	}
	if (a.Revenue == nil && !a.isRejected("revenue")) || (a.NetIncome == nil && !a.isRejected("net_income")) {
		return true
	}
	for i := range yahoo {
		if yahoo[i].PeriodType == periodAnnual && (yahoo[i].isRejected("revenue") || yahoo[i].isRejected("net_income")) {
			return true
		}
	}
	return false
}

// codeRe is what an ASX code may look like before it is put in a URL path.
var codeRe = regexp.MustCompile(`^[A-Z0-9]{1,10}$`)

// normalizeCode upper-cases and trims a code, returning "" when it is not a
// plausible ASX code (stock_code is VARCHAR(10)).
func normalizeCode(code string) string {
	c := strings.ToUpper(strings.TrimSpace(code))
	if !codeRe.MatchString(c) {
		return ""
	}
	return c
}
