package strategies

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The daily job's database writes. Every statement is keyed by session and
// upserted, so a run that repeats a session writes the same rows.

// dailyLeaseName is the picks_run_lease row the daily job holds while it runs.
const dailyLeaseName = "strategies-daily"

// dailyLeaseTTL is how long a claimed lease lasts without an extension.
const dailyLeaseTTL = 2 * time.Hour

// dailyLeaseTTLSQL is dailyLeaseTTL as a Postgres interval.
const dailyLeaseTTLSQL = "2 hours"

const (
	claimDailyLeaseSQL = `
		INSERT INTO picks_run_lease AS l (name, holder, expires_at)
		VALUES ($1, $2, now() + $3::interval)
		ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
		WHERE l.expires_at < now() OR l.holder = EXCLUDED.holder
		RETURNING holder`
	leaseHolderOfDailySQL = `SELECT holder FROM picks_run_lease WHERE name = $1`
	releaseDailyLeaseSQL  = `DELETE FROM picks_run_lease WHERE name = $1 AND holder = $2`
)

// store is the daily job's pool-backed writer and reader.
type store struct {
	pool *pgxpool.Pool
}

// claimLease takes the daily lease. absent is true when picks_run_lease does not
// exist yet (migration 000132 not applied): the run goes ahead without it, as the
// picks job does. proceed is false when another execution holds it.
func (s store) claimLease(ctx context.Context, holder string) (proceed bool, absent bool, current string, err error) {
	var got string
	err = s.pool.QueryRow(ctx, claimDailyLeaseSQL, dailyLeaseName, holder, dailyLeaseTTLSQL).Scan(&got)
	switch {
	case err == nil:
		return true, false, holder, nil
	case isUndefinedTable(err):
		return true, true, "", nil
	case !errors.Is(err, pgx.ErrNoRows):
		return false, false, "", fmt.Errorf("claim the daily lease: %w", err)
	}
	if err := s.pool.QueryRow(ctx, leaseHolderOfDailySQL, dailyLeaseName).Scan(&current); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, false, "", fmt.Errorf("read the daily lease holder: %w", err)
	}
	return false, false, current, nil
}

// releaseLease deletes the lease row on a detached context, so a cancelled run
// still frees it. It expires on its own when that fails.
func (s store) releaseLease(holder string, logf func(string, ...any)) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx, releaseDailyLeaseSQL, dailyLeaseName, holder); err != nil && !isUndefinedTable(err) {
		logf("strategies: releasing the daily lease failed (it expires on its own): %v", err)
	}
}

// phaseNames is the phases a session completes, in the order the job runs them.
var phaseNames = []string{phaseFeatures, phaseEvaluation, phaseEvents}

// completedPhases returns which of the session's phases completed.
func (s store) completedPhases(ctx context.Context, d civil.Date) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT phase FROM strategy_daily_runs WHERE as_of = $1::date AND status = 'completed'`, d.String())
	if err != nil {
		if isUndefinedTable(err) {
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("read completed phases of %s: %w", d, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scan completed phase: %w", err)
		}
		out[p] = true
	}
	return out, rows.Err()
}

// completedSessions returns the sessions whose every phase completed, newest
// first, up to the given date (inclusive when inclusive is true, else before it).
// A session is complete only when all phaseNames completed.
func (s store) completedSessions(ctx context.Context, upTo civil.Date, inclusive bool, limit int) ([]civil.Date, error) {
	op := "<"
	if inclusive {
		op = "<="
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT as_of FROM strategy_daily_runs
		 WHERE as_of %s $1::date AND phase = ANY($2) AND status = 'completed'
		 GROUP BY as_of
		HAVING count(DISTINCT phase) = $3
		 ORDER BY as_of DESC
		 LIMIT $4`, op), upTo.String(), phaseNames, len(phaseNames), limit)
	if err != nil {
		if isUndefinedTable(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read completed sessions: %w", err)
	}
	defer rows.Close()
	var out []civil.Date
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("scan completed session: %w", err)
		}
		out = append(out, civil.DateOf(t))
	}
	return out, rows.Err()
}

// runRow is one strategy_daily_runs row.
type runRow struct {
	AsOf          civil.Date
	Phase         string
	Status        string
	EngineVersion string
	RulesHashes   []string
	Report        civil.Date
	Avail         civil.Date
	XJO           civil.Date
	Counts        string // a JSON object
	Note          string
}

