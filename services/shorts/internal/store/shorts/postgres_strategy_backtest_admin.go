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
// for a live canonical version. The store refuses what the job would not run.
type StrategyBacktestQueueAdminStore interface {
	QueueStrategyBacktest(ctx context.Context, req QueueStrategyBacktestRequest) (QueueStrategyBacktestResult, error)
}

// rulesHashPattern is a rules hash: 64 lowercase hexadecimal characters.
var rulesHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ErrBacktestRefused is a queue request the store refuses. Its message says why,
// after the sentinel's text and a colon.
var ErrBacktestRefused = errors.New("backtest request refused")

// QueueStrategyBacktestRequest names one canonical version to queue a publish for.
type QueueStrategyBacktestRequest struct {
	// Version is a label (for example v1, with StrategyID) or a full rules hash.
	StrategyID string
	Version    string
	// RecipeID names the recipe when the strategy records more than one.
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

// versionRow is a recorded version's identity and status.
type versionRow struct {
	StrategyID string
	Label      string
	Kind       string
	Status     string
	RulesHash  string
}

// checkBacktestVersion refuses what the backtest job would not run: a variant, a
// version that is not live, and the pre-recipe v0.
func checkBacktestVersion(v versionRow) error {
	switch {
	case v.Kind != "canonical":
		return fmt.Errorf("%w: the version names a variant; only canonical versions are backtested here", ErrBacktestRefused)
	case v.Status != "live":
		return fmt.Errorf("%w: %s %s is %s, not live", ErrBacktestRefused, v.StrategyID, v.Label, v.Status)
	case v.Label == "v0":
		return fmt.Errorf("%w: v0 has no recipe to backtest", ErrBacktestRefused)
	}
	return nil
}

// QueueStrategyBacktest queues one publish request for a live canonical version
// and its recipe. The backtest job claims it at its next execution. A key with a
// request already queued or running is not queued twice.
func (s *postgresStore) QueueStrategyBacktest(ctx context.Context, req QueueStrategyBacktestRequest) (QueueStrategyBacktestResult, error) {
	var out QueueStrategyBacktestResult
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return out, fmt.Errorf("begin the backtest request: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	v, err := resolveBacktestVersion(ctx, tx, req)
	if err != nil {
		return out, backtestQueueError(err)
	}
	if err := checkBacktestVersion(v); err != nil {
		return out, err
	}

	recipe, err := resolveBacktestRecipe(ctx, tx, v.StrategyID, req.RecipeID)
	if err != nil {
		return out, backtestQueueError(err)
	}

	out.StrategyID, out.Label = v.StrategyID, v.Label
	err = tx.QueryRow(ctx, `
		SELECT id FROM strategy_backtest_requests
		 WHERE kind = 'publish' AND strategy_id = $1 AND rules_hash = $2 AND recipe_hash = $3
		   AND status IN ('queued', 'running')
		 ORDER BY id LIMIT 1`, v.StrategyID, v.RulesHash, recipe).Scan(&out.RequestID)
	if err == nil {
		out.Status = "already_queued"
		return out, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, backtestQueueError(err)
	}

	dedupe := fmt.Sprintf("publish:%s:%s:admin:%d", v.RulesHash, recipe, time.Now().UnixNano())
	err = tx.QueryRow(ctx, `
		INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, requested_by, dedupe_key, status)
		VALUES ('publish', $1, $2, $3, NULLIF($4, ''), $5, 'queued')
		RETURNING id`, v.StrategyID, v.RulesHash, recipe, req.Actor, dedupe).Scan(&out.RequestID)
	if err != nil {
		return out, backtestQueueError(err)
	}
	out.Status = "queued"
	return out, tx.Commit(ctx)
}

// resolveBacktestVersion finds the one recorded version a request names.
func resolveBacktestVersion(ctx context.Context, tx pgx.Tx, req QueueStrategyBacktestRequest) (versionRow, error) {
	var (
		rows pgx.Rows
		err  error
	)
	if rulesHashPattern.MatchString(req.Version) {
		rows, err = tx.Query(ctx, `
			SELECT strategy_id, label, kind, status, rules_hash FROM strategy_rule_versions WHERE rules_hash = $1`, req.Version)
	} else {
		if req.StrategyID == "" {
			return versionRow{}, fmt.Errorf("%w: a label needs its strategy_id", ErrBacktestRefused)
		}
		rows, err = tx.Query(ctx, `
			SELECT strategy_id, label, kind, status, rules_hash FROM strategy_rule_versions
			 WHERE strategy_id = $1 AND label = $2 AND kind = 'canonical'`, req.StrategyID, req.Version)
	}
	if err != nil {
		return versionRow{}, err
	}
	defer rows.Close()
	var found []versionRow
	for rows.Next() {
		var v versionRow
		if err := rows.Scan(&v.StrategyID, &v.Label, &v.Kind, &v.Status, &v.RulesHash); err != nil {
			return versionRow{}, err
		}
		found = append(found, v)
	}
	if err := rows.Err(); err != nil {
		return versionRow{}, err
	}
	switch len(found) {
	case 0:
		return versionRow{}, fmt.Errorf("%w: no recorded version matches %q", ErrBacktestRefused, req.Version)
	case 1:
		return found[0], nil
	}
	return versionRow{}, fmt.Errorf("%w: %d versions match %q; name the rules hash", ErrBacktestRefused, len(found), req.Version)
}

// resolveBacktestRecipe is the one recipe a strategy records, or the one a request names.
func resolveBacktestRecipe(ctx context.Context, tx pgx.Tx, strategyID, recipeID string) (string, error) {
	rows, err := tx.Query(ctx, `
		SELECT recipe_hash, recipe_id FROM strategy_recipes
		 WHERE strategy_id = $1 AND ($2 = '' OR recipe_id = $2)
		 ORDER BY recipe_id`, strategyID, recipeID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var hashes, ids []string
	for rows.Next() {
		var h, id string
		if err := rows.Scan(&h, &id); err != nil {
			return "", err
		}
		hashes = append(hashes, h)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	switch len(hashes) {
	case 0:
		return "", fmt.Errorf("%w: no recipe is recorded for %s yet (the daily snapshot records it)", ErrBacktestRefused, strategyID)
	case 1:
		return hashes[0], nil
	}
	return "", fmt.Errorf("%w: %s records %d recipes (%v); name one with recipe_id", ErrBacktestRefused, strategyID, len(ids), ids)
}

// backtestQueueError names a missing table as the migration it needs.
func backtestQueueError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		return fmt.Errorf("%w: the backtest tables do not exist yet (migration 000158 not applied)", ErrBacktestRefused)
	}
	return err
}
