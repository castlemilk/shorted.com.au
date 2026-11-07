package strategies

// The paper track's market fixture. The rows are generated deterministically, so
// every run of a test sees the same market, and they are written to the source
// tables the production readers select from. The daily job's features phase reads
// them, so a test's snapshot is the job's own, not a stand-in.

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
)

// paperMarketStart is the first bar the fixture writes: enough history for the
// features' 400-day and the ASIC window's 730-day lookbacks before the first run.
var paperMarketStart = civil.Date{Year: 2025, Month: time.January, Day: 2}

// paperRunFrom is the first session the daily job snapshots (a live version's
// live_from), and paperRunTo the last.
var (
	paperRunFrom = civil.Date{Year: 2026, Month: time.June, Day: 1}
	paperRunTo   = civil.Date{Year: 2026, Month: time.September, Day: 25}
)

// paperCodes are the fixture's stocks. Their roles:
//   - CCC: a dividend with a Saturday ex-date (credited on the Monday), a NULL close
//     on one day while held, and a 10% fall that is its minervini stop.
//   - DDD: its last bar is its fill day, so its exit is a stale exit (delisted_exit).
//   - GGG: no volume on three days (a triggered entry can cancel as untraded).
//   - AAA: a corporate-action suspect on 22 July (a zero-volume level shift); its
//     6 August entry is blocked for sixty sessions.
//   - the rest: sawtooth cycles that set new highs, so the rules trigger.
var paperCodes = []string{"AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"}

// paperStaleCode is held from its entry on paperStaleLast and has no bar after it:
// its missing sessions reach the stale limit before the 20-session time stop, so
// the exit is delisted_exit.
const paperStaleCode = "DDD"

// paperNullCode is the code with the NULL close: one the batch steps, so the NULL
// close reaches the simulator's session.
const paperNullCode = "CCC"

// paperCrash is BBB's fall: a 40% level drop from this session on. It is a
// fixture for the batch's own rules over a large move, not a held position: BBB's
// crowded-short trade has already closed by then (28 July).
var paperCrash = civil.Date{Year: 2026, Month: time.August, Day: 3}

// paperCASuspect is AAA's corporate-action suspect, on a session where AAA is not
// held: a level shift of 1.9 from this session on, with no volume on the day. The
// features phase flags the bar as a zero-volume suspect, known on the day, so no
// entry is taken on AAA for the next sixty sessions (AAA would enter crowded-short
// on 6 August).
var paperCASuspect = civil.Date{Year: 2026, Month: time.July, Day: 22}

// paperHeldSuspect is HHH's corporate-action suspect on a session where HHH is
// held (crowded-short holds it from 27 July). The bar carries a halving of the
// level (a log move past the detector's 1.8 factor) and no volume, so the batch exits the position through corporate_action_exit, and a
// minervini position in HHH meets its 8% stop on the same bar.
var paperHeldSuspect = civil.Date{Year: 2026, Month: time.August, Day: 10}

// paperNullClose is paperNullCode's day with no close.
var (
	paperNullClose = civil.Date{Year: 2026, Month: time.July, Day: 24}
	paperStaleLast = civil.Date{Year: 2026, Month: time.June, Day: 23} // the code's fill day: the next 20 sessions have no bar, a stale exit
	paperDividend  = civil.Date{Year: 2026, Month: time.July, Day: 18} // a Saturday
)

// paperZeroVolume are GGG's days with no volume.
var paperZeroVolume = map[civil.Date]bool{
	{Year: 2026, Month: time.June, Day: 17}:     true,
	{Year: 2026, Month: time.August, Day: 12}:   true,
	{Year: 2026, Month: time.September, Day: 8}: true,
}

// paperTradingDays are the ASX sessions from from to to, inclusive, oldest first.
func paperTradingDays(from, to civil.Date) []civil.Date {
	var out []civil.Date
	for d := from; !d.After(to); d = d.AddDays(1) {
		if asxcalendar.IsTradingDay(time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)) {
			out = append(out, d)
		}
	}
	return out
}

