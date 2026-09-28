// Package picks is the `shorted picks` job: the data layer of the stock picker
// (docs/plans/stock-picker.md §2.6, extended by
// docs/plans/fundamentals-coverage.md §3).
//
//	-mode fundamentals  Pull the full statements (Yahoo fundamentals-timeseries,
//	                    one GET per code: income statement, balance sheet and
//	                    cash flow, annual + trailing, quarterly balance
//	                    snapshots; Markit key statistics as the per-field
//	                    fallback), run the sanity gates, and upsert
//	                    stock_fundamentals under the vendor rules (store.go).
//	                    Budget-driven: every code in priority order (due
//	                    filers, never attempted by market cap, failures,
//	                    stale successes) until PICKS_FUNDAMENTALS_BUDGET_MIN
//	                    elapses. Every attempt is recorded in
//	                    stock_fundamentals_sync.
//	-mode filings       Parse revenue / net profit / EPS out of
//	                    financial_report_extractions.metrics (the
//	                    report-extractor's reading of Appendix 4D/4E and other
//	                    results documents) into typed 'half' and 'annual'
//	                    stock_fundamentals rows, source 'asx-filing-extraction'
//	                    (filings_ingest.go). No network, no LLM.
//	-mode refresh       SET LOCAL statement_timeout = 0; SELECT
//	                    refresh_strategy_views(). Scheduled after the daily
//	                    price sweep. After a successful refresh it waits 16
//	                    minutes (the API's strategy cache + 1) and pings the
//	                    web tier's /api/revalidate (tag strategy-picks, plus
//	                    fundamentals when this execution changed them).
//	-mode all           fundamentals, then filings, then refresh.
//
// fundamentals, filings and all take the picks_run_lease row first, so two
// executions never write at once; a run that finds it held logs the holder and
// exits 0. refresh does not take it.
//
// Exit codes (runner.ExitCodeError, economy's convention):
//
//	0   ok (>= 50% of attempted codes loaded or answered empty), or the lease
//	    is held by another execution
//	1   failure: DB unreachable, refresh failed or skipped a view, every
//	    attempted code failed, every filing write failed, or the run was
//	    cancelled
//	10  DEGRADED: fewer than 50% of attempted codes answered, Yahoo failed
//	    for more than half of them (the fallback covered what it could), or
//	    the filings step degraded
//
// In -mode all every step runs and the worst verdict wins (worstError).
package picks

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

const (
	modeFundamentals = "fundamentals"
	modeFilings      = "filings"
	modeRefresh      = "refresh"
	modeAll          = "all"
)

const (
	// defaultBudgetMin stops the fundamentals step from taking new codes
	// after 170 minutes (PICKS_FUNDAMENTALS_BUDGET_MIN, §3.7): the universe at
	// the 4s pace is ~155 minutes. The job's 12600s timeout leaves 40 minutes
	// for the last fetch, the filings step, the refresh and the 16-minute
	// revalidation wait.
	defaultBudgetMin = 170
	// retryBudget caps the step on a Cloud Run task retry
	// (CLOUD_RUN_TASK_ATTEMPT > 0): the retry exists to finish filings and
	// the refresh, not to run a second full pass (§3.7).
	retryBudget = 20 * time.Minute
)

