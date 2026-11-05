package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The daily snapshot (migration 000156) read by the API. The picks, the
// status counts, the session date and the source dates of a strategy read
// come from the newest completed session when STRATEGY_SOURCE=snapshot.

// strategySnapshotFeatureSet is the feature set the daily job writes its rows under.
const strategySnapshotFeatureSet = "fs1"

// strategySnapshotPhases are the phases a session completes before it is served.
var strategySnapshotPhases = []string{"features", "evaluation", "events"}

var (
	// ErrStrategySnapshotUnavailable says the snapshot tables do not exist yet
	// (migration 000156 is not applied): the caller falls back to the views.
	ErrStrategySnapshotUnavailable = errors.New("strategy snapshot tables are not migrated")
	// ErrNoStrategySnapshot says no session has completed every phase yet.
	ErrNoStrategySnapshot = errors.New("no completed strategy snapshot session")
)

// StrategySnapshotReader is the snapshot read the API serves. The store
// implements it beside Store; the service asserts it, so a store without the
// snapshot (a test fake) keeps reading the views.
type StrategySnapshotReader interface {
	ReadStrategySnapshot(ctx context.Context) (StrategySnapshot, error)
	ReadStrategyDataStatus(ctx context.Context) (StrategyDataStatus, error)
	ListStrategySignalEvents(ctx context.Context, f StrategySignalEventsFilter) ([]StrategySignalEventRow, error)
}

// The store must implement the snapshot reader at compile time: the service's
// runtime type assertion would otherwise quietly serve the views.
var _ StrategySnapshotReader = (*postgresStore)(nil)

// StrategySnapshot is one completed session as the API evaluates it.
type StrategySnapshot struct {
	// AsOf is the newest completed session; PrevAsOf the one before it (zero when none).
	AsOf     civil.Date
	PrevAsOf civil.Date
	// CompletedAt is when the session's last phase finished.
	CompletedAt time.Time
	// Rows are the session's feature rows, in code order.
	Rows []snapshot.Row
	// Blobs are the fundamentals bodies the rows point at, keyed by hash.
	Blobs map[string]features.Fundamentals
	// Regime is the market regime as at the session. Its LatestSession is the
	// newest index session the price series reaches, read live.
	Regime engine.Regime
}

// StrategyDataStatus is what GetStrategyDataStatus reports, before the
// service adds the next update time.
type StrategyDataStatus struct {
	LatestSession       string
	PricesCompletedAt   *time.Time
	SnapshotAsOf        string
	SnapshotCompletedAt *time.Time
	PricedCodes         int
	AsicReports         []AsicReportRow
}

// AsicReportRow is one ASIC short-position report as asic_report_ingests holds it.
type AsicReportRow struct {
	ReportDate      civil.Date
	FirstIngestedAt time.Time
	FileRows        *int
	LoadedRows      int
	// AvailableDate is when the report became public on the calendar the
	// snapshot's short reading uses (reportAvailability). nil for a report the
	// holiday table does not cover, or when the calendar has no session for it.
	AvailableDate *civil.Date
}

// StrategySignalEventsFilter selects one rules version's status changes. Ordering
// and paging are by id, newest first: AfterID > 0 reads the rows below it.
type StrategySignalEventsFilter struct {
	StrategyID string
	RulesHash  string
	StockCode  string
	Since      *civil.Date
	AfterID    int64
	Limit      int
}

// StrategySignalEventRow is one recorded status change.
type StrategySignalEventRow struct {
	ID          int64
	StockCode   string
	CompanyName string
	AsOf        string
	PrevAsOf    string
	FromStatus  string
	ToStatus    string
	Score       *float64
	// Evidence is the event's compact JSON as the daily job wrote it.
	Evidence  string
	RulesHash string
}

