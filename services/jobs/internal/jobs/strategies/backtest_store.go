package strategies

// The backtest job's database access: the lease, the request queue, the run,
// series and trade writes, the publish flip and retention. Every write is one
// transaction; the flip of a key's published run is in the same transaction as
// the run it publishes.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"syscall"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// backtestStore is the job's pool-backed reader and writer.
type backtestStore struct {
	pool *pgxpool.Pool
}

// queryRower is the read a pool and a transaction both answer.
type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// leaseClaim is the outcome of claiming the lease. ok is false when another
// execution holds it; holder names that execution.
type leaseClaim struct {
	ok     bool
	holder string
}

// claimLease takes the named lease, the picks_run_lease row the daily job also
// uses. An absent table (migration 000132 not applied) runs without it, as the
// daily job does.
func (s backtestStore) claimLease(ctx context.Context, name, holder string) (leaseClaim, error) {
	var got string
	err := s.pool.QueryRow(ctx, claimDailyLeaseSQL, name, holder, dailyLeaseTTLSQL).Scan(&got)
	switch {
	case err == nil:
		return leaseClaim{ok: true, holder: holder}, nil
	case isUndefinedTable(err):
		return leaseClaim{ok: true, holder: holder}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return leaseClaim{}, fmt.Errorf("claim the %s lease: %w", name, err)
	}
	var current string
	if err := s.pool.QueryRow(ctx, leaseHolderOfDailySQL, name).Scan(&current); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return leaseClaim{}, fmt.Errorf("read the %s lease holder: %w", name, err)
	}
	return leaseClaim{ok: false, holder: current}, nil
}

// releaseLease deletes the lease on a detached context, so a cancelled run still
// frees it. It expires on its own when that fails.
func (s backtestStore) releaseLease(name, holder string, logf func(string, ...any)) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx, releaseDailyLeaseSQL, name, holder); err != nil && !isUndefinedTable(err) {
		logf("strategies backtest: releasing the %s lease failed (it expires on its own): %v", name, err)
	}
}

// backtestRequest is one claimed request.
type backtestRequest struct {
	ID         int64
	Kind       string
	StrategyID string
	RulesHash  string
	RecipeHash string
	VariantID  string
}

// enqueue queues each target's weekly publish request, and an immediate one when
// the key has no succeeded run and no request queued or running for it. A new key
// therefore costs one request: the weekly one is queued first, so it is pending
// and the immediate one is not added. Once that weekly request has failed, the
// next execution queues the day's immediate request, and then one each UTC day
// (the day is in its key), so a failing key is retried once a day, not every hour.
// A key with a succeeded run waits for the next ISO week's request.
func (s backtestStore) enqueue(ctx context.Context, targets []backtestTarget, now time.Time) error {
	week := isoWeek(now)
	day := now.UTC().Format("2006-01-02")
	for _, t := range targets {
		sid := t.Reg.Spec.StrategyID
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
			VALUES ('publish', $1, $2, $3, 'schedule', $4, 'queued')
			ON CONFLICT (dedupe_key) DO NOTHING`,
			sid, t.RulesHash, t.RecipeHash, publishDedupeKey(t.RulesHash, t.RecipeHash, engine.Version, week)); err != nil {
			return fmt.Errorf("queue the weekly publish of %s: %w", sid, err)
		}
		var need bool
		if err := s.pool.QueryRow(ctx, `
			SELECT NOT EXISTS (SELECT 1 FROM strategy_backtest_runs
			                    WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
			                      AND engine_version = $4 AND status = 'succeeded' AND kind <> 'verify')
			   AND NOT EXISTS (SELECT 1 FROM strategy_backtest_requests
			                    WHERE kind = 'publish' AND strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
			                      AND status IN ('queued', 'running'))`,
			sid, t.RulesHash, t.RecipeHash, engine.Version).Scan(&need); err != nil {
			return fmt.Errorf("read the queue of %s: %w", sid, err)
		}
		if !need {
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
			VALUES ('publish', $1, $2, $3, 'schedule', $4, 'queued')
			ON CONFLICT (dedupe_key) DO NOTHING`,
			sid, t.RulesHash, t.RecipeHash, asapDedupeKey(t.RulesHash, t.RecipeHash, engine.Version, day)); err != nil {
			return fmt.Errorf("queue the first publish of %s: %w", sid, err)
		}
	}
	return nil
}

