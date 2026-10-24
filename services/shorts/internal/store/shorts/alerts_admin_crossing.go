package shorts

// alerts_admin_crossing.go is the admin smoke test's crossing finder: "which
// report date would the evaluator have fired this stock on?"
//
// It is a second implementation of the evaluator's rule, in the API's module,
// because the evaluator (services/jobs/internal/jobs/alerts) is internal to the
// jobs module. Every rule here names its counterpart in that package, and
// alerts_admin_crossing_test.go pins the same cases the evaluator's own tests
// pin. Change one, change the other.
//
//   - Window: the 20 newest distinct report dates and every reading in them
//     (windowDates, windowSQL and loadRows in store.go).
//   - Compared date: the report before the evaluated one in that window
//     (PlanReplay: snap.Dates[i+1]). The OLDEST of the 20 has no earlier report in
//     the window, so it is never a candidate.
//   - Oldest end: the window moves as new reports arrive, so a date within
//     replayMargin positions of the oldest end is not offered, and an explicit
//     date there is refused. Its compared date and lookback would otherwise fall
//     off the window before the replay runs.
//   - Completeness: a date with fewer than half the previous date's rows is
//     skipped. The evaluator's planner holds such dates, but PlanReplay has no
//     completeness hold, so the smoke test refuses them to keep a replay from
//     comparing a half-written day.
//   - Previous reading: the first report from the compared date back five dates
//     that has the code (previousAt, lookbackDates).
//   - Rule: short_interest_above fires on an UPWARD crossing only, on rounded
//     readings: previous < threshold <= latest (move.satisfies).
//   - Search without a code: candidates are the stocks whose NEWEST reading, to two
//     places, is at or above the threshold. A stock that crossed only on an older
//     date and has since fallen back is not a candidate. That is the search's
//     limit, not the rule's; a code given explicitly is always checked.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

const (
	// AlertWindowDates is how many of the newest report dates an alert replay can
	// evaluate (services/jobs/internal/jobs/alerts windowDates).
	AlertWindowDates = 20
	// alertLookbackDates is how many report dates back a previous reading may
	// come from (lookbackDates).
	alertLookbackDates = 5
)

// AlertWindow is the report window the evaluator reads: newest first.
type AlertWindow struct {
	// Dates are the distinct report dates (YYYY-MM-DD), newest first.
	Dates []string
	// Readings maps each date to its percent by code. Only non-null readings are
	// present, as the evaluator's loadRows reads them.
	Readings map[string]map[string]float64
	// Names maps a code to its company name, where company-metadata has one.
	Names map[string]string
}

// AlertCrossing is one stock that crossed a threshold on one report date.
type AlertCrossing struct {
	Code       string
	Name       string
	ReportDate string
	// ComparedTo is the report the evaluator compares the date with.
	ComparedTo string
	// PreviousDate is the report the previous reading was taken on. It is
	// ComparedTo unless the code was missing from that report.
	PreviousDate string
	Previous     float64
	Latest       float64
}

// roundAlertPercent is round2 in the evaluator: two decimal places.
func roundAlertPercent(x float64) float64 {
	return math.Round(x*100) / 100
}

// ShortInterestAboveCrossed is the evaluator's rule for short_interest_above
// (move.satisfies): the previous reading below the threshold and the threshold at
// or below the latest reading, both rounded to two places. The threshold is not
// rounded.
func ShortInterestAboveCrossed(previous, latest, threshold float64) bool {
	return roundAlertPercent(previous) < threshold && threshold <= roundAlertPercent(latest)
}

// dateComplete is planDaily's completeness guard for the date at index idx: a
// date with under half the previous date's rows is held, not evaluated.
func (w AlertWindow) dateComplete(idx int) bool {
	if idx+1 >= len(w.Dates) {
		return false
	}
	return 2*len(w.Readings[w.Dates[idx]]) >= len(w.Readings[w.Dates[idx+1]])
}

// crossingAt evaluates one code on the date at idx against the report before it.
func (w AlertWindow) crossingAt(code string, idx int, threshold float64) (AlertCrossing, bool) {
	if idx+1 >= len(w.Dates) || !w.dateComplete(idx) {
		return AlertCrossing{}, false
	}
	day := w.Dates[idx]
	latest, ok := w.Readings[day][code]
	if !ok {
		return AlertCrossing{}, false
	}
	from := idx + 1
	var prev float64
	var prevDate string
	found := false
	for i := from; i < len(w.Dates) && i < from+alertLookbackDates; i++ {
		if v, ok := w.Readings[w.Dates[i]][code]; ok {
			prev, prevDate, found = v, w.Dates[i], true
			break
		}
	}
	if !found || !ShortInterestAboveCrossed(prev, latest, threshold) {
		return AlertCrossing{}, false
	}
	return AlertCrossing{
		Code:         code,
		Name:         w.Names[code],
		ReportDate:   day,
		ComparedTo:   w.Dates[idx+1],
		PreviousDate: prevDate,
		Previous:     roundAlertPercent(prev),
		Latest:       roundAlertPercent(latest),
	}, true
}

// indexOf is the position of day in the window, or -1.
func (w AlertWindow) indexOf(day string) int {
	for i, d := range w.Dates {
		if d == day {
			return i
		}
	}
	return -1
}

// replayMargin is how many positions the oldest report date must be from the end
// of the window before a date is offered for replay.
const replayMargin = 3

