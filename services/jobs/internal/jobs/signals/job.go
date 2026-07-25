// Package signals is the `shorted signals` job — the first Python→Go port of
// the consolidation (docs/jobs-consolidation-plan.md Phase 2), replacing
// services/signals-collector/collect.py.
//
// It is the "intelligent crawler" path for stock reputation/risk: instead of
// bespoke per-source scrapers it calls brandbrain's ResolveBusinessSignals RPC
// (Gemini-grounded web research), which returns adverse signals (court matters,
// regulator sanctions, money-laundering findings, safety incidents, complaints)
// and positive signals (awards, certifications, major press), each with
// citations + confidence, and upserts them into stock_signals.
//
//	-priority top-shorted|enriched  which stocks to sweep first
//	-limit N                        max stocks per sweep
//	-max-age-days N                 skip stocks swept more recently than this
//	-workers N                      concurrent brandbrain calls
//	-dry-run                        resolve + log, write nothing
//
// The deployed Cloud Run Job passes the same flags in `--flag value` form,
// which the stdlib flag package accepts unchanged.
package signals

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"sync"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"golang.org/x/sync/errgroup"
)

// Priorities. These are the values the deployed scheduler passes, so they must
// not be renamed.
const (
	priorityTopShorted = "top-shorted"
	priorityEnriched   = "enriched"
)

// config is the parsed flag set, threaded explicitly rather than living in
// package-level flag vars (which would leak across subcommands).
type config struct {
	priority   string
	limit      int
	maxAgeDays int
	workers    int
	dryRun     bool
}

// Job returns the `shorted signals` subcommand. It honours -dry-run (signals
// are still resolved from brandbrain; nothing is written).
func Job() runner.Job {
	return runner.Func{
		JobName: "signals",
		Desc:    "resolve brandbrain risk/reputation signals for ASX issuers into stock_signals",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the signal sweep. Flag names and defaults match collect.py's
// argparse definitions exactly.
func Run(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("signals", flag.ContinueOnError)
	cfg := config{}
	fs.StringVar(&cfg.priority, "priority", priorityTopShorted, "Which stocks to sweep first: "+priorityTopShorted+" | "+priorityEnriched)
	fs.IntVar(&cfg.limit, "limit", 50, "Max stocks to sweep in this run")
	fs.IntVar(&cfg.maxAgeDays, "max-age-days", 30, "Skip stocks swept more recently than this many days ago")
	fs.IntVar(&cfg.workers, "workers", 4, "Concurrent brandbrain calls (brandbrain 502s above ~2)")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Resolve signals and log them, but write nothing")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	// argparse enforced the choices; flag does not, so validate explicitly
	// rather than silently falling through to the "enriched" branch.
	if cfg.priority != priorityTopShorted && cfg.priority != priorityEnriched {
		return fmt.Errorf("invalid -priority %q (want %s or %s)", cfg.priority, priorityTopShorted, priorityEnriched)
	}
	if cfg.workers < 1 {
		return fmt.Errorf("invalid -workers %d (want >= 1)", cfg.workers)
	}

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	client := newBrandbrainClient()
	store := &pgStore{pool: pool}

	stocks, err := store.SelectStocks(ctx, cfg.priority, cfg.limit, cfg.maxAgeDays)
	if err != nil {
		return fmt.Errorf("select stocks: %w", err)
	}
	log.Printf("Signal collection: %d stocks (priority=%s)", len(stocks), cfg.priority)

	return sweep(ctx, client, store, stocks, cfg)
}

// resolver resolves the signals payload for one company name.
type resolver interface {
	Resolve(ctx context.Context, companyName string) (*signalsPayload, error)
}

// signalStore is the write side, kept as an interface so the sweep is testable
// without a database.
type signalStore interface {
	Store(ctx context.Context, stockCode string, rows []signalRow) error
}

// tally accumulates the cross-worker run counters.
type tally struct {
	mu          sync.Mutex
	ok          int
	failed      int
	done        int
	totalAdvers int
}

func (t *tally) record(total int, adverse int, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.done++
	if err != nil {
		t.failed++
	} else {
		t.ok++
		t.totalAdvers += adverse
	}
	if t.done%10 == 0 {
		log.Printf("  progress %d/%d  ok=%d error=%d  adverse_total=%d", t.done, total, t.ok, t.failed, t.totalAdvers)
	}
}

// sweep resolves and stores signals for every selected stock, `workers` at a
// time.
//
// Like collect.py, a per-stock failure is counted and the sweep continues — one
// brandbrain 502 must not lose the rest of the run. Unlike collect.py, context
// cancellation (SIGTERM, or the Cloud Run task timeout) stops the sweep:
// remaining stocks are simply left for the next run, since selection is
// last_fetched_at driven and therefore resumable.
func sweep(ctx context.Context, client resolver, store signalStore, stocks []stock, cfg config) error {
	counters := &tally{}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(cfg.workers)
	// interrupted records a cancellation that stopped the fan-out before every
	// stock was queued, so an aborted sweep never reports success.
	var interrupted error
	for _, s := range stocks {
		if err := gctx.Err(); err != nil {
			interrupted = err
			break
		}
		g.Go(func() error {
			if err := gctx.Err(); err != nil {
				return err
			}
			adverse, err := processStock(gctx, client, store, s, cfg.dryRun)
			if err != nil {
				// Cancellation is fatal to the whole sweep; anything else is a
				// per-stock failure that must not abort the others.
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					counters.record(len(stocks), 0, err)
					return err
				}
				log.Printf("  WARN: %s failed: %v", s.Code, err)
			}
			counters.record(len(stocks), adverse, err)
			return nil
		})
	}
	err := g.Wait()
	if err == nil {
		err = interrupted
	}

	log.Printf("DONE: ok=%d error=%d of %d  total_adverse_signals=%d",
		counters.ok, counters.failed, len(stocks), counters.totalAdvers)
	if err != nil {
		return fmt.Errorf("signal sweep interrupted: %w", err)
	}
	return nil
}

// processStock resolves one company's signals and stores them, returning the
// adverse count for the run tally.
func processStock(ctx context.Context, client resolver, store signalStore, s stock, dryRun bool) (int, error) {
	payload, err := client.Resolve(ctx, s.CompanyName)
	if err != nil {
		return 0, err
	}
	rows := rowsFromSignals(s.Code, payload)
	adverse, positive := countPolarities(rows)

	if dryRun {
		for _, r := range rows {
			log.Printf("  [dry-run] %s %s/%s: %s", s.Code, r.Polarity, deref(r.Severity, "-"), truncate(r.Headline, 80))
		}
		log.Printf("  [dry-run] %s -> %d adverse, %d positive", s.Code, adverse, positive)
		return adverse, nil
	}
	if err := store.Store(ctx, s.Code, rows); err != nil {
		return 0, err
	}
	return adverse, nil
}

func deref(s *string, def string) string {
	if s == nil || *s == "" {
		return def
	}
	return *s
}

// truncate shortens a headline for the dry-run log. It counts RUNES, not bytes,
// so a cut never lands mid-character (headlines carry en dashes and curly
// quotes routinely).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
