// Package picks is the `shorted picks` job: the data layer of the stock picker
// (docs/plans/stock-picker.md §2.6).
//
//	-mode fundamentals  Pull typed per-period fundamentals (Yahoo
//	                    fundamentals-timeseries, Markit key statistics as the
//	                    fallback) for up to PICKS_FUNDAMENTALS_MAX_CODES codes,
//	                    recent 4D/4E filers first, then stalest first, skipping
//	                    codes attempted in the last six days. Upserts
//	                    stock_fundamentals, records every attempt in
//	                    stock_fundamentals_sync.
//	-mode refresh       SET LOCAL statement_timeout = 0; SELECT
//	                    refresh_strategy_views() — mv_market_regime,
//	                    mv_fundamentals_growth, mv_price_features. Scheduled
//	                    after the daily price sweep.
//	-mode all           fundamentals, then refresh.
//
// Exit codes (runner.ExitCodeError, economy's convention):
//
//	0   ok (>= 50% of attempted codes loaded or answered empty)
//	1   failure: DB unreachable, refresh failed or skipped a view, every
//	    attempted code failed, or the run was cancelled
//	10  DEGRADED: fewer than 50% of attempted codes answered, or Yahoo failed
//	    for more than half of them (the fallback covered what it could)
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
	modeRefresh      = "refresh"
	modeAll          = "all"
)

// defaultBudget stops a fundamentals run from taking new codes after 45
// minutes, leaving room inside the Cloud Run job's 3600s timeout for the last
// fetch, the attempt write and (in -mode all) the refresh. The queue is
// stalest-first, so a run that stops on budget is resumed by the next one.
const defaultBudget = 45 * time.Minute

// Job returns the `shorted picks` subcommand. It honours a dry run: fetch,
// parse and log, write nothing (no upsert, no attempt row, no refresh).
func Job() runner.Job {
	return runner.Func{
		JobName: "picks",
		Desc:    "stock picker data: per-period fundamentals + refresh_strategy_views()",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the picks job.
func Run(parent context.Context, args []string) error {
	g := runner.FromContext(parent)
	fs := flag.NewFlagSet("picks", flag.ContinueOnError)
	mode := fs.String("mode", modeAll, "fundamentals | refresh | all")
	dryRun := fs.Bool("dry-run", g.DryRun, "fetch + parse + log; write nothing (no upsert, no attempt row, no refresh)")
	verbose := fs.Bool("verbose", g.Verbose, "log Postgres notices")
	maxCodes := fs.Int("max-codes", envPositiveInt("PICKS_FUNDAMENTALS_MAX_CODES", defaultMaxCodes), "codes per fundamentals run (env PICKS_FUNDAMENTALS_MAX_CODES)")
	codesFlag := fs.String("codes", "", "comma-separated codes to fetch instead of the selection (ignores the 6-day skip and the cap)")
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
	case modeFundamentals, modeRefresh, modeAll:
	default:
		return fmt.Errorf("unknown -mode %q (want fundamentals|refresh|all)", *mode)
	}
	var codes []string
	if strings.TrimSpace(*codesFlag) != "" {
		codes = strings.Split(*codesFlag, ",")
	}
	budget := time.Duration(envPositiveInt("PICKS_FUNDAMENTALS_BUDGET_MIN", int(defaultBudget/time.Minute))) * time.Minute

	ctx := parent

	// A dry run over explicit codes needs no database at all (useful for
	// checking the upstream from a laptop). Everything else opens the pool.
	var st store
	needDB := !(*dryRun && len(codes) > 0 && *mode == modeFundamentals)
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
		st = &pgStore{pool: pool, notices: notices}
	}

	var fundamentalsErr error
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
		if !*noFallback {
			cfg.fallback = newMarkitKeyStatistics()
		}
		_, fundamentalsErr = runFundamentals(ctx, cfg)
		if *mode == modeFundamentals {
			return fundamentalsErr
		}
		if ctx.Err() != nil {
			return fundamentalsErr
		}
	}

	if err := runRefresh(ctx, st, *dryRun, log.Printf); err != nil {
		if fundamentalsErr != nil {
			// The refresh failure is the worse outcome (exit 1); keep the
			// fundamentals verdict in the message without letting its exit
			// code win.
			return fmt.Errorf("%w (fundamentals: %v)", err, fundamentalsErr)
		}
		return err
	}
	return fundamentalsErr
}

// runRefresh calls refresh_strategy_views() and fails when any view was
// skipped: the function catches every error per view and returns normally, so
// its WARNINGs are the only evidence a view went stale (task db:prod:refresh
// applies the same rule).
func runRefresh(ctx context.Context, st store, dryRun bool, logf func(string, ...any)) error {
	if dryRun {
		logf("picks: dry run: would call refresh_strategy_views()")
		return nil
	}
	if st == nil {
		return errors.New("refresh: no database")
	}
	start := time.Now()
	skipped, err := st.RefreshStrategyViews(ctx)
	if err != nil {
		return err
	}
	if len(skipped) > 0 {
		return fmt.Errorf("refresh_strategy_views skipped %d view(s): %s", len(skipped), strings.Join(skipped, ", "))
	}
	logf("picks: refresh_strategy_views ok in %s", time.Since(start).Round(time.Millisecond))
	return nil
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
