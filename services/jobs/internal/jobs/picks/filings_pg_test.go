package picks

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// TestFilingUpsertPolicyAgainstPostgres runs the filing conflict policy for
// real. It needs a database with migration 000129 applied and is skipped
// unless PICKS_TEST_DATABASE_URL is set (CI has no database for this package):
//
//	PICKS_TEST_DATABASE_URL=postgres://postgres@localhost:5499/picks GOWORK=off go test ./internal/jobs/picks/ -run AgainstPostgres
//
// It only touches rows of the codes ZZT1..ZZT3 and deletes them first.
func TestFilingUpsertPolicyAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("PICKS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PICKS_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := platform.Connect(ctx, dsn) // simple protocol, exactly as the job
	require.NoError(t, err)
	defer pool.Close()
	st := &pgStore{pool: pool, notices: &noticeLog{}}

	_, err = pool.Exec(ctx, `DELETE FROM stock_fundamentals WHERE stock_code IN ('ZZT1','ZZT2','ZZT3')`)
	require.NoError(t, err)

	type got struct {
		revenue, netIncome, epsBasic *float64
		currency, source             string
		updatedAt                    time.Time
	}
	read := func(code, typ, end string) (got, bool) {
		var g got
		err := pool.QueryRow(ctx, `SELECT revenue, net_income, eps_basic, currency, source, updated_at
			FROM stock_fundamentals WHERE stock_code = $1 AND period_type = $2 AND period_end = $3::date`, code, typ, end).
			Scan(&g.revenue, &g.netIncome, &g.epsBasic, &g.currency, &g.source, &g.updatedAt)
		if err != nil {
			return got{}, false
		}
		return g, true
	}
	fy := int16(2025)
	vendor := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy, Currency: "AUD", Revenue: f64(100e6), Source: sourceYahoo},
	}
	require.NoError(t, st.UpsertPeriods(ctx, "ZZT1", vendor, time.Now()))
	usd := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy, Currency: "USD", Revenue: f64(50e6), Source: sourceYahoo},
	}
	require.NoError(t, st.UpsertPeriods(ctx, "ZZT2", usd, time.Now()))

	// 1. A filing for the vendor's period fills only the NULL column.
	fyH := int16(2026)
	filing := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy, Currency: "AUD", Revenue: f64(999e6), NetIncome: f64(7e6), Source: sourceFiling},
		{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), FiscalYear: &fyH, Currency: "AUD", Revenue: f64(60e6), EPSBasic: f64(0.03), Source: sourceFiling},
		{PeriodType: periodHalf, PeriodEnd: date("2024-12-31"), FiscalYear: &fy, Currency: "AUD", Revenue: f64(45e6), Source: sourceFiling},
	}
	require.NoError(t, st.UpsertFilingPeriods(ctx, "ZZT1", filing, time.Now()))
	a, ok := read("ZZT1", periodAnnual, "2025-06-30")
	require.True(t, ok)
	assert.Equal(t, 100e6, *a.revenue, "the vendor's value is never overwritten")
	require.NotNil(t, a.netIncome)
	assert.Equal(t, 7e6, *a.netIncome, "the vendor's NULL is filled")
	assert.Equal(t, sourceYahoo, a.source, "the row stays the vendor's")

	// 2. Only when currencies agree.
	require.NoError(t, st.UpsertFilingPeriods(ctx, "ZZT2", []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy, Currency: "AUD", NetIncome: f64(7e6), Source: sourceFiling},
	}, time.Now()))
	u, _ := read("ZZT2", periodAnnual, "2025-06-30")
	assert.Nil(t, u.netIncome, "an AUD filing never fills a USD vendor row")
	assert.Equal(t, "USD", u.currency)

	// 3. Half rows the vendor lacks are inserted whole.
	h, ok := read("ZZT1", periodHalf, "2025-12-31")
	require.True(t, ok)
	assert.Equal(t, sourceFiling, h.source)
	assert.Equal(t, 60e6, *h.revenue)
	assert.Equal(t, 0.03, *h.epsBasic)

	// 4. A no-op re-run moves nothing (updated_at stays).
	time.Sleep(20 * time.Millisecond)
	require.NoError(t, st.UpsertFilingPeriods(ctx, "ZZT1", filing, time.Now()))
	h2, _ := read("ZZT1", periodHalf, "2025-12-31")
	assert.Equal(t, h.updatedAt, h2.updatedAt, "an identical rebuild is a no-op")
	a2, _ := read("ZZT1", periodAnnual, "2025-06-30")
	assert.Equal(t, a.updatedAt, a2.updatedAt, "a vendor row with nothing left to fill is untouched")

	// 5. The next rebuild replaces a filing row whole and prunes what it no
	//    longer produces; the vendor row is never deleted.
	rebuilt := []PeriodRow{
		{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), FiscalYear: &fyH, Currency: "AUD", Revenue: f64(61e6), Source: sourceFiling},
	}
	require.NoError(t, st.UpsertFilingPeriods(ctx, "ZZT1", rebuilt, time.Now()))
	h3, _ := read("ZZT1", periodHalf, "2025-12-31")
	assert.Equal(t, 61e6, *h3.revenue)
	assert.Nil(t, h3.epsBasic, "full replace: no document supports the EPS any more")
	_, ok = read("ZZT1", periodHalf, "2024-12-31")
	assert.False(t, ok, "a filing row this run no longer produces is pruned")
	a3, ok := read("ZZT1", periodAnnual, "2025-06-30")
	require.True(t, ok, "a vendor row is never pruned")
	assert.Equal(t, 7e6, *a3.netIncome, "the value it was filled with stays (the vendor row owns it now)")

	// 6. Yahoo arriving for a period a filing wrote first takes the row over.
	fy24 := int16(2024)
	require.NoError(t, st.UpsertFilingPeriods(ctx, "ZZT3", []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), FiscalYear: &fy24, Currency: "AUD", Revenue: f64(10e6), NetIncome: f64(1e6), Source: sourceFiling},
	}, time.Now()))
	require.NoError(t, st.UpsertPeriods(ctx, "ZZT3", []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), FiscalYear: &fy24, Currency: "AUD", Revenue: f64(10.2e6), Source: sourceYahoo},
	}, time.Now()))
	y, _ := read("ZZT3", periodAnnual, "2024-06-30")
	assert.Equal(t, sourceYahoo, y.source)
	assert.Equal(t, 10.2e6, *y.revenue, "the vendor's value wins")
	assert.Equal(t, 1e6, *y.netIncome, "the filing's survives where the vendor has none")

	_, err = pool.Exec(ctx, `DELETE FROM stock_fundamentals WHERE stock_code IN ('ZZT1','ZZT2','ZZT3')`)
	require.NoError(t, err)
}
