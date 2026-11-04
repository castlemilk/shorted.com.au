// Package strategies is the `shorted strategies` job: the strategy engine's
// batch work. Its modes are documented with each mode.
//
//	-mode parity  Compares the Go feature port with the stored views at the
//	              current session: fs1 with mv_price_features, the regime with
//	              mv_market_regime, sf0's days to cover with 000080's shorts
//	              and volume CTEs (parity.go). Read-only: it writes nothing and
//	              takes no lease. The picks job runs the same comparison after
//	              each weekday refresh, log-only (STRATEGY_PARITY_SHADOW=on).
//
// Exit codes (runner.ExitCodeError, picks' convention):
//
//	0   the comparison ran and agrees, or it was inconclusive (the newest sweep
//	    had not completed before the views were refreshed; the log line says why)
//	1   failure: the database, or a read that errored
//	10  a conclusive run found a disagreement (only_view, only_go or mismatches)
package strategies

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

const modeParity = "parity"

// Job returns the `shorted strategies` subcommand. Every mode is read-only, so
// it honours a dry run trivially.
func Job() runner.Job {
	return runner.Func{
		JobName: "strategies",
		Desc:    "strategy engine: -mode parity compares the Go feature port with the views (read-only)",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the strategies job.
func Run(parent context.Context, args []string) error {
	fs := flag.NewFlagSet("strategies", flag.ContinueOnError)
	mode := fs.String("mode", modeParity, "parity")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	if *mode != modeParity {
		return fmt.Errorf("unknown -mode %q (want parity)", *mode)
	}

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
