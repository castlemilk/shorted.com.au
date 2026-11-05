package strategies

// The backtest job: shorted strategies -mode backtest. It runs the canonical
// versions' recipes over the stored history and publishes the runs that pass the
// publication gate. The job is one writer (the lease), reads every input inside
// one REPEATABLE READ, READ ONLY transaction, and idles in milliseconds until a
// live version with a recipe exists. A fundamentals strategy whose window opens
// at computable_from gets pass 1 only: its derivation is stored, never simulated.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"runtime"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

const (
	// backtestLeaseName is the picks_run_lease row the backtest job holds while it runs.
	backtestLeaseName = "strategies-backtest"
	// backtestBatchRuns bounds the requests one execution takes.
	backtestBatchRuns = 5
	// backtestBudget bounds the work an execution starts (a request is not started
	// after it is spent). Load time, this budget, the overrun of the last request
	// and the revalidation wait must fit the CronJob's 3300 s activeDeadlineSeconds.
	backtestBudget = 20 * time.Minute
	// backtestRevalidateWait is how long the API's cache takes to turn over.
	backtestRevalidateWait = 16 * time.Minute
	backtestRevalidateTags = "strategy-backtests"
	// Retention: runs younger than 30 days, the published run and the newest
	// succeeded run of each key are kept; requests are kept 90 days.
	backtestRunRetentionDays     = 30
	backtestRequestRetentionDays = 90
)

// errDeterminism is a publish whose verify pass did not reproduce its input or
// output hash. It is a failure of the engine or the data path, so the run exits
// 10 and the monitor pages.
var errDeterminism = errors.New("determinism failure")

// errNotReady is a request whose version or recipe the daily snapshot has not
// recorded yet. It is not a failure: the request goes back in the queue.
var errNotReady = errors.New("not ready")

// backtestTarget is one live canonical version and the recipe it registers.
type backtestTarget struct {
	Reg        spec.Registered
	RulesHash  string
	Recipe     spec.Recipe
	RecipeHash string
}

// backtestTargets pairs each live canonical version with the recipe it registers.
// A version is eligible once it is live, is not the pre-recipe v0 and carries a
// recipe (the job idles until one does). A recipe's window may be the literal
// "computable_from", which the job derives.
func backtestTargets(versions []spec.Registered) ([]backtestTarget, error) {
	var out []backtestTarget
	for _, v := range versions {
		if !v.Live || v.Label == "v0" || v.Recipe == nil {
			continue
		}
		h, err := spec.RulesHash(v.Spec)
		if err != nil {
			return nil, fmt.Errorf("hash %s %s: %w", v.Spec.StrategyID, v.Label, err)
		}
		rh, err := spec.RecipeHash(*v.Recipe)
		if err != nil {
			return nil, fmt.Errorf("hash recipe %s: %w", v.Recipe.ID, err)
		}
		out = append(out, backtestTarget{Reg: v, RulesHash: h, Recipe: *v.Recipe, RecipeHash: rh})
	}
	return out, nil
}

// isoWeek names the ISO week of t, the publish request's cadence.
func isoWeek(t time.Time) string {
	y, w := t.UTC().ISOWeek()
	return fmt.Sprintf("%04d-W%02d", y, w)
}

// publishDedupeKey is the weekly publish request's key: one per key and ISO week.
func publishDedupeKey(rulesHash, recipeHash, engineVersion, week string) string {
	return fmt.Sprintf("publish:%s:%s:%s:%s", rulesHash, recipeHash, engineVersion, week)
}

// asapDedupeKey is the immediate publish request's key: one per key and day, so a
// key whose request failed is queued again the next day.
func asapDedupeKey(rulesHash, recipeHash, engineVersion, day string) string {
	return fmt.Sprintf("publish:%s:%s:%s:asap:%s", rulesHash, recipeHash, engineVersion, day)
}