// claimBatch takes up to n queued requests, publish before variant and then the
// oldest first. The rows are marked running; FOR UPDATE SKIP LOCKED keeps a
// second writer from taking the same request even if the lease were lost.
func (s backtestStore) claimBatch(ctx context.Context, n int) ([]backtestRequest, error) {
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
		  SELECT id FROM strategy_backtest_requests
		   WHERE status = 'queued'
		   ORDER BY CASE kind WHEN 'publish' THEN 0 ELSE 1 END, requested_at, id
		   LIMIT $1
		   FOR UPDATE SKIP LOCKED)
		UPDATE strategy_backtest_requests r SET status = 'running', started_at = now()
		  FROM picked WHERE r.id = picked.id
		RETURNING r.id, r.kind, r.strategy_id, r.rules_hash, r.recipe_hash, COALESCE(r.variant_id, '')`, n)
	if err != nil {
		return nil, fmt.Errorf("claim the queued requests: %w", err)
	}
	defer rows.Close()
	var out []backtestRequest
	for rows.Next() {
		var r backtestRequest
		if err := rows.Scan(&r.ID, &r.Kind, &r.StrategyID, &r.RulesHash, &r.RecipeHash, &r.VariantID); err != nil {
			return nil, fmt.Errorf("scan a claimed request: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claim the queued requests: %w", err)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := kindRank(out[i].Kind), kindRank(out[j].Kind)
		if ri != rj {
			return ri < rj
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// kindRank orders publish requests before variant ones.
func kindRank(kind string) int {
	if kind == "publish" {
		return 0
	}
	return 1
}

// requeue puts claimed requests back in the queue, for the next execution.
func (s backtestStore) requeue(ctx context.Context, batch []backtestRequest) error {
	if len(batch) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(batch))
	for _, r := range batch {
		ids = append(ids, r.ID)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE strategy_backtest_requests SET status = 'queued', started_at = NULL
		 WHERE id = ANY($1) AND status = 'running'`, ids); err != nil {
		return fmt.Errorf("requeue %d request(s): %w", len(ids), err)
	}
	return nil
}

// failAbandoned fails every request a dead execution left running. Only the lease
// holder claims requests, so under the lease a running row belongs to an execution
// that was SIGKILLed before it could unwind (an out-of-memory kill, or a kill after
// a deadline or drain). It is failed rather than queued again: a request that kills
// every execution that takes it would otherwise be retried on every lease expiry.
// The next execution after this one queues the key's immediate request when the key
// has no succeeded run, so the failure is retried once a UTC day. A SIGTERM does not
// reach this path: the run unwinds and requeues its open requests (see runBacktest).
func (s backtestStore) failAbandoned(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE strategy_backtest_requests
		   SET status = 'failed', error = 'the execution that claimed it did not finish', finished_at = now()
		 WHERE status = 'running'`)
	if err != nil {
		return 0, fmt.Errorf("fail the abandoned requests: %w", err)
	}
	return tag.RowsAffected(), nil
}

// finishRequest marks a request done (ok) or failed, and links the run it made.
func (s backtestStore) finishRequest(ctx context.Context, id, runID int64, errText string, ok bool) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE strategy_backtest_requests
		   SET status = CASE WHEN $2 THEN 'done' ELSE 'failed' END,
		       run_id = NULLIF($3::bigint, 0), error = NULLIF($4, ''), finished_at = now()
		 WHERE id = $1`, id, ok, runID, errText); err != nil {
		return fmt.Errorf("finish request %d: %w", id, err)
	}
	return nil
}

