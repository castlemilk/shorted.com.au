package backtest

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
)

// prevOf is the previously published run of a key over in, taken at cut: it read
// its inputs at readAt and its ASIC reports through asicThrough.
func prevOf(in Inputs, cut civil.Date, readAt time.Time, asicThrough civil.Date, inputHash string) *PreviousRun {
	return &PreviousRun{
		RunID: 7, CutOff: cut, ReadAt: readAt, ASICThrough: asicThrough, InputHash: inputHash,
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
	cut := civil.Date{Year: 2025, Month: 6, Day: 30}
	prev := prevOf(in, cut, time.Now(), cut, "same")
	d := DiffAgainst(in, prev, "same", Curve{}, []ASICRevision{{ReportDate: cut, Code: "AAA", RevisedAt: time.Now().Add(time.Hour)}})
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
	prev := prevOf(in, cut, time.Now(), cut, "old")

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

// A revision counts when it changes a report the previous run read (up to its ASIC
// through-date, which can lie after its digest cut-off) and was recorded after the
// previous run read its inputs. Anything else is not the diff's.
func TestDiffListsASICRevisionsTheRunReadAfterItsSnapshot(t *testing.T) {
	in := loadGolden(t)
	cut := civil.Date{Year: 2025, Month: 6, Day: 30}
	readAt := time.Date(2025, 7, 1, 0, 0, 0, 0, time.UTC)
	asicThrough := civil.Date{Year: 2025, Month: 7, Day: 4}
	prev := prevOf(in, cut, readAt, asicThrough, "old")
	after := readAt.Add(time.Hour)
	revs := []ASICRevision{
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "BBB", RevisedAt: after},
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "BBB", RevisedAt: after},
		{ReportDate: civil.Date{Year: 2025, Month: 6, Day: 27}, Code: "AAA", RevisedAt: readAt.Add(-time.Hour)},
		// A report after the digest cut-off that the previous run read is listed.
		{ReportDate: civil.Date{Year: 2025, Month: 7, Day: 3}, Code: "CCC", RevisedAt: after},
		// A report the previous run did not read is not.
		{ReportDate: civil.Date{Year: 2025, Month: 7, Day: 10}, Code: "DDD", RevisedAt: after},
	}
	d := DiffAgainst(in, prev, "new", Curve{}, revs)
	if d.RevisedCount != 2 || len(d.ASICRevised) != 2 || d.ASICRevised[0] != "BBB" || d.ASICRevised[1] != "CCC" {
		t.Fatalf("revisions: %+v", d.ASICRevised)
	}
}

// The CAGR shift compares the two curves over the span both cover: the current
// curve runs past the previous one, and what it adds afterwards is not the shift.
func TestDiffCAGRShiftIsOverTheSharedWindow(t *testing.T) {
	start := civil.Date{Year: 2019, Month: 5, Day: 1}
	var prevC, curC Curve
	for i := 0; i <= 400; i += 7 {
		d := start.AddDays(i)
		prevC.Dates = append(prevC.Dates, d)
		prevC.Values = append(prevC.Values, 1+0.10*float64(i)/400)
	}
	for i := 0; i <= 470; i += 7 {
		d := start.AddDays(i)
		v := 1 + 0.20*float64(i)/400
		if i > 400 {
			v *= 10 // a week of new sessions far above the old path
		}
		curC.Dates = append(curC.Dates, d)
		curC.Values = append(curC.Values, v)
	}
	prev := &PreviousRun{RunID: 3, CutOff: start, ReadAt: time.Now(), InputHash: "old", Dates: prevC.Dates, Equity: prevC.Values}
	d := DiffAgainst(loadGolden(t), prev, "new", curC, nil)
	if !d.HasCAGRShift {
		t.Fatalf("no shift over a shared window: %+v", d)
	}
	if d.SharedTo != prevC.Dates[len(prevC.Dates)-1] {
		t.Fatalf("shared window ends %s, want the previous run's last session %s", d.SharedTo, prevC.Dates[len(prevC.Dates)-1])
	}
	a, _ := CAGR(prevC)
	b, ok := CAGR(within(curC, d.SharedFrom, d.SharedTo))
	if !ok {
		t.Fatal("the truncated current curve is not annualised")
	}
	if math.Abs(d.CAGRShiftPP-(b-a)*100) > 1e-9 || d.CAGRShiftPP <= 0 {
		t.Fatalf("shift %.6f pp, want %.6f over the shared window", d.CAGRShiftPP, (b-a)*100)
	}
	if full, _ := CAGR(curC); math.Abs(full*100-b*100) < 1 {
		t.Fatalf("the fixture must make the untruncated curve differ, got %.3f vs %.3f", full*100, b*100)
	}
	if d.SharedFrom != start {
		t.Fatalf("shared window starts %s, want %s", d.SharedFrom, start)
	}
}

