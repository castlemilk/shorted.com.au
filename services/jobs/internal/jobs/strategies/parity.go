package strategies

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The parity check holds the Go port to the materialised views at one session.
// It compares fs1 with mv_price_features, the regime with mv_market_regime and
// sf0's days to cover with the shorts and volume CTEs of 000080 (the view that
// mv_screener_data is built from). It never reads mv_screener_data, which only
// refresh_all_materialized_views refreshes, and it changes nothing: it reads
// inside one REPEATABLE READ, READ ONLY transaction, so the Go side and the
// view side see the same rows.
//
// A run is conclusive only when the newest price sweep has completed before the
// picks refresh started. Otherwise the views and the stored bars may disagree
// for reasons that are not a port defect, and the run is discarded.

const (
	// barLookbackDays is the bar history fs1 reads: its 400-day window plus a
	// margin, as the daily pipeline loads it.
	barLookbackDays = 420
	// dtcLookbackDays is the span of 000080's average volume.
	dtcLookbackDays = 35
	// shortsLookbackDays bounds the shorts rows read. A code whose newest
	// qualifying row is older is in neither side of the comparison.
	shortsLookbackDays = 60
	// parityTimeout bounds one run, so a slow read cannot hold the picks
	// execution past its own deadline.
	parityTimeout = 10 * time.Minute
	// examplesCap is how many codes a log line names.
	examplesCap = 5
	// regimeKey names the regime's disagreements among the examples.
	regimeKey = "XJO"
)

// sweepRow is the newest price-sweep row of sync_status.
type sweepRow struct {
	Status      string
	CompletedAt *time.Time
}

// sweepVerdict says whether the views can be compared with the stored bars: the
// newest sweep must have completed, and before the refresh began, so that the
// refreshed views were built from the bars the Go side reads. The reason is
// empty when the run is conclusive.
func sweepVerdict(row *sweepRow, refreshStart time.Time) (conclusive bool, reason string) {
	switch {
	case row == nil:
		return false, "no_sweep_row"
	case row.Status != "completed":
		return false, "sweep_" + row.Status
	case row.CompletedAt == nil:
		return false, "sweep_unfinished"
	case row.CompletedAt.After(refreshStart):
		return false, "sweep_after_refresh"
	}
	return true, ""
}

// Result is one parity run. Counts are over both sides of each comparison: a
// code only the view features is an OnlyView, whichever comparison it came from.
type Result struct {
	D          civil.Date
	Conclusive bool
	Reason     string // why the run is not conclusive
	Codes      int    // the price universe: every code either side features
	OnlyView   int
	OnlyGo     int
	Mismatches int            // codes (and the regime, once) whose columns disagree
	Fields     map[string]int // disagreeing column -> count
	Examples   []string       // up to examplesCap codes with any disagreement, sorted
}

// Line is the one log line a run writes.
func (r Result) Line() string {
	if !r.Conclusive {
		return fmt.Sprintf("strategy_parity d=%s conclusive=false inconclusive=%s", r.D, r.Reason)
	}
	return fmt.Sprintf("strategy_parity d=%s codes=%d only_view=%d only_go=%d mismatches=%d fields=%s examples=%s conclusive=true",
		r.D, r.Codes, r.OnlyView, r.OnlyGo, r.Mismatches, fieldsText(r.Fields), listText(r.Examples))
}

func fieldsText(fields map[string]int) string {
	if len(fields) == 0 {
		return "none"
	}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s:%d", name, fields[name]))
	}
	return strings.Join(parts, ",")
}

func listText(items []string) string {
	if len(items) == 0 {
		return "none"
	}
	return strings.Join(items, ",")
}

// comparison accumulates the disagreements of one run.
type comparison struct {
	codes      int
	onlyView   int
	onlyGo     int
	mismatches int
	fields     map[string]int
	issues     map[string]bool
}

func newComparison() *comparison {
	return &comparison{fields: map[string]int{}, issues: map[string]bool{}}
}

// lines records the column disagreements of one code. Each line is "<column>
// go ... view ..."; the column is what comes before " go ".
func (c *comparison) lines(code string, lines []string) {
	if len(lines) == 0 {
		return
	}
	c.mismatches++
	c.issues[code] = true
	for _, line := range lines {
		name, _, _ := strings.Cut(line, " go ")
		c.fields[strings.ReplaceAll(name, " ", "_")]++
	}
}

func (c *comparison) result(d civil.Date) Result {
	examples := make([]string, 0, len(c.issues))
	for code := range c.issues {
		examples = append(examples, code)
	}
	sort.Strings(examples)
	if len(examples) > examplesCap {
		examples = examples[:examplesCap]
	}
	return Result{
		D: d, Conclusive: true, Codes: c.codes, OnlyView: c.onlyView, OnlyGo: c.onlyGo,
		Mismatches: c.mismatches, Fields: c.fields, Examples: examples,
	}
}