// liveFrom reads the version's live_from and whether its recipe is recorded. The
// daily snapshot records both in its evaluation write. Until it has, the request
// is not ready: it stays queued (errNotReady), rather than failing and waiting for
// the next week.
func (s backtestStore) liveFrom(ctx context.Context, t backtestTarget) (civil.Date, error) {
	var live *time.Time
	var recipeRecorded bool
	err := s.pool.QueryRow(ctx, `
		SELECT v.live_from,
		       EXISTS (SELECT 1 FROM strategy_recipes r WHERE r.recipe_hash = $2)
		  FROM strategy_rule_versions v
		 WHERE v.rules_hash = $1`, t.RulesHash, t.RecipeHash).Scan(&live, &recipeRecorded)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return civil.Date{}, fmt.Errorf("%w: version %s is not recorded yet (the daily snapshot records it)", errNotReady, shortHash(t.RulesHash))
	case err != nil:
		return civil.Date{}, fmt.Errorf("read the live date of %s: %w", shortHash(t.RulesHash), err)
	case !recipeRecorded:
		return civil.Date{}, fmt.Errorf("%w: recipe %s is not recorded yet (the daily snapshot records it)", errNotReady, shortHash(t.RecipeHash))
	case live == nil:
		return civil.Date{}, fmt.Errorf("%w: version %s has no live_from recorded", errNotReady, shortHash(t.RulesHash))
	}
	return civil.DateOf(*live), nil
}

// verifiedRun reports whether a succeeded verify pass already reproduced this
// exact input and output on the current engine. Only such a record satisfies the
// publication gate's verify check: a verify of another input or output does not.
func (s backtestStore) verifiedRun(ctx context.Context, t backtestTarget, inputHash, outputHash string) (bool, error) {
	var has bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM strategy_backtest_runs
		                WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
		                  AND engine_version = $4 AND kind = 'verify' AND status = 'succeeded'
		                  AND input_hash = $5 AND output_hash = $6)`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version, inputHash, outputHash).Scan(&has)
	if err != nil {
		return false, fmt.Errorf("read the verify passes of %s: %w", t.Reg.Spec.StrategyID, err)
	}
	return has, nil
}

// indexWeekendRows counts the XJO and XJT rows dated on a weekend on or before
// windowEnd. Until the index sync re-dates them (the one-off re-fetch), each
// weekday holds the next session's close, so a run over them reads the future.
func indexWeekendRows(ctx context.Context, q queryRower, windowEnd civil.Date) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT count(*)::int FROM index_prices
		 WHERE index_code IN ('XJO', 'XJT') AND date <= $1::date AND EXTRACT(ISODOW FROM date) > 5`,
		windowEnd.String()).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count the weekend-dated index rows: %w", err)
	}
	return n, nil
}

// throughDates are the newest dates a run's inputs reach: the newest ASIC report
// and the newest XJT session on or before the window end.
type throughDates struct {
	ASIC  civil.Date
	Index civil.Date
}

// throughOf is the through-dates of the loaded inputs.
func throughOf(in *backtest.MemoryInputs, windowEnd civil.Date) throughDates {
	var out throughDates
	for _, r := range in.Mkt.ASIC {
		if !r.ReportDate.After(windowEnd) && out.ASIC.Before(r.ReportDate) {
			out.ASIC = r.ReportDate
		}
	}
	for _, b := range in.Mkt.XJT {
		if !b.Date.After(windowEnd) && out.Index.Before(b.Date) {
			out.Index = b.Date
		}
	}
	return out
}

// executionName is the Cloud Run execution name the chart emulates, or "".
func executionName() string {
	return os.Getenv("CLOUD_RUN_EXECUTION")
}

// runWrite is one run to store.
type runWrite struct {
	Target      backtestTarget
	Recipe      spec.Recipe
	Kind        string
	WindowEnd   civil.Date
	Computable  civil.Date
	Label       string
	Disclosures backtest.Disclosures
	Result      backtest.Result
	// Diff is the diff note of a publish; nil for a verify record.
	Diff         *backtest.DiffNote
	Publish      bool
	Verified     bool
	Build        string
	Fundamentals string
	Through      throughDates
	// ReadAt is the batch snapshot's start, the time the run's inputs were read. A
	// later run's diff note lists the revisions recorded after it.
	ReadAt time.Time
}