// ReadStrategySnapshot reads the newest completed session and the one before
// it, the session's feature rows and fundamentals blobs, and its regime. A
// database without 000156 answers ErrStrategySnapshotUnavailable; one with no
// completed session answers ErrNoStrategySnapshot.
func (s *postgresStore) ReadStrategySnapshot(ctx context.Context) (StrategySnapshot, error) {
	// One deadline over the whole read: the fill it runs under is shared by every picks read.
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	sessions, err := completedStrategySessions(ctx, s.db, 2)
	if err != nil {
		return StrategySnapshot{}, err
	}
	if len(sessions) == 0 {
		return StrategySnapshot{}, ErrNoStrategySnapshot
	}
	out := StrategySnapshot{AsOf: sessions[0].day, CompletedAt: sessions[0].completedAt}
	if len(sessions) > 1 {
		out.PrevAsOf = sessions[1].day
	}

	rows, err := pgsource.ReadFeatureRows(ctx, s.db, out.AsOf, strategySnapshotFeatureSet)
	if err != nil {
		return StrategySnapshot{}, fmt.Errorf("read strategy snapshot rows: %w", err)
	}
	if len(rows) == 0 {
		return StrategySnapshot{}, ErrNoStrategySnapshot
	}
	out.Rows = rows

	hashes := make([]string, 0, len(rows))
	seen := map[string]bool{}
	for i := range rows {
		if h := rows[i].FundamentalsHash; h != "" && !seen[h] {
			seen[h] = true
			hashes = append(hashes, h)
		}
	}
	out.Blobs, err = pgsource.ReadFundamentalsBlobs(ctx, s.db, hashes)
	if err != nil {
		return StrategySnapshot{}, fmt.Errorf("read strategy snapshot fundamentals: %w", err)
	}

	regime, ok, err := pgsource.ReadRegime(ctx, s.db, out.AsOf, engine.DefaultIndexCode)
	if err != nil {
		return StrategySnapshot{}, fmt.Errorf("read strategy snapshot regime: %w", err)
	}
	if !ok {
		// A completed session without its regime row is not a whole session (the
		// daily job refuses to diff against one). The service falls back, loudly.
		return StrategySnapshot{}, fmt.Errorf("strategy snapshot session %s has no regime row: %w", out.AsOf, ErrNoStrategySnapshot)
	}
	// The index's own newest session, read live (as GetMarketRegime does):
	// the snapshot is stale when the market has closed a session it lacks.
	latest, err := latestIndexSessionBounded(ctx, s.db)
	if err != nil {
		return StrategySnapshot{}, err
	}
	regime.LatestSession = latest
	out.Regime = regime
	return out, nil
}

// completedSession is one session every phase of which completed.
type completedSession struct {
	day         civil.Date
	completedAt time.Time
}

