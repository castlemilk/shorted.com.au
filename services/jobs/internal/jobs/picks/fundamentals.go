package picks

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// exitCodeDegraded is economy's convention (runner.ExitCodeError's doc):
// some codes loaded, too many failed. Distinct from 3-7, the reserved
// residential-rig codes.
const exitCodeDegraded = 10

// Breakers (plan fundamentals-coverage.md §3.7).
const (
	// maxConsecutiveFailures stops a run that is only collecting refusals:
	// the price sweep's rule (25 codes in a row).
	maxConsecutiveFailures = 25
	// rateWindow / rateMaxFailures: stop taking codes when more than 30% of
	// the last 100 Yahoo requests failed. A partly blocking Yahoo (every
	// third request refused) never trips the consecutive breaker but is
	// exactly the load we must not keep adding. Evaluated only once the
	// window is full; the consecutive breaker covers a total block sooner.
	rateWindow      = 100
	rateMaxFailures = 30
	// markitMaxConsecutiveFailures disables the fallback for the rest of the
	// run: a fallback that is down costs a second at every code for nothing.
	markitMaxConsecutiveFailures = 10
	// leaseExtendEvery: the run lease (§3.8) is extended every 100 codes.
	leaseExtendEvery = 100
)

// Stop reasons, as they appear in stopped_early=.
const (
	stopBudget              = "budget"
	stopConsecutiveFailures = "consecutive_failures"
	stopErrorRate           = "error_rate"
)

// Attempt outcomes stored in stock_fundamentals_sync.last_outcome (§2.3).
const (
	outcomeLoaded = "loaded"
	outcomeEmpty  = "empty"
	outcomeFailed = "failed"
)

// runConfig is one fundamentals run's collaborators and knobs.
type runConfig struct {
	store    store   // nil only for a dry run over explicit codes
	primary  Fetcher // yahooTimeseries in production
	fallback Fetcher // markitKeyStatistics; nil disables the fallback
	now      func() time.Time
	dryRun   bool
	maxCodes int           // 0 = no count cap (§3.7: the budget decides)
	codes    []string      // explicit codes: bypass selection (manual runs)
	budget   time.Duration // stop taking new codes after this long (0 = none)
	logf     func(format string, args ...any)
	// extendLease, when set, is called every leaseExtendEvery codes (§3.8).
	extendLease func(ctx context.Context) error
}

// runStats is the run's tally. A code is exactly one of Loaded (rows written,
// or would be in a dry run), Empty (every source asked ANSWERED and publishes
// nothing: an ETF, a shell, a new listing) or Failed (a source asked did not
// answer usefully and nothing was loaded, or the write failed).
type runStats struct {
	Selected, Loaded, Empty, Failed int
	Periods, RejectedValues         int
	FallbackAsked, FallbackUsed     int
	// PrimaryFailed counts codes Yahoo did not answer, whether or not the
	// fallback then covered them: a blocked primary must show in the exit
	// code even on a day Markit fills the gaps.
	PrimaryFailed int
	// FXConverted counts codes whose Yahoo statements were FX-converted.
	FXConverted int
	// Gates is every sanity-gate rejection of the run, by reason.
	Gates            map[string]int
	FallbackDisabled bool
	StoppedEarly     string
}

func (s runStats) attempted() int { return s.Loaded + s.Empty + s.Failed }

func (s runStats) String() string {
	out := fmt.Sprintf("selected=%d attempted=%d loaded=%d empty=%d failed=%d periods=%d rejected_values=%d primary_failed=%d fallback_asked=%d fallback_used=%d fx_converted=%d",
		s.Selected, s.attempted(), s.Loaded, s.Empty, s.Failed, s.Periods, s.RejectedValues, s.PrimaryFailed, s.FallbackAsked, s.FallbackUsed, s.FXConverted)
	if len(s.Gates) > 0 {
		out += " gates[" + gateReport{counts: s.Gates}.String() + "]"
	}
	if s.FallbackDisabled {
		out += " fallback_disabled"
	}
	if s.StoppedEarly != "" {
		out += " stopped_early=" + s.StoppedEarly
	}
	return out
}