// Job returns the `shorted picks` subcommand. It honours a dry run: fetch,
// parse and log, write nothing (no upsert, no attempt row, no lease, no
// refresh).
func Job() runner.Job {
	return runner.Func{
		JobName: "picks",
		Desc:    "stock picker data: full statements per period, filing half-years + refresh_strategy_views()",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the picks job.
func Run(parent context.Context, args []string) error {
	g := runner.FromContext(parent)
	fs := flag.NewFlagSet("picks", flag.ContinueOnError)
	mode := fs.String("mode", modeAll, "fundamentals | filings | refresh | all")
	dryRun := fs.Bool("dry-run", g.DryRun, "fetch/read + parse + log; write nothing (no upsert, no attempt row, no lease, no refresh)")
	verbose := fs.Bool("verbose", g.Verbose, "log Postgres notices")
	maxCodes := fs.Int("max-codes", envPositiveInt("PICKS_FUNDAMENTALS_MAX_CODES", defaultMaxCodes), "optional count cap per fundamentals run, 0 = none: the budget decides (env PICKS_FUNDAMENTALS_MAX_CODES)")
	codesFlag := fs.String("codes", "", "comma-separated codes to fetch instead of the selection (ignores the skips and the cap)")
	noFallback := fs.Bool("no-fallback", false, "never ask the Markit fallback")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	switch *mode {
	case modeFundamentals, modeFilings, modeRefresh, modeAll:
	default:
		return fmt.Errorf("unknown -mode %q (want fundamentals|filings|refresh|all)", *mode)
	}
	var codes []string
	if strings.TrimSpace(*codesFlag) != "" {
		codes = strings.Split(*codesFlag, ",")
	}
	budget := fundamentalsBudget()

	ctx := parent

	// A dry run over explicit codes needs no database at all (useful for
	// checking the upstream from a laptop). Everything else opens the pool,
	// including a dry run of -mode filings, which reads (never writes).
	var st store
	needDB := !*dryRun || len(codes) == 0 || *mode != modeFundamentals
	if needDB {
		notices := &noticeLog{}
		if *verbose {
			notices.logf = log.Printf
		}
		pool, err := platform.ConnectFromEnv(ctx, platform.PoolOption(func(cfg *pgxpool.Config) {
			cfg.ConnConfig.OnNotice = notices.handle
		}))
		if err != nil {
			return fmt.Errorf("db connect: %w", err)
		}
		defer pool.Close()
		st = &pgStore{pool: pool, notices: notices, logf: log.Printf}
	}

	// The run lease (§3.8): one writer at a time. A dry run writes nothing
	// and takes no lease.
	var lease *runLease
	if *mode != modeRefresh && !*dryRun && st != nil {
		l, proceed, err := acquireLease(ctx, st, leaseHolder(), log.Printf)
		if err != nil {
			return err
		}
		if !proceed {
			return nil
		}
		lease = l
		defer lease.release()
	}

	var stepErrs []error
	fundamentalsChanged := false
	if *mode == modeFundamentals || *mode == modeAll {
		yahoo, closeYahoo, err := newYahooTimeseries()
		if err != nil {
			return err
		}
		defer func() { _ = closeYahoo() }()
		cfg := runConfig{
			store:    st,
			primary:  yahoo,
			now:      time.Now,
			dryRun:   *dryRun,
			maxCodes: *maxCodes,
			codes:    codes,
			budget:   budget,
			logf:     log.Printf,
		}
		if lease != nil {
			cfg.extendLease = lease.extend
		}
		if !*noFallback {
			cfg.fallback = newMarkitKeyStatistics()
		}
		stats, err := runFundamentals(ctx, cfg)
		fundamentalsChanged = !*dryRun && stats.Loaded > 0
		if *mode == modeFundamentals {
			return err
		}
		stepErrs = append(stepErrs, stepError("fundamentals", err))
		if ctx.Err() != nil {
			return worstError(stepErrs...)
		}
	}

	if *mode == modeFilings || *mode == modeAll {
		_, err := runFilings(ctx, st, *dryRun, log.Printf)
		if !*dryRun && err == nil {
			// The filings step is a deterministic rebuild: when it completes,
			// stock_fundamentals reflects this run's extractions.
			fundamentalsChanged = true
		}
		if *mode == modeFilings {
			return err
		}
		stepErrs = append(stepErrs, stepError("filings", err))
		if ctx.Err() != nil {
			return worstError(stepErrs...)
		}
	}
	// The writers are done; the refresh does not need the lease, and the
	// revalidation wait should not hold it for 16 minutes.
	lease.release()

	// The refresh runs even after a degraded or failed pull: whatever did
	// land should reach the views, and the stale-view check is its own verdict.
	err := runRefresh(ctx, st, *dryRun, log.Printf)
	if err == nil && !*dryRun {
		revalidateAfterRefresh(ctx, defaultRevalidator(), fundamentalsChanged, log.Printf)
	}
	if *mode == modeRefresh {
		return err
	}
	return worstError(append(stepErrs, stepError("refresh", err))...)
}

// fundamentalsBudget is PICKS_FUNDAMENTALS_BUDGET_MIN (default 170), capped
// at retryBudget on a Cloud Run task retry.
func fundamentalsBudget() time.Duration {
	b := time.Duration(envPositiveInt("PICKS_FUNDAMENTALS_BUDGET_MIN", defaultBudgetMin)) * time.Minute
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("CLOUD_RUN_TASK_ATTEMPT"))); err == nil && n > 0 && b > retryBudget {
		log.Printf("picks: task retry (CLOUD_RUN_TASK_ATTEMPT=%d): fundamentals budget %s", n, retryBudget)
		b = retryBudget
	}
	return b
}