// writeRun upserts one phase's run row. A completed or held row gets its finish
// time; a running one does not.
func (s store) writeRun(ctx context.Context, w runWriter, r runRow) error {
	hashes := r.RulesHashes
	if hashes == nil {
		hashes = []string{}
	}
	counts := r.Counts
	if counts == "" {
		counts = "{}"
	}
	_, err := w.Exec(ctx, `
		INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version, rules_hashes,
			asic_report_date, asic_available_date, xjo_date, counts, note, started_at, finished_at)
		VALUES ($1::date, $2, $3, $4, $5::text[], $6::date, $7::date, $8::date, $9::jsonb, $10, now(),
			CASE WHEN $3 IN ('completed','held','failed') THEN now() END)
		ON CONFLICT (as_of, phase) DO UPDATE SET
			status = EXCLUDED.status, engine_version = EXCLUDED.engine_version,
			rules_hashes = EXCLUDED.rules_hashes, asic_report_date = EXCLUDED.asic_report_date,
			asic_available_date = EXCLUDED.asic_available_date, xjo_date = EXCLUDED.xjo_date,
			counts = EXCLUDED.counts, note = EXCLUDED.note,
			started_at = now(), finished_at = EXCLUDED.finished_at`,
		r.AsOf.String(), r.Phase, r.Status, r.EngineVersion, hashes,
		dateOrNilArg(r.Report), dateOrNilArg(r.Avail), dateOrNilArg(r.XJO), counts, textOrNil(r.Note))
	if err != nil {
		return fmt.Errorf("write %s run for %s: %w", r.Phase, r.AsOf, err)
	}
	return nil
}

// runWriter is the part of pgxpool.Pool and pgx.Tx that writeRun needs.
type runWriter interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func dateOrNilArg(d civil.Date) any {
	if d.IsZero() {
		return nil
	}
	return d.String()
}

func textOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// liveVersion is a canonical version the database records as live.
type liveVersion struct {
	RulesHash string
	Label     string
	LiveFrom  civil.Date
}