// writeRun stores one succeeded run, its series and trades, and, when Publish is
// set, flips the key's published run to it, all in one transaction. A run whose
// run key a succeeded run already holds is not stored twice: the existing run is
// returned (and published, when this one is).
func (s backtestStore) writeRun(ctx context.Context, w runWrite) (int64, error) {
	key := w.Disclosures.Identity.RunKey
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin the run write: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if key != "" && w.Kind == "publish" {
		var existing int64
		err := tx.QueryRow(ctx, `
			SELECT id FROM strategy_backtest_runs
			 WHERE run_key = $1 AND status = 'succeeded' AND kind <> 'verify'`, key).Scan(&existing)
		switch {
		case err == nil:
			if w.Publish {
				if err := flipPublished(ctx, tx, w.Target, w.Fundamentals, existing); err != nil {
					return 0, err
				}
			}
			return existing, tx.Commit(ctx)
		case !errors.Is(err, pgx.ErrNoRows):
			return 0, fmt.Errorf("look up run %s: %w", shortHash(key), err)
		}
	}

	id, err := insertRun(ctx, tx, w)
	if err != nil {
		return 0, err
	}
	if w.Kind == "publish" {
		if err := insertSeries(ctx, tx, id, w.Result); err != nil {
			return 0, err
		}
		if err := insertTrades(ctx, tx, id, w.Result.Trades); err != nil {
			return 0, err
		}
	}
	if w.Publish {
		if err := flipPublished(ctx, tx, w.Target, w.Fundamentals, id); err != nil {
			return 0, err
		}
	}
	return id, tx.Commit(ctx)
}