// runState is the mutable per-run breaker state fetchCode consults.
type runState struct {
	yahooResults      []bool // ring of the last rateWindow Yahoo outcomes (true = failed)
	yahooNext         int
	markitConsecutive int
	markitDisabled    bool
}

// recordYahoo notes one Yahoo request outcome.
func (s *runState) recordYahoo(failed bool) {
	if len(s.yahooResults) < rateWindow {
		s.yahooResults = append(s.yahooResults, failed)
		return
	}
	s.yahooResults[s.yahooNext] = failed
	s.yahooNext = (s.yahooNext + 1) % rateWindow
}

// yahooErrorRateTripped reports > rateMaxFailures failures among the last
// rateWindow Yahoo requests (a full window only).
func (s *runState) yahooErrorRateTripped() (bool, int) {
	if len(s.yahooResults) < rateWindow {
		return false, 0
	}
	n := 0
	for _, f := range s.yahooResults {
		if f {
			n++
		}
	}
	return n > rateMaxFailures, n
}

// runFundamentals pulls per-period fundamentals for the selected codes,
// upserts them and records every attempt. See outcome for the exit rule.
func runFundamentals(ctx context.Context, cfg runConfig) (runStats, error) {
	var st runStats
	start := cfg.now()

	codes, err := workList(ctx, cfg)
	if err != nil {
		return st, err
	}
	st.Selected = len(codes)
	capText := "none"
	if cfg.maxCodes > 0 {
		capText = strconv.Itoa(cfg.maxCodes)
	}
	cfg.logf("picks: fundamentals: %d codes selected (cap %s, budget %s, dry_run=%t)", len(codes), capText, cfg.budget, cfg.dryRun)

	rs := &runState{}
	consecutiveFailures := 0
	for i, code := range codes {
		if err := ctx.Err(); err != nil {
			return st, fmt.Errorf("cancelled after %d/%d codes (%s): %w", i, len(codes), st, err)
		}
		if cfg.budget > 0 && cfg.now().Sub(start) > cfg.budget {
			// Not a failure: the queue is priority-ordered, so the next run
			// resumes with what is still due.
			st.StoppedEarly = stopBudget
			cfg.logf("picks: time budget %s reached after %d/%d codes; the rest carries to the next run", cfg.budget, i, len(codes))
			break
		}
		if consecutiveFailures >= maxConsecutiveFailures {
			st.StoppedEarly = stopConsecutiveFailures
			cfg.logf("picks: %d consecutive failures after %d/%d codes: upstream is refusing, stopping", consecutiveFailures, i, len(codes))
			break
		}
		if tripped, n := rs.yahooErrorRateTripped(); tripped {
			st.StoppedEarly = stopErrorRate
			cfg.logf("picks: %d of the last %d Yahoo requests failed after %d/%d codes: stopping before adding more load", n, rateWindow, i, len(codes))
			break
		}
		if i > 0 && i%leaseExtendEvery == 0 && cfg.extendLease != nil {
			if err := cfg.extendLease(ctx); err != nil {
				cfg.logf("picks: lease extend failed (continuing): %v", err)
			}
		}

		res := fetchCode(ctx, cfg, rs, code)
		if ctxErr := ctx.Err(); ctxErr != nil {
			// A fetch cut short by SIGTERM says nothing about the code; do not
			// record it as a failure.
			return st, fmt.Errorf("cancelled after %d/%d codes (%s): %w", i, len(codes), st, ctxErr)
		}
		if rs.markitDisabled && !st.FallbackDisabled {
			st.FallbackDisabled = true
			cfg.logf("picks: markit failed %d times in a row: fallback_disabled for the rest of the run", markitMaxConsecutiveFailures)
		}
		st.RejectedValues += res.rejected
		if res.primaryErr != nil {
			st.PrimaryFailed++
		}
		if res.fallbackAsked {
			st.FallbackAsked++
		}
		if res.fallbackUsed {
			st.FallbackUsed++
		}
		if res.gates.fxConverted {
			st.FXConverted++
		}
		for reason, n := range res.gates.counts {
			if st.Gates == nil {
				st.Gates = map[string]int{}
			}
			st.Gates[reason] += n
		}

		a := attempt{Code: code, At: cfg.now()}
		switch {
		case len(res.rows) > 0:
			if !cfg.dryRun {
				if err := cfg.store.UpsertPeriods(ctx, code, res.rows, a.At); err != nil {
					res.err = err
					break
				}
			}
			a.Success, a.PeriodsLoaded, a.Outcome = true, len(res.rows), outcomeLoaded
			if res.measured() {
				// k and fx_converted are measured on Yahoo's rows; a run Yahoo
				// did not answer, or answered with no rows (the rows written
				// are then Markit's alone), says nothing about them, so the
				// stored values stand (§2.3).
				a.Measured, a.MedianK = true, res.gates.medianK
				a.FXConverted, a.NativeCurrency = res.gates.fxConverted, res.nativeCur
			}
		case res.answeredEmpty():
			a.Outcome = outcomeEmpty
			a.Err = "no fundamentals published: " + res.detail()
		default:
			res.err = errors.New(res.detail())
		}

		switch {
		case res.err != nil:
			st.Failed++
			consecutiveFailures++
			a.Success, a.PeriodsLoaded, a.Outcome = false, 0, outcomeFailed
			a.Measured, a.MedianK, a.FXConverted, a.NativeCurrency = false, nil, false, ""
			a.Err = res.err.Error()
			cfg.logf("picks: %s FAILED: %v", code, res.err)
		case a.Success:
			st.Loaded++
			st.Periods += len(res.rows)
			consecutiveFailures = 0
			cfg.logf("picks: %s %s", code, describeRows(res, cfg.dryRun))
		default:
			st.Empty++
			consecutiveFailures = 0
			cfg.logf("picks: %s empty: %s", code, a.Err)
		}

		if !cfg.dryRun {
			if err := cfg.store.RecordAttempt(ctx, a); err != nil {
				// The attempt log drives the selection order; a DB that cannot
				// take it cannot take the upserts either.
				return st, fmt.Errorf("after %d/%d codes (%s): %w", i+1, len(codes), st, err)
			}
		}
	}

	cfg.logf("picks: fundamentals done in %s: %s", cfg.now().Sub(start).Round(time.Second), st)
	return st, outcome(st)
}

