// Package keymetrics is the `shorted key-metrics` job: the daily refresh of
// "company-metadata".key_metrics from Yahoo's quoteSummary.
//
// It replaces the shorts API's SyncKeyMetrics RPC, which forked python3 and
// yfinance once per stock inside the serving process. That path never finished
// (the instance was killed for memory 3 to 30 seconds after each trigger), so
// the key metrics stopped updating. Here the work runs in a VKE CronJob with a
// time budget, so the universe cycles over days instead of failing in one run.
//
// Per run (services/jobs/README.md "key-metrics" has the full contract):
//
//   - the universe of stocks with a price row in the last 90 days, ordered
//     stalest first (key_metrics_updated_at NULLS FIRST, then oldest, then
//     code); a stock refreshed within the last 20 hours is skipped unless -force;
//   - one quoteSummary GET per stock, paced about one a second with jitter,
//     through the shared yahoo.Session (crumb and cookies, stealth client);
//   - a stock Yahoo answers with no quote (no regularMarketPrice, or not one
//     measured field) is no data and keeps its row; a fetch error keeps its row;
//   - a good record is one UPDATE of key_metrics and key_metrics_updated_at,
//     through keymetrics.Sanitise like the API's guard;
//   - it stops taking new stocks when the time budget (default 40 minutes) is
//     spent, or when a breaker trips: 25 consecutive Yahoo failures, more than
//     30% of the last 100 Yahoo requests, or 5 database write failures in a row.
//
// Dry run is the default: KEY_METRICS_DRY_RUN unset or anything but "false"
// fetches and logs what it would write, and writes nothing. Exit codes
// (runner.ExitCodeError, code 1 both ways): a breaker tripped, or the run
// attempted stocks and wrote none of them. Otherwise exit 0, including a run
// that found every stock fresh.
package keymetrics

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"github.com/castlemilk/shorted.com.au/services/pkg/yahoo"
)

const (
	// defaultBudget stops new stocks after 40 minutes (KEY_METRICS_BUDGET_MIN or
	// -budget-min). At about 1.15 seconds a stock (the pace plus Yahoo's ~0.15 s
	// answer) that is roughly 2,000 stocks. The universe is the ~2,200 codes with
	// a recent price (store.go), so it cycles in about one and a bit daily runs,
	// stalest first.
	defaultBudget = 40 * time.Minute
	// freshWindow: a stock whose key_metrics_updated_at is newer than this is
	// skipped, so a retried or re-run CronJob does not refetch the universe.
	freshWindow = 20 * time.Hour
	// pace is the mean wait between two requests; the actual wait is uniform in
	// [pace-paceJitter, pace+paceJitter].
	pace       = time.Second
	paceJitter = 250 * time.Millisecond

	// Breakers (the picks job's, fundamentals.go) cover Yahoo. The write breaker
	// covers the database: a pooler that refuses writes stops the run after this
	// many in a row instead of spending the budget on quotes it cannot store.
	maxConsecutiveFailures      = 25
	rateWindow                  = 100
	rateMaxFailures             = 30
	maxConsecutiveWriteFailures = 5

	yahooSuffix = ".AX"
)

// Job returns the `shorted key-metrics` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "key-metrics",
		Desc:    "key_metrics refresh of company-metadata from Yahoo quoteSummary (stalest first, time budget, breakers)",
		DryRun:  true,
		Fn:      Run,
	}
}

// Stock is one universe entry: its code and when key_metrics was last written
// (nil when never).
type Stock struct {
	Code      string
	UpdatedAt *time.Time
}

// Store is the job's database: the universe, and the one write.
type Store interface {
	// Universe returns every stock with its key_metrics_updated_at, in any order.
	Universe(ctx context.Context) ([]Stock, error)
	// WriteKeyMetrics replaces key_metrics and stamps key_metrics_updated_at for
	// one stock, after keymetrics.Sanitise. An unknown stock is an error.
	WriteKeyMetrics(ctx context.Context, code string, metrics map[string]any) error
}