// paperPrice is one code's close on its k-th fixture session.
func paperPrice(code, k int) float64 {
	base := 10 + 3*float64(code)
	drift := 0.0025 + 0.0004*float64(code%3)
	period := 12 + code
	phase := k % period
	trend := base * math.Exp(drift*float64(k))
	if paperCodes[code] == "AAA" && k >= paperCAIndex() {
		trend *= 1.9 // the level shift of the corporate-action suspect
	}
	if paperCodes[code] == "CCC" && k >= paperStopIndex() {
		trend *= 0.9 // a 10% fall, past minervini's 8% stop and under the suspect detector's move
	}
	if paperCodes[code] == "HHH" && k >= paperHeldIndex() {
		trend *= 0.5 // the level drop of the held-position suspect (a move past caMoveFactor)
	}
	if paperCodes[code] == "BBB" && k >= paperCrashIndex() {
		trend *= 0.6
	}
	// The sawtooth dips by at most 2% in the last quarter of each cycle, less than
	// the cycle's drift, so each cycle closes at a new high: a breakout.
	dip := 0.0
	if quarter := period / 4; phase > period*3/4 {
		dip = 0.02 * float64(phase-period*3/4) / float64(quarter+1)
	}
	return trend * (1 - dip) * (1 + 0.002*math.Sin(float64(k)/3.0+float64(code)))
}

// paperStopDay is the session CCC falls past its minervini stop-loss (held from 28
// July): a 10% fall with no suspect, so the stop, not a corporate action, closes it.
var paperStopDay = civil.Date{Year: 2026, Month: time.August, Day: 12}

// paperStopIndex is the fixture session index of paperStopDay.
func paperStopIndex() int {
	for i, d := range paperTradingDays(paperMarketStart, paperRunTo) {
		if d == paperStopDay {
			return i
		}
	}
	return -1
}

// paperHeldIndex is the fixture session index of paperHeldSuspect.
func paperHeldIndex() int {
	for i, d := range paperTradingDays(paperMarketStart, paperRunTo) {
		if d == paperHeldSuspect {
			return i
		}
	}
	return -1
}

// paperCancelDay is the session GGG's crowded-short entry is planned for.
var paperCancelDay = civil.Date{Year: 2026, Month: time.August, Day: 18}

// paperCAIndex is the fixture session index of paperCASuspect.
func paperCAIndex() int {
	for i, d := range paperTradingDays(paperMarketStart, paperRunTo) {
		if d == paperCASuspect {
			return i
		}
	}
	return -1
}

// paperCrashIndex is the fixture session index of paperCrash.
func paperCrashIndex() int {
	for i, d := range paperTradingDays(paperMarketStart, paperRunTo) {
		if d == paperCrash {
			return i
		}
	}
	return -1
}

// paperIsHigh reports whether the code's k-th session closes at the highest close
// of the 20 sessions before it and the session itself.
func paperIsHigh(code, k int) bool {
	if k < 20 {
		return false
	}
	c := paperPrice(code, k)
	for j := k - 20; j < k; j++ {
		if paperPrice(code, j) >= c {
			return false
		}
	}
	return true
}

// seedPaperMarket writes the fixture's market: bars for every code and the index
// levels, the ASX sweep row the readiness gate reads, the dividend, the ASIC
// reports and the cash-rate series. Bars run from paperMarketStart to paperRunTo.
func seedPaperMarket(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	days := paperTradingDays(paperMarketStart, paperRunTo)

	var priceRows, indexRows [][]any
	for i, d := range days {
		for code := range paperCodes {
			if paperCodes[code] == paperStaleCode && d.After(paperStaleLast) {
				continue
			}
			c := paperPrice(code, i)
			var closeArg any = c
			if paperCodes[code] == paperNullCode && d == paperNullClose {
				closeArg = nil
			}
			// A session that closes at a 20-session high trades heavily: the volume
			// behind a breakout.
			// The heavy session is one in four of the highs: the 50-session average
			// stays near the base, so the heavy day clears 1.5 times it.
			volume := int64(1000000)
			if paperIsHigh(code, i) && i%4 == 0 {
				volume = 4000000
			}
			if paperCodes[code] == "GGG" && paperZeroVolume[d] {
				volume = 0
			}
			if paperCodes[code] == "AAA" && d == paperCASuspect {
				volume = 0
			}
			if paperCodes[code] == "HHH" && d == paperHeldSuspect {
				volume = 0
			}
			// GGG is untraded on the day its crowded-short entry is planned: the batch
			// cancels the entry (cancelled_untraded), and the paper track records it.
			if paperCodes[code] == "GGG" && d == paperCancelDay {
				volume = 0
			}
			open := c * (1 + 0.002*math.Cos(float64(i)))
			priceRows = append(priceRows, []any{paperCodes[code], d.String(), open, math.Max(open, c) * 1.001, math.Min(open, c) * 0.999, closeArg, c, volume})
		}
		xjo := 5000 * math.Exp(0.0003*float64(i)) * (1 + 0.003*math.Sin(float64(i)/5))
		xjt := 3000 * math.Exp(0.00035*float64(i)) * (1 + 0.003*math.Sin(float64(i)/5))
		indexRows = append(indexRows, []any{"XJO", d.String(), xjo * 1.01, xjo * 0.99, xjo},
			[]any{"XJT", d.String(), xjt * 1.01, xjt * 0.99, xjt})
	}
	for _, r := range priceRows {
		_, err := pool.Exec(ctx, `INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
			VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`, r...)
		require.NoError(t, err)
	}
	for _, r := range indexRows {
		_, err := pool.Exec(ctx, `INSERT INTO index_prices (index_code, date, high, low, close) VALUES ($1, $2::date, $3, $4, $5)`, r...)
		require.NoError(t, err)
	}

	_, err := pool.Exec(ctx, `INSERT INTO dividend_history (stock_code, ex_date, dividend_type, amount_per_share)
		VALUES ('CCC', $1::date, 'final', 0.4)`, paperDividend.String())
	require.NoError(t, err)

	// One completed price sweep, started on the last session's morning: it is the
	// newest sweep for every earlier session too, and each earlier 05:30 has passed.
	_, err = pool.Exec(ctx, `INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 1800, 'completed', $1::timestamptz, $2::timestamptz)`,
		paperRunTo.String()+" 06:00:00+00", paperRunTo.String()+" 06:30:00+00")
	require.NoError(t, err)

	seedPaperASIC(t, pool)
	seedPaperCashRate(t, pool)
}

