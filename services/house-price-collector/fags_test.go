package main

import (
	"bytes"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// TestNormCouncil pins the FAG↔ABS council name normalisation, especially the
// parenthetical-alias strip that fixed the 'Melbourne City Council (City of
// Melbourne)' edge-case, and guards the doubled-name names it must NOT collapse.
func TestNormCouncil(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// The edge-case: FAG appends the '(City of X)' alias, so without the paren
		// strip the suburb name appeared twice → "melbourne melbourne" ≠ "melbourne".
		{"Melbourne City Council (City of Melbourne)", "melbourne"},
		{"Melbourne", "melbourne"},
		// Renamed council: FAG keeps the old name in a parenthetical.
		{"Merri-bek City Council (formerly Moreland City Council)", "merri bek"},
		{"Merri-bek", "merri bek"},
		// ABS disambiguation suffix on the FAG side, stripped consistently.
		{"Central Coast Council (NSW)", "central coast"},
		{"Central Coast (NSW)", "central coast"},
		// Doubled names MUST survive (only bracketed spans are cut, not repeats).
		{"Wagga Wagga City Council", "wagga wagga"},
		{"Wagga Wagga", "wagga wagga"},
		{"Baw Baw Shire Council", "baw baw"},
		{"Wujal Wujal Aboriginal Council", "wujal wujal"},
		// Existing council-type / stopword stripping still holds.
		{"City of Albany", "albany"},
		{"Alpine Shire Council", "alpine"},
		{"The Corporation of the City of Adelaide", "adelaide"},
		// Bare type words (LGPRF form: '<Name> City' / '<Name> Shire', no 'Council').
		{"Melbourne City", "melbourne"},
		{"Greater Geelong City", "greater geelong"},
		{"Yarra City", "yarra"},
		{"Alpine Shire", "alpine"},
		{"Ararat Rural City", "ararat"},
	}
	for _, c := range cases {
		if got := normCouncil(c.in); got != c.want {
			t.Errorf("normCouncil(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The councils the old normaliser missed. Each pair must normalise to one
// key: the FAG workbook's spelling on the left, ABS LGA_2024's on the right.
func TestNormCouncilMatchesABSNames(t *testing.T) {
	for _, c := range [][2]string{
		{"Hunter's Hill Council", "Hunters Hill"},
		{"Corporation of the City of Norwood Payneham & St Peters", "Norwood Payneham and St Peters"},
		{"Clare & Gilbert Valleys Council", "Clare and Gilbert Valleys"},
		{"Rural City of Murray Bridge", "Murray Bridge"},
		{"Mapoon Aboriginal Council", "Mapoon"},
		{"Palm Island Aboriginal Council", "Palm Island"},
		{"Doomadgee Aboriginal Community Council", "Doomadgee"},
		{"Wujal Wujal Aboriginal Council", "Wujal Wujal"},
		{"Belyuen Community Government Council", "Belyuen"},
		{"Coomalie Community Government Council", "Coomalie"},
		{"Anangu Pitjantjatjara Inc", "Anangu Pitjantjatjara Yankunytjatjara"},
		{"City of Tea Tree Gully", "Tea Tree Gully"},
		{"Corporation of the City of Tea Tree Gully", "Tea Tree Gully"},
		{"Ararat Rural City Council ", "Ararat"},
	} {
		if a, b := normCouncil(c[0]), normCouncil(c[1]); a != b {
			t.Errorf("normCouncil(%q) = %q, normCouncil(%q) = %q: want equal", c[0], a, c[1], b)
		}
	}
	// Distinct councils must stay distinct.
	for _, c := range [][2]string{
		{"Murray River Council", "Murray Bridge"},
		{"Palmerston City Council", "Palm Island"},
		{"Wagga Wagga City Council", "Wagga"},
	} {
		if normCouncil(c[0]) == normCouncil(c[1]) {
			t.Errorf("%q and %q collapsed to %q", c[0], c[1], normCouncil(c[0]))
		}
	}
}

func TestFagYearEnd(t *testing.T) {
	end, ok := fagYearEnd("2025-26")
	if !ok || !end.Equal(time.Date(2026, time.June, 30, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("2025-26 → %v %v, want 2026-06-30", end, ok)
	}
	if end, ok := fagYearEnd("1999-00"); !ok || end.Year() != 2000 {
		t.Errorf("1999-00 → %v %v, want 2000-06-30", end, ok)
	}
	for _, bad := range []string{"2025", "2025-27", "FY26", ""} {
		if _, ok := fagYearEnd(bad); ok {
			t.Errorf("fagYearEnd(%q) accepted", bad)
		}
	}
}

func TestResolveFAGs(t *testing.T) {
	idx := map[fagCouncilKey]string{
		{"SA", "tea tree gully"}:    "47700",
		{"NSW", "hunters hill"}:     "14100",
		{"NT", "east arnhem"}:       "71300",
		{"SA", "unincorporated sa"}: "49399",
		{"NSW", "campbelltown"}:     "11500",
		{"SA", "campbelltown"}:      "40910",
	}
	rows := []FagRow{
		// Renamed mid-series: one council, and the newest year wins across both
		// names. The old raw-name key applied whichever map entry came last.
		{"SA", "City of Tea Tree Gully", "2025-26", 4_336_738},
		{"SA", "Corporation of the City of Tea Tree Gully", "2023-24", 4_182_353},
		{"SA", "Corporation of the City of Tea Tree Gully", "2024-25", 4_200_000},
		{"NSW", "Hunter's Hill Council", "2025-26", 1_000},
		// Groote Archipelago's grant is part of LGA_2024 East Arnhem's.
		{"NT", "East Arnhem Regional Council", "2025-26", 5_000_000},
		{"NT", "Groote Archipelago Regional Council", "2025-26", 1_023_047},
		{"SA", "Outback Communities Authority", "2025-26", 700},
		// Same name, different state: two councils.
		{"NSW", "Campbelltown City Council", "2025-26", 10},
		{"SA", "Campbelltown City Council", "2025-26", 20},
		{"NSW", "Lord Howe Island Board", "2025-26", 99},
		{"NSW", "Lord Howe Island Board", "2024-25", 98},
	}
	res, conflicts := resolveFAGs(rows, idx)
	if len(conflicts) != 0 {
		t.Errorf("conflicts = %v", conflicts)
	}
	if got := res.Latest["47700"]; got.PeriodLabel != "2025-26" || got.Value != 4_336_738 {
		t.Errorf("Tea Tree Gully latest = %+v, want the 2025-26 grant", got)
	}
	ttg := 0
	for _, r := range res.Series {
		if r.LGACode == "47700" {
			ttg++
		}
		if r.Measure != fagMeasure || r.Source != fagSource || r.Licence != "CC-BY-4.0" || r.Unit != "AUD" {
			t.Errorf("series row tagged wrongly: %+v", r)
		}
	}
	if ttg != 3 {
		t.Errorf("Tea Tree Gully history = %d years, want 3 (history spans the rename)", ttg)
	}
	if got := res.Latest["71300"].Value; got != 6_023_047 {
		t.Errorf("East Arnhem = %v, want East Arnhem + Groote Archipelago", got)
	}
	if res.Latest["49399"].Value != 700 || res.Latest["14100"].Value != 1_000 {
		t.Errorf("OCA / Hunters Hill not matched: %+v", res.Latest)
	}
	if res.Latest["11500"].Value != 10 || res.Latest["40910"].Value != 20 {
		t.Errorf("Campbelltown NSW/SA crossed: %+v %+v", res.Latest["11500"], res.Latest["40910"])
	}
	if len(res.Unmatched) != 1 || res.Unmatched[0] != "NSW Lord Howe Island Board" {
		t.Errorf("unmatched = %v, want one entry per entity", res.Unmatched)
	}
	for i := 1; i < len(res.Series); i++ {
		a, b := res.Series[i-1], res.Series[i]
		if a.LGACode > b.LGACode || (a.LGACode == b.LGACode && !a.Period.Before(b.Period)) {
			t.Fatalf("series not sorted: %+v before %+v", a, b)
		}
	}

	// Two names on one council in ONE year (a rename listed twice) is reported,
	// not summed, and the pick does not depend on row order.
	dup := []FagRow{
		{"SA", "Corporation of the City of Tea Tree Gully", "2025-26", 1},
		{"SA", "City of Tea Tree Gully", "2025-26", 2},
	}
	for _, order := range [][]FagRow{dup, {dup[1], dup[0]}} {
		res, conflicts = resolveFAGs(order, idx)
		if len(conflicts) != 1 || res.Latest["47700"].Value != 1 {
			t.Errorf("duplicate year: value %v conflicts %v, want the lexically last name's value (1) and one conflict",
				res.Latest["47700"].Value, conflicts)
		}
	}

	// An aggregate whose target area is missing from the dimension is reported,
	// never written against a code the lga_series FK would reject.
	res, _ = resolveFAGs([]FagRow{{"NT", "Groote Archipelago Regional Council", "2025-26", 1}},
		map[fagCouncilKey]string{{"NT", "darwin"}: "71000"})
	if len(res.Series) != 0 || len(res.Unmatched) != 1 {
		t.Errorf("aggregate to a missing area: %+v", res)
	}
}

// parseFAGs keeps EVERY year, not just the latest, and treats a blank or zero
// total as "not listed" rather than a measured zero grant.
func TestParseFAGsKeepsHistory(t *testing.T) {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	_, _ = f.NewSheet("All data")
	for i, row := range [][]any{
		{"Financial Assistance Grant - Cash Payments (2017-18 to 2025-26)"},
		{"Jurisdiction", "LGA", "Year", "Total", "Early Payment", "Total Financial Assistance Grant (inc Early Payment)"},
		{"South Australia", "City of Tea Tree Gully", "2025-26", "", "", "$4,336,738"},
		{"South Australia", "Corporation of the City of Tea Tree Gully", "2023-24", "", "", "4182353"},
		{"South Australia", "Nowhere Council", "2023-24", "", "", "0"},
		{"Atlantis", "Somewhere Council", "2023-24", "", "", "5"},
	} {
		cellRef, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow("All data", cellRef, &row); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	rows, err := parseFAGs(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].Year != "2025-26" || rows[1].Year != "2023-24" || rows[0].TotalAud != 4_336_738 {
		t.Errorf("rows = %+v, want both Tea Tree Gully years and nothing else", rows)
	}
}