// fundamentalsNeeds names the fundamentals a spec reads through its core rules.
// A spec reads fundamentals when a data requirement names them; growth and quality
// are the core rules of each family (v0.go). A non-core rule adds no need, so
// Quality Compounders' revenue_not_shrinking does not make growth a requirement.
func fundamentalsNeeds(s spec.Spec) (backtest.Needs, bool) {
	var needs backtest.Needs
	reads := false
	for _, req := range s.Requires {
		if req.Source == "fundamentals" {
			reads = true
		}
	}
	for _, r := range s.Rules {
		if !r.Core {
			continue
		}
		switch r.ID {
		case "growth", "eps_growth", "revenue_growth":
			needs.Growth = true
		case "roe", "net_margin", "cash_conversion", "leverage", "fcf_margin":
			needs.Quality = true
		}
	}
	return needs, reads && (needs.Growth || needs.Quality)
}

// publicationParts is what the publication gate has wired. Sensitivity
// runs and the same-data reference arrive in the follow-up, so this build publishes nothing.
type publicationParts struct {
	Sensitivity bool
	Reference   bool
}

// publicationWired is what this build's gate has. the follow-up switches the two parts on.
var publicationWired = publicationParts{}

// publicationGate reports why a run may not publish, or nil when it may. It
// needs coverage (always computed), the parts wired in this build, and a verify
// pass that reproduced the run.
func publicationGate(d backtest.Disclosures, verified bool, wired publicationParts) error {
	if !verified {
		return errors.New("no verify pass reproduced the run")
	}
	if !wired.Sensitivity {
		return errors.New("sensitivity runs are not wired in this build (the follow-up)")
	}
	if !wired.Reference {
		return errors.New("the same-data reference is not wired in this build (the follow-up)")
	}
	if d.Coverage.Qualifying.Total.Qualifying == 0 {
		return errors.New("coverage is not computed")
	}
	return nil
}

// backtestOptions carries the job's dependencies, so a test can stand in the
// database clock and the revalidation ping.
type backtestOptions struct {
	Write   bool
	Holder  string
	Now     time.Time
	Logf    func(string, ...any)
	Sleep   func(context.Context, time.Duration) error
	Ping    func(platform.RevalidateRequest)
	Targets []backtestTarget
	Build   string
	Budget  time.Duration
	Batch   int
	// Load reads the verify pass's second copy of the inputs. Nil reads them from
	// the database; a test sets it to make the second read differ.
	Load func(context.Context, pgsource.DB, civil.Date) (*backtest.MemoryInputs, error)
}

// backtestResult reports what one execution did, for the exit code and the log.
type backtestResult struct {
	Idle          bool
	Held          bool
	Processed     int
	NotReady      int
	Published     int
	Pass1         int
	NotComputable int
	Determinism   int
	Failed        int
}

// runBacktest is one execution: enqueue the due requests, take a batch, run it
// over one read of the stored history, and publish what passes the gate.
func runBacktest(ctx context.Context, pool *pgxpool.Pool, opts backtestOptions) (backtestResult, error) {
	if len(opts.Targets) == 0 {
		opts.Logf("strategies backtest: no live version with a recipe (v1 is not live); idle")
		return backtestResult{Idle: true}, nil
	}
	if opts.Budget == 0 {
		opts.Budget = backtestBudget
	}
	if opts.Batch == 0 {
		opts.Batch = backtestBatchRuns
	}
	st := backtestStore{pool: pool}
	if !opts.Write {
		return dryRunBacktest(ctx, pool, opts)
	}

	proceed, err := st.claimLease(ctx, backtestLeaseName, opts.Holder)
	if err != nil {
		return backtestResult{}, err
	}
	if !proceed.ok {
		opts.Logf("strategies backtest: another execution holds %s (%s); exit 0", backtestLeaseName, proceed.holder)
		return backtestResult{}, nil
	}
	defer st.releaseLease(backtestLeaseName, opts.Holder, opts.Logf)

	if err := st.enqueue(ctx, opts.Targets, opts.Now); err != nil {
		return backtestResult{}, err
	}
	// Only the lease holder claims requests, so a running row belongs to an
	// execution that did not finish. It is queued again, not left running.
	n, err := st.requeueRunning(ctx)
	if err != nil {
		return backtestResult{}, err
	}
	if n > 0 {
		opts.Logf("strategies backtest: %d request(s) left running by an earlier execution are queued again", n)
	}
	batch, err := st.claimBatch(ctx, opts.Batch)
	if err != nil {
		return backtestResult{}, err
	}
	if len(batch) == 0 {
		opts.Logf("strategies backtest: nothing queued; idle")
		return backtestResult{Idle: true}, nil
	}
	res, err := processBatch(ctx, pool, st, opts, batch)
	if err != nil {
		// A batch that errored before it finished puts its open requests back in the
		// queue. requeue touches only rows still running, so a finished request stays.
		if rerr := st.requeue(context.Background(), batch); rerr != nil {
			opts.Logf("strategies backtest: requeueing after the error failed: %v", rerr)
		}
	}
	return res, err
}