// outcome is the exit rule, with economy's split of the failure:
//
//	exit 0  >= 50% of attempted codes loaded or answered empty (or nothing was
//	        due)
//	exit 10 DEGRADED: under 50%, but some codes loaded or answered; OR the
//	        primary (Yahoo) failed for more than half the attempted codes,
//	        even if the fallback covered them
//	exit 1  DOWN: codes were attempted and not one answered
//
// "Answered empty" counts as healthy: an ETF with no statements is not an
// outage, and counting it as one would page on the shape of the market.
func outcome(st runStats) error {
	attempted := st.attempted()
	healthy := st.Loaded + st.Empty
	switch {
	case attempted == 0:
		return nil
	case healthy == 0:
		return fmt.Errorf("picks: DOWN all %d attempted codes failed (%s)", attempted, st)
	case healthy*2 < attempted:
		return &runner.ExitCodeError{
			Code: exitCodeDegraded,
			Err:  fmt.Errorf("picks: DEGRADED %d/%d attempted codes failed (%s)", st.Failed, attempted, st),
		}
	case st.PrimaryFailed*2 > attempted:
		return &runner.ExitCodeError{
			Code: exitCodeDegraded,
			Err:  fmt.Errorf("picks: DEGRADED yahoo failed for %d/%d attempted codes; the fallback covered what it could (%s)", st.PrimaryFailed, attempted, st),
		}
	default:
		return nil
	}
}

