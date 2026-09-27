package picks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// exitCodeDegraded is economy's convention (runner.ExitCodeError's doc):
// some codes loaded, too many failed. Distinct from 3-7, the reserved
// residential-rig codes.
const exitCodeDegraded = 10

// maxConsecutiveFailures stops a run that is only collecting refusals: the
// price sweep's rule (25 in a row), so a blocking Yahoo is not asked 400 times.
const maxConsecutiveFailures = 25

// runConfig is one fundamentals run's collaborators and knobs.
type runConfig struct {
	store    store   // nil only for a dry run over explicit codes
	primary  Fetcher // yahooTimeseries in production
	fallback Fetcher // markitKeyStatistics; nil disables the fallback
	now      func() time.Time
	dryRun   bool
	maxCodes int
	codes    []string      // explicit codes: bypass selection (manual runs)
	budget   time.Duration // stop taking new codes after this long (0 = none)
	logf     func(format string, args ...any)
}

// runStats is the run's tally. A code is exactly one of Loaded (rows written,
// or would be in a dry run), Empty (every source asked ANSWERED and publishes
// nothing: an ETF, a shell, a new listing) or Failed (no source answered
// usefully, or the write failed).
type runStats struct {
	Selected, Loaded, Empty, Failed int
	Periods, RejectedValues         int
	FallbackAsked, FallbackUsed     int
	// PrimaryFailed counts codes Yahoo did not answer, whether or not the
	// fallback then covered them: a blocked primary must show in the exit
	// code even on a day Markit fills the gaps.
	PrimaryFailed int
	StoppedEarly  string
}

func (s runStats) attempted() int { return s.Loaded + s.Empty + s.Failed }

func (s runStats) String() string {
	out := fmt.Sprintf("selected=%d attempted=%d loaded=%d empty=%d failed=%d periods=%d rejected_values=%d primary_failed=%d fallback_asked=%d fallback_used=%d",
		s.Selected, s.attempted(), s.Loaded, s.Empty, s.Failed, s.Periods, s.RejectedValues, s.PrimaryFailed, s.FallbackAsked, s.FallbackUsed)
	if s.StoppedEarly != "" {
		out += " stopped_early=" + s.StoppedEarly
	}
	return out
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
	cfg.logf("picks: fundamentals: %d codes selected (cap %d, dry_run=%t)", len(codes), cfg.maxCodes, cfg.dryRun)

	consecutiveFailures := 0
	for i, code := range codes {
		if err := ctx.Err(); err != nil {
			return st, fmt.Errorf("cancelled after %d/%d codes (%s): %w", i, len(codes), st, err)
		}
		if cfg.budget > 0 && cfg.now().Sub(start) > cfg.budget {
			// Not a failure: the queue is stalest-first, so the next run
			// resumes exactly here.
			st.StoppedEarly = fmt.Sprintf("time budget %s reached after %d/%d codes", cfg.budget, i, len(codes))
			cfg.logf("picks: %s", st.StoppedEarly)
			break
		}
		if consecutiveFailures >= maxConsecutiveFailures {
			st.StoppedEarly = fmt.Sprintf("%d consecutive failures after %d/%d codes", consecutiveFailures, i, len(codes))
			cfg.logf("picks: %s: upstream is refusing, stopping", st.StoppedEarly)
			break
		}

		res := fetchCode(ctx, cfg, code)
		if ctxErr := ctx.Err(); ctxErr != nil {
			// A fetch cut short by SIGTERM says nothing about the code; do not
			// record it as a failure.
			return st, fmt.Errorf("cancelled after %d/%d codes (%s): %w", i, len(codes), st, ctxErr)
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

		a := attempt{Code: code, At: cfg.now()}
		switch {
		case len(res.rows) > 0:
			if !cfg.dryRun {
				if err := cfg.store.UpsertPeriods(ctx, code, res.rows, a.At); err != nil {
					res.err = err
					break
				}
			}
			a.Success, a.PeriodsLoaded = true, len(res.rows)
		case res.answered:
			a.Err = "no fundamentals published: " + res.detail()
		default:
			res.err = errors.New(res.detail())
		}

		switch {
		case res.err != nil:
			st.Failed++
			consecutiveFailures++
			a.Success, a.PeriodsLoaded = false, 0
			a.Err = res.err.Error()
			cfg.logf("picks: %s FAILED: %v", code, res.err)
		case a.Success:
			st.Loaded++
			st.Periods += len(res.rows)
			consecutiveFailures = 0
			cfg.logf("picks: %s %s", code, describeRows(res.rows, cfg.dryRun))
		default:
			st.Empty++
			consecutiveFailures = 0
			cfg.logf("picks: %s empty: %s", code, a.Err)
		}

		if !cfg.dryRun {
			if err := cfg.store.RecordAttempt(ctx, a); err != nil {
				// The attempt log drives the stalest-first order; a DB that
				// cannot take it cannot take the upserts either.
				return st, fmt.Errorf("after %d/%d codes (%s): %w", i+1, len(codes), st, err)
			}
		}
	}

	cfg.logf("picks: fundamentals done: %s", st)
	return st, outcome(st)
}

// outcome is the exit rule (plan §2.6), with economy's split of the failure:
//
//	exit 0  >= 50% of attempted codes loaded or answered empty (or nothing was
//	        due: every code was attempted within six days)
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
	last, err := cfg.store.LastAttempts(ctx)
	if err != nil {
		return nil, err
	}
	filed := map[string]bool{}
	headlines, err := cfg.store.RecentFilingHeadlines(ctx, filingLookbackDays)
	if err != nil {
		// Priority is an optimisation; the stalest-first queue still covers
		// every code.
		cfg.logf("picks: recent filings unavailable, no filing priority this run: %v", err)
	}
	for _, h := range headlines {
		if classifyResultsFiling(h.Headline) != "" {
			if code := normalizeCode(h.Code); code != "" {
				filed[code] = true
			}
		}
	}
	codes := selectCodes(universe, last, filed, cfg.now(), cfg.maxCodes)
	nFiled := 0
	for _, c := range codes {
		if filed[c] {
			nFiled++
		}
	}
	cfg.logf("picks: universe=%d with_sync_row=%d recent_filers=%d (queued %d)", len(universe), len(last), len(filed), nFiled)
	return codes, nil
}

