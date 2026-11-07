package shorts

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The admin view and the admin queue of the strategy backtest job (000158). Every
// field is an aggregate or a canonical run's own facts: no user identifier, no
// email address, no alert or variant name, no rules hash. The queue is written
// only by queue_strategy_backtest, and only for a canonical live version.

// StrategyBacktestQueueRow is the request queue's length by kind and status.
type StrategyBacktestQueueRow struct {
	Kind   string
	Status string
	Count  int64
	// OldestAt is the oldest request in this group, RFC 3339; "" when none.
	OldestAt string
}

// StrategyBacktestRunRow is one canonical backtest run.
type StrategyBacktestRunRow struct {
	StrategyID    string
	Label         string
	Kind          string
	Status        string
	State         string
	EngineVersion string
	Published     bool
	WindowEnd     string
	FinishedAt    string
	// DiffState is the run's diff note state ("none", "unchanged", "changed").
	DiffState string
	// RewrittenCodes is the count of codes whose history the diff note lists.
	RewrittenCodes int64
}

// backtestRunsShown bounds the recent canonical runs the status reports.
const backtestRunsShown = 10

// strategyBacktestStatus reads the queue and the newest canonical runs into out.
// A database without 000158 leaves both empty, not an error.
func (s *postgresStore) strategyBacktestStatus(ctx context.Context, out *StrategyDailyStatus) error {
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		qrows, err := tx.Query(ctx, `
			SELECT kind, status, count(*), COALESCE(to_char(min(requested_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
			  FROM strategy_backtest_requests
			 WHERE status IN ('queued', 'running')
			 GROUP BY kind, status
			 ORDER BY kind, status`)
		if err != nil {
			return err
		}
		for qrows.Next() {
			var r StrategyBacktestQueueRow
			if err := qrows.Scan(&r.Kind, &r.Status, &r.Count, &r.OldestAt); err != nil {
				qrows.Close()
				return err
			}
			out.BacktestQueue = append(out.BacktestQueue, r)
		}
		qrows.Close()
		if err := qrows.Err(); err != nil {
			return err
		}

		rrows, err := tx.Query(ctx, `
			SELECT r.strategy_id, v.label, r.kind, r.status, COALESCE(r.summary->>'state', ''), r.engine_version,
			       r.published, COALESCE(r.window_end::text, ''),
			       COALESCE(to_char(COALESCE(r.finished_at, r.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
			       COALESCE(r.summary->'diff'->>'state', ''),
			       COALESCE((r.summary->'diff'->>'rewritten_count')::bigint, 0)
			  FROM strategy_backtest_runs r
			  JOIN strategy_rule_versions v ON v.rules_hash = r.rules_hash AND v.kind = 'canonical'
			 WHERE r.variant_id IS NULL
			 ORDER BY r.id DESC
			 LIMIT $1`, backtestRunsShown)
		if err != nil {
			return err
		}
		defer rrows.Close()
		for rrows.Next() {
			var r StrategyBacktestRunRow
			if err := rrows.Scan(&r.StrategyID, &r.Label, &r.Kind, &r.Status, &r.State, &r.EngineVersion,
				&r.Published, &r.WindowEnd, &r.FinishedAt, &r.DiffState, &r.RewrittenCodes); err != nil {
				return err
			}
			out.BacktestRuns = append(out.BacktestRuns, r)
		}
		return rrows.Err()
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return nil
		}
		return fmt.Errorf("read the backtest status: %w", err)
	}
	return nil
}

// StrategyBacktestQueueAdminStore is the admin queue's write: one publish request
// for a canonical version and its recipe. The service resolves the request from the
// code registry (the live version the job runs) before it reaches the store, so the
// store checks only what the database records about that pair.
type StrategyBacktestQueueAdminStore interface {
	QueueStrategyBacktest(ctx context.Context, req QueueStrategyBacktestRequest) (QueueStrategyBacktestResult, error)
}

// rulesHashPattern is a rules hash: 64 lowercase hexadecimal characters.
var rulesHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ErrBacktestRefused is a queue request the store refuses. Its message says why,
// after the sentinel's text and a colon.
var ErrBacktestRefused = errors.New("backtest request refused")

// QueueStrategyBacktestRequest names one canonical version and its recipe to queue a
// publish for. The service fills the hashes from the registry; RecipeID is the
// caller's optional check against it and the store does not read it.
type QueueStrategyBacktestRequest struct {
	// StrategyID and Version (the label) name the version, for the answer.
	StrategyID string
	Version    string
	// RulesHash and RecipeHash are the pair the backtest job matches its requests on.
	RulesHash  string
	RecipeHash string
	// RecipeID is the recipe the caller named, if any; checked by the service.
	RecipeID string
	// Actor is the caller's audit identity, stored on the request and never returned.
	Actor string
}