// workList is the explicit -codes list, or the selection over the universe.
func workList(ctx context.Context, cfg runConfig) ([]string, error) {
	if len(cfg.codes) > 0 {
		var out []string
		seen := map[string]bool{}
		for _, c := range cfg.codes {
			if code := normalizeCode(c); code != "" && !seen[code] {
				seen[code] = true
				out = append(out, code)
			}
		}
		if len(out) == 0 {
			return nil, errors.New("-codes: no valid ASX codes")
		}
		return out, nil
	}
	if cfg.store == nil {
		return nil, errors.New("no store: a run without -codes needs DATABASE_URL")
	}
	universe, err := cfg.store.UniverseCodes(ctx)
	if err != nil {
		return nil, err
	}
	states, err := cfg.store.SyncStates(ctx)
	if err != nil {
		return nil, err
	}
	filings := map[string][]time.Time{}
	headlines, err := cfg.store.RecentFilingHeadlines(ctx, filingLookbackDays)
	if err != nil {
		// Priority is an optimisation; the rest of the order still covers
		// every code.
		cfg.logf("picks: recent filings unavailable, no filing priority this run: %v", err)
	}
	for _, h := range headlines {
		switch classifyResultsFiling(h.Headline) {
		case filingAppendix4DE, filingPeriodResults:
			// Not filingAnnualReport: the annual report lands weeks after the
			// 4E that already moved the numbers (§3.7).
			if code := normalizeCode(h.Code); code != "" && !h.Date.IsZero() {
				filings[code] = append(filings[code], h.Date)
			}
		}
	}
	ranks, err := cfg.store.RankInputs(ctx)
	if err != nil {
		cfg.logf("picks: market cap / dollar volume unavailable, never-attempted codes go by code: %v", err)
		ranks = nil
	}
	sel := selectCodes(universe, states, filings, ranks, cfg.now(), cfg.maxCodes)
	cfg.logf("picks: universe=%d with_sync_row=%d recent_filers=%d queued: %s", len(universe), len(states), len(filings), sel.summary())
	return sel.codes, nil
}

// codeResult is one code's fetch outcome before it is written.
type codeResult struct {
	rows       []PeriodRow
	primaryErr error
	// primaryRows is how many rows Yahoo returned, before the gates and the
	// merge: the vendor facts (median_k, fx_converted, native_currency) are
	// measured only when it is > 0.
	primaryRows   int
	fallbackErr   error
	fallbackAsked bool
	fallbackUsed  bool
	nativeCur     string // an FX-converted code's native currency, from Markit
	gates         gateReport
	rejected      int
	err           error // set when the code failed
}

// measured: Yahoo answered without error AND with rows, so this attempt
// measured the code's vendor facts (median_k, fx_converted, native_currency).
func (r codeResult) measured() bool { return r.primaryErr == nil && r.primaryRows > 0 }

// answeredEmpty: every source asked returned without error and with no rows
// (§2.3). A fallback error with no rows is a failure, not an empty answer.
func (r codeResult) answeredEmpty() bool {
	return len(r.rows) == 0 && r.primaryErr == nil && (!r.fallbackAsked || r.fallbackErr == nil)
}

func (r codeResult) detail() string {
	parts := []string{}
	if r.primaryErr != nil {
		parts = append(parts, "yahoo: "+r.primaryErr.Error())
	} else {
		parts = append(parts, "yahoo: none")
	}
	switch {
	case !r.fallbackAsked:
	case r.fallbackErr != nil:
		parts = append(parts, "markit: "+r.fallbackErr.Error())
	default:
		parts = append(parts, "markit: none")
	}
	return strings.Join(parts, "; ")
}

