package features

import (
	"math"
	"math/rand"
	"sort"
	"testing"
	"time"

	"cloud.google.com/go/civil"
)

// legacyComplete is the completeness rule as NewReports computed it before
// ReportCompleteness existed: the rows deduplicated by (code, date) with the last
// one kept, the counts of finite rows, and the same Complete. It is the oracle.
type legacyReports struct {
	dates   []civil.Date
	pos     map[civil.Date]int
	count   map[civil.Date]int
	ingests map[civil.Date]ReportIngest
}

func legacyNew(rows []ASICRow, ingests []ReportIngest) *legacyReports {
	r := &legacyReports{pos: map[civil.Date]int{}, count: map[civil.Date]int{}, ingests: map[civil.Date]ReportIngest{}}
	type key struct {
		code string
		date civil.Date
	}
	kept := map[key]ASICRow{}
	for _, row := range rows {
		kept[key{row.Code, row.ReportDate}] = row
	}
	seen := map[civil.Date]bool{}
	for k, row := range kept {
		if !seen[k.date] {
			seen[k.date] = true
			r.dates = append(r.dates, k.date)
		}
		if row.Percent != nil && finite(*row.Percent) {
			r.count[k.date]++
		}
	}
	sort.Slice(r.dates, func(i, j int) bool { return r.dates[i].Before(r.dates[j]) })
	for i, d := range r.dates {
		r.pos[d] = i
	}
	for _, in := range ingests {
		r.ingests[in.ReportDate] = in
	}
	return r
}

func (r *legacyReports) complete(date civil.Date) bool {
	if in, ok := r.ingests[date]; ok && in.FileRows != nil {
		return in.LoadedRows >= *in.FileRows
	}
	i, ok := r.pos[date]
	if !ok {
		return false
	}
	if i == 0 {
		return true
	}
	prev := r.dates[i-1]
	return 2*r.count[date] >= r.count[prev]
}

// TestReportCompletenessMatchesTheLegacyRule compares Complete, through both the
// view and Reports, with the rule as it was, over random reports: duplicated
// (code, date) pairs with differing percentages, NULL and NaN percentages, codes
// missing from a report, partial reports and ingests that override the rule.
func TestReportCompletenessMatchesTheLegacyRule(t *testing.T) {
	r := rand.New(rand.NewSource(20261108))
	first := civil.Date{Year: 2019, Month: time.March, Day: 1}
	codes := []string{"AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"}
	for trial := 0; trial < 400; trial++ {
		var rows []ASICRow
		nDates := 1 + r.Intn(40)
		var dates []civil.Date
		for k := 0; k < nDates; k++ {
			dates = append(dates, first.AddDays(r.Intn(3000)))
		}
		for _, d := range dates {
			for _, c := range codes {
				if r.Intn(100) < 15 {
					continue // missing from this report
				}
				n := 1 + r.Intn(3) // duplicates for this (code, date)
				for j := 0; j < n; j++ {
					row := ASICRow{Code: c, ReportDate: d, Product: "ORDINARY FULLY PAID", Positions: float64(r.Intn(50))}
					switch r.Intn(10) {
					case 0:
						row.Percent = nil
					case 1:
						nan := math.NaN()
						row.Percent = &nan
					default:
						p := float64(r.Intn(12))
						row.Percent = &p
					}
					rows = append(rows, row)
				}
			}
		}
		r.Shuffle(len(rows), func(i, j int) { rows[i], rows[j] = rows[j], rows[i] })
		var ingests []ReportIngest
		for _, d := range dates {
			if r.Intn(4) != 0 {
				continue
			}
			ing := ReportIngest{ReportDate: d, LoadedRows: r.Intn(8)}
			if r.Intn(3) != 0 {
				fr := r.Intn(8)
				ing.FileRows = &fr
			}
			ingests = append(ingests, ing)
		}

		legacy := legacyNew(rows, ingests)
		view := NewReportCompleteness(rows, ingests)
		reports := NewReports(rows, ingests)
		probe := append([]civil.Date{}, dates...)
		for k := 0; k < 60; k++ {
			probe = append(probe, first.AddDays(r.Intn(3200)-100))
		}
		for _, d := range probe {
			want := legacy.complete(d)
			if got := view.Complete(d); got != want {
				t.Fatalf("trial %d: ReportCompleteness.Complete(%v) = %v, want %v", trial, d, got, want)
			}
			if got := reports.Complete(d); got != want {
				t.Fatalf("trial %d: Reports.Complete(%v) = %v, want %v", trial, d, got, want)
			}
		}
	}
}

// TestReportsRowMatchesTheLastGivenRow checks Reports.row against the map the
// rows were kept in before Reports indexed the shared slice: for a (code, date)
// pair given more than once, the last row given is the one returned, and a pair
// never given is absent.
func TestReportsRowMatchesTheLastGivenRow(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	first := civil.Date{Year: 2019, Month: time.March, Day: 1}
	codes := []string{"AAA", "BBB", "CCC", "DDD"}
	for trial := 0; trial < 200; trial++ {
		var rows []ASICRow
		for k := 0; k < 300; k++ {
			p := float64(r.Intn(9))
			rows = append(rows, ASICRow{
				Code:       codes[r.Intn(len(codes))],
				ReportDate: first.AddDays(r.Intn(40)),
				Product:    "ORDINARY FULLY PAID",
				Positions:  float64(k), // identifies the row
				Percent:    &p,
			})
		}
		kept := map[string]ASICRow{}
		for _, row := range rows {
			kept[row.Code+row.ReportDate.String()] = row
		}
		reports := NewReports(rows, nil)
		for _, code := range codes {
			for d := 0; d < 45; d++ {
				date := first.AddDays(d)
				want, wantOK := kept[code+date.String()]
				got, gotOK := reports.row(code, date)
				if gotOK != wantOK || (gotOK && got.Positions != want.Positions) {
					t.Fatalf("trial %d: row(%s, %v) = %v,%v want %v,%v", trial, code, date, got.Positions, gotOK, want.Positions, wantOK)
				}
			}
		}
	}
}
