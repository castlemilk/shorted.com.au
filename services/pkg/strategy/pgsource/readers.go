package pgsource

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// Every reader below is per code or bounded by a date range, so none of them
// scans a whole history (Supabase's work_mem is 2 MB). A NULL price or count
// is NaN, which the feature functions read as "not a price" or "not a count",
// never as zero.

// CashRateSeries is the economic_series key of the cash rate target that
// Sharpe and idle cash read.
const CashRateSeries = "rates.cash_rate_target.aus"

// DividendsFrom is the first ex-date dividend_history is read from. The
// history before it is not in the vendor's unadjusted form the cash-dividend
// rule needs.
var DividendsFrom = civil.Date{Year: 2024, Month: time.September, Day: 11}

// nanOr returns the value of a nullable float, or NaN when it is NULL.
func nanOr(v *float64) float64 {
	if v == nil {
		return math.NaN()
	}
	return *v
}

// dateOf converts a scanned DATE to a civil.Date.
func dateOf(t time.Time) civil.Date { return civil.DateOf(t) }

// Bars reads one code's stock_prices rows in [from, to], date ascending. The
// rows are as stored: no close filter (features apply validPrice themselves).
// A NULL open, high, low, close or adjusted close is NaN; a NULL volume is 0.
func Bars(ctx context.Context, db DB, code string, from, to civil.Date) ([]features.Bar, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT date::date, open::float8, high::float8, low::float8, close::float8,
		       adjusted_close::float8, COALESCE(volume, 0)::float8
		FROM stock_prices
		WHERE stock_code = $1 AND date BETWEEN $2::date AND $3::date
		ORDER BY date`, code, from.String(), to.String())
	if err != nil {
		return nil, fmt.Errorf("query bars for %s: %w", code, err)
	}
	defer rows.Close()
	var out []features.Bar
	for rows.Next() {
		var (
			d                    time.Time
			o, h, l, c, adj, vol *float64
			bar                  features.Bar
		)
		if err := rows.Scan(&d, &o, &h, &l, &c, &adj, &vol); err != nil {
			return nil, fmt.Errorf("scan bar for %s: %w", code, err)
		}
		bar = features.Bar{
			Date: dateOf(d), Open: nanOr(o), High: nanOr(h), Low: nanOr(l),
			Close: nanOr(c), AdjClose: nanOr(adj), Volume: nanOr(vol),
		}
		if vol == nil {
			bar.Volume = 0
		}
		out = append(out, bar)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bars for %s: %w", code, err)
	}
	return out, nil
}

// IndexBars reads one index's bars (index_prices, for example XJO or XJT) in
// [from, to], date ascending. A missing index or range is an empty slice.
func IndexBars(ctx context.Context, db DB, indexCode string, from, to civil.Date) ([]features.IndexBar, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT date::date, high::float8, low::float8, close::float8
		FROM index_prices
		WHERE index_code = $1 AND date BETWEEN $2::date AND $3::date
		ORDER BY date`, indexCode, from.String(), to.String())
	if err != nil {
		return nil, fmt.Errorf("query index bars for %s: %w", indexCode, err)
	}
	defer rows.Close()
	var out []features.IndexBar
	for rows.Next() {
		var (
			d       time.Time
			h, l, c *float64
		)
		if err := rows.Scan(&d, &h, &l, &c); err != nil {
			return nil, fmt.Errorf("scan index bar for %s: %w", indexCode, err)
		}
		out = append(out, features.IndexBar{Date: dateOf(d), High: nanOr(h), Low: nanOr(l), Close: nanOr(c)})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate index bars for %s: %w", indexCode, err)
	}
	return out, nil
}

// ASICRows reads the shorts rows whose report date is in [from, to]. Zero
// positions are kept (the readings count a zero row as a report that had no
// short position), and a row with a NULL product code is dropped, since it
// has no code to attach to. A NULL position or share count is NaN; a NULL
// percentage stays nil.
func ASICRows(ctx context.Context, db DB, from, to civil.Date) ([]features.ASICRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT "PRODUCT_CODE"::text, "DATE"::date, COALESCE("PRODUCT", '')::text,
		       "REPORTED_SHORT_POSITIONS"::float8, "TOTAL_PRODUCT_IN_ISSUE"::float8,
		       "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"::float8
		FROM shorts
		WHERE "DATE" BETWEEN $1::date AND $2::date AND "PRODUCT_CODE" IS NOT NULL
		ORDER BY "DATE", "PRODUCT_CODE"`, from.String(), to.String())
	if err != nil {
		return nil, fmt.Errorf("query ASIC rows: %w", err)
	}
	defer rows.Close()
	var out []features.ASICRow
	for rows.Next() {
		var (
			code, product   string
			d               time.Time
			pos, issued, pc *float64
		)
		if err := rows.Scan(&code, &d, &product, &pos, &issued, &pc); err != nil {
			return nil, fmt.Errorf("scan ASIC row: %w", err)
		}
		out = append(out, features.ASICRow{
			Code: code, ReportDate: dateOf(d), Product: product,
			Positions: nanOr(pos), Issued: nanOr(issued), Percent: finite(pc),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ASIC rows: %w", err)
	}
	return out, nil
}

// ReportIngests reads asic_report_ingests for the report dates in [from, to]:
// how many codes ASIC's file listed and how many reached shorts. A NULL
// file_rows is nil, which the completeness rule reads as not recorded.
func ReportIngests(ctx context.Context, db DB, from, to civil.Date) ([]features.ReportIngest, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT report_date::date, file_rows::int4, loaded_rows::int4
		FROM asic_report_ingests
		WHERE report_date BETWEEN $1::date AND $2::date
		ORDER BY report_date`, from.String(), to.String())
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReportIngests", err)
			return nil, nil
		}
		return nil, fmt.Errorf("query report ingests: %w", err)
	}
	defer rows.Close()
	var out []features.ReportIngest
	for rows.Next() {
		var (
			d      time.Time
			file   *int32
			loaded int32
		)
		if err := rows.Scan(&d, &file, &loaded); err != nil {
			return nil, fmt.Errorf("scan report ingest: %w", err)
		}
		ing := features.ReportIngest{ReportDate: dateOf(d), LoadedRows: int(loaded)}
		if file != nil {
			n := int(*file)
			ing.FileRows = &n
		}
		out = append(out, ing)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate report ingests: %w", err)
	}
	return out, nil
}

