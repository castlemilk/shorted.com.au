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

// enqueue queues each target's publish request for this ISO week, and an
// immediate one when the key has no succeeded run on the current engine. Both
// are keyed, so a repeat is a no-op.
func (s backtestStore) enqueue(ctx context.Context, targets []backtestTarget, week string) error {
	for _, t := range targets {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
			VALUES ('publish', $1, $2, $3, 'schedule', $4, 'queued')
			ON CONFLICT (dedupe_key) DO NOTHING`,
			t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, publishDedupeKey(t.RulesHash, t.RecipeHash, engine.Version, week)); err != nil {
			return fmt.Errorf("queue the weekly publish of %s: %w", t.Reg.Spec.StrategyID, err)
		}
		var has bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM strategy_backtest_runs
			                WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
			                  AND engine_version = $4 AND status = 'succeeded' AND kind <> 'verify')`,
			t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version).Scan(&has); err != nil {
			return fmt.Errorf("read the succeeded runs of %s: %w", t.Reg.Spec.StrategyID, err)
		}
		if has {
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
			VALUES ('publish', $1, $2, $3, 'schedule', $4, 'queued')
			ON CONFLICT (dedupe_key) DO NOTHING`,
			t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, asapDedupeKey(t.RulesHash, t.RecipeHash, engine.Version)); err != nil {
			return fmt.Errorf("queue the first publish of %s: %w", t.Reg.Spec.StrategyID, err)
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

// liveFrom reads the version's live_from, which the daily snapshot records. A
// version the database does not record as live has no freeze date to report
// against, so the run is refused rather than guessed.
func (s backtestStore) liveFrom(ctx context.Context, rulesHash string) (civil.Date, error) {
	var t *time.Time
	err := s.pool.QueryRow(ctx, `SELECT live_from FROM strategy_rule_versions WHERE rules_hash = $1`, rulesHash).Scan(&t)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return civil.Date{}, fmt.Errorf("version %s is not recorded yet (the daily snapshot records it)", shortHash(rulesHash))
	case err != nil:
		return civil.Date{}, fmt.Errorf("read the live date of %s: %w", shortHash(rulesHash), err)
	case t == nil:
		return civil.Date{}, fmt.Errorf("version %s has no live_from recorded", shortHash(rulesHash))
	}
	return civil.DateOf(*t), nil
}

// hasVerified reports whether a succeeded verify pass exists for the target's key
// on the current engine.
func (s backtestStore) hasVerified(ctx context.Context, t backtestTarget) (bool, error) {
	var has bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM strategy_backtest_runs
		                WHERE strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
		                  AND engine_version = $4 AND kind = 'verify' AND status = 'succeeded')`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version).Scan(&has)
	if err != nil {
		return false, fmt.Errorf("read the verify passes of %s: %w", t.Reg.Spec.StrategyID, err)
	}
	return has, nil
}

// runWrite is one run to store.
type runWrite struct {
	Target       backtestTarget
	Recipe       spec.Recipe
	Kind         string
	WindowEnd    civil.Date
	Computable   civil.Date
	Label        string
	Disclosures  backtest.Disclosures
	Result       backtest.Result
	Publish      bool
	Verified     bool
	Build        string
	Fundamentals string
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
	summary, err := json.Marshal(map[string]any{
		"state":        "computed",
		"coverage":     d.Coverage,
		"survivorship": d.Survivorship,
		"data_quality": d.DataQuality,
		"sensitivity":  d.Sensitivity,
		"reference":    d.Reference,
		"trades":       w.Result.Metrics.Trades,
		"identity":     map[string]any{"cut_off": d.Identity.CutOff, "in_sample_until": d.Identity.InSampleUntil},
		"verified":     w.Verified,
	})
	if err != nil {
		return 0, fmt.Errorf("encode run summary: %w", err)
	}
	diag := map[string]any{}
	if w.Kind == "publish" {
		diag["code_digests"] = d.Identity.Digests
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
		  input_hash, output_hash, build_revision, goarch, prices_through, index_through, in_sample_until,
		  metrics, summary, diagnostics, started_at, finished_at)
		VALUES (NULLIF($1, ''), $2, $3, $4, $5, $6, 'succeeded', $7,
		  $8::date, $9::date, $10::date, NULLIF($11, ''), 'total', 'XJT', $12,
		  NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), $16, $17::date, $17::date, $18::date,
		  $19::jsonb, $20::jsonb, $21::jsonb, now(), now())
		RETURNING id`,
		d.Identity.RunKey, w.Kind, w.Target.Reg.Spec.StrategyID, w.Target.RulesHash, w.Target.RecipeHash,
		engine.Version, w.Publish,
		w.Recipe.WindowStart, dateOrNilArg(w.WindowEnd), dateOrNilArg(w.Computable), w.Label, w.Fundamentals,
		d.Identity.InputHash, d.Identity.OutputHash, w.Build, runtime.GOARCH, dateOrNilArg(w.WindowEnd),
		d.Identity.InSampleUntil,
		string(metrics), string(summary), string(diagJSON),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("write the %s run: %w", w.Kind, err)
	}
	return id, nil
}

// writeNotComputable stores the outcome of a fundamentals strategy whose window
// is not yet computable: pass 1 only, no simulation, no series.
func (s backtestStore) writeNotComputable(ctx context.Context, t backtestTarget, from, windowEnd civil.Date, der backtest.Derivation, opts backtestOptions) (int64, error) {
	// One outcome per key and window end: the weekly and the immediate request of a
	// key that is not computable read the same snapshot and store the same row.
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
	var id int64
	err = s.pool.QueryRow(ctx, `
		INSERT INTO strategy_backtest_runs (
		  kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, returns, benchmark_code, fundamentals, build_revision, goarch,
		  prices_through, index_through, summary, started_at, finished_at)
		VALUES ('publish', $1, $2, $3, $4, 'succeeded', false,
		  $5::date, $6::date, 'total', 'XJT', 'strict', NULLIF($7, ''), $8, $6::date, $6::date, $9::jsonb, now(), now())
		RETURNING id`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version, from.String(), windowEnd.String(),
		opts.Build, runtime.GOARCH, string(summary),
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
		  prices_through, error, started_at, finished_at)
		VALUES ('publish', $1, $2, $3, $4, 'failed', false,
		  $5::date, $6::date, 'total', 'XJT', 'strict', $7, $8, $6::date, $9, now(), now())`,
		t.Reg.Spec.StrategyID, t.RulesHash, t.RecipeHash, engine.Version,
		from.String(), windowEnd.String(), opts.Build, runtime.GOARCH, cause.Error(),
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
	if _, err := tx.Exec(ctx, `UPDATE strategy_backtest_runs SET published = true WHERE id = $1`, runID); err != nil {
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

// prune applies the retention: unpublished runs older than 30 days go, except
// the newest succeeded run of each key; requests older than 90 days go. Published
// runs and their series are never pruned here.
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
		      GROUP BY strategy_id, rules_hash, recipe_hash, fundamentals)`, backtestRunRetentionDays); err != nil {
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