// insertRun writes the run row and returns its id.
func insertRun(ctx context.Context, tx pgx.Tx, w runWrite) (int64, error) {
	d := w.Disclosures
	metrics, err := json.Marshal(map[string]any{
		"total_return":     w.Result.Metrics.TotalReturn,
		"has_total_return": w.Result.Metrics.HasTotalReturn,
		"cagr":             w.Result.Metrics.CAGR,
		"has_cagr":         w.Result.Metrics.HasCAGR,
		"max_drawdown":     w.Result.Metrics.MaxDrawdown,
		"windows":          d.Windows,
	})
	if err != nil {
		return 0, fmt.Errorf("encode run metrics: %w", err)
	}
	summaryMap := map[string]any{
		"state":        "computed",
		"coverage":     d.Coverage,
		"survivorship": d.Survivorship,
		"data_quality": d.DataQuality,
		"sensitivity":  d.Sensitivity,
		"reference":    d.Reference,
		"trades":       w.Result.Metrics.Trades,
		"identity":     map[string]any{"cut_off": d.Identity.CutOff, "in_sample_until": d.Identity.InSampleUntil},
		"verified":     w.Verified,
	}
	if w.Diff != nil {
		summaryMap["diff"] = w.Diff
	}
	summary, err := json.Marshal(summaryMap)
	if err != nil {
		return 0, fmt.Errorf("encode run summary: %w", err)
	}
	diag := map[string]any{}
	if w.Kind == "publish" {
		diag["code_digests"] = d.Identity.Digests
		if !w.ReadAt.IsZero() {
			diag["read_at"] = w.ReadAt.UTC().Format(time.RFC3339Nano)
		}
	}
	diagJSON, err := json.Marshal(diag)
	if err != nil {
		return 0, fmt.Errorf("encode run diagnostics: %w", err)
	}
	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO strategy_backtest_runs (
		  run_key, kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, computable_from, fiscal_label, returns, benchmark_code, fundamentals,
		  input_hash, output_hash, build_revision, goarch, prices_through, asic_report_through, index_through,
		  in_sample_until, metrics, summary, diagnostics, execution, started_at, finished_at)
		VALUES (NULLIF($1, ''), $2, $3, $4, $5, $6, 'succeeded', $7,
		  $8::date, $9::date, $10::date, NULLIF($11, ''), 'total', 'XJT', $12,
		  NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), $16, $17::date, $18::date, $19::date,
		  $20::date, $21::jsonb, $22::jsonb, $23::jsonb, NULLIF($24, ''), now(), now())
		RETURNING id`,
		d.Identity.RunKey, w.Kind, w.Target.Reg.Spec.StrategyID, w.Target.RulesHash, w.Target.RecipeHash,
		engine.Version, false, // flipPublished sets the flag: un-publishing the previous run comes first
		w.Recipe.WindowStart, dateOrNilArg(w.WindowEnd), dateOrNilArg(w.Computable), w.Label, w.Fundamentals,
		d.Identity.InputHash, d.Identity.OutputHash, w.Build, runtime.GOARCH, dateOrNilArg(w.WindowEnd),
		dateOrNilArg(w.Through.ASIC), dateOrNilArg(w.Through.Index),
		dateOrNilArg(d.Identity.InSampleUntil),
		string(metrics), string(summary), string(diagJSON), executionName(),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("write the %s run: %w", w.Kind, err)
	}
	return id, nil
}

// writeNotComputable stores the outcome of a fundamentals strategy whose window
// opens at computable_from, under the strict policy: pass 1 only, no simulation,
// no series or trades. When the derivation finds the date, the row carries the
// computable_from and the fiscal label it found; when it does not, both are NULL
// and the share is recorded. One outcome per key and window end.
func (s backtestStore) writeNotComputable(ctx context.Context, t backtestTarget, from, windowEnd civil.Date, der backtest.Derivation, through throughDates, opts backtestOptions) (int64, error) {
	// One outcome per key and window end: the weekly and the immediate request of a
	// key read the same snapshot and store the same row.
	var existing int64
	err := s.pool.QueryRow(ctx, `
		SELECT id FROM strategy_backtest_runs
		 WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3 AND engine_version = $4
		   AND status = 'succeeded' AND summary->>'state' = 'not_computable' AND window_end = $5::date
		 ORDER BY id DESC LIMIT 1`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version, windowEnd.String()).Scan(&existing)
	switch {
	case err == nil:
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return 0, fmt.Errorf("look up the not-computable run: %w", err)
	}
	summary, err := json.Marshal(map[string]any{
		"state":     "not_computable",
		"share":     der.Share,
		"threshold": backtest.ComputableShare,
	})
	if err != nil {
		return 0, fmt.Errorf("encode the not-computable summary: %w", err)
	}
	var computable civil.Date
	if der.Found {
		computable = der.ComputableFrom
	}
	var id int64
	err = s.pool.QueryRow(ctx, `
		INSERT INTO strategy_backtest_runs (
		  kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, computable_from, fiscal_label, returns, benchmark_code, fundamentals,
		  build_revision, goarch, prices_through, asic_report_through, index_through, summary, execution,
		  started_at, finished_at)
		VALUES ('publish', $1, $2, $3, $4, 'succeeded', false,
		  $5::date, $6::date, $7::date, NULLIF($8, ''), 'total', 'XJT', 'strict',
		  NULLIF($9, ''), $10, $6::date, $11::date, $12::date, $13::jsonb, NULLIF($14, ''),
		  now(), now())
		RETURNING id`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version, from.String(), windowEnd.String(),
		dateOrNilArg(computable), der.FiscalLabel, opts.Build, runtime.GOARCH,
		dateOrNilArg(through.ASIC), dateOrNilArg(through.Index), string(summary), executionName(),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("write the not-computable run: %w", err)
	}
	return id, nil
}

// failRun stores a publish that failed its verify pass, so the failure is on the
// record next to the requests it failed.
func (s backtestStore) failRun(ctx context.Context, t backtestTarget, opts backtestOptions, from, windowEnd civil.Date, cause error) error {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO strategy_backtest_runs (
		  kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, returns, benchmark_code, fundamentals, build_revision, goarch,
		  prices_through, error, execution, started_at, finished_at)
		VALUES ('publish', $1, $2, $3, $4, 'failed', false,
		  $5::date, $6::date, 'total', 'XJT', 'strict', $7, $8, $6::date, $9, NULLIF($10, ''), now(), now())`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version,
		from.String(), windowEnd.String(), opts.Build, runtime.GOARCH, cause.Error(), executionName(),
	); err != nil {
		return fmt.Errorf("record the failed publish: %w", err)
	}
	return nil
}