// liveVersions reads the canonical versions recorded as live, keyed by rules hash.
func (s store) liveVersions(ctx context.Context) (map[string]liveVersion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT rules_hash, label, live_from FROM strategy_rule_versions
		 WHERE status = 'live' AND kind = 'canonical'`)
	if err != nil {
		if isUndefinedTable(err) {
			return map[string]liveVersion{}, nil
		}
		return nil, fmt.Errorf("read live versions: %w", err)
	}
	defer rows.Close()
	out := map[string]liveVersion{}
	for rows.Next() {
		var (
			v    liveVersion
			from *time.Time
		)
		if err := rows.Scan(&v.RulesHash, &v.Label, &from); err != nil {
			return nil, fmt.Errorf("scan live version: %w", err)
		}
		if from != nil {
			v.LiveFrom = civil.DateOf(*from)
		}
		out[v.RulesHash] = v
	}
	return out, rows.Err()
}

// versionRow is one rule version to record: a registered canonical version.
type versionRow struct {
	Hash      string
	Canonical []byte
	Reg       spec.Registered
}

// registeredVersions hashes every registered canonical version.
func registeredVersions(regs []spec.Registered) ([]versionRow, error) {
	out := make([]versionRow, 0, len(regs))
	for _, r := range regs {
		h, err := spec.RulesHash(r.Spec)
		if err != nil {
			return nil, fmt.Errorf("hash %s %s: %w", r.Spec.StrategyID, r.Label, err)
		}
		canon, err := spec.Canonical(r.Spec)
		if err != nil {
			return nil, fmt.Errorf("canonical %s %s: %w", r.Spec.StrategyID, r.Label, err)
		}
		out = append(out, versionRow{Hash: h, Canonical: canon, Reg: r})
	}
	return out, nil
}

// newlyLive returns the registered live versions the database does not record
// as live yet: a first session, or a promotion. A version that is not live in the
// registry is never returned.
func newlyLive(versions []versionRow, live map[string]liveVersion) map[string]bool {
	out := map[string]bool{}
	for _, v := range versions {
		if !v.Reg.Live {
			continue
		}
		if _, ok := live[v.Hash]; !ok {
			out[v.Hash] = true
		}
	}
	return out
}

// upsertVersions records the registered canonical versions. A live version
// supersedes the other live version of its strategy first, so the one-live index
// is never violated; the new one takes live_from = d.
func (s store) upsertVersions(ctx context.Context, w runWriter, d civil.Date, versions []versionRow) error {
	for _, v := range versions {
		status := "superseded"
		if v.Reg.Live {
			status = "live"
			if _, err := w.Exec(ctx, `
				UPDATE strategy_rule_versions SET status = 'superseded', superseded_on = $3::date
				 WHERE strategy_id = $1 AND kind = 'canonical' AND status = 'live' AND rules_hash <> $2`,
				v.Reg.Spec.StrategyID, v.Hash, d.String()); err != nil {
				return fmt.Errorf("supersede live %s: %w", v.Reg.Spec.StrategyID, err)
			}
		}
		var from any
		if v.Reg.Live {
			from = d.String()
		}
		changes := v.Reg.Changes
		if changes == nil {
			changes = []string{}
		}
		known := v.Reg.KnownIssues
		if known == nil {
			known = []string{}
		}
		if _, err := w.Exec(ctx, `
			INSERT INTO strategy_rule_versions (rules_hash, strategy_id, label, kind, engine_major,
				feature_set, canonical_json, status, live_from, changes, known_issues)
			VALUES ($1, $2, $3, 'canonical', $4, $5, $6::jsonb, $7, $8::date, $9::text[], $10::text[])
			ON CONFLICT (rules_hash) DO UPDATE SET status = EXCLUDED.status, live_from = EXCLUDED.live_from
			 WHERE strategy_rule_versions.status <> EXCLUDED.status`,
			v.Hash, v.Reg.Spec.StrategyID, v.Reg.Label, v.Reg.Spec.EngineMajor, v.Reg.Spec.FeatureSet,
			string(v.Canonical), status, from, changes, known); err != nil {
			return fmt.Errorf("upsert version %s %s: %w", v.Reg.Spec.StrategyID, v.Reg.Label, err)
		}
	}
	return nil
}

// upsertRecipes records the registered execution recipes by hash.
func upsertRecipes(ctx context.Context, w runWriter, recipes []spec.Recipe) error {
	for _, r := range recipes {
		h, err := spec.RecipeHash(r)
		if err != nil {
			return fmt.Errorf("hash recipe %s: %w", r.ID, err)
		}
		canon, err := spec.RecipeCanonical(r)
		if err != nil {
			return fmt.Errorf("canonical recipe %s: %w", r.ID, err)
		}
		if _, err := w.Exec(ctx, `
			INSERT INTO strategy_recipes (recipe_hash, strategy_id, recipe_id, canonical_json)
			VALUES ($1, $2, $3, $4::jsonb)
			ON CONFLICT (recipe_hash) DO NOTHING`, h, r.StrategyID, r.ID, string(canon)); err != nil {
			return fmt.Errorf("upsert recipe %s: %w", r.ID, err)
		}
	}
	return nil
}

// eventRow is one signal event to record.
type eventRow struct {
	RulesHash     string
	EngineVersion string
	StrategyID    string
	Code          string
	AsOf          civil.Date
	PrevAsOf      civil.Date
	From          string
	To            string
	Score         *float64
	Evidence      string // a JSON object
}

// insertEvents writes the events, skipping any the unique key already holds.
func insertEvents(ctx context.Context, w batchWriter, events []eventRow) error {
	if len(events) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, e := range events {
		batch.Queue(`
			INSERT INTO strategy_signal_events (rules_hash, engine_version, strategy_id, stock_code, as_of,
				prev_as_of, from_status, to_status, score, evidence)
			VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10::jsonb)
			ON CONFLICT (rules_hash, stock_code, as_of) DO NOTHING`,
			e.RulesHash, e.EngineVersion, e.StrategyID, e.Code, e.AsOf.String(), dateOrNilArg(e.PrevAsOf),
			e.From, e.To, e.Score, e.Evidence)
	}
	br := w.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range events {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("insert signal events: %w", err)
		}
	}
	return nil
}

// batchWriter is the part of pgxpool.Pool and pgx.Tx that insertEvents needs.
type batchWriter interface {
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
}

// sortDates sorts dates oldest first.
func sortDates(ds []civil.Date) {
	sort.Slice(ds, func(i, j int) bool { return ds[i].Before(ds[j]) })
}

// isUndefinedTable reports SQLSTATE 42P01: a relation a later migration adds is
// not there yet, so the read answers empty and the run says so.
func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}