// seedPaperASIC writes a short-position report per code on every session, as the
// ASIC publishes them: the rows the calendar, the ASIC history and the crowded-short
// universe read. A session below the newest report needs a report on its own date.
func seedPaperASIC(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for i, report := range paperTradingDays(paperMarketStart, paperRunTo) {
		for code := range paperCodes {
			shares := 1e8 * float64(1+code)
			// Above the 5% crowded threshold on every session.
			pct := 5.5 + 0.7*float64(code%4) + 0.05*float64(i%20)
			_, err := pool.Exec(ctx, `INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS",
				"TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
				VALUES ($1::timestamp, $2, $3, $4, $5, $6)`,
				report.String(), fmt.Sprintf("%s LIMITED ORDINARY", paperCodes[code]), paperCodes[code],
				shares*pct/100, shares, pct)
			require.NoError(t, err)
		}
		_, err := pool.Exec(ctx, `INSERT INTO asic_report_ingests (report_date, file_rows, loaded_rows) VALUES ($1::date, 8, 8)`, report.String())
		require.NoError(t, err)
	}
}

// seedPaperCashRate writes the RBA cash rate target monthly: the series the batch
// forward-fills and the paper track reads per session.
func seedPaperCashRate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO economic_series (series_key) VALUES ($1)`, pgsource.CashRateSeries)
	require.NoError(t, err)
	for y, m := 2025, time.January; y < 2026 || m < time.December; m++ {
		if m > time.December {
			m, y = time.January, y+1
		}
		rate := 4.35
		if y == 2026 && m >= time.February {
			rate = 4.10
		}
		_, err := pool.Exec(ctx, `INSERT INTO economic_observations (series_id, period, value)
			SELECT id, $1::date, $2 FROM economic_series WHERE series_key = $3`,
			civil.Date{Year: y, Month: m, Day: 1}.String(), rate, pgsource.CashRateSeries)
		require.NoError(t, err)
	}
}

// paperEconomicTables creates the economic tables the cash-rate reader selects
// from, which the source tables of dailyDB do not include.
func paperEconomicTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		CREATE TABLE economic_series (id BIGSERIAL PRIMARY KEY, series_key TEXT UNIQUE NOT NULL);
		CREATE TABLE economic_observations (series_id BIGINT NOT NULL REFERENCES economic_series(id),
			period DATE NOT NULL, value DOUBLE PRECISION NOT NULL);`)
	require.NoError(t, err)
}

// runPaperDay runs the daily job once for the session of day, as the job does at
// 14:00 UTC on that weekday, and fails the test on any error.
func runPaperDay(t *testing.T, pool *pgxpool.Pool, day civil.Date) dailyResult {
	t.Helper()
	opts := dailyOptions{
		Write:  true,
		Holder: "paper-test",
		Now:    time.Date(day.Year, day.Month, day.Day, 14, 0, 0, 0, time.UTC),
		Logf:   func(string, ...any) {},
		Sleep:  func(context.Context, time.Duration) error { return nil },
	}
	res, err := runDaily(context.Background(), pool, opts)
	require.NoError(t, err, "the daily run for %s", day)
	return res
}