// The full count is kept past the list limit: a note of 60 rewritten codes counts
// 60 and lists 50.
func TestDiffListsAreCappedButCountedInFull(t *testing.T) {
	in := loadGolden(t)
	cut := civil.Date{Year: 2025, Month: 6, Day: 30}
	prev := prevOf(in, cut, time.Now(), cut, "old")
	for i := 0; i < diffListLimit+10; i++ {
		prev.Digests[fmt.Sprintf("X%03d", i)] = Digest{Rows: 1, Sum: "gone"}
	}
	d := DiffAgainst(in, prev, "new", Curve{}, nil)
	if d.RewrittenCount != diffListLimit+10 || len(d.PriceRowsRewritten) != diffListLimit {
		t.Fatalf("rewritten count %d, listed %d; want %d and %d", d.RewrittenCount, len(d.PriceRowsRewritten), diffListLimit+10, diffListLimit)
	}

	var list []string
	for i := 0; i < diffListLimit+5; i++ {
		list = append(list, fmt.Sprintf("C%03d", i))
	}
	if got := capList(list); len(got) != diffListLimit || got[0] != "C000" {
		t.Fatalf("capList kept %d entries", len(got))
	}
}

// A stored note decodes back into the type that wrote it: no zero date is written
// as "0000-00-00" (no reader can parse it) and no list is null.
func TestDiffNoteRoundTripsForEveryState(t *testing.T) {
	in := loadGolden(t)
	cut := civil.Date{Year: 2025, Month: 6, Day: 30}
	withShift := &PreviousRun{RunID: 3, CutOff: cut, ReadAt: time.Now(), InputHash: "old",
		Dates: []civil.Date{cut, cut.AddDays(200), cut.AddDays(400)}, Equity: []float64{1, 1.10, 1.20}}
	cases := map[string]DiffNote{
		"none":                  NoPrevious(),
		"unchanged":             DiffAgainst(in, prevOf(in, cut, time.Now(), cut, "same"), "same", Curve{}, nil),
		"changed-without-shift": DiffAgainst(in, prevOf(in, cut, time.Now(), cut, "old"), "new", Curve{}, nil),
		"changed-with-shift":    DiffAgainst(in, withShift, "new", Curve{Dates: []civil.Date{cut, cut.AddDays(200), cut.AddDays(400)}, Values: []float64{1, 1.15, 1.30}}, nil),
	}
	for name, note := range cases {
		raw, err := json.Marshal(note)
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		if strings.Contains(string(raw), "0000-00-00") {
			t.Errorf("%s: a zero date was written: %s", name, raw)
		}
		if strings.Contains(string(raw), "null") {
			t.Errorf("%s: a list was written as null: %s", name, raw)
		}
		var back DiffNote
		if err := json.Unmarshal(raw, &back); err != nil {
			t.Fatalf("%s: the stored note does not decode: %v: %s", name, err, raw)
		}
		if back.State != note.State || back.RewrittenCount != note.RewrittenCount || back.HasCAGRShift != note.HasCAGRShift {
			t.Errorf("%s: round trip changed the note: %+v -> %+v", name, note, back)
		}
	}
}