// codeResult is one code's fetch outcome before it is written.
type codeResult struct {
	rows          []PeriodRow
	answered      bool // some source answered (with rows or with nothing)
	primaryErr    error
	fallbackErr   error
	fallbackAsked bool
	fallbackUsed  bool
	rejected      int
	err           error // set when the code failed
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

// fetchCode asks the primary source, asks the fallback when the primary is
// missing or visibly behind (needsFallback), merges, derives fiscal years and
// runs the write funnel.
func fetchCode(ctx context.Context, cfg runConfig, code string) codeResult {
	var res codeResult
	rows, err := cfg.primary.Fundamentals(ctx, code)
	res.primaryErr = err
	if err == nil {
		res.answered = true
	} else {
		rows = nil
	}
	if cfg.fallback != nil && ctx.Err() == nil && needsFallback(rows, err, cfg.now()) {
		res.fallbackAsked = true
		fb, ferr := cfg.fallback.Fundamentals(ctx, code)
		res.fallbackErr = ferr
		if ferr == nil {
			res.answered = true
			merged := mergeFallback(rows, fb)
			res.fallbackUsed = len(merged) > len(rows)
			rows = merged
		}
	}
	assignFiscalYears(rows)
	res.rows, res.rejected = sanitizeRows(rows)
	return res
}

// describeRows is the per-code log line: counts by period type and the span.
func describeRows(rows []PeriodRow, dryRun bool) string {
	var annual, ttm int
	var first, last time.Time
	sources := map[string]bool{}
	for _, r := range rows {
		if r.PeriodType == periodAnnual {
			annual++
		} else {
			ttm++
		}
		if first.IsZero() || r.PeriodEnd.Before(first) {
			first = r.PeriodEnd
		}
		if r.PeriodEnd.After(last) {
			last = r.PeriodEnd
		}
		sources[r.Source] = true
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
	return fmt.Sprintf("%s %d periods (annual=%d ttm=%d) %s..%s currency=%s source=%s",
		verb, len(rows), annual, ttm, first.Format("2006-01-02"), last.Format("2006-01-02"),
		rows[len(rows)-1].Currency, strings.Join(src, "+"))
}