// queueHoldMessage is the log line of a held execution.
const queueHoldMessage = "strategies backtest: %d weekend-dated index row(s) on or before %s (the XJO and XJT history is not re-dated yet: the one-off index re-fetch); requests stay queued"

// processBatch runs a batch of requests over one REPEATABLE READ, READ ONLY
// transaction. Requests run in the order claimed: publish before variant, then FIFO.
func processBatch(ctx context.Context, pool *pgxpool.Pool, st backtestStore, opts backtestOptions, batch []backtestRequest) (backtestResult, error) {
	var res backtestResult
	started := time.Now()
	windowEnd, ok, err := pgsource.BacktestWindowEnd(ctx, pool)
	if err != nil {
		return res, err
	}
	if !ok {
		opts.Logf("strategies backtest: no features session has completed; %d request(s) stay queued", len(batch))
		if err := st.requeue(ctx, batch); err != nil {
			return res, err
		}
		return res, nil
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return res, fmt.Errorf("begin the read transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	// A weekend-dated XJO or XJT row means the index history is not yet re-dated, so
	// every weekday holds the next session's close. The batch is held, not run.
	held, err := indexWeekendRows(ctx, tx, windowEnd)
	if err != nil {
		return res, err
	}
	if held > 0 {
		opts.Logf(queueHoldMessage, held, windowEnd)
		res.Held = true
		return res, st.requeue(ctx, batch)
	}

	inputs, err := pgsource.LoadBacktestInputs(ctx, tx, windowEnd)
	if err != nil {
		return res, err
	}
	statements, err := pgsource.BacktestStatements(ctx, tx, windowEnd)
	if err != nil {
		return res, err
	}
	opts.Logf("strategies backtest: read %d code(s) to %s in one snapshot, %d batch request(s)", len(inputs.BarsByCode), windowEnd, len(batch))
	through := throughOf(inputs, windowEnd)

	// seen maps a key already published in this batch to its run, so a second
	// request for the same key is finished against that run, not recomputed.
	seen := map[string]int64{}
	for i, req := range batch {
		if time.Since(started) > opts.Budget {
			opts.Logf("strategies backtest: work budget %s spent; %d request(s) stay queued", opts.Budget, len(batch)-i)
			if err := st.requeue(ctx, batch[i:]); err != nil {
				return res, err
			}
			break
		}
		t, ok := findTarget(opts.Targets, req)
		if !ok {
			res.Failed++
			if err := st.finishRequest(ctx, req.ID, 0, "no live version matches this request", false); err != nil {
				return res, err
			}
			continue
		}
		key := t.Reg.Spec.StrategyID + "|" + t.RulesHash + "|" + t.RecipeHash
		if id, dup := seen[key]; dup {
			if err := st.finishRequest(ctx, req.ID, id, "", true); err != nil {
				return res, err
			}
			continue
		}
		res.Processed++
		out, err := publishRequest(ctx, tx, st, inputs, statements, windowEnd, through, t, opts)
		switch {
		case errors.Is(err, errNotReady):
			res.NotReady++
			opts.Logf("strategies backtest: %s %s waits: %v", t.Reg.Label, t.Recipe.ID, err)
			if rerr := st.requeue(ctx, []backtestRequest{req}); rerr != nil {
				return res, rerr
			}
		case errors.Is(err, errDeterminism):
			res.Determinism++
			opts.Logf("strategies backtest: %s %s: %v", t.Reg.Label, t.Recipe.ID, err)
			if ferr := st.failRun(ctx, t, opts, firstSession(sessionsOf(inputs)), windowEnd, err); ferr != nil {
				return res, ferr
			}
			if ferr := st.finishRequest(ctx, req.ID, 0, err.Error(), false); ferr != nil {
				return res, ferr
			}
		case err != nil:
			res.Failed++
			opts.Logf("strategies backtest: %s %s failed: %v", t.Reg.Label, t.Recipe.ID, err)
			if ferr := st.finishRequest(ctx, req.ID, 0, err.Error(), false); ferr != nil {
				return res, ferr
			}
		default:
			if out.NotComputable {
				res.NotComputable++
			}
			if out.Pass1 {
				res.Pass1++
			}
			if out.Published {
				res.Published++
			}
			if out.RunID != 0 {
				seen[key] = out.RunID
			}
			if err := st.finishRequest(ctx, req.ID, out.RunID, "", true); err != nil {
				return res, err
			}
		}
	}

	// The batch's reads are finished: close the snapshot before the revalidation
	// wait, which holds no transaction and no pooled connection.
	_ = tx.Rollback(context.Background())

	if res.Published > 0 && opts.Ping != nil && opts.Sleep != nil {
		opts.Logf("strategies backtest: waiting %s for the API's cache before revalidating %s", backtestRevalidateWait, backtestRevalidateTags)
		if err := opts.Sleep(ctx, backtestRevalidateWait); err != nil {
			return res, err
		}
		opts.Ping(platform.RevalidateRequest{Reason: "strategies-backtest", Tag: backtestRevalidateTags})
	}
	if err := st.prune(ctx); err != nil {
		opts.Logf("strategies backtest: retention failed (the next run retries): %v", err)
	}
	logPeakRSS(opts.Logf)
	if res.Determinism > 0 {
		return res, fmt.Errorf("%w: %d publish(es) failed their verify pass", errDeterminism, res.Determinism)
	}
	return res, nil
}

// publishOutcome is what one request produced.
type publishOutcome struct {
	RunID int64
	// Published is set when the run was published by this request.
	Published bool
	// Pass1 is set for a fundamentals strategy whose derivation found computable_from.
	Pass1 bool
	// NotComputable is set when the derivation found no computable_from.
	NotComputable bool
}

// publishRequest computes one request's run inside the batch's snapshot. For a
// fundamentals strategy whose window is computable_from, the strict policy stores
// the derivation's outcome (pass 1) and never simulates the window: a simulation
// would read today's fundamentals at every session. A simple recipe is simulated;
// its first publish of a result runs the verify pass.
func publishRequest(ctx context.Context, tx pgx.Tx, st backtestStore, in *backtest.MemoryInputs, stmts map[string][]backtest.Statement, windowEnd civil.Date, through throughDates, t backtestTarget, opts backtestOptions) (publishOutcome, error) {
	var out publishOutcome
	liveFrom, err := st.liveFrom(ctx, t)
	if err != nil {
		return out, err
	}
	recipe := t.Recipe
	if recipe.WindowStart == spec.WindowComputableFrom {
		needs, ok := fundamentalsNeeds(t.Reg.Spec)
		if !ok {
			return out, fmt.Errorf("recipe %s opens at computable_from but its strategy reads no fundamentals", recipe.ID)
		}
		sessions := sessionsOf(in)
		der, err := backtest.DeriveComputableFrom(stmts, needs, sessions)
		if err != nil {
			return out, err
		}
		if der.Found {
			out.Pass1 = true
			opts.Logf("strategies backtest: %s %s computable from %s (%s); pass 1 only, no simulation", t.Reg.Label, recipe.ID, der.ComputableFrom, der.FiscalLabel)
		} else {
			out.NotComputable = true
			opts.Logf("strategies backtest: %s %s not computable (best share %.2f); no simulation", t.Reg.Label, recipe.ID, der.Share)
		}
		id, err := st.writeNotComputable(ctx, t, firstSession(sessions), windowEnd, der, through, opts)
		out.RunID = id
		return out, err
	}

	d1, base, err := backtest.Disclose(in, t.Reg.Spec, recipe, liveFrom, nil, windowEnd, opts.Build, "")
	if err != nil {
		return out, fmt.Errorf("publish %s %s: %w", t.Reg.Label, recipe.ID, err)
	}
	// The verify pass runs unless a succeeded verify already reproduced this exact
	// input and output: the gate's verify check is for this run, never another.
	verified, err := st.verifiedRun(ctx, t, d1.Identity.InputHash, d1.Identity.OutputHash)
	if err != nil {
		return out, err
	}
	if !verified {
		d2, err := verifyPass(ctx, tx, t, recipe, liveFrom, windowEnd, opts, d1)
		if err != nil {
			return out, err
		}
		if _, err := st.writeRun(ctx, runWrite{
			Target: t, Recipe: recipe, Kind: "verify", WindowEnd: windowEnd,
			Disclosures: d2, Result: base, Build: opts.Build, Verified: true,
			Fundamentals: fundamentalsPolicy(recipe), Through: through,
		}); err != nil {
			return out, err
		}
		verified = true
	}

	gate := publicationGate(d1, verified, publicationWired)
	publish := gate == nil
	out.Published = publish
	if gate != nil {
		opts.Logf("strategies backtest: %s %s computed, not published: %v", t.Reg.Label, recipe.ID, gate)
	}
	id, err := st.writeRun(ctx, runWrite{
		Target: t, Recipe: recipe, Kind: "publish", WindowEnd: windowEnd,
		Disclosures: d1, Result: base,
		Publish: publish, Build: opts.Build, Verified: verified,
		Fundamentals: fundamentalsPolicy(recipe), Through: through,
	})
	out.RunID = id
	return out, err
}

// verifyPass reruns the key from a second read inside the same transaction and
// compares the input hash and the output hash. A mismatch is a
// determinism failure. The rerun is stored as kind verify, the record of it.
func verifyPass(ctx context.Context, tx pgx.Tx, t backtestTarget, recipe spec.Recipe, liveFrom, windowEnd civil.Date, opts backtestOptions, first backtest.Disclosures) (backtest.Disclosures, error) {
	load := opts.Load
	if load == nil {
		load = pgsource.LoadBacktestInputs
	}
	second, err := load(ctx, tx, windowEnd)
	if err != nil {
		return backtest.Disclosures{}, fmt.Errorf("verify: second read: %w", err)
	}
	d2, _, err := backtest.Disclose(second, t.Reg.Spec, recipe, liveFrom, nil, windowEnd, opts.Build, "")
	if err != nil {
		return backtest.Disclosures{}, fmt.Errorf("verify: rerun: %w", err)
	}
	if d2.Identity.InputHash != first.Identity.InputHash {
		return d2, fmt.Errorf("%w: input hash %s != %s", errDeterminism, shortHash(d2.Identity.InputHash), shortHash(first.Identity.InputHash))
	}
	if d2.Identity.OutputHash != first.Identity.OutputHash {
		return d2, fmt.Errorf("%w: output hash %s != %s", errDeterminism, shortHash(d2.Identity.OutputHash), shortHash(first.Identity.OutputHash))
	}
	opts.Logf("strategies backtest: %s %s determinism ok (input %s output %s)", t.Reg.Label, recipe.ID, shortHash(d2.Identity.InputHash), shortHash(d2.Identity.OutputHash))
	return d2, nil
}

// dryRunBacktest computes each eligible target once and logs it. It writes
// nothing: no lease, no requests, no runs. The default for a by-hand run. A
// fundamentals strategy whose window is computable_from gets the same pass 1 as
// a write run: its derivation is logged, and it is not simulated.
func dryRunBacktest(ctx context.Context, pool *pgxpool.Pool, opts backtestOptions) (backtestResult, error) {
	windowEnd, ok, err := pgsource.BacktestWindowEnd(ctx, pool)
	if err != nil {
		return backtestResult{}, err
	}
	if !ok {
		opts.Logf("strategies backtest dry run: no features session has completed")
		return backtestResult{Idle: true}, nil
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return backtestResult{}, fmt.Errorf("begin the read transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	held, err := indexWeekendRows(ctx, tx, windowEnd)
	if err != nil {
		return backtestResult{}, err
	}
	if held > 0 {
		opts.Logf(queueHoldMessage, held, windowEnd)
		return backtestResult{Held: true}, nil
	}
	in, err := pgsource.LoadBacktestInputs(ctx, tx, windowEnd)
	if err != nil {
		return backtestResult{}, err
	}
	st := backtestStore{pool: pool}
	stmts, err := pgsource.BacktestStatements(ctx, tx, windowEnd)
	if err != nil {
		return backtestResult{}, err
	}
	var res backtestResult
	for _, t := range opts.Targets {
		liveFrom, err := st.liveFrom(ctx, t)
		if errors.Is(err, errNotReady) {
			res.NotReady++
			opts.Logf("strategies backtest dry run: %s %s waits: %v", t.Reg.Label, t.Recipe.ID, err)
			continue
		}
		if err != nil {
			return res, err
		}
		recipe := t.Recipe
		if recipe.WindowStart == spec.WindowComputableFrom {
			needs, ok := fundamentalsNeeds(t.Reg.Spec)
			if !ok {
				return res, fmt.Errorf("recipe %s opens at computable_from but its strategy reads no fundamentals", recipe.ID)
			}
			der, err := backtest.DeriveComputableFrom(stmts, needs, sessionsOf(in))
			if err != nil {
				return res, err
			}
			if !der.Found {
				opts.Logf("strategies backtest dry run: %s %s not computable (best share %.2f); no simulation", t.Reg.Label, recipe.ID, der.Share)
				res.NotComputable++
				continue
			}
			opts.Logf("strategies backtest dry run: %s %s computable from %s (%s); pass 1 only, no simulation", t.Reg.Label, recipe.ID, der.ComputableFrom, der.FiscalLabel)
			res.Pass1++
			continue
		}
		d, _, err := backtest.Disclose(in, t.Reg.Spec, recipe, liveFrom, nil, windowEnd, opts.Build, "")
		if err != nil {
			return res, fmt.Errorf("dry run %s %s: %w", t.Reg.Label, recipe.ID, err)
		}
		res.Processed++
		opts.Logf("strategies backtest dry run: %s %s run key %s, output %s, coverage %s (no writes)",
			t.Reg.Label, recipe.ID, shortHash(d.Identity.RunKey), shortHash(d.Identity.OutputHash), coverageLabel(d))
	}
	logPeakRSS(opts.Logf)
	return res, nil
}

// findTarget returns the target a request names, by its keys.
func findTarget(targets []backtestTarget, req backtestRequest) (backtestTarget, bool) {
	for _, t := range targets {
		if t.RulesHash == req.RulesHash && t.RecipeHash == req.RecipeHash && t.Reg.Spec.StrategyID == req.StrategyID {
			return t, true
		}
	}
	return backtestTarget{}, false
}

// firstSession is the earliest session of a list, or the zero date when none.
func firstSession(sessions []civil.Date) civil.Date {
	if len(sessions) == 0 {
		return civil.Date{}
	}
	return sessions[0]
}

// sessionsOf is the market's XJO sessions in order: the calendar the run reads.
func sessionsOf(in *backtest.MemoryInputs) []civil.Date {
	out := make([]civil.Date, 0, len(in.Mkt.XJO))
	for _, b := range in.Mkt.XJO {
		out = append(out, b.Date)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out
}

// fundamentalsPolicy is the recipe's fundamentals policy, strict unless it says otherwise.
func fundamentalsPolicy(r spec.Recipe) string {
	if r.Fundamentals == "" {
		return "strict"
	}
	return r.Fundamentals
}

// coverageLabel is a short human form of a run's coverage for the log.
func coverageLabel(d backtest.Disclosures) string {
	total := d.Coverage.Qualifying.Total
	if total.Qualifying == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.1f%%", total.Ratio*100)
}

// shortHash is the first twelve characters of a hash, for the log.
func shortHash(h string) string {
	if len(h) <= 12 {
		return h
	}
	return h[:12]
}

// roundSeries rounds a series value to the millionth, as the stored points are.
func roundSeries(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

// logPeakRSS logs the process's peak resident set, the figure the live check
// records. Darwin reports bytes and Linux kilobytes.
func logPeakRSS(logf func(string, ...any)) {
	rss, ok := peakRSSBytes()
	if !ok {
		return
	}
	logf("strategies backtest: peak RSS %.0f MiB (%s/%s)", float64(rss)/(1<<20), runtime.GOOS, runtime.GOARCH)
}

// backtestBuildRevision names the build: the VCS revision when the binary has
// one, else the image tag, else "local".
func backtestBuildRevision() string {
	if tag := os.Getenv("IMAGE_TAG"); tag != "" {
		return tag
	}
	if rev := vcsRevision(); rev != "" {
		return rev
	}
	return "local"
}

// runBacktestMode is the `shorted strategies -mode backtest` entry point. The dry
// run is the default; STRATEGIES_DRY_RUN=false with the flag set writes. A request
// that fails for a reason other than not-ready exits 1, so the monitor pages; a
// determinism failure exits 10.
func runBacktestMode(parent context.Context, dryFlag bool) error {
	write := !dryFlag && os.Getenv("STRATEGIES_DRY_RUN") == "false"
	targets, err := backtestTargets(spec.Registry())
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		log.Printf("strategies backtest: no live version with a recipe yet; idle")
		return nil
	}
	pool, err := platform.ConnectFromEnv(parent)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()
	if !write {
		log.Printf("strategies backtest: dry run (set STRATEGIES_DRY_RUN=false to write)")
	}
	res, err := runBacktest(parent, pool, backtestOptions{
		Write:   write,
		Holder:  leaseHolder(),
		Now:     time.Now(),
		Logf:    log.Printf,
		Sleep:   sleepCtx,
		Ping:    platform.PingRevalidate,
		Targets: targets,
		Build:   backtestBuildRevision(),
	})
	if err != nil {
		if errors.Is(err, errDeterminism) {
			return &runner.ExitCodeError{Code: 10, Err: err}
		}
		return err
	}
	log.Printf("strategies backtest: processed %d, published %d, pass 1 %d, not computable %d, not ready %d, held %t, determinism failures %d, failed %d",
		res.Processed, res.Published, res.Pass1, res.NotComputable, res.NotReady, res.Held, res.Determinism, res.Failed)
	if res.Failed > 0 {
		return &runner.ExitCodeError{Code: 1, Err: fmt.Errorf("%d backtest request(s) failed; the log names them", res.Failed)}
	}
	return nil
}