// completedStrategySessions returns the newest n sessions whose every phase
// completed, newest first. A missing table is ErrStrategySnapshotUnavailable.
func completedStrategySessions(ctx context.Context, db fundamentalsDB, n int) ([]completedSession, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT as_of::text, max(finished_at)
		  FROM strategy_daily_runs
		 WHERE status = 'completed' AND phase = ANY($1)
		 GROUP BY as_of
		HAVING count(DISTINCT phase) = $2
		 ORDER BY as_of DESC
		 LIMIT $3`, strategySnapshotPhases, len(strategySnapshotPhases), n)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadStrategySnapshot", err)
			return nil, ErrStrategySnapshotUnavailable
		}
		return nil, fmt.Errorf("read completed strategy sessions: %w", err)
	}
	defer rows.Close()
	var out []completedSession
	for rows.Next() {
		var (
			day  string
			done *time.Time
			cs   completedSession
		)
		if err := rows.Scan(&day, &done); err != nil {
			return nil, fmt.Errorf("scan completed strategy session: %w", err)
		}
		d, err := civil.ParseDate(day)
		if err != nil {
			return nil, fmt.Errorf("parse completed strategy session %q: %w", day, err)
		}
		cs.day = d
		if done != nil {
			cs.completedAt = *done
		}
		out = append(out, cs)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate completed strategy sessions: %w", err)
	}
	return out, nil
}

// ReadStrategyDataStatus reads the source dates: the latest index session, the
// newest completed price sweep, the snapshot session and when it completed,
// the priced count of that session and the newest ten ASIC reports. Missing
// tables read as absent (empty fields), never as an error.
func (s *postgresStore) ReadStrategyDataStatus(ctx context.Context) (StrategyDataStatus, error) {
	var out StrategyDataStatus

	latest, err := latestIndexSessionBounded(ctx, s.db)
	if err != nil {
		return StrategyDataStatus{}, err
	}
	if latest != nil {
		out.LatestSession = latest.Format("2006-01-02")
	}

	sweep, err := latestPriceSweepCompletion(ctx, s.db)
	if err != nil {
		return StrategyDataStatus{}, err
	}
	out.PricesCompletedAt = sweep

	// The ASIC reports are read whatever the snapshot's state: the daily job holds
	// every session until its index sync lands, and the reports are ingested regardless.
	reports, err := recentAsicReports(ctx, s.db, 10)
	if err != nil {
		return StrategyDataStatus{}, err
	}
	if err := reportAvailability(ctx, s.db, reports); err != nil {
		return StrategyDataStatus{}, err
	}
	out.AsicReports = reports

	sessions, err := completedStrategySessions(ctx, s.db, 1)
	switch {
	case errors.Is(err, ErrStrategySnapshotUnavailable):
		return out, nil
	case err != nil:
		return StrategyDataStatus{}, err
	case len(sessions) == 0:
		return out, nil
	}
	out.SnapshotAsOf = sessions[0].day.String()
	if !sessions[0].completedAt.IsZero() {
		t := sessions[0].completedAt
		out.SnapshotCompletedAt = &t
	}
	pricedCtx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	if err := s.db.QueryRow(pricedCtx, `
		SELECT COALESCE((counts->>'priced')::int, 0)
		  FROM strategy_daily_runs WHERE as_of = $1::date AND phase = 'features'`,
		out.SnapshotAsOf).Scan(&out.PricedCodes); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if !isUndefinedTable(err) {
			return StrategyDataStatus{}, fmt.Errorf("read snapshot priced count: %w", err)
		}
	}
	return out, nil
}

// latestIndexSessionBounded is the index's newest session under the query timeout.
// It runs inside the snapshot fill, which every picks read waits on.
func latestIndexSessionBounded(ctx context.Context, db fundamentalsDB) (*time.Time, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	return latestIndexSession(ctx, db, engine.DefaultIndexCode)
}

// latestPriceSweepCompletion is when the newest completed price sweep finished
// (the sync_status row the picks readiness reads), nil when none has.
func latestPriceSweepCompletion(ctx context.Context, db fundamentalsDB) (*time.Time, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	var at *time.Time
	err := db.QueryRow(ctx, `
		SELECT completed_at FROM sync_status
		 WHERE environment IS NULL AND hostname IS NULL AND checkpoint_stocks_total > 1
		   AND status = 'completed' AND completed_at IS NOT NULL
		 ORDER BY started_at DESC LIMIT 1`).Scan(&at)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case isUndefinedTable(err) || isUndefinedColumn(err):
		logMissingRelationOnce("ReadStrategyDataStatus.sweep", err)
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("read the newest price sweep: %w", err)
	}
	return at, nil
}

// reportAvailability sets each report's publication date from the calendar the
// snapshot's short reading is built on: the index sessions and the distinct
// report dates of the shorts table, at the v1 publication lag. A date shown here
// is therefore the date the stored reading used (the sf1 availability), not a
// second calendar's guess: the job reads the same two inputs, with the same
// filters (pgsource.IndexBars and pgsource.ASICRows). The reports listed are
// the newest, and a report's lag reads only the sessions after it.
func reportAvailability(ctx context.Context, db fundamentalsDB, reports []AsicReportRow) error {
	if len(reports) == 0 {
		return nil
	}
	oldest := reports[len(reports)-1].ReportDate
	xjo, err := allIndexSessionDates(ctx, db, engine.DefaultIndexCode, oldest)
	if err != nil {
		return err
	}
	asic, err := shortsReportDates(ctx, db, oldest)
	if err != nil {
		return err
	}
	cal := calendar.New(xjo, asic, publicationLagSessions())
	for i := range reports {
		if reports[i].ReportDate.Year < asxcalendar.HolidayCoverageStartYear {
			continue
		}
		if p, ok := cal.PublishedOn(reports[i].ReportDate); ok {
			published := p
			reports[i].AvailableDate = &published
		}
	}
	return nil
}

// shortsReportDates returns the distinct report dates of the shorts table from
// `from` on, ascending: the report dates the job's calendar is built from.
func shortsReportDates(ctx context.Context, db fundamentalsDB, from civil.Date) ([]civil.Date, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT DISTINCT "DATE"::date::text FROM shorts
		 WHERE "DATE" >= $1::date AND "PRODUCT_CODE" IS NOT NULL
		 ORDER BY 1`, from.String())
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadStrategyDataStatus.shorts", err)
			return nil, nil
		}
		return nil, fmt.Errorf("read ASIC report dates: %w", err)
	}
	defer rows.Close()
	var out []civil.Date
	for rows.Next() {
		var day string
		if err := rows.Scan(&day); err != nil {
			return nil, fmt.Errorf("scan ASIC report date: %w", err)
		}
		d, err := civil.ParseDate(day)
		if err != nil {
			return nil, fmt.Errorf("parse ASIC report date %q: %w", day, err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ASIC report dates: %w", err)
	}
	return out, nil
}

// allIndexSessionDates returns every index bar date from `from` on, ascending,
// as pgsource.IndexBars reads them (no close filter). A missing index table
// reads as no sessions.
func allIndexSessionDates(ctx context.Context, db fundamentalsDB, indexCode string, from civil.Date) ([]civil.Date, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT DISTINCT date::date::text FROM index_prices
		 WHERE index_code = $1 AND date >= $2::date
		 ORDER BY 1`, indexCode, from.String())
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadStrategyDataStatus.index", err)
			return nil, nil
		}
		return nil, fmt.Errorf("read index sessions: %w", err)
	}
	defer rows.Close()
	var out []civil.Date
	for rows.Next() {
		var day string
		if err := rows.Scan(&day); err != nil {
			return nil, fmt.Errorf("scan index session: %w", err)
		}
		d, err := civil.ParseDate(day)
		if err != nil {
			return nil, fmt.Errorf("parse index session %q: %w", day, err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate index sessions: %w", err)
	}
	return out, nil
}

// publicationLagSessions is the v1 policy's publication lag, read from the
// registered version rather than restated.
func publicationLagSessions() int {
	if r, ok := spec.Version(spec.StrategyZangerBreakout, "v1"); ok {
		return r.Spec.Data.PublicationLagSessions
	}
	return calendar.PublicationLagSessions
}

// recentAsicReports reads the newest n ASIC reports, newest first. A database
// without 000155 has none.
func recentAsicReports(ctx context.Context, db fundamentalsDB, n int) ([]AsicReportRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT report_date::text, first_ingested_at, file_rows, loaded_rows
		  FROM asic_report_ingests ORDER BY report_date DESC LIMIT $1`, n)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadStrategyDataStatus.asic", err)
			return nil, nil
		}
		return nil, fmt.Errorf("read asic report ingests: %w", err)
	}
	defer rows.Close()
	var out []AsicReportRow
	for rows.Next() {
		var (
			day string
			r   AsicReportRow
		)
		if err := rows.Scan(&day, &r.FirstIngestedAt, &r.FileRows, &r.LoadedRows); err != nil {
			return nil, fmt.Errorf("scan asic report ingest: %w", err)
		}
		d, err := civil.ParseDate(day)
		if err != nil {
			return nil, fmt.Errorf("parse asic report date %q: %w", day, err)
		}
		r.ReportDate = d
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate asic report ingests: %w", err)
	}
	return out, nil
}