// flipPublished makes runID the key's published run, un-publishing the previous
// one in the same transaction, so the one-published index is never violated.
func flipPublished(ctx context.Context, tx pgx.Tx, t backtestTarget, fundamentals string, runID int64) error {
	if _, err := tx.Exec(ctx, `
		UPDATE strategy_backtest_runs SET published = false
		 WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3 AND fundamentals = $4
		   AND published AND id <> $5`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, fundamentals, runID); err != nil {
		return fmt.Errorf("unpublish the previous run: %w", err)
	}
	// The published_at marker is what retention and the diff note read: the newest
	// run of a key that was ever published is the previously published run.
	if _, err := tx.Exec(ctx, `
		UPDATE strategy_backtest_runs
		   SET published = true,
		       diagnostics = diagnostics || jsonb_build_object('published_at', to_jsonb(now()))
		 WHERE id = $1`, runID); err != nil {
		return fmt.Errorf("publish run %d: %w", runID, err)
	}
	return nil
}

// seriesPoints is the stored series: parallel arrays, rounded to the millionth.
type seriesPoints struct {
	D  []string  `json:"d"`
	E  []float64 `json:"e"`
	B  []float64 `json:"b"`
	R  []float64 `json:"r"`
	DD []float64 `json:"dd"`
	X  []float64 `json:"x"`
}

