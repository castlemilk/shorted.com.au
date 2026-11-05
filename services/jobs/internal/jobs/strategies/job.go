// Package strategies is the `shorted strategies` job: the strategy engine's
// batch work. Its modes are documented with each mode.
//
//	-mode parity  Compares the Go feature port with the stored views at the
//	              current session: fs1 with mv_price_features, the regime with
//	              mv_market_regime, sf0's days to cover with 000080's shorts
//	              and volume CTEs (parity.go). Read-only: it writes nothing and
//	              takes no lease. The picks job runs the same comparison after
//	              each weekday refresh, log-only (STRATEGY_PARITY_SHADOW=on).
//	-mode daily   Snapshots one session (today's, or the last trading day's):
//	              the feature rows, the regime and the fundamentals blobs, then
//	              the canonical versions' evaluation and their signal events.
//	              It backfills a held or missed session oldest first, and
//	              writes only when STRATEGIES_DRY_RUN=false (daily.go). The
//	              default is a dry run: it reads, computes and logs.
//
// Exit codes (runner.ExitCodeError, picks' convention):
//
//	0   the comparison ran and agrees, or it was inconclusive (the newest sweep
//	    had not completed before the views were refreshed; the log line says why),
//	    or the daily session is complete, held before the deadline, or another
//	    execution holds the daily lease
//	1   failure: the database, or a read that errored
//	10  a conclusive parity run found a disagreement (only_view, only_go or
//	    mismatches); or the daily session is still held at 16:40 UTC, the last
//	    scheduled run, so the monitor pages once
package strategies

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

const (
	modeParity = "parity"
	modeDaily  = "daily"
)

// Job returns the `shorted strategies` subcommand. Parity writes nothing, so a
// global dry run holds trivially; daily honours the dry run through its own
// STRATEGIES_DRY_RUN switch, so the runner's flag is declared and accepted.
func Job() runner.Job {
	return runner.Func{
		JobName: "strategies",
		Desc:    "strategy engine: -mode parity (read-only) compares the Go port with the views; -mode daily snapshots the session",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the strategies job.
func Run(parent context.Context, args []string) error {
	g := runner.FromContext(parent)
	fs := flag.NewFlagSet("strategies", flag.ContinueOnError)
	mode := fs.String("mode", modeParity, "parity | daily")
	dryFlag := fs.Bool("dry-run", g.DryRun, "daily writes only when this is false AND STRATEGIES_DRY_RUN=false; parity writes nothing")
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
	case modeParity:
		return runParityMode(parent)
	case modeDaily:
		return runDailyMode(parent, *dryFlag)
	default:
		return fmt.Errorf("unknown -mode %q (want parity or daily)", *mode)
	}
}

// runParityMode is the read-only comparison.
func runParityMode(parent context.Context) error {
	pool, err := platform.ConnectFromEnv(parent)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	// A by-hand run has no picks refresh to measure from, so it takes its own
	// start: a sweep that finished after the views were last refreshed is not
	// caught here. The scheduled shadow in the picks job is the one that is.
	res, err := RunParity(parent, pool, time.Now(), log.Printf)
	if err != nil {
		return err
	}
	if res.Conclusive && (res.OnlyView > 0 || res.OnlyGo > 0 || res.Mismatches > 0) {
		return &runner.ExitCodeError{Code: 10, Err: fmt.Errorf("parity disagrees at %s: %d only in the view, %d only in the Go port, %d mismatched", res.D, res.OnlyView, res.OnlyGo, res.Mismatches)}
	}
	return nil
}

// runDailyMode runs one daily pass. It writes only when the flag and the
// environment both say so: a dry run is the default.
func runDailyMode(parent context.Context, dryFlag bool) error {
	write := !dryFlag && os.Getenv("STRATEGIES_DRY_RUN") == "false"
	pool, err := platform.ConnectFromEnv(parent)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	holder := leaseHolder()
	if !write {
		log.Printf("strategies: daily dry run (set STRATEGIES_DRY_RUN=false to write)")
	}
	res, err := runDaily(parent, pool, dailyOptions{
		Write:  write,
		Holder: holder,
		Now:    time.Now(),
		Logf:   log.Printf,
		Sleep:  sleepCtx,
		Ping:   platform.PingRevalidate,
	})
	if err != nil {
		return err
	}
	if res.PastDeadline {
		return &runner.ExitCodeError{Code: 10, Err: fmt.Errorf("strategies daily: session %s still held at the last scheduled run: %s", res.Held.Date, res.Held.Reason)}
	}
	return nil
}

// leaseHolder names this execution in the lease: the Kubernetes job, else the host and process.
func leaseHolder() string {
	if h := os.Getenv("HOSTNAME"); h != "" {
		return h
	}
	host, _ := os.Hostname()
	return fmt.Sprintf("local:%s:%d", host, os.Getpid())
}

// sleepCtx waits for d or until ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