// ListStrategySignalEvents reads one rules version's status changes, newest
// first. Only a version that is live or superseded, canonical, and whose
// events start at its live_from is served: a variant or a draft reads
// nothing. A missing table is ErrStrategySnapshotUnavailable.
func (s *postgresStore) ListStrategySignalEvents(ctx context.Context, f StrategySignalEventsFilter) ([]StrategySignalEventRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	var since *string
	if f.Since != nil {
		v := f.Since.String()
		since = &v
	}
	rows, err := s.db.Query(ctx, `
		SELECT e.id, e.stock_code, COALESCE(m.company_name, ''), e.as_of::text, COALESCE(e.prev_as_of::text, ''),
		       e.from_status, e.to_status, e.score, COALESCE(e.evidence::text, '{}'), e.rules_hash
		  FROM strategy_signal_events e
		  JOIN strategy_rule_versions v
		    ON v.rules_hash = e.rules_hash AND v.kind = 'canonical'
		   AND v.status IN ('live', 'superseded')
		   AND e.as_of >= v.live_from
		  LEFT JOIN "company-metadata" m ON m.stock_code = e.stock_code
		 WHERE e.strategy_id = $1 AND e.rules_hash = $2
		   AND ($3::text = '' OR e.stock_code = $3::text)
		   AND ($4::date IS NULL OR e.as_of >= $4::date)
		   AND ($5::bigint = 0 OR e.id < $5::bigint)
		 ORDER BY e.id DESC
		 LIMIT $6`, f.StrategyID, f.RulesHash, strings.ToUpper(f.StockCode), since, f.AfterID, f.Limit)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ListStrategySignalEvents", err)
			return nil, ErrStrategySnapshotUnavailable
		}
		return nil, fmt.Errorf("read strategy signal events: %w", err)
	}
	defer rows.Close()
	var out []StrategySignalEventRow
	for rows.Next() {
		var r StrategySignalEventRow
		if err := rows.Scan(&r.ID, &r.StockCode, &r.CompanyName, &r.AsOf, &r.PrevAsOf, &r.FromStatus, &r.ToStatus,
			&r.Score, &r.Evidence, &r.RulesHash); err != nil {
			return nil, fmt.Errorf("scan strategy signal event: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate strategy signal events: %w", err)
	}
	return out, nil
}