// Quoter fetches one quoteSummary result. *yahoo.Session satisfies it.
type Quoter interface {
	QuoteSummary(ctx context.Context, symbol string, modules []string) (json.RawMessage, error)
}

// Summary is the run's count, logged as one line. Failed counts Yahoo fetch
// failures; WriteFailed counts database write failures, reported apart.
type Summary struct {
	Attempted    int
	Written      int // written, or would be written in a dry run
	NoData       int
	Failed       int
	WriteFailed  int
	SkippedFresh int
	BudgetLeft   time.Duration
	Stopped      string // "" for the whole universe, else why it stopped early
}

// config is the parsed run.
type config struct {
	dryRun bool
	force  bool
	budget time.Duration
	codes  map[string]bool // nil = the whole universe
}

// deps are the run's collaborators; the tests replace the clock and the sleep.
type deps struct {
	quoter Quoter
	store  Store
	now    func() time.Time
	sleep  func(ctx context.Context, d time.Duration) error
	jitter func(span time.Duration) time.Duration // uniform in [0, span]
	logf   func(string, ...any)
}

// Run executes the key-metrics job.
func Run(parent context.Context, args []string) error {
	g := runner.FromContext(parent)
	cfg, err := parseRunArgs(args,
		g.DryRun || dryRunFromEnv(os.Getenv("KEY_METRICS_DRY_RUN")),
		envPositiveInt("KEY_METRICS_BUDGET_MIN", int(defaultBudget/time.Minute)))
	if err != nil {
		return err
	}

	pool, err := platform.ConnectFromEnv(parent)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	session, closeFetch, err := newYahooSession()
	if err != nil {
		return err
	}
	defer func() { _ = closeFetch() }()

	sum, err := runKeyMetrics(parent, cfg, deps{
		quoter: session,
		store:  &pgStore{pool: pool},
		now:    time.Now,
		sleep:  sleepCtx,
		jitter: func(span time.Duration) time.Duration {
			if span <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(span) + 1))
		},
		logf: log.Printf,
	})
	return verdict(sum, err)
}