// ETPSet is the exchange-traded fund and listed-investment-company codes
// (ownership_funds), the universe's exclusion list. Upper case.
func ETPSet(ctx context.Context, db DB) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT upper(asx_code)::text
		FROM ownership_funds
		WHERE fund_type IN ('etf', 'lic') AND asx_code IS NOT NULL`)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ETPSet", err)
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("query ETP set: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, fmt.Errorf("scan ETP code: %w", err)
		}
		out[code] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ETP set: %w", err)
	}
	return out, nil
}

// CompanyNames maps each stock code to its company-metadata name, for the
// ordinary-share rule. Codes with an empty name are left out.
func CompanyNames(ctx context.Context, db DB) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT stock_code::text, company_name::text
		FROM "company-metadata"
		WHERE company_name IS NOT NULL AND company_name <> ''`)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("CompanyNames", err)
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("query company names: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var code, name string
		if err := rows.Scan(&code, &name); err != nil {
			return nil, fmt.Errorf("scan company name: %w", err)
		}
		out[strings.ToUpper(code)] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate company names: %w", err)
	}
	return out, nil
}

// Dividends reads dividend_history from from onward, per code in ex-date
// order. amount_per_share is the unadjusted cash per share on the ex-date.
func Dividends(ctx context.Context, db DB, from civil.Date) (map[string][]features.Dividend, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT stock_code::text, ex_date::date, amount_per_share::float8
		FROM dividend_history
		WHERE ex_date >= $1::date
		ORDER BY stock_code, ex_date`, from.String())
	if err != nil {
		return nil, fmt.Errorf("query dividends: %w", err)
	}
	defer rows.Close()
	out := map[string][]features.Dividend{}
	for rows.Next() {
		var (
			code string
			d    time.Time
			amt  float64
		)
		if err := rows.Scan(&code, &d, &amt); err != nil {
			return nil, fmt.Errorf("scan dividend: %w", err)
		}
		out[code] = append(out[code], features.Dividend{ExDate: dateOf(d), AmountPerShare: amt})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate dividends: %w", err)
	}
	return out, nil
}

// CashRate reads the cash rate target (CashRateSeries) and returns one point
// per calendar month from the first observation's month through the month of
// to, each carrying the latest rate observed on or before the month's start.
// No observation means no points.
func CashRate(ctx context.Context, db DB, to civil.Date) ([]features.RatePoint, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT o.period::date, o.value::float8
		FROM economic_observations o
		JOIN economic_series s ON s.id = o.series_id
		WHERE s.series_key = $1 AND o.period <= $2::date
		ORDER BY o.period`, CashRateSeries, to.String())
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("CashRate", err)
			return nil, nil
		}
		return nil, fmt.Errorf("query cash rate: %w", err)
	}
	defer rows.Close()
	var obs []features.RatePoint
	for rows.Next() {
		var (
			d    time.Time
			rate float64
		)
		if err := rows.Scan(&d, &rate); err != nil {
			return nil, fmt.Errorf("scan cash rate: %w", err)
		}
		obs = append(obs, features.RatePoint{Date: dateOf(d), Rate: rate})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate cash rate: %w", err)
	}
	return monthlyForwardFill(obs, to), nil
}

// monthlyForwardFill turns observations (date ascending) into one point per
// month from the first observation's month through to's month. Each month
// takes the last observation on or before its first day.
func monthlyForwardFill(obs []features.RatePoint, to civil.Date) []features.RatePoint {
	if len(obs) == 0 {
		return nil
	}
	var out []features.RatePoint
	i := 0
	cur := civil.Date{Year: obs[0].Date.Year, Month: obs[0].Date.Month, Day: 1}
	last := civil.Date{Year: to.Year, Month: to.Month, Day: 1}
	for !cur.After(last) {
		for i < len(obs) && !monthStart(obs[i].Date).After(cur) {
			i++
		}
		out = append(out, features.RatePoint{Date: cur, Rate: obs[i-1].Rate})
		cur = addMonth(cur)
	}
	return out
}

// monthStart is the first day of d's month.
func monthStart(d civil.Date) civil.Date { return civil.Date{Year: d.Year, Month: d.Month, Day: 1} }

// addMonth moves a first-of-month date one month on.
func addMonth(d civil.Date) civil.Date {
	if d.Month == time.December {
		return civil.Date{Year: d.Year + 1, Month: time.January, Day: 1}
	}
	return civil.Date{Year: d.Year, Month: d.Month + 1, Day: 1}
}
