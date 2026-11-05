package backtest

import (
	"fmt"
	"math"
	"testing"
	"time"

	"cloud.google.com/go/civil"
)

// prevOf is the previously published run of a key over in, taken at cut.
func prevOf(in Inputs, cut civil.Date, finished time.Time, inputHash string) *PreviousRun {
	return &PreviousRun{
		RunID: 7, CutOff: cut, FinishedAt: finished, InputHash: inputHash,
		Digests: CodeDigests(in, cut),
	}
}

func TestDiffWithoutAPreviousRunIsNone(t *testing.T) {
	in := loadGolden(t)
	if d := DiffAgainst(in, nil, "h", Curve{}, nil); d.State != DiffNone || d.PreviousRunID != 0 {
		t.Fatalf("no previous run: %+v", d)
	}
}

func TestDiffOfUnchangedInputsListsNothing(t *testing.T) {
	in := loadGolden(t)
	prev := prevOf(in, civil.Date{Year: 2025, Month: 6, Day: 30}, time.Now(), "same")
	d := DiffAgainst(in, prev, "same", Curve{}, []ASICRevision{{ReportDate: prev.CutOff, Code: "AAA", RevisedAt: time.Now().Add(time.Hour)}})
	if d.State != DiffUnchanged || d.RewrittenCount != 0 || d.RevisedCount != 0 {
		t.Fatalf("unchanged input: %+v", d)
	}
}

// Ordinary daily appends after the cut-off change the input hash but no digest.
func TestDiffListsRewrittenHistoryNotAppends(t *testing.T) {
	in := loadGolden(t)
	code := in.Codes()[0]
	last := in.BarsByCode[code][len(in.BarsByCode[code])-1].Date
	cut := last.AddDays(-30)
	prev := prevOf(in, cut, time.Now(), "old")

	appended := loadGolden(t)
	b := appended.BarsByCode[code][len(appended.BarsByCode[code])-1]
	b.Date = last.AddDays(1)
	appended.BarsByCode[code] = append(appended.BarsByCode[code], b)
	d := DiffAgainst(appended, prev, "new", Curve{}, nil)
	if d.State != DiffChanged || d.RewrittenCount != 0 {
		t.Fatalf("an append alone: %+v", d)
	}

	rewritten := loadGolden(t)
	rewritten.BarsByCode[code][0].Close += 0.01
	d = DiffAgainst(rewritten, prev, "new", Curve{}, nil)
	if d.RewrittenCount != 1 || len(d.PriceRowsRewritten) != 1 || d.PriceRowsRewritten[0] != code {
		t.Fatalf("a rewritten row: %+v, want [%s]", d.PriceRowsRewritten, code)
	}
}

// A revision counts when it changes a report at or before the cut-off and was
// recorded after the previous run finished. Anything else is not the diff's.
func TestDiffListsASICRevisionsAfterThePreviousRun(t *testing.T) {
	in := loadGolden(t)
	cut := civil.Date{Year: 2025, Month: 6, Day: 30}
	finished := time.Date(2025, 7, 1, 0, 0, 0, 0, time.UTC)
	prev := prevOf(in, cut, finished, "old")
	after := finished.Add(time.Hour)
	revs := []ASICRevision{
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "BBB", RevisedAt: after},
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "BBB", RevisedAt: after},
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "AAA", RevisedAt: finished.Add(-time.Hour)},
		{ReportDate: civil.Date{Year: 2025, Month: 7, Day: 3}, Code: "CCC", RevisedAt: after},
	}
	d := DiffAgainst(in, prev, "new", Curve{}, revs)
	if d.RevisedCount != 1 || len(d.ASICRevised) != 1 || d.ASICRevised[0] != "BBB" {
		t.Fatalf("revisions: %+v", d.ASICRevised)
	}
}

// The CAGR shift compares the two curves over the span both cover.
func TestDiffCAGRShiftIsOverTheSharedWindow(t *testing.T) {
	start := civil.Date{Year: 2019, Month: 5, Day: 1}
	var prevC, curC Curve
	for i := 0; i <= 400; i += 7 {
		d := start.AddDays(i)
		prevC.Dates = append(prevC.Dates, d)
		prevC.Values = append(prevC.Values, 1+0.10*float64(i)/400)
		curC.Dates = append(curC.Dates, d)
		curC.Values = append(curC.Values, 1+0.20*float64(i)/400)
	}
	prev := &PreviousRun{RunID: 3, CutOff: start, FinishedAt: time.Now(), InputHash: "old", Dates: prevC.Dates, Equity: prevC.Values}
	d := DiffAgainst(loadGolden(t), prev, "new", curC, nil)
	if !d.HasCAGRShift {
		t.Fatalf("no shift over a shared window: %+v", d)
	}
	a, _ := CAGR(prevC)
	b, _ := CAGR(curC)
	if math.Abs(d.CAGRShiftPP-(b-a)*100) > 1e-9 || d.CAGRShiftPP <= 0 {
		t.Fatalf("shift %.6f pp, want %.6f", d.CAGRShiftPP, (b-a)*100)
	}
	if d.SharedFrom != start || d.SharedTo.Before(d.SharedFrom) {
		t.Fatalf("shared window %s..%s", d.SharedFrom, d.SharedTo)
	}
}

func TestDiffListsAreCappedButCountedInFull(t *testing.T) {
	var list []string
	for i := 0; i < diffListLimit+5; i++ {
		list = append(list, fmt.Sprintf("C%03d", i))
	}
	if got := capList(list); len(got) != diffListLimit || got[0] != "C000" {
		t.Fatalf("capList kept %d entries", len(got))
	}
}
