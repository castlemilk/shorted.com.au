package economy

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

var crimeFixtureStates = []struct {
	name string
}{
	{"New South Wales"},
	{"Victoria(n)"},
	{"Queensland"},
	{"South Australia"},
	{"Western Australia"},
	{"Tasmania(w)"},
	{"Northern Territory(w)(z)(aa)"},
	{"Australian Capital Territory"},
}

func crimeFixtureYearHeader() []string {
	return crimeFixtureYearHeaderThrough(2024)
}

func crimeFixtureYearHeaderThrough(lastYear int) []string {
	header := []string{"Offence"}
	for year := 1993; year <= lastYear; year++ {
		label := strconv.Itoa(year)
		switch year {
		case 1999:
			label += "(a)"
		case 2009:
			label += "(d)(e)"
		}
		header = append(header, label)
	}
	return header
}

func crimeFixtureOffenceRowThrough(lastYear int, label string, valueForYear func(int) interface{}) []interface{} {
	row := []interface{}{label}
	for year := 1993; year <= lastYear; year++ {
		row = append(row, valueForYear(year))
	}
	return row
}

func crimeFixtureWorkbook(t *testing.T) *excelize.File {
	return crimeFixtureWorkbookThrough(t, 2024)
}

func crimeFixtureWorkbookThrough(t *testing.T, lastYear int) *excelize.File {
	t.Helper()
	f := excelize.NewFile()
	if err := f.SetSheetName("Sheet1", "Table 9"); err != nil {
		t.Fatal(err)
	}
	header := crimeFixtureYearHeaderThrough(lastYear)
	headerRow := make([]interface{}, len(header))
	for i, cell := range header {
		headerRow[i] = cell
	}
	rows := [][]interface{}{
		{fmt.Sprintf("This table shows Victims from %d - %d, by states and territories by number.", lastYear-1, lastYear)},
		{"Australian Bureau of Statistics"},
		{fmt.Sprintf("Table 9 Victims, Selected offences by states and territories, 1993 to %d", lastYear)},
		{fmt.Sprintf("Recorded Crime – Victims, %d", lastYear)},
		{"", "Year"},
		headerRow,
	}
	for _, state := range crimeFixtureStates {
		rows = append(rows,
			[]interface{}{"", state.name},
			crimeFixtureOffenceRowThrough(lastYear, "Homicide and related offences(h)", func(year int) interface{} {
				if year == lastYear {
					return "240"
				}
				return "250"
			}),
			crimeFixtureOffenceRowThrough(lastYear, "Murder", func(int) interface{} { return "140" }), // subrow: skipped and counted
			crimeFixtureOffenceRowThrough(lastYear, "Assault(i)(x)", func(year int) interface{} {
				if year == 1993 {
					return "np"
				}
				return "65,000"
			}),
			crimeFixtureOffenceRowThrough(lastYear, "Sexual assault(p)", func(int) interface{} { return "3,000" }),
			crimeFixtureOffenceRowThrough(lastYear, "Robbery", func(int) interface{} { return "1,000" }),
			crimeFixtureOffenceRowThrough(lastYear, "Unlawful entry with intent(l)(s)", func(int) interface{} { return "20,000" }),
			crimeFixtureOffenceRowThrough(lastYear, "Motor vehicle theft", func(int) interface{} { return "8,000" }),
			crimeFixtureOffenceRowThrough(lastYear, "Other theft(m)", func(year int) interface{} {
				if year == 1994 {
					return ""
				}
				return "50,000"
			}),
		)
	}
	for i, row := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow("Table 9", cell, &row); err != nil {
			t.Fatal(err)
		}
	}

	// A numerically plausible distractor sheet must never be ingested.
	if _, err := f.NewSheet("Table 10"); err != nil {
		t.Fatal(err)
	}
	distractor := []interface{}{"Homicide and related offences", "999999"}
	if err := f.SetSheetRow("Table 10", "A1", &distractor); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestStripCrimeFootnotesNormalizesLetterNumericAndMixedSuffixes(t *testing.T) {
	tests := map[string]string{
		"Assault (1)":                "Assault",
		"Robbery(a1)":                "Robbery",
		"Other theft (2)(b3)  ":      "Other theft",
		"Motor vehicle theft (note)": "Motor vehicle theft",
	}
	for input, want := range tests {
		if got := stripCrimeFootnotes(input); got != want {
			t.Errorf("stripCrimeFootnotes(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSelectCrimeXLSXLinkMatchesDecodedURLOrDisplayText(t *testing.T) {
	tests := []struct {
		name string
		html string
		want string
	}{
		{
			name: "decoded URL",
			html: `<a href="/media/2024/other.xlsx">Other</a>
			       <a href="/media/2024/Victims%20of%20crime%2C%20states%20and%20territories%20%28Tables%209%20to%2016%29.xlsx">Download</a>`,
			want: "https://www.abs.gov.au/media/2024/Victims%20of%20crime%2C%20states%20and%20territories%20%28Tables%209%20to%2016%29.xlsx",
		},
		{
			name: "display text",
			html: `<a href="https://cdn.example.test/cube.xlsx?download=1">Victims of crime, states and territories</a>`,
			want: "https://cdn.example.test/cube.xlsx?download=1",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectCrimeXLSXLink(crimePage, []byte(tc.html))
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("selected link = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSelectCrimeXLSXLinkFailsLoudlyWhenTargetAbsent(t *testing.T) {
	_, err := selectCrimeXLSXLink(crimePage, []byte(`<a href="/unrelated.xlsx">Unrelated cube</a>`))
	if err == nil || !strings.Contains(err.Error(), "states and territories") {
		t.Fatalf("want loud missing-target error, got %v", err)
	}
}

func TestCrimeYearColumnsRejectsDrift(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func([]string) []string
		wantErr string
	}{
		{
			name: "interior malformed year",
			mutate: func(header []string) []string {
				header[2005-1993+1] = "2005?"
				return header
			},
			wantErr: "malformed",
		},
		{
			name: "missing 2024",
			mutate: func(header []string) []string {
				return header[:len(header)-1]
			},
			wantErr: "missing 2024",
		},
		{
			name: "duplicate year",
			mutate: func(header []string) []string {
				header[2000-1993+1] = "1999(b)"
				return header
			},
			wantErr: "duplicate",
		},
		{
			name: "unexpected year",
			mutate: func(header []string) []string {
				return append(header, "2025")
			},
			wantErr: "unexpected",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			header := tc.mutate(crimeFixtureYearHeader())
			_, err := crimeYearColumns([][]string{header}, 2024)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestParseCrimeWorkbookTable9AllStateSections(t *testing.T) {
	f := crimeFixtureWorkbook(t)
	defer f.Close()

	obs, err := parseCrimeWorkbook(f, "https://example.test/crime.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	// 8 states × (7 offences × 32 years - one np cell - one blank cell).
	if got, want := len(obs), 1776; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}

	byKeyPeriod := map[string]Obs{}
	for _, o := range obs {
		byKeyPeriod[o.Series.Key()+"@"+o.Period.Format("2006-01-02")] = o
		if o.Series.Unit != "persons" || o.Series.Frequency != "annual" ||
			o.Series.Adjustment != "original" || o.Series.SourceKey != crimeSource ||
			o.Series.Licence != "CC-BY-4.0" {
			t.Fatalf("wrong series metadata: %#v", o.Series)
		}
		if o.Series.Dimensions["sheet"] != "Table 9" ||
			o.Series.Dimensions["source_url"] != "https://example.test/crime.xlsx" ||
			o.Series.Dimensions["unmapped_rows_skipped"] != "1" {
			t.Fatalf("missing parser provenance: %#v", o.Series.Dimensions)
		}
	}

	homicide := byKeyPeriod["crime.victims.homicide.nsw@2024-01-01"]
	if homicide.Value < 100 || homicide.Value > 600 {
		t.Fatalf("NSW homicide magnitude %v outside guard 100..600/year", homicide.Value)
	}
	assault := byKeyPeriod["crime.victims.assault.nsw@2024-01-01"]
	if assault.Value < 10000 || assault.Value > 120000 {
		t.Fatalf("published NSW assault magnitude %v outside guard 10000..120000/year", assault.Value)
	}
	if assault.Series.Dimensions["comparability"] != "within-state-only" {
		t.Fatalf("assault comparability missing: %#v", assault.Series.Dimensions)
	}
	sexualAssault := byKeyPeriod["crime.victims.sexual-assault.nsw@2024-01-01"]
	if sexualAssault.Series.Dimensions["comparability"] != "within-state-only" {
		t.Fatalf("sexual-assault comparability missing: %#v", sexualAssault.Series.Dimensions)
	}
	if _, present := homicide.Series.Dimensions["comparability"]; present {
		t.Fatalf("non-assault offence must not carry comparability: %#v", homicide.Series.Dimensions)
	}
	if _, present := byKeyPeriod["crime.victims.assault.nsw@1993-01-01"]; present {
		t.Fatal("np assault cell must be skipped")
	}
	if _, present := byKeyPeriod["crime.victims.other-theft.nsw@1994-01-01"]; present {
		t.Fatal("blank other-theft cell must be skipped")
	}
	if _, present := byKeyPeriod["crime.victims.murder.nsw@2024-01-01"]; present {
		t.Fatal("unmapped subrow must not create a series")
	}
}

func TestParseCrimeWorkbookAcceptsContiguous2025Extension(t *testing.T) {
	f := crimeFixtureWorkbookThrough(t, 2025)
	defer f.Close()

	obs, err := parseCrimeWorkbook(f, "https://example.test/crime-2025.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	// 8 states × (7 offences × 33 years - one np cell - one blank cell).
	if got, want := len(obs), 1832; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	for _, observation := range obs {
		if observation.Series.Key() == "crime.victims.homicide.nsw" &&
			observation.Period.Format("2006-01-02") == "2025-01-01" {
			if observation.Value != 240 {
				t.Fatalf("2025 homicide value = %v, want 240", observation.Value)
			}
			return
		}
	}
	t.Fatal("2025 extension observation not parsed")
}

func TestParseCrimeWorkbookKeepsHealthyStatesWhenOneSectionDrifts(t *testing.T) {
	f := crimeFixtureWorkbook(t)
	defer f.Close()
	if err := f.SetCellValue("Table 9", "B16", "Victoria renamed upstream"); err != nil {
		t.Fatal(err)
	}

	obs, err := parseCrimeWorkbook(f, "")
	if err == nil || !strings.Contains(err.Error(), "vic") {
		t.Fatalf("want non-nil per-state drift error naming vic, got %v", err)
	}
	if got, want := len(obs), 1554; got != want {
		t.Fatalf("healthy observations = %d, want %d (7 states only)", got, want)
	}
	for _, o := range obs {
		if o.Series.RegionCode == "vic" {
			t.Fatalf("drifted Victoria section leaked partial observation: %#v", o)
		}
	}
}

func TestParseCrimeWorkbookRejectsDuplicateMappedOffenceWithinState(t *testing.T) {
	f := crimeFixtureWorkbook(t)
	defer f.Close()
	if err := f.SetCellValue("Table 9", "A9", "Robbery"); err != nil {
		t.Fatal(err)
	}

	obs, err := parseCrimeWorkbook(f, "")
	if err == nil || !strings.Contains(err.Error(), "nsw") || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("want NSW duplicate-offence drift error, got %v", err)
	}
	if got, want := len(obs), 1554; got != want {
		t.Fatalf("healthy observations = %d, want %d (7 states only)", got, want)
	}
	for _, o := range obs {
		if o.Series.RegionCode == "nsw" {
			t.Fatalf("duplicate NSW section leaked observation: %#v", o)
		}
	}
}

func TestParseCrimeWorkbookRejectsInvalidVictimValues(t *testing.T) {
	tests := []struct {
		name  string
		value interface{}
	}{
		{"NaN", math.NaN()},
		{"positive infinity", math.Inf(1)},
		{"negative", -1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := crimeFixtureWorkbook(t)
			defer f.Close()
			if err := f.SetCellValue("Table 9", "B8", tc.value); err != nil {
				t.Fatal(err)
			}

			obs, err := parseCrimeWorkbook(f, "")
			if err == nil || !strings.Contains(err.Error(), "nsw") || !strings.Contains(err.Error(), "invalid victim value") {
				t.Fatalf("want NSW invalid-value drift error, got %v", err)
			}
			for _, o := range obs {
				if o.Series.RegionCode == "nsw" {
					t.Fatalf("invalid NSW section leaked observation: %#v", o)
				}
			}
		})
	}
}

func TestParseCrimeWorkbookAllowsZeroVictims(t *testing.T) {
	f := crimeFixtureWorkbook(t)
	defer f.Close()
	if err := f.SetCellValue("Table 9", "B8", 0); err != nil {
		t.Fatal(err)
	}

	obs, err := parseCrimeWorkbook(f, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range obs {
		if o.Series.Key() == "crime.victims.homicide.nsw" &&
			o.Period.Format("2006-01-02") == "1993-01-01" {
			if o.Value != 0 {
				t.Fatalf("zero victim count changed to %v", o.Value)
			}
			return
		}
	}
	t.Fatal("zero victim count was skipped")
}

func TestParseCrimeWorkbookRejectsWrongTable9Title(t *testing.T) {
	f := crimeFixtureWorkbook(t)
	defer f.Close()
	if err := f.SetCellValue("Table 9", "A3", "Table 9 changed"); err != nil {
		t.Fatal(err)
	}
	obs, err := parseCrimeWorkbook(f, "")
	if err == nil || !strings.Contains(err.Error(), "title") || len(obs) != 0 {
		t.Fatalf("want workbook-level title failure and no obs, got len=%d err=%v", len(obs), err)
	}
}

func TestParseActualCrimeWorkbook(t *testing.T) {
	const path = "/tmp/crime-states.xlsx"
	if _, err := os.Stat(path); err != nil {
		t.Skipf("live-layout probe workbook unavailable: %v", err)
	}
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	obs, err := parseCrimeWorkbook(f, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) < 1500 {
		t.Fatalf("actual Table 9 produced only %d observations", len(obs))
	}
	var homicide, assault *Obs
	for i := range obs {
		o := &obs[i]
		switch o.Series.Key() + "@" + o.Period.Format("2006-01-02") {
		case "crime.victims.homicide.nsw@2024-01-01":
			homicide = o
		case "crime.victims.assault.nsw@2024-01-01":
			assault = o
		}
	}
	if homicide == nil || homicide.Value != 124 {
		t.Fatalf("actual NSW 2024 homicide wrong: %#v", homicide)
	}
	if assault == nil || assault.Value != 79624 {
		t.Fatalf("actual NSW 2024 assault wrong: %#v", assault)
	}
}
