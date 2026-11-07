package strategies

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Readiness decides whether a session's inputs are complete enough to snapshot.
// A held session is written as held and retried by the next run; nothing is
// computed from a partial day.

// sweepDayStart is the time of day, UTC, from which a price sweep counts as the
// session's own (readiness rule b).
const sweepDayStart = 5*time.Hour + 30*time.Minute

// readinessFacts are the database facts the rules read, gathered once per session.
type readinessFacts struct {
	ASICSyncRunning bool
	// Sweep is the newest price-sweep row; nil when there is none.
	Sweep *sweepFact
	// Priced is the number of codes with a bar dated s and volume above zero.
	Priced int
	// PriorPriced is the same count for each of the previous sessions.
	PriorPriced []int
	XJOBar      bool
	// XJOWeekendRows is true when the XJO index stores a bar dated on a Saturday or
	// Sunday inside the bar window: the index's stored dates are not yet exchange
	// dates (the index sync that re-dates them has not run).
	XJOWeekendRows bool
}

// sweepFact is the newest price-sweep row of sync_status.
type sweepFact struct {
	Status    string
	StartedAt time.Time
}

// evaluateReadiness applies the four rules to one session. The reason is empty
// when the session is ready. The rules run in order, so the first one that fails
// is the reason the session is held.
//
//	(a) no ASIC sync is writing shorts;
//	(b) the newest price sweep started on or after the session's 05:30 UTC and completed;
//	(c) the priced codes are at least 85% of the median of the previous ten sessions;
//	(d) the XJO index has a bar dated the session;
//	(e) the XJO index has no weekend-dated bar in the bar window.
func evaluateReadiness(s civil.Date, f readinessFacts) (bool, string) {
	if f.ASICSyncRunning {
		return false, "asic_sync_running"
	}
	start := time.Date(s.Year, s.Month, s.Day, 0, 0, 0, 0, time.UTC).Add(sweepDayStart)
	switch {
	case f.Sweep == nil:
		return false, "no_price_sweep"
	case f.Sweep.StartedAt.Before(start):
		return false, "price_sweep_not_yet_run"
	case f.Sweep.Status != "completed":
		return false, "price_sweep_" + f.Sweep.Status
	}
	if f.Priced == 0 {
		return false, "no_priced_codes"
	}
	if m := medianInt(f.PriorPriced); m > 0 && float64(f.Priced) < readinessFraction*m {
		return false, fmt.Sprintf("priced_codes_%d_below_%d_percent_of_median_%g", f.Priced, int(readinessFraction*100), m)
	}
	if !f.XJOBar {
		return false, "xjo_bar_missing"
	}
	if f.XJOWeekendRows {
		return false, "xjo_weekend_rows"
	}
	return true, ""
}

// medianInt is the median of the counts, the mean of the two middle values when
// the count is even. Zero when there are no counts.
func medianInt(vals []int) float64 {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]int(nil), vals...)
	sort.Ints(sorted)
	n := len(sorted)
	if n%2 == 1 {
		return float64(sorted[n/2])
	}
	return float64(sorted[n/2-1]+sorted[n/2]) / 2
}

// readinessDB gathers a session's readiness facts. The sweep is the complement
// of the ASIC sync's rows: the ASIC sync always sets environment and hostname,
// the market-data serve's single-stock runs have a total of one, so neither
// counts.
func readinessDB(ctx context.Context, pool *pgxpool.Pool, s civil.Date) (readinessFacts, error) {
	var f readinessFacts
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM sync_status
		                WHERE status = 'running' AND started_at > now() - interval '2 hours'
		                  AND environment IS NOT NULL AND hostname IS NOT NULL)`).Scan(&f.ASICSyncRunning); err != nil {
		return f, fmt.Errorf("read ASIC sync state: %w", err)
	}

	var sw sweepFact
	err := pool.QueryRow(ctx, `
		SELECT status, started_at FROM sync_status
		 WHERE environment IS NULL AND hostname IS NULL AND checkpoint_stocks_total > 1
		 ORDER BY started_at DESC LIMIT 1`).Scan(&sw.Status, &sw.StartedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		f.Sweep = nil
	case err != nil:
		return f, fmt.Errorf("read the newest price sweep: %w", err)
	default:
		f.Sweep = &sw
	}

	prior := previousSessions(s, priceFloorSessions)
	from := s
	if len(prior) > 0 {
		from = prior[len(prior)-1]
	}
	counts, err := pricedCounts(ctx, pool, from, s)
	if err != nil {
		return f, err
	}
	f.Priced = counts[s]
	for _, d := range prior {
		f.PriorPriced = append(f.PriorPriced, counts[d])
	}

	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM index_prices WHERE index_code = $1 AND date = $2::date)`,
		"XJO", s.String()).Scan(&f.XJOBar); err != nil {
		return f, fmt.Errorf("read XJO bar: %w", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM index_prices
		                WHERE index_code = $1 AND date BETWEEN $2::date AND $3::date
		                  AND EXTRACT(ISODOW FROM date) > 5)`,
		"XJO", s.AddDays(-barLookbackDays).String(), s.String()).Scan(&f.XJOWeekendRows); err != nil {
		return f, fmt.Errorf("read XJO weekend rows: %w", err)
	}
	return f, nil
}

// pricedCounts counts, per date in [from, to], the codes with a priced bar and a
// volume above zero. A date with no such bar has no entry.
func pricedCounts(ctx context.Context, pool *pgxpool.Pool, from, to civil.Date) (map[civil.Date]int, error) {
	rows, err := pool.Query(ctx, `
		SELECT date::date, count(*)::int FROM stock_prices
		 WHERE date BETWEEN $1::date AND $2::date AND COALESCE(volume, 0) > 0 AND close > 0
		 GROUP BY date`, from.String(), to.String())
	if err != nil {
		return nil, fmt.Errorf("count priced codes %s..%s: %w", from, to, err)
	}
	defer rows.Close()
	out := map[civil.Date]int{}
	for rows.Next() {
		var (
			t time.Time
			n int
		)
		if err := rows.Scan(&t, &n); err != nil {
			return nil, fmt.Errorf("scan priced count: %w", err)
		}
		out[civil.DateOf(t)] = n
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate priced counts: %w", err)
	}
	return out, nil
}