// QueueStrategyBacktestResult is the request the store holds for the key.
type QueueStrategyBacktestResult struct {
	RequestID  int64
	StrategyID string
	Label      string
	// Status is "queued" for a new request, "already_queued" when one for the key is waiting or running.
	Status string
}

// versionRow is a recorded version's identity.
type versionRow struct {
	StrategyID string
	Label      string
	Kind       string
	RulesHash  string
}

// checkBacktestVersion refuses a recorded version the backtest job would not run: a
// variant, and the pre-recipe v0. Liveness is the registry's, resolved by the service.
func checkBacktestVersion(v versionRow) error {
	switch {
	case v.Kind != "canonical":
		return fmt.Errorf("%w: the version names a variant; only canonical versions are backtested here", ErrBacktestRefused)
	case v.Label == "v0":
		return fmt.Errorf("%w: v0 has no recipe to backtest", ErrBacktestRefused)
	}
	return nil
}

// QueueStrategyBacktest queues one publish request for a canonical version and its
// recipe. The backtest job claims it at its next execution. A key with a request
// already queued or running is not queued twice.
func (s *postgresStore) QueueStrategyBacktest(ctx context.Context, req QueueStrategyBacktestRequest) (QueueStrategyBacktestResult, error) {
	var out QueueStrategyBacktestResult
	if !rulesHashPattern.MatchString(req.RulesHash) || !rulesHashPattern.MatchString(req.RecipeHash) {
		return out, fmt.Errorf("%w: the request names no registered version and recipe", ErrBacktestRefused)
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return out, fmt.Errorf("begin the backtest request: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	v, err := recordedBacktestVersion(ctx, tx, req.RulesHash)
	if err != nil {
		return out, backtestQueueError(err)
	}
	if err := checkBacktestVersion(v); err != nil {
		return out, err
	}
	if err := checkRecipeRecorded(ctx, tx, req.RecipeHash); err != nil {
		return out, backtestQueueError(err)
	}

	out.StrategyID, out.Label = v.StrategyID, v.Label
	err = tx.QueryRow(ctx, `
		SELECT id FROM strategy_backtest_requests
		 WHERE kind = 'publish' AND strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
		   AND status IN ('queued', 'running')
		 ORDER BY id LIMIT 1`, v.StrategyID, req.RulesHash, req.RecipeHash).Scan(&out.RequestID)
	if err == nil {
		out.Status = "already_queued"
		return out, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, backtestQueueError(err)
	}

	dedupe := fmt.Sprintf("publish:%s:%s:admin:%d", req.RulesHash, req.RecipeHash, time.Now().UnixNano())
	err = tx.QueryRow(ctx, `
		INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
		VALUES ('publish', $1, $2, $3, NULLIF($4, ''), $5, 'queued')
		RETURNING id`, v.StrategyID, req.RulesHash, req.RecipeHash, req.Actor, dedupe).Scan(&out.RequestID)
	if err != nil {
		return out, backtestQueueError(err)
	}
	out.Status = "queued"
	return out, tx.Commit(ctx)
}

// recordedBacktestVersion reads the recorded version a request's rules hash names.
// The daily snapshot records a version; until it has, the request is refused.
func recordedBacktestVersion(ctx context.Context, tx pgx.Tx, rulesHash string) (versionRow, error) {
	var v versionRow
	err := tx.QueryRow(ctx, `
		SELECT strategy_id, label, kind, rules_hash FROM strategy_rule_versions WHERE rules_hash = $1`, rulesHash).Scan(
		&v.StrategyID, &v.Label, &v.Kind, &v.RulesHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return versionRow{}, fmt.Errorf("%w: the version is not recorded yet (the daily snapshot records it)", ErrBacktestRefused)
	}
	return v, err
}

// checkRecipeRecorded refuses a recipe the daily snapshot has not recorded.
func checkRecipeRecorded(ctx context.Context, tx pgx.Tx, recipeHash string) error {
	var recorded bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM strategy_recipes WHERE recipe_hash = $1)`, recipeHash).Scan(&recorded); err != nil {
		return err
	}
	if !recorded {
		return fmt.Errorf("%w: the recipe is not recorded yet (the daily snapshot records it)", ErrBacktestRefused)
	}
	return nil
}

// backtestQueueError names a missing table as the migration it needs.
func backtestQueueError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		return fmt.Errorf("%w: the backtest tables do not exist yet (migration 000158 not applied)", ErrBacktestRefused)
	}
	return err
}