// fetchCode runs one code through the vendor pipeline:
//
//  1. Yahoo (one GET), parsed with per-field currency (§3.1, §3.4);
//  2. the sanity gates (§3.4, §3.5), which null and mask what they refuse;
//  3. Markit when Yahoo is missing, behind or incomplete, or the code is
//     FX-converted (§3.6), folded in per field;
//  4. the TTM-at-FYE copy (§3.6), the balance-snapshot fill (§3.3) and the
//     operating-cash-flow derivation (§3.2), in that order so a derived OCF
//     can use a TTM-copied FCF and capex;
//  5. fiscal years and the write funnel.
func fetchCode(ctx context.Context, cfg runConfig, rs *runState, code string) codeResult {
	var res codeResult
	rows, err := cfg.primary.Fundamentals(ctx, code)
	res.primaryErr = err
	if err != nil {
		rows = nil
	}
	res.primaryRows = len(rows)
	if ctx.Err() == nil {
		rs.recordYahoo(err != nil)
	}
	rows, res.gates = applyVendorGates(rows)

	askFallback := needsFallback(rows, err, cfg.now()) || res.gates.fxConverted
	if cfg.fallback != nil && !rs.markitDisabled && ctx.Err() == nil && askFallback {
		res.fallbackAsked = true
		fb, ferr := cfg.fallback.Fundamentals(ctx, code)
		res.fallbackErr = ferr
		switch {
		case ferr != nil && ctx.Err() == nil:
			rs.markitConsecutive++
			if rs.markitConsecutive >= markitMaxConsecutiveFailures {
				rs.markitDisabled = true
			}
		case ferr == nil:
			rs.markitConsecutive = 0
			if res.gates.fxConverted {
				// §3.4: the native currency is Markit's curCode. Yahoo's
				// label is the conversion target, not the reporting
				// currency, and every Yahoo monetary and per-share field is
				// already Rejected (Yahoo converted all of them, EPS
				// included), so relabelling moves only the share count and
				// the masks; Markit's native revenue and net income fill in.
				if cur := fallbackCurrency(fb); cur != "" {
					res.nativeCur = cur
					relabelCurrency(rows, cur)
				}
			}
			before := len(rows)
			filledBefore := countFieldSource(rows, sourceMarkit)
			rows = mergeFallback(rows, fb)
			res.fallbackUsed = len(rows) > before || countFieldSource(rows, sourceMarkit) > filledBefore
		}
	}
	copyTTMAtFYE(rows)
	fillAnnualFromSnapshots(rows)
	deriveOperatingCashFlow(rows)
	assignFiscalYears(rows)
	res.rows, res.rejected = sanitizeRows(rows)
	return res
}

func countFieldSource(rows []PeriodRow, src string) int {
	n := 0
	for _, r := range rows {
		for _, s := range r.FieldSources {
			if s == src {
				n++
			}
		}
	}
	return n
}

// describeRows is the per-code log line: counts by period type, the span, the
// currency and source, the fields filled from elsewhere, the gates that fired
// and the identity reference.
func describeRows(res codeResult, dryRun bool) string {
	rows := res.rows
	byType := map[string]int{}
	var first, last time.Time
	sources := map[string]bool{}
	filled := map[string]int{}
	masked := 0
	for _, r := range rows {
		byType[r.PeriodType]++
		if first.IsZero() || r.PeriodEnd.Before(first) {
			first = r.PeriodEnd
		}
		if r.PeriodEnd.After(last) {
			last = r.PeriodEnd
		}
		sources[r.Source] = true
		for _, s := range r.FieldSources {
			filled[s]++
		}
		masked += len(r.Rejected)
	}
	var src []string
	for _, s := range []string{sourceYahoo, sourceMarkit} {
		if sources[s] {
			src = append(src, s)
		}
	}
	verb := "wrote"
	if dryRun {
		verb = "would write"
	}
	out := fmt.Sprintf("%s %d periods (annual=%d ttm=%d quarter=%d) %s..%s currency=%s source=%s",
		verb, len(rows), byType[periodAnnual], byType[periodTTM], byType[periodQuarter],
		first.Format("2006-01-02"), last.Format("2006-01-02"), latestCurrency(rows), strings.Join(src, "+"))
	if len(filled) > 0 {
		keys := make([]string, 0, len(filled))
		for k := range filled {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = fmt.Sprintf("%s=%d", k, filled[k])
		}
		out += " filled[" + strings.Join(parts, " ") + "]"
	}
	if res.gates.total() > 0 {
		out += fmt.Sprintf(" gates[%s] masked_fields=%d", res.gates, masked)
	}
	if res.gates.fxConverted {
		native := res.nativeCur
		if native == "" {
			native = "unknown"
		}
		out += " native_currency=" + native
	}
	if res.gates.medianK != nil {
		out += fmt.Sprintf(" median_k=%.3g (n=%d)", *res.gates.medianK, res.gates.kPeriods)
	}
	return out
}

// latestCurrency is the currency of the newest annual row, else of the newest
// row of any type.
func latestCurrency(rows []PeriodRow) string {
	cur, curAny := "", ""
	var latest, latestAny time.Time
	for _, r := range rows {
		if !r.PeriodEnd.Before(latestAny) {
			latestAny, curAny = r.PeriodEnd, r.Currency
		}
		if r.PeriodType == periodAnnual && !r.PeriodEnd.Before(latest) {
			latest, cur = r.PeriodEnd, r.Currency
		}
	}
	if cur == "" {
		return curAny
	}
	return cur
}