// LiveRuleVersion is the canonical version strategy_rule_versions marks live for
// one strategy: the rules hash the daily job evaluates under, and the first
// session it was live (YYYY-MM-DD, "" when the row has none).
type LiveRuleVersion struct {
	StrategyID string
	RulesHash  string
	Label      string
	LiveFrom   string
}

// StrategyLiveReader is the live-version read the API serves picks under.
// Store implements it beside the snapshot reader; a store without it (a test
// fake) serves the registry's live flag.
type StrategyLiveReader interface {
	ReadLiveRuleVersions(ctx context.Context) ([]LiveRuleVersion, error)
}

// ReadLiveRuleVersions returns the live canonical version of every strategy the
// table records, the version the job last promoted (the table is written by the
// daily job, so the served version changes when the job promotes, not at
// deploy). A database without the table answers ErrStrategySnapshotUnavailable.
func (s *postgresStore) ReadLiveRuleVersions(ctx context.Context) ([]LiveRuleVersion, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT strategy_id, rules_hash, label, COALESCE(live_from::text, '')
		  FROM strategy_rule_versions
		 WHERE kind = 'canonical' AND status = 'live'
		 ORDER BY strategy_id`)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadLiveRuleVersions", err)
			return nil, ErrStrategySnapshotUnavailable
		}
		return nil, fmt.Errorf("read live rule versions: %w", err)
	}
	defer rows.Close()
	var out []LiveRuleVersion
	for rows.Next() {
		var v LiveRuleVersion
		if err := rows.Scan(&v.StrategyID, &v.RulesHash, &v.Label, &v.LiveFrom); err != nil {
			return nil, fmt.Errorf("scan live rule version: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read live rule versions: %w", err)
	}
	return out, nil
}
