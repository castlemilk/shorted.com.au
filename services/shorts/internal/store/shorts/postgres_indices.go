package shorts

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// IndexSeriesQuery selects a window of a benchmark index's levels.
type IndexSeriesQuery struct {
	IndexCode string
	Period    string
	From, To  string
	MaxPoints int32
}

// ListIndices returns the benchmark registry with each series' real coverage.
//
// Coverage is computed rather than declared because it differs materially
// between series and the difference decides what a caller can do: the
// total-return index only exists from 2019, so a study spanning 2011 onward has
// to use price return for the early years and know that it is doing so.
func (s *postgresStore) ListIndices() ([]*shortsv1alpha1.IndexDefinition, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rows, err := s.db.Query(ctx, `
		SELECT m.index_code, m.name, m.return_type, m.currency,
		       COALESCE(MIN(p.date)::text, ''), COALESCE(MAX(p.date)::text, ''),
		       COUNT(p.date)
		FROM index_metadata m
		LEFT JOIN index_prices p ON p.index_code = m.index_code
		GROUP BY m.index_code, m.name, m.return_type, m.currency
		ORDER BY m.index_code`)
	if err != nil {
		return nil, fmt.Errorf("list indices: %w", err)
	}
	defer rows.Close()

	out := []*shortsv1alpha1.IndexDefinition{}
	for rows.Next() {
		d := &shortsv1alpha1.IndexDefinition{}
		var observations int64
		if err := rows.Scan(&d.Code, &d.Name, &d.ReturnType, &d.Currency,
			&d.EarliestDate, &d.LatestDate, &observations); err != nil {
			return nil, err
		}
		d.Observations = int32(observations)
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetIndexSeries returns daily levels for one benchmark.
func (s *postgresStore) GetIndexSeries(q IndexSeriesQuery) (*shortsv1alpha1.GetIndexSeriesResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	code := strings.ToUpper(strings.TrimSpace(q.IndexCode))

	// The definition carries the series' FULL coverage, not the window served
	// below. Coverage differs sharply between series and cannot be guessed —
	// XJO reaches 2006, XKO 2013, and XJT, the only total-return series, begins
	// 2019-04-29 because that is where it begins upstream — so a caller needs
	// it stated to know whether their window was answerable at all.
	def := &shortsv1alpha1.IndexDefinition{}
	var observations int64
	err := s.db.QueryRow(ctx, `
		SELECT m.index_code, m.name, m.return_type, m.currency,
		       COALESCE(MIN(p.date)::text, ''), COALESCE(MAX(p.date)::text, ''),
		       COUNT(p.date)
		FROM index_metadata m
		LEFT JOIN index_prices p ON p.index_code = m.index_code
		WHERE m.index_code = $1
		GROUP BY m.index_code, m.name, m.return_type, m.currency`, code).
		Scan(&def.Code, &def.Name, &def.ReturnType, &def.Currency,
			&def.EarliestDate, &def.LatestDate, &observations)
	if err != nil {
		return nil, fmt.Errorf("unknown index %q: %w", code, err)
	}
	def.Observations = int32(observations)

	requestedFrom, requestedTo := q.From, q.To

	var where string
	args := []interface{}{code}
	switch {
	case q.From != "":
		where = " AND date >= $2::date"
		args = append(args, q.From)
		if q.To != "" {
			where += " AND date <= $3::date"
			args = append(args, q.To)
		}
	case q.To != "":
		where = " AND date <= $2::date"
		args = append(args, q.To)
	default:
		// Anchored on the newest stored session rather than CURRENT_DATE, so a
		// lagging feed narrows the window instead of emptying it — the failure
		// mode mv_screener_data has, where a stale price feed silently returns
		// nothing at all.
		where = fmt.Sprintf(
			" AND date > (SELECT MAX(date) FROM index_prices WHERE index_code = $1) - INTERVAL '%s'",
			periodToInterval(q.Period))

		// Resolve the shorthand to a concrete date so truncation is detectable.
		// "10Y" against a series holding two years is precisely the request
		// that used to come back looking complete, and with requested_from left
		// empty nothing downstream could tell.
		if from := periodStartDate(q.Period, def.LatestDate); from != "" {
			requestedFrom = from
			requestedTo = def.LatestDate
		}
	}

	base := "FROM index_prices WHERE index_code = $1" + where

	var total int
	if err := s.db.QueryRow(ctx, "SELECT COUNT(*) "+base, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count index sessions: %w", err)
	}

	rows, err := s.db.Query(ctx,
		`SELECT date, open, high, low, close, volume `+base+` ORDER BY date ASC`, args...)
	if err != nil {
		return nil, fmt.Errorf("query index series: %w", err)
	}
	defer rows.Close()

	points := []*shortsv1alpha1.IndexPoint{}
	for rows.Next() {
		var date time.Time
		var open, high, low, closeLvl *float64
		var volume *int64
		if err := rows.Scan(&date, &open, &high, &low, &closeLvl, &volume); err != nil {
			return nil, fmt.Errorf("scan index row: %w", err)
		}
		p := &shortsv1alpha1.IndexPoint{Date: date.Format("2006-01-02")}
		if open != nil {
			p.Open = finiteOrZero(*open)
		}
		if high != nil {
			p.High = finiteOrZero(*high)
		}
		if low != nil {
			p.Low = finiteOrZero(*low)
		}
		if closeLvl != nil {
			p.Close = finiteOrZero(*closeLvl)
		}
		if volume != nil {
			p.Volume = *volume
		}
		points = append(points, p)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	downsampled := false
	if q.MaxPoints > 0 && len(points) > int(q.MaxPoints) {
		points = thinIndexPoints(points, int(q.MaxPoints))
		downsampled = true
	}

	out := &shortsv1alpha1.GetIndexSeriesResponse{
		Index:             def,
		Points:            points,
		TotalObservations: int32(total),
		Downsampled:       downsampled,
		RequestedFrom:     requestedFrom,
		RequestedTo:       requestedTo,
	}
	if len(points) > 0 {
		out.CoveredFrom = points[0].Date
		out.CoveredTo = points[len(points)-1].Date
	}

	// Truncation is judged against the SERIES, not against the window returned.
	// A request for 10 years of a series that holds two is truncated even
	// though every session it holds was returned — which is exactly the case
	// that used to look like a complete answer.
	out.Truncated = isTruncated(requestedFrom, requestedTo, def.EarliestDate, def.LatestDate)

	return out, nil
}

// thinIndexPoints mirrors thinTimeSeries: evenly spaced, both endpoints kept.
// The endpoints matter more here than anywhere else — a benchmark's first and
// last level ARE the return being compared against.
func thinIndexPoints(points []*shortsv1alpha1.IndexPoint, max int) []*shortsv1alpha1.IndexPoint {
	if max <= 0 || len(points) <= max {
		return points
	}
	if max == 1 {
		return points[len(points)-1:]
	}
	out := make([]*shortsv1alpha1.IndexPoint, 0, max)
	step := float64(len(points)-1) / float64(max-1)
	for i := 0; i < max; i++ {
		out = append(out, points[int(math.Round(float64(i)*step))])
	}
	return out
}

// isTruncated reports whether a requested window reaches outside what the
// series holds.
//
// Judged against the SERIES' coverage rather than against the rows returned: a
// request for ten years of a series holding two returns every session it has,
// so comparing returned-rows to requested-rows would call that complete. It is
// the case most worth flagging — the caller believes they measured a decade.
//
// An open-ended request (no from/to, i.e. a period shorthand resolved server
// side) is never truncated: the caller asked for "the last N years of whatever
// exists", and got it.
func isTruncated(requestedFrom, requestedTo, earliest, latest string) bool {
	if earliest == "" || latest == "" {
		// No data at all. The empty series is the signal; calling it truncated
		// as well would say the same thing twice.
		return false
	}
	if requestedFrom != "" && requestedFrom < earliest {
		return true
	}
	if requestedTo != "" && requestedTo > latest {
		return true
	}
	return false
}

// periodStartDate resolves a period shorthand to the date that window starts
// on, relative to the newest session held. Returns "" for MAX, an unknown
// period, or when the series is empty — none of which describe a bounded
// request that could be truncated.
func periodStartDate(period, latest string) string {
	if latest == "" {
		return ""
	}
	anchor, err := time.Parse("2006-01-02", latest)
	if err != nil {
		return ""
	}
	var years, months, days int
	switch strings.ToUpper(strings.TrimSpace(period)) {
	case "1D":
		days = -1
	case "1W":
		days = -7
	case "1M":
		months = -1
	case "3M":
		months = -3
	case "6M":
		months = -6
	case "1Y":
		years = -1
	case "2Y":
		years = -2
	case "5Y":
		years = -5
	case "10Y":
		years = -10
	default:
		// MAX asks for everything there is, so it cannot fall short of itself.
		return ""
	}
	return anchor.AddDate(years, months, days).Format("2006-01-02")
}