// parseRunArgs reads the job's flags. dryDefault is the default of -dry-run
// (the global -dry-run, or KEY_METRICS_DRY_RUN unless it is exactly "false");
// budgetDefault is the default of -budget-min in minutes.
func parseRunArgs(args []string, dryDefault bool, budgetDefault int) (config, error) {
	fs := flag.NewFlagSet("key-metrics", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", dryDefault, "fetch and log what would be written; write nothing (env KEY_METRICS_DRY_RUN, default true; only \"false\" writes)")
	force := fs.Bool("force", false, "refresh stocks refreshed within the last 20 hours too")
	budgetMin := fs.Int("budget-min", budgetDefault, "stop taking new stocks after this many minutes (env KEY_METRICS_BUDGET_MIN)")
	codesFlag := fs.String("codes", "", "comma-separated codes to refresh instead of the universe (the skips and the breakers still apply)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return config{}, runner.ErrUsage
		}
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	if *budgetMin <= 0 {
		return config{}, fmt.Errorf("-budget-min must be positive, got %d", *budgetMin)
	}

	cfg := config{
		dryRun: *dryRun,
		force:  *force,
		budget: time.Duration(*budgetMin) * time.Minute,
	}
	if strings.TrimSpace(*codesFlag) != "" {
		cfg.codes = map[string]bool{}
		for _, c := range strings.Split(*codesFlag, ",") {
			if c = normCode(c); c != "" {
				cfg.codes[c] = true
			}
		}
	}
	return cfg, nil
}

// verdict maps the run to its exit code. A breaker trip, or attempts with no
// write, is exit 1 so the monitor pages; a cancelled run is an error too.
func verdict(sum Summary, err error) error {
	if err != nil {
		return err
	}
	if sum.Stopped == stopBreaker {
		return &runner.ExitCodeError{Code: 1, Err: fmt.Errorf("key-metrics: Yahoo breaker tripped after %d attempts", sum.Attempted)}
	}
	if sum.Stopped == stopDB {
		return &runner.ExitCodeError{Code: 1, Err: fmt.Errorf("key-metrics: database write breaker tripped after %d write failures", sum.WriteFailed)}
	}
	if sum.Attempted > 0 && sum.Written == 0 {
		return &runner.ExitCodeError{Code: 1, Err: fmt.Errorf("key-metrics: %d attempted, none written (%d no data, %d failed, %d write failed)", sum.Attempted, sum.NoData, sum.Failed, sum.WriteFailed)}
	}
	return nil
}

const (
	stopBudget  = "budget"
	stopBreaker = "breaker"
	stopDB      = "db"
)

// runKeyMetrics is the run, free of the process: the universe, the skips, the
// pacing, the breakers, the writes and the summary line.
func runKeyMetrics(ctx context.Context, cfg config, d deps) (Summary, error) {
	start := d.now()
	deadline := start.Add(cfg.budget)

	universe, err := d.store.Universe(ctx)
	if err != nil {
		return Summary{}, fmt.Errorf("key-metrics: universe: %w", err)
	}
	stocks := order(universe, cfg.codes)

	mode := "live"
	if cfg.dryRun {
		mode = "dry-run"
	}
	d.logf("key-metrics: %s, %d stocks in scope, budget %s, force=%v", mode, len(stocks), cfg.budget, cfg.force)

	var sum Summary
	var brk breaker
	var writeFails int // consecutive database write failures
	requested := false
	for _, s := range stocks {
		if err := ctx.Err(); err != nil {
			sum.Stopped = "cancelled"
			sum.BudgetLeft = remaining(d, deadline)
			d.logf("%s", summaryLine(sum, cfg.dryRun))
			return sum, err
		}
		if !cfg.force && s.UpdatedAt != nil && start.Sub(*s.UpdatedAt) < freshWindow {
			sum.SkippedFresh++
			continue
		}
		if requested {
			if err := d.sleep(ctx, pace-paceJitter+d.jitter(2*paceJitter)); err != nil {
				sum.Stopped = "cancelled"
				sum.BudgetLeft = remaining(d, deadline)
				d.logf("%s", summaryLine(sum, cfg.dryRun))
				return sum, err
			}
		}
		// The budget is checked after the pacing wait, so no request starts
		// once it is spent.
		if !d.now().Before(deadline) {
			sum.Stopped = stopBudget
			break
		}
		if reason, tripped := brk.tripped(); tripped {
			d.logf("key-metrics: %s: stopping before %s", reason, s.Code)
			sum.Stopped = stopBreaker
			break
		}
		requested = true
		sum.Attempted++

		raw, err := d.quoter.QuoteSummary(ctx, yahooSymbol(s.Code), modules)
		if err != nil && ctx.Err() != nil {
			sum.Attempted--
			sum.Stopped = "cancelled"
			sum.BudgetLeft = remaining(d, deadline)
			d.logf("%s", summaryLine(sum, cfg.dryRun))
			return sum, ctx.Err()
		}
		switch {
		case err != nil && yahoo.IsNotFound(err):
			// Yahoo answered that it has no such quote: an answer, not a failure.
			brk.record(false)
			sum.NoData++
			d.logf("key-metrics: %s: no data (%v)", s.Code, err)
			continue
		case err != nil:
			brk.record(true)
			sum.Failed++
			d.logf("key-metrics: %s: fetch failed, row kept: %v", s.Code, err)
			continue
		case raw == nil:
			brk.record(false)
			sum.NoData++
			d.logf("key-metrics: %s: no data, row kept", s.Code)
			continue
		}
		brk.record(false)

		metrics, err := Build(s.Code, raw)
		if err != nil {
			sum.NoData++
			d.logf("key-metrics: %s: no data, row kept: %v", s.Code, err)
			continue
		}

		if cfg.dryRun {
			sum.Written++
			b, _ := json.Marshal(metrics)
			d.logf("key-metrics: dry run, would write %s: %s", s.Code, b)
			continue
		}
		if err := d.store.WriteKeyMetrics(ctx, s.Code, metrics); err != nil {
			sum.WriteFailed++
			writeFails++
			d.logf("key-metrics: %s: write failed, row kept: %v", s.Code, err)
			if writeFails >= maxConsecutiveWriteFailures {
				d.logf("key-metrics: database write breaker: %d write failures in a row, stopping", writeFails)
				sum.Stopped = stopDB
				break
			}
			continue
		}
		writeFails = 0
		sum.Written++
	}

	sum.BudgetLeft = remaining(d, deadline)
	d.logf("%s", summaryLine(sum, cfg.dryRun))
	return sum, nil
}

// order is the universe in refresh order: never written first, then the oldest
// key_metrics_updated_at, then code. A non-empty codes set restricts it first.
// Codes keep their stored spelling (a padded "FXG " is its own row, and the
// UPDATE must match that row); only the Yahoo symbol is normalised.
func order(universe []Stock, codes map[string]bool) []Stock {
	out := make([]Stock, 0, len(universe))
	for _, s := range universe {
		if codes != nil && !codes[normCode(s.Code)] {
			continue
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		switch {
		case a.UpdatedAt == nil && b.UpdatedAt != nil:
			return true
		case a.UpdatedAt != nil && b.UpdatedAt == nil:
			return false
		case a.UpdatedAt != nil && b.UpdatedAt != nil && !a.UpdatedAt.Equal(*b.UpdatedAt):
			return a.UpdatedAt.Before(*b.UpdatedAt)
		}
		return a.Code < b.Code
	})
	return out
}

// normCode is a stock code as Yahoo and the -codes flag spell it: trimmed and
// upper-cased.
func normCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

// yahooSymbol is the quoteSummary symbol for a stored code.
func yahooSymbol(code string) string {
	return normCode(code) + yahooSuffix
}

func remaining(d deps, deadline time.Time) time.Duration {
	if left := deadline.Sub(d.now()); left > 0 {
		return left.Round(time.Second)
	}
	return 0
}

func summaryLine(s Summary, dryRun bool) string {
	return fmt.Sprintf("key-metrics: summary dry_run=%v attempted=%d written=%d no_data=%d failed=%d write_failed=%d skipped_fresh=%d budget_left=%s stopped=%s",
		dryRun, s.Attempted, s.Written, s.NoData, s.Failed, s.WriteFailed, s.SkippedFresh, s.BudgetLeft, orNone(s.Stopped))
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// breaker is the picks job's: consecutive failures, and a rolling window of the
// last rateWindow Yahoo outcomes (true = failed), evaluated once the window is
// full.
type breaker struct {
	consecutive int
	ring        []bool
	next        int
}

func (b *breaker) record(failed bool) {
	if failed {
		b.consecutive++
	} else {
		b.consecutive = 0
	}
	if len(b.ring) < rateWindow {
		b.ring = append(b.ring, failed)
		return
	}
	b.ring[b.next] = failed
	b.next = (b.next + 1) % rateWindow
}

// tripped reports why the breaker is open, if it is.
func (b *breaker) tripped() (string, bool) {
	if b.consecutive >= maxConsecutiveFailures {
		return fmt.Sprintf("%d consecutive Yahoo failures", b.consecutive), true
	}
	if len(b.ring) < rateWindow {
		return "", false
	}
	n := 0
	for _, f := range b.ring {
		if f {
			n++
		}
	}
	if n > rateMaxFailures {
		return fmt.Sprintf("%d of the last %d Yahoo requests failed", n, rateWindow), true
	}
	return "", false
}

// newYahooSession builds the shared session on the stealth client, the one
// path Yahoo answers from the jobs runners.
func newYahooSession() (*yahoo.Session, func() error, error) {
	c, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, nil, fmt.Errorf("key-metrics: stealth client: %w", err)
	}
	return yahoo.NewSession(&yahoo.StealthFetcher{Client: c}), c.Close, nil
}

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

// dryRunFromEnv is the KEY_METRICS_DRY_RUN rule: a dry run unless the value is
// exactly "false" (after trimming). Unset, empty, "False" and "0" all dry-run.
func dryRunFromEnv(v string) bool {
	return strings.TrimSpace(v) != "false"
}

func envPositiveInt(key string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
