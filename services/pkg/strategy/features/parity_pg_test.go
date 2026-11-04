package features

import (
	"context"
	"encoding/csv"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The container parity suite holds AsOf and Regime to the migration's own
// views. It applies the two CREATE MATERIALIZED VIEW statements of 000130,
// verbatim from the migration file except CURRENT_DATE, which becomes the anchor
// session as a date literal, to a schema of minimal tables loaded from
// testdata/parity. It then compares every column of every row with the Go port
// evaluated at the same anchor.
//
// The suite runs only with the testcontainers build tag and an opt-in:
//
//	FEATURES_PARITY_TESTCONTAINERS=1 CGO_ENABLED=0 \
//	  go test -tags=testcontainers -run TestPriceFeaturesParity ./pkg/strategy/features/
//
// or FEATURES_PARITY_DATABASE_URL names a server to use instead. Without either
// the test skips. The fixtures are offsets from the anchor, so each anchor
// exercises the same shapes on different calendar days (month ends, Easter).
const parityMigration = "../../../migrations/000130_add_price_features.up.sql"

// parityAnchors are the fixed sessions, and the real date is added at run time.
var parityAnchors = []string{"2024-01-31", "2024-02-29", "2024-05-31", "2019-04-23"}

func TestPriceFeaturesParity(t *testing.T) {
	dsn, err := testpostgres.Admin("FEATURES_PARITY_DATABASE_URL", "FEATURES_PARITY_TESTCONTAINERS")
	if err != nil {
		t.Fatal(err)
	}
	if dsn == "" {
		t.Skip("set FEATURES_PARITY_TESTCONTAINERS=1 (with -tags=testcontainers) or FEATURES_PARITY_DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	anchors := append([]string{}, parityAnchors...)
	anchors = append(anchors, time.Now().UTC().Format("2006-01-02"))
	for _, a := range anchors {
		t.Run(a, func(t *testing.T) {
			runParityAnchor(t, ctx, conn, a)
		})
	}
}

// fixtureRows reads a parity CSV, dropping the header.
func fixtureRows(t *testing.T, name string) [][]string {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "parity", name))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	recs, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return recs[1:]
}

// cell is a fixture value as a SQL parameter: an empty cell is NULL.
func cell(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func runParityAnchor(t *testing.T, ctx context.Context, conn *pgx.Conn, anchorText string) {
	t.Helper()
	anchor, err := civil.ParseDate(anchorText)
	if err != nil {
		t.Fatal(err)
	}
	schema := "features_parity_" + strings.ReplaceAll(anchorText, "-", "_")
	mustExec(t, ctx, conn, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	mustExec(t, ctx, conn, "CREATE SCHEMA "+schema)
	mustExec(t, ctx, conn, "SET search_path TO "+schema)
	defer func() {
		mustExec(t, ctx, conn, "SET search_path TO public")
		mustExec(t, ctx, conn, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	}()

	mustExec(t, ctx, conn, `
CREATE TABLE stock_prices (
    stock_code VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    open NUMERIC(12,4), high NUMERIC(12,4), low NUMERIC(12,4),
    close NUMERIC(12,4), adjusted_close NUMERIC(12,4),
    volume BIGINT,
    UNIQUE (stock_code, date)
);
CREATE TABLE index_prices (
    index_code VARCHAR(16) NOT NULL,
    date DATE NOT NULL,
    open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION,
    close DOUBLE PRECISION, volume BIGINT,
    UNIQUE (index_code, date)
);
CREATE TABLE index_metadata (index_code VARCHAR(16) PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO index_metadata VALUES ('XJO', 'S&P/ASX 200'), ('XJT', 'S&P/ASX 200 Total Return');`)

	loadStockPrices(t, ctx, conn, anchor)
	loadIndexPrices(t, ctx, conn, anchor)
	for _, stmt := range viewStatements(t, anchorText) {
		mustExec(t, ctx, conn, stmt)
	}

	// The views and the Go port read the same rows: the stored bars, with their
	// NULLs and NaNs as the reader would convert them.
	bars, codes := readStockBars(t, ctx, conn)
	xjo := readXJO(t, ctx, conn)

	view := readPriceView(t, ctx, conn)
	regime := readRegimeView(t, ctx, conn)
	fs := v0FS1(t)

	// Coverage: the fixtures must actually exercise breakouts at each rank, or
	// the comparison below could pass vacuously.
	// Every fixture stock with 60 or more sessions in the window is featured;
	// SHORT40 and EXACT59 are not.
	featured := []string{"BADCLOSE", "BADHL", "BRK1", "BRK24", "BRK3", "BRK5", "CLAMP", "CONT", "EXACT60", "FLAT",
		"FUTURE", "GAPS", "LONG", "NULLVOL", "STALE", "STALE7", "STALE8"}
	if len(view) != len(featured) {
		t.Fatalf("mv_price_features has %d rows %v, want the %d featured fixtures", len(view), keys(view), len(featured))
	}
	for _, code := range featured {
		if _, ok := view[code]; !ok {
			t.Fatalf("mv_price_features has no row for %s", code)
		}
	}
	for code, rank := range map[string]int{"BRK1": 1, "BRK3": 3, "BRK5": 5, "BRK24": 2} {
		row, ok := view[code]
		if !ok || !row.BreakoutRecent || row.BreakoutDate == nil {
			t.Fatalf("%s: the view reports no recent breakout", code)
		}
		want := rankDate(t, code, anchor, rank)
		if got := civil.DateOf(*row.BreakoutDate); got != want {
			t.Fatalf("%s: breakout_date %s, want the rank-%d session %s", code, got, rank, want)
		}
	}

	// Set equality first: a stock is featured by the view if and only if the
	// Go port says it is.
	var goCodes []string
	goFeatures := map[string]PriceFeatures{}
	for _, code := range codes {
		got, ok := AsOf(bars[code], xjo, anchor, fs)
		if ok {
			goFeatures[code] = got
			goCodes = append(goCodes, code)
		}
	}
	for code := range view {
		if _, ok := goFeatures[code]; !ok {
			t.Errorf("only the view has %s", code)
		}
	}
	for _, code := range goCodes {
		if _, ok := view[code]; !ok {
			t.Errorf("only the Go port has %s", code)
		}
	}

	mismatches := 0
	for _, code := range goCodes {
		v, ok := view[code]
		if !ok {
			continue
		}
		for _, d := range ComparePrice(goFeatures[code], v) {
			mismatches++
			if mismatches <= 40 {
				t.Errorf("%s: %s", code, d)
			}
		}
	}
	if mismatches > 40 {
		t.Errorf("... and %d more mismatches", mismatches-40)
	}

	// The regime, from its own view at the same anchor.
	got := Regime(xjo, anchor)
	for _, d := range CompareRegime(got, regime) {
		t.Error(d)
	}
}

// viewStatements returns the two view definitions, with their unique indexes,
// from the migration text. CURRENT_DATE is the anchor as a date literal.
func viewStatements(t *testing.T, anchor string) []string {
	t.Helper()
	raw, err := os.ReadFile(parityMigration)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	blocks := []struct{ view, index string }{
		{"CREATE MATERIALIZED VIEW IF NOT EXISTS mv_market_regime", "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_market_regime_index_code"},
		{"CREATE MATERIALIZED VIEW IF NOT EXISTS mv_price_features", "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_price_features_stock_code"},
	}
	var out []string
	for _, b := range blocks {
		start := strings.Index(text, b.view)
		if start < 0 {
			t.Fatalf("%s not found in the migration", b.view)
		}
		end := strings.Index(text[start:], "WITH DATA;")
		if end < 0 {
			t.Fatalf("%s has no WITH DATA", b.view)
		}
		out = append(out, text[start:start+end+len("WITH DATA;")])
		istart := strings.Index(text, b.index)
		if istart < 0 {
			t.Fatalf("%s not found in the migration", b.index)
		}
		iend := strings.Index(text[istart:], ";")
		out = append(out, text[istart:istart+iend+1])
	}
	for i, stmt := range out {
		if strings.Contains(stmt, "CURRENT_DATE") {
			out[i] = strings.ReplaceAll(stmt, "CURRENT_DATE", "DATE '"+anchor+"'")
		}
	}
	if !strings.Contains(out[0], "DATE '"+anchor+"'") || !strings.Contains(out[2], "DATE '"+anchor+"'") {
		t.Fatal("the anchor literal did not replace CURRENT_DATE in both views")
	}
	return out
}

func loadStockPrices(t *testing.T, ctx context.Context, conn *pgx.Conn, anchor civil.Date) {
	t.Helper()
	rows := fixtureRows(t, "stock_prices.csv")
	const batch = 400
	for start := 0; start < len(rows); start += batch {
		end := min(start+batch, len(rows))
		var sb strings.Builder
		sb.WriteString("INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume) VALUES ")
		var args []any
		for i, r := range rows[start:end] {
			off, err := strconv.Atoi(r[1])
			if err != nil {
				t.Fatalf("day_offset %q: %v", r[1], err)
			}
			if i > 0 {
				sb.WriteString(",")
			}
			p := len(args)
			fmt.Fprintf(&sb, "($%d,$%d::date,$%d::numeric,$%d::numeric,$%d::numeric,$%d::numeric,$%d::numeric,$%d::bigint)",
				p+1, p+2, p+3, p+4, p+5, p+6, p+7, p+8)
			args = append(args, r[0], anchor.AddDays(off).String(),
				cell(r[2]), cell(r[3]), cell(r[4]), cell(r[5]), cell(r[6]), cell(r[7]))
		}
		if _, err := conn.Exec(ctx, sb.String(), args...); err != nil {
			t.Fatalf("insert stock_prices: %v", err)
		}
	}
}

func loadIndexPrices(t *testing.T, ctx context.Context, conn *pgx.Conn, anchor civil.Date) {
	t.Helper()
	rows := fixtureRows(t, "index_prices.csv")
	for _, r := range rows {
		off, err := strconv.Atoi(r[1])
		if err != nil {
			t.Fatalf("day_offset %q: %v", r[1], err)
		}
		mustExecArgs(t, ctx, conn,
			"INSERT INTO index_prices (index_code, date, high, low, close) VALUES ($1, $2::date, $3::double precision, $4::double precision, $5::double precision)",
			r[0], anchor.AddDays(off).String(), cell(r[2]), cell(r[3]), cell(r[4]))
	}
}

func mustExec(t *testing.T, ctx context.Context, conn *pgx.Conn, sql string) {
	t.Helper()
	if _, err := conn.Exec(ctx, sql); err != nil {
		t.Fatalf("exec: %v\n%s", err, firstLine(sql))
	}
}

func mustExecArgs(t *testing.T, ctx context.Context, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v\n%s", err, firstLine(sql))
	}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " ..."
	}
	return s
}

// nanIfNull reads a nullable float as the Go port does: a NULL price is not a
// price, which NaN already means to the features.
func nanIfNull(p *float64) float64 {
	if p == nil {
		return math.NaN()
	}
	return *p
}

func keys(m map[string]ViewPrice) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// readStockBars returns each code's bars in date order, and the sorted codes.
func readStockBars(t *testing.T, ctx context.Context, conn *pgx.Conn) (map[string][]Bar, []string) {
	t.Helper()
	rows, err := conn.Query(ctx, `SELECT stock_code, date, open::float8, high::float8, low::float8, close::float8, adjusted_close::float8, volume
		FROM stock_prices ORDER BY stock_code, date`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	bars := map[string][]Bar{}
	for rows.Next() {
		var (
			code                     string
			date                     time.Time
			open, high, low, cl, adj *float64
			volume                   *int64
		)
		if err := rows.Scan(&code, &date, &open, &high, &low, &cl, &adj, &volume); err != nil {
			t.Fatal(err)
		}
		vol := 0.0
		if volume != nil {
			vol = float64(*volume)
		}
		bars[code] = append(bars[code], Bar{
			Date:     civil.DateOf(date),
			Open:     nanIfNull(open),
			High:     nanIfNull(high),
			Low:      nanIfNull(low),
			Close:    nanIfNull(cl),
			AdjClose: nanIfNull(adj),
			Volume:   vol,
		})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	codes := make([]string, 0, len(bars))
	for code := range bars {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return bars, codes
}

func readXJO(t *testing.T, ctx context.Context, conn *pgx.Conn) []IndexBar {
	t.Helper()
	rows, err := conn.Query(ctx, `SELECT date, high, low, close FROM index_prices WHERE index_code = 'XJO' ORDER BY date`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []IndexBar
	for rows.Next() {
		var (
			date          time.Time
			high, low, cl *float64
		)
		if err := rows.Scan(&date, &high, &low, &cl); err != nil {
			t.Fatal(err)
		}
		out = append(out, IndexBar{Date: civil.DateOf(date), High: nanIfNull(high), Low: nanIfNull(low), Close: nanIfNull(cl)})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// readPriceView reads mv_price_features, keyed by stock code.
func readPriceView(t *testing.T, ctx context.Context, conn *pgx.Conn) map[string]ViewPrice {
	t.Helper()
	rows, err := conn.Query(ctx, `SELECT stock_code, as_of, close, prev_close, sma10, sma20, sma50, sma150, sma200,
		sma200_1m_ago, high_52w, low_52w, pct_off_52w_high, pct_above_52w_low, volume, avg_volume_50d,
		volume_ratio_50d, dollar_volume_20d, base_high, base_low, base_depth_pct, base_length_days,
		breakout_recent, breakout_date, ret_1m_pct, ret_3m_pct, ret_6m_pct, ret_12m_pct, rs_3m_pct, rs_6m_pct,
		sessions_available FROM mv_price_features`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]ViewPrice{}
	for rows.Next() {
		var code string
		var v ViewPrice
		if err := rows.Scan(&code, &v.AsOf, &v.Close, &v.PrevClose, &v.SMA10, &v.SMA20, &v.SMA50, &v.SMA150, &v.SMA200,
			&v.SMA200Lag, &v.High52, &v.Low52, &v.PctOff, &v.PctAbove, &v.Volume, &v.AvgVolume,
			&v.VolumeRatio, &v.DollarVolume, &v.BaseHigh, &v.BaseLow, &v.BaseDepth, &v.BaseLength,
			&v.BreakoutRecent, &v.BreakoutDate, &v.Ret1, &v.Ret3, &v.Ret6, &v.Ret12, &v.RS3, &v.RS6,
			&v.SessionsAvail); err != nil {
			t.Fatal(err)
		}
		out[code] = v
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// readRegimeView reads the XJO row of mv_market_regime.
func readRegimeView(t *testing.T, ctx context.Context, conn *pgx.Conn) ViewRegime {
	t.Helper()
	var v ViewRegime
	err := conn.QueryRow(ctx, `SELECT as_of, close, sma50, sma200, pct_off_52w_high, ret_1m_pct, ret_3m_pct, regime
		FROM mv_market_regime WHERE index_code = 'XJO'`).Scan(
		&v.AsOf, &v.Close, &v.SMA50, &v.SMA200, &v.PctOff, &v.Ret1, &v.Ret3, &v.Label)
	if err != nil {
		t.Fatalf("mv_market_regime: %v", err)
	}
	return v
}

// rankDate is the date of the rank-th newest fixture session of a code, read
// from the CSV the database was loaded from.
func rankDate(t *testing.T, code string, anchor civil.Date, rank int) civil.Date {
	t.Helper()
	var offs []int
	for _, r := range fixtureRows(t, "stock_prices.csv") {
		if r[0] != code {
			continue
		}
		off, err := strconv.Atoi(r[1])
		if err != nil {
			t.Fatal(err)
		}
		if off <= 0 {
			offs = append(offs, off)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(offs)))
	if rank < 1 || rank > len(offs) {
		t.Fatalf("%s has %d sessions, no rank %d", code, len(offs), rank)
	}
	return anchor.AddDays(offs[rank-1])
}