// insertSeries stores a canonical run's daily series.
func insertSeries(ctx context.Context, tx pgx.Tx, runID int64, res backtest.Result) error {
	var p seriesPoints
	for _, r := range res.Records {
		p.D = append(p.D, r.Date.String())
		p.E = append(p.E, roundSeries(r.Equity))
		p.B = append(p.B, roundSeries(r.Benchmark))
		p.R = append(p.R, roundSeries(r.Reference))
		p.DD = append(p.DD, roundSeries(r.Drawdown))
		p.X = append(p.X, roundSeries(r.Exposure))
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("encode the series: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO strategy_backtest_series (run_id, points) VALUES ($1, $2::jsonb)`, runID, string(raw)); err != nil {
		return fmt.Errorf("write the series: %w", err)
	}
	return nil
}

// insertTrades stores a run's trades. The return columns are percentages, the
// simulator's fractions times one hundred; the prices are the fills.
func insertTrades(ctx context.Context, tx pgx.Tx, runID int64, trades []backtest.Trade) error {
	for i, t := range trades {
		flags := t.Flags
		if flags == nil {
			flags = []string{}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO strategy_backtest_trades (
			  run_id, seq, stock_code, signal_date, entry_date, entry_price, captured_pivot, entry_score,
			  exit_signal_date, exit_date, exit_price, exit_reason, sessions_held,
			  gross_return_pct, net_return_pct, flags, open)
			VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9::date, $10::date, $11, NULLIF($12, ''), $13,
			  $14, $15, $16, $17)`,
			runID, i+1, t.Code, t.SignalDate.String(), dateOrNilArg(t.EntryDate), t.EntryFill, t.Pivot, float32(t.EntryScore),
			dateOrNilArg(t.ExitSignalDate), dateOrNilArg(t.ExitDate), t.ExitFill, t.ExitReason, t.SessionsHeld,
			t.Gross*100, t.Net*100, flags, t.OpenAtEnd,
		); err != nil {
			return fmt.Errorf("write trade %d: %w", i+1, err)
		}
	}
	return nil
}

// backtestPublishedKept is how many publishes of each key are kept whatever their
// age: the published run and the one it replaced, which the next publish's diff
// note reads. Across engines, so an engine bump keeps the last published run of
// the engine before it.
const backtestPublishedKept = 2

// prune applies the retention: unpublished runs older than 30 days go, except
// the newest succeeded run, the newest succeeded verify record of each key and
// the two newest published runs of each key (ranked by published_at, across
// engines). Requests older than 90 days go. Published runs and their series are
// never pruned here.
func (s backtestStore) prune(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM strategy_backtest_requests
		 WHERE status IN ('done','failed','cancelled')
		   AND finished_at < now() - make_interval(days => $1)`, backtestRequestRetentionDays); err != nil {
		return fmt.Errorf("prune requests: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM strategy_backtest_runs r
		 WHERE NOT r.published
		   AND r.finished_at < now() - make_interval(days => $1)
		   AND r.id NOT IN (
		     SELECT max(id) FROM strategy_backtest_runs
		      WHERE status = 'succeeded' AND kind <> 'verify'
		      GROUP BY strategy_id, rules_hash, recipe_hash, fundamentals)
		   AND r.id NOT IN (
		     SELECT max(id) FROM strategy_backtest_runs
		      WHERE status = 'succeeded' AND kind = 'verify'
		      GROUP BY strategy_id, rules_hash, recipe_hash, engine_version)
		   AND r.id NOT IN (
		     SELECT ranked.id FROM (
		       SELECT id, row_number() OVER (
		         PARTITION BY strategy_id, rules_hash, recipe_hash, fundamentals
		         ORDER BY (diagnostics->>'published_at')::timestamptz DESC, id DESC) AS rn
		         FROM strategy_backtest_runs
		        WHERE status = 'succeeded' AND kind <> 'verify' AND diagnostics ? 'published_at') ranked
		      WHERE ranked.rn <= $2)`, backtestRunRetentionDays, backtestPublishedKept); err != nil {
		return fmt.Errorf("prune runs: %w", err)
	}
	return nil
}

// peakRSSBytes is the process's peak resident set. Darwin reports bytes and
// Linux reports kilobytes.
func peakRSSBytes() (int64, bool) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0, false
	}
	if runtime.GOOS == "darwin" {
		return int64(ru.Maxrss), true
	}
	return int64(ru.Maxrss) * 1024, true
}

// vcsRevision is the VCS revision the binary was built from, or "".
func vcsRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" {
			return s.Value
		}
	}
	return ""
}

// previousPublished is the previously published run of a key on the current
// engine: the most recently published one (the published_at marker, newest first,
// so a run published again after an older one is the previous run). It is nil when
// the key has none yet. The current run is never returned: it is not written until
// after this read.
func (s backtestStore) previousPublished(ctx context.Context, tx pgx.Tx, t backtestTarget, fundamentals string) (*backtest.PreviousRun, error) {
	var (
		id            int64
		pricesThrough string
		asicThrough   string
		readAt        time.Time
		inputHash     string
		digestsJSON   string
		pointsJSON    string
	)
	err := tx.QueryRow(ctx, `
		SELECT r.id, COALESCE(r.prices_through::text, ''), COALESCE(r.asic_report_through::text, ''),
		       COALESCE((r.diagnostics->>'read_at')::timestamptz, r.finished_at, r.started_at),
		       COALESCE(r.input_hash, ''), COALESCE(r.diagnostics->'code_digests', '{}')::text,
		       COALESCE(sr.points::text, '{}')
		  FROM strategy_backtest_runs r
		  LEFT JOIN strategy_backtest_series sr ON sr.run_id = r.id
		 WHERE r.strategy_id = $1 AND r.rules_hash = $2 AND r.recipe_hash = $3
		   AND r.fundamentals = $4 AND r.engine_version = $5
		   AND r.kind = 'publish' AND r.status = 'succeeded' AND r.diagnostics ? 'published_at'
		 ORDER BY (r.diagnostics->>'published_at')::timestamptz DESC, r.id DESC LIMIT 1`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, fundamentals, engine.Version).Scan(
		&id, &pricesThrough, &asicThrough, &readAt, &inputHash, &digestsJSON, &pointsJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the previously published run of %s: %w", t.Reg.Spec.StrategyID, err)
	}
	prev := &backtest.PreviousRun{RunID: id, ReadAt: readAt, InputHash: inputHash}
	if asicThrough != "" {
		if prev.ASICThrough, err = civil.ParseDate(asicThrough); err != nil {
			return nil, fmt.Errorf("previous run %d has an unreadable asic_report_through: %w", id, err)
		}
	}
	through, err := civil.ParseDate(pricesThrough)
	if err != nil {
		return nil, fmt.Errorf("previous run %d has no prices_through: %w", id, err)
	}
	prev.CutOff = backtest.CutOff(through)
	if err := json.Unmarshal([]byte(digestsJSON), &prev.Digests); err != nil {
		return nil, fmt.Errorf("decode the digests of run %d: %w", id, err)
	}
	var pts seriesPoints
	if err := json.Unmarshal([]byte(pointsJSON), &pts); err != nil {
		return nil, fmt.Errorf("decode the series of run %d: %w", id, err)
	}
	for _, d := range pts.D {
		day, err := civil.ParseDate(d)
		if err != nil {
			return nil, fmt.Errorf("decode a series date of run %d: %w", id, err)
		}
		prev.Dates = append(prev.Dates, day)
	}
	prev.Equity = pts.E
	return prev, nil
}

// snapshotTime is the start of the batch's read transaction: the time its inputs
// were read. transaction_timestamp is fixed for the whole transaction.
func snapshotTime(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var at time.Time
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&at); err != nil {
		return time.Time{}, fmt.Errorf("read the snapshot time: %w", err)
	}
	return at, nil
}

// asicRevisions reads the ASIC revisions to reports up to through that were recorded
// after the previous run read its inputs (after), in the same snapshot as the run.
// The table is checked first: a failed statement would abort the batch's transaction,
// and the verify pass reads on it.
func (s backtestStore) asicRevisions(ctx context.Context, tx pgx.Tx, through civil.Date, after time.Time) ([]backtest.ASICRevision, error) {
	var has bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.shorts_revisions') IS NOT NULL`).Scan(&has); err != nil {
		return nil, fmt.Errorf("check for the ASIC revisions table: %w", err)
	}
	if !has {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT report_date::text, product_code, revised_at
		  FROM shorts_revisions
		 WHERE report_date <= $1::date AND revised_at > $2
		 ORDER BY report_date, product_code, id`, through.String(), after)
	if err != nil {
		return nil, fmt.Errorf("read the ASIC revisions: %w", err)
	}
	defer rows.Close()
	var out []backtest.ASICRevision
	for rows.Next() {
		var (
			date string
			r    backtest.ASICRevision
		)
		if err := rows.Scan(&date, &r.Code, &r.RevisedAt); err != nil {
			return nil, fmt.Errorf("scan an ASIC revision: %w", err)
		}
		if r.ReportDate, err = civil.ParseDate(date); err != nil {
			return nil, fmt.Errorf("parse an ASIC revision date: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// diffNote builds a publish's diff note against the key's previously published
// run. The first copy of the history (in) and the run's disclosures are read; the
// revisions are read in the run's own snapshot.
func (s backtestStore) diffNote(ctx context.Context, tx pgx.Tx, t backtestTarget, fundamentals string, in *backtest.MemoryInputs, d backtest.Disclosures, base backtest.Result) (backtest.DiffNote, error) {
	prev, err := s.previousPublished(ctx, tx, t, fundamentals)
	if err != nil {
		return backtest.DiffNote{}, err
	}
	if prev == nil {
		return backtest.NoPrevious(), nil
	}
	revs, err := s.asicRevisions(ctx, tx, prev.ASICThrough, prev.ReadAt)
	if err != nil {
		return backtest.DiffNote{}, err
	}
	// The current curve is compared as it is stored, rounded, so an unchanged path
	// shifts by exactly zero.
	cur := backtest.EquityCurve(base.Records)
	for i, v := range cur.Values {
		cur.Values[i] = roundSeries(v)
	}
	return backtest.DiffAgainst(in, prev, d.Identity.InputHash, cur, revs), nil
}