// replayable reports whether the date at idx may be replayed: it is at least
// replayMargin positions from the oldest end, so its compared date and lookback are
// still in the window.
func (w AlertWindow) replayable(idx int) bool {
	return idx >= 0 && idx+replayMargin < len(w.Dates)
}

// CrossingOn reports whether code crossed the threshold on day, and why not when it
// did not. day must be one the smoke test can replay.
func (w AlertWindow) CrossingOn(code, day string, threshold float64) (AlertCrossing, error) {
	idx := w.indexOf(day)
	if idx < 0 {
		return AlertCrossing{}, fmt.Errorf("%s is not one of the last %d report dates", day, AlertWindowDates)
	}
	if idx+1 >= len(w.Dates) {
		return AlertCrossing{}, fmt.Errorf("%s is the oldest report date in the window, so it has no earlier report to compare with", day)
	}
	if !w.replayable(idx) {
		return AlertCrossing{}, fmt.Errorf("%s is among the %d oldest report dates in the window, which move as new reports arrive: pick a newer date", day, replayMargin)
	}
	if !w.dateComplete(idx) {
		return AlertCrossing{}, fmt.Errorf("%s is incomplete (fewer than half the rows of the report before it), and the smoke test skips incomplete dates", day)
	}
	c, ok := w.crossingAt(code, idx, threshold)
	if !ok {
		return AlertCrossing{}, fmt.Errorf("%s did not cross %g on %s", code, threshold, day)
	}
	return c, nil
}

// FindShortInterestCrossing returns the most recent replayable report date on which a
// stock crossed the threshold. With a code, only that code is considered. Without
// one, the candidates are the stocks whose newest reading, rounded to two places, is
// at or above the threshold, ordered by that reading. ok is false when no replayable
// date has a crossing.
func (w AlertWindow) FindShortInterestCrossing(code string, threshold float64) (AlertCrossing, bool) {
	var candidates []string
	if code != "" {
		candidates = []string{code}
	} else if len(w.Dates) > 0 {
		newest := w.Readings[w.Dates[0]]
		for c, v := range newest {
			if roundAlertPercent(v) >= threshold {
				candidates = append(candidates, c)
			}
		}
		sort.Slice(candidates, func(i, j int) bool {
			a, b := newest[candidates[i]], newest[candidates[j]]
			if a != b {
				return a > b
			}
			return candidates[i] < candidates[j]
		})
	}
	for idx := 0; w.replayable(idx); idx++ {
		if !w.dateComplete(idx) {
			continue
		}
		for _, c := range candidates {
			if crossing, ok := w.crossingAt(c, idx, threshold); ok {
				return crossing, true
			}
		}
	}
	return AlertCrossing{}, false
}

// ReportWindow reads the evaluator's window: the newest AlertWindowDates report
// dates and every non-null reading in them, plus company names. The same two
// reads as the evaluator's snapshot (store.go reportDates and loadRows).
func (s *postgresStore) ReportWindow(ctx context.Context) (AlertWindow, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	w := AlertWindow{Readings: map[string]map[string]float64{}, Names: map[string]string{}}
	rows, err := s.db.Query(ctx, `
		WITH RECURSIVE d(dt) AS (
		  SELECT max("DATE") FROM shorts
		  UNION ALL
		  SELECT (SELECT max("DATE") FROM shorts WHERE "DATE" < d.dt) FROM d WHERE d.dt IS NOT NULL
		)
		SELECT dt::date FROM d WHERE dt IS NOT NULL LIMIT $1`, AlertWindowDates)
	if err != nil {
		return w, fmt.Errorf("read report dates: %w", err)
	}
	for rows.Next() {
		var day time.Time
		if err := rows.Scan(&day); err != nil {
			rows.Close()
			return w, fmt.Errorf("scan report date: %w", err)
		}
		w.Dates = append(w.Dates, day.Format("2006-01-02"))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return w, fmt.Errorf("iterate report dates: %w", err)
	}
	if len(w.Dates) == 0 {
		return w, nil
	}

	readings, err := s.db.Query(ctx, `
		SELECT "DATE"::date, "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		  FROM shorts
		 WHERE "DATE" >= $1::date AND "DATE" < $2::date + 1
		   AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL`,
		w.Dates[len(w.Dates)-1], w.Dates[0])
	if err != nil {
		return w, fmt.Errorf("read readings: %w", err)
	}
	defer readings.Close()
	for readings.Next() {
		var (
			day  time.Time
			code string
			pct  float64
		)
		if err := readings.Scan(&day, &code, &pct); err != nil {
			return w, fmt.Errorf("scan reading: %w", err)
		}
		key := day.Format("2006-01-02")
		if w.Readings[key] == nil {
			w.Readings[key] = map[string]float64{}
		}
		w.Readings[key][code] = pct
	}
	if err := readings.Err(); err != nil {
		return w, fmt.Errorf("iterate readings: %w", err)
	}

	names, err := s.db.Query(ctx, `SELECT stock_code, COALESCE(company_name, '') FROM "company-metadata"`)
	if err != nil {
		return w, fmt.Errorf("read company names: %w", err)
	}
	defer names.Close()
	for names.Next() {
		var code, name string
		if err := names.Scan(&code, &name); err != nil {
			return w, fmt.Errorf("scan company name: %w", err)
		}
		w.Names[code] = name
	}
	return w, names.Err()
}