// leaseHolder names this execution: the Cloud Run execution (shared by a
// task's retries, so a retry can take over the lease its dead attempt left),
// else the host and process.
func leaseHolder() string {
	if e := strings.TrimSpace(os.Getenv("CLOUD_RUN_EXECUTION")); e != "" {
		return e
	}
	host, _ := os.Hostname()
	return fmt.Sprintf("local:%s:%d", host, os.Getpid())
}

// runLease is a held picks_run_lease row. A nil *runLease is valid and does
// nothing (the table is absent: running without the lease).
type runLease struct {
	st       store
	holder   string
	logf     func(string, ...any)
	released bool
}

// acquireLease claims the lease. proceed=false means another execution holds
// it: the caller exits 0. A missing table (42P01) runs without it.
func acquireLease(ctx context.Context, st store, holder string, logf func(string, ...any)) (*runLease, bool, error) {
	claimed, current, err := st.ClaimLease(ctx, holder)
	switch {
	case errors.Is(err, errLeaseAbsent):
		logf("picks: picks_run_lease does not exist (migration 000132 not applied); running without the lease")
		return nil, true, nil
	case err != nil:
		return nil, false, err
	case !claimed:
		logf("picks: another execution holds the run lease (%s); exiting without work", current)
		return nil, false, nil
	}
	logf("picks: run lease taken by %s", holder)
	return &runLease{st: st, holder: holder, logf: logf}, true, nil
}

func (l *runLease) extend(ctx context.Context) error {
	if l == nil || l.released {
		return nil
	}
	return l.st.ExtendLease(ctx, l.holder)
}

// release deletes the lease row, on a detached context so SIGTERM (the job
// ctx cancelled) still frees it. Idempotent.
func (l *runLease) release() {
	if l == nil || l.released {
		return
	}
	l.released = true
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := l.st.ReleaseLease(ctx, l.holder); err != nil {
		l.logf("picks: releasing the run lease failed (it expires on its own): %v", err)
	}
}

// stepError labels one -mode all step's error, keeping its exit code.
func stepError(step string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", step, err)
}

// worstError folds the steps of -mode all into one verdict: a plain error
// (exit 1) beats a DEGRADED one (exit 10), which beats success. The worst
// step's error is wrapped (%w, so runner.ExitCodeOf still finds its code);
// the others ride along in the message only.
func worstError(errs ...error) error {
	var worst error
	worstRank := 0
	var others []string
	for _, err := range errs {
		if err == nil {
			continue
		}
		rank := 2 // plain error: exit 1
		var ec *runner.ExitCodeError
		if errors.As(err, &ec) && ec.Code != 1 && ec.Code != 0 {
			rank = 1
		}
		if rank > worstRank {
			if worst != nil {
				others = append(others, worst.Error())
			}
			worst, worstRank = err, rank
		} else {
			others = append(others, err.Error())
		}
	}
	if worst == nil {
		return nil
	}
	if len(others) == 0 {
		return worst
	}
	return fmt.Errorf("%w (also: %s)", worst, strings.Join(others, "; "))
}

// envPositiveInt reads a positive integer env var (economy's envInt rule: zero,
// negative or garbage keeps the default rather than disabling the cap).
func envPositiveInt(name string, def int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