// comparePrices holds fs1 to mv_price_features, code by code.
func comparePrices(goRows map[string]features.PriceFeatures, view map[string]features.ViewPrice, c *comparison) {
	for _, code := range unionKeys(goRows, view) {
		g, inGo := goRows[code]
		v, inView := view[code]
		c.codes++
		switch {
		case !inGo:
			c.onlyView++
			c.issues[code] = true
		case !inView:
			c.onlyGo++
			c.issues[code] = true
		default:
			c.lines(code, features.ComparePrice(g, v))
		}
	}
}

// compareRegime holds the regime to the XJO row of mv_market_regime. A missing
// row is a disagreement, not a match.
func compareRegime(got engine.Regime, view features.ViewRegime, haveView bool, c *comparison) {
	if !haveView {
		c.mismatches++
		c.fields["regime_row"]++
		c.issues[regimeKey] = true
		return
	}
	c.lines(regimeKey, features.CompareRegime(got, view))
}

// shortRead is sf0's reading of one code: the latest qualifying shorts row.
type shortRead struct {
	ReportDate civil.Date
	Positions  float64
	DTC        *float64 // days to cover; nil when unknown
}

// shortView is 000080's row for one code: the same latest row and the 35-day
// average volume as a bigint (nil when the average has fewer than five traded
// sessions).
type shortView struct {
	ReportDate civil.Date
	Positions  float64
	AvgVolume  *int64
}

// compareShorts holds sf0 to 000080's latest_shorts and avg_volume.
func compareShorts(goRows map[string]shortRead, view map[string]shortView, c *comparison) {
	for _, code := range unionKeys(goRows, view) {
		g, inGo := goRows[code]
		v, inView := view[code]
		switch {
		case !inGo:
			c.onlyView++
			c.issues[code] = true
			continue
		case !inView:
			c.onlyGo++
			c.issues[code] = true
			continue
		}
		var lines []string
		if g.ReportDate != v.ReportDate {
			lines = append(lines, fmt.Sprintf("report_date go %s view %s", g.ReportDate, v.ReportDate))
		}
		if !agree(g.Positions, v.Positions) {
			lines = append(lines, fmt.Sprintf("positions go %v view %v", g.Positions, v.Positions))
		}
		var gotDTC float64
		if g.DTC != nil {
			gotDTC = *g.DTC
		}
		if wantDTC := features.ViewDaysToCover(v.Positions, v.AvgVolume); !agree(gotDTC, wantDTC) {
			lines = append(lines, fmt.Sprintf("days_to_cover go %v view %v", gotDTC, wantDTC))
		}
		c.lines(code, lines)
	}
}

// agree is the parity tolerance: floats agree to 1e-9 relative, the same
// tolerance the features' own parity uses.
func agree(a, b float64) bool {
	if a == b {
		return true
	}
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

// unionKeys is the sorted union of two maps' keys, the only order the
// comparisons iterate in.
func unionKeys[A, B any](a map[string]A, b map[string]B) []string {
	seen := make(map[string]bool, len(a)+len(b))
	var out []string
	for k := range a {
		seen[k] = true
		out = append(out, k)
	}
	for k := range b {
		if !seen[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// RunParity compares the Go port with the views at the current session. It
// logs one line and returns the result. It is the shadow run of the picks
// refresh: refreshStart is when that refresh began, and a run is inconclusive
// unless the newest sweep completed before it. A panic is recovered into an
// error, and the caller decides what an error means for its own exit code.
func RunParity(parent context.Context, pool *pgxpool.Pool, refreshStart time.Time, logf func(string, ...any)) (res Result, err error) {
	defer func() {
		if r := recover(); r != nil {
			res, err = Result{}, fmt.Errorf("strategy parity: recovered from a panic: %v", r)
		}
		if err != nil {
			logf("strategy_parity: %v", err)
		}
	}()
	ctx, cancel := context.WithTimeout(parent, parityTimeout)
	defer cancel()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Result{}, fmt.Errorf("begin parity transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	res, err = parityInTx(ctx, tx, refreshStart)
	if err != nil {
		return res, err
	}
	logf("%s", res.Line())
	return res, nil
}

// parityInTx runs the comparison inside its transaction.
func parityInTx(ctx context.Context, tx pgx.Tx, refreshStart time.Time) (Result, error) {
	var today time.Time
	if err := tx.QueryRow(ctx, `SELECT CURRENT_DATE`).Scan(&today); err != nil {
		return Result{}, fmt.Errorf("read CURRENT_DATE: %w", err)
	}
	d := civil.DateOf(today)

	sweep, err := readSweep(ctx, tx)
	if err != nil {
		return Result{}, err
	}
	if ok, reason := sweepVerdict(sweep, refreshStart); !ok {
		return Result{D: d, Reason: reason}, nil
	}

	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		return Result{}, errors.New("no live strategy version to take the feature parameters from")
	}
	// fs1 is one parameter set shared by every live version (spec.v0).
	fs := reg.Spec.Features

	from := d.AddDays(-barLookbackDays)
	xjo, err := pgsource.IndexBars(ctx, tx, engine.DefaultIndexCode, from, d)
	if err != nil {
		return Result{}, err
	}
	codes, err := pgsource.BarCodes(ctx, tx, from, d)
	if err != nil {
		return Result{}, err
	}
	goPrices := make(map[string]features.PriceFeatures, len(codes))
	recent := make(map[string][]features.Bar, len(codes))
	dtcFrom := d.AddDays(-dtcLookbackDays)
	for _, code := range codes {
		bars, err := pgsource.Bars(ctx, tx, code, from, d)
		if err != nil {
			return Result{}, err
		}
		if p, ok := features.AsOf(bars, xjo, d, fs); ok {
			goPrices[code] = p
		}
		recent[code] = barsFrom(bars, dtcFrom)
	}
	viewPrices, err := pgsource.PriceView(ctx, tx)
	if err != nil {
		return Result{}, err
	}
	goRegime := features.Regime(xjo, d)
	viewRegime, haveRegime, err := pgsource.RegimeView(ctx, tx)
	if err != nil {
		return Result{}, err
	}

	shortsFrom := d.AddDays(-shortsLookbackDays)
	asic, err := pgsource.ASICRows(ctx, tx, shortsFrom, d)
	if err != nil {
		return Result{}, err
	}
	reports := features.NewReports(asic, nil)
	cal := calendar.New(nil, nil, 0)
	goShorts := map[string]shortRead{}
	for _, code := range asicCodes(asic) {
		r := features.ShortReadingV0(code, d, cal, reports, recent[code])
		if r.Status != features.StatusReported {
			continue
		}
		goShorts[code] = shortRead{ReportDate: *r.ReportDate, Positions: *r.Positions, DTC: r.DaysToCover}
	}
	viewShorts, err := readViewShorts(ctx, tx, shortsFrom)
	if err != nil {
		return Result{}, err
	}

	c := newComparison()
	comparePrices(goPrices, viewPrices, c)
	compareRegime(goRegime, viewRegime, haveRegime, c)
	compareShorts(goShorts, viewShorts, c)
	return c.result(d), nil
}

// readSweep reads the newest price-sweep row: the complement of the ASIC sync's
// own rows, and of market-data serve's single-stock runs (4.2). nil when none.
func readSweep(ctx context.Context, tx pgx.Tx) (*sweepRow, error) {
	var row sweepRow
	err := tx.QueryRow(ctx, `
		SELECT status, completed_at FROM sync_status
		 WHERE environment IS NULL AND hostname IS NULL AND checkpoint_stocks_total > 1
		 ORDER BY started_at DESC LIMIT 1`).Scan(&row.Status, &row.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the newest price sweep: %w", err)
	}
	return &row, nil
}

// readViewShorts reads sf0's view side: 000080's latest_shorts joined to its
// avg_volume, for the newest rows dated on or after from.
func readViewShorts(ctx context.Context, tx pgx.Tx, from civil.Date) (map[string]shortView, error) {
	rows, err := tx.Query(ctx, `WITH latest_shorts AS (`+latestShortsCTE+`),
		avg_volume AS (`+avgVolumeCTE+`)
		SELECT ls.stock_code::text, ls.reported_short_positions::float8, ls.short_date::date,
		       av.avg_volume_20d::int8
		  FROM latest_shorts ls
		  LEFT JOIN avg_volume av ON av.stock_code = ls.stock_code
		 WHERE ls.short_date::date >= $1::date`, from.String())
	if err != nil {
		return nil, fmt.Errorf("query 000080 latest_shorts: %w", err)
	}
	defer rows.Close()
	out := map[string]shortView{}
	for rows.Next() {
		var (
			code      string
			positions *float64
			date      time.Time
			avg       *int64
		)
		if err := rows.Scan(&code, &positions, &date, &avg); err != nil {
			return nil, fmt.Errorf("scan 000080 latest_shorts row: %w", err)
		}
		v := shortView{ReportDate: civil.DateOf(date), AvgVolume: avg, Positions: math.NaN()}
		if positions != nil {
			v.Positions = *positions
		}
		out[code] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate 000080 latest_shorts: %w", err)
	}
	return out, nil
}

// asicCodes is the sorted set of codes in the rows.
func asicCodes(rows []features.ASICRow) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rows {
		if !seen[r.Code] {
			seen[r.Code] = true
			out = append(out, r.Code)
		}
	}
	sort.Strings(out)
	return out
}

// barsFrom copies the bars dated on or after from. The copy keeps the parity
// from holding the whole history of every code.
func barsFrom(bars []features.Bar, from civil.Date) []features.Bar {
	i := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(from) })
	return append([]features.Bar(nil), bars[i:]...)
}
