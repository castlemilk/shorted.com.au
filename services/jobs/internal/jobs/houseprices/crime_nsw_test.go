package houseprices

import (
	"bytes"
	"encoding/csv"
	"testing"
)

// fy2025Months is a complete FY2025 (Jul 2024 → Jun 2025) plus a partial FY2026.
var fy2025Months = []string{
	"Jul 2024", "Aug 2024", "Sep 2024", "Oct 2024", "Nov 2024", "Dec 2024",
	"Jan 2025", "Feb 2025", "Mar 2025", "Apr 2025", "May 2025", "Jun 2025",
	"Jul 2025", "Aug 2025", // partial FY2026 — must be dropped (incomplete)
}

func buildNSWCSV(t *testing.T, rows []nswTestRow) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	header := append([]string{"Suburb", "Offence category", "Subcategory"}, fy2025Months...)
	if err := w.Write(header); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		rec := []string{r.suburb, r.category, r.subcategory}
		for _, m := range fy2025Months {
			rec = append(rec, itoa(r.counts[m]))
		}
		if err := w.Write(rec); err != nil {
			t.Fatal(err)
		}
	}
	w.Flush()
	return buf.Bytes()
}

type nswTestRow struct {
	suburb, category, subcategory string
	counts                        map[string]int
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	// small positive ints only in fixtures
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func TestMeltNSW(t *testing.T) {
	rows := []nswTestRow{
		// Alpha: 1 break-in in each of the 12 FY2025 months (=12), plus 100 in
		// the partial FY2026 (must be dropped).
		{"Alpha", "Theft", "Break and enter dwelling", map[string]int{
			"Jul 2024": 1, "Aug 2024": 1, "Sep 2024": 1, "Oct 2024": 1, "Nov 2024": 1, "Dec 2024": 1,
			"Jan 2025": 1, "Feb 2025": 1, "Mar 2025": 1, "Apr 2025": 1, "May 2025": 1, "Jun 2025": 1,
			"Jul 2025": 100,
		}},
		{"Alpha", "Theft", "Motor vehicle theft", map[string]int{"Jul 2024": 2}},
		// THE TRAP: steal-FROM-vehicle must not fold into motor_vehicle.
		{"Alpha", "Theft", "Steal from motor vehicle", map[string]int{"Jul 2024": 999}},
		{"Alpha", "Assault", "Domestic violence related assault", map[string]int{"Jul 2024": 1}},
		{"Alpha", "Assault", "Non-domestic violence related assault", map[string]int{"Aug 2024": 1}},
		{"Alpha", "Malicious damage to property", "Malicious damage to property", map[string]int{"Jul 2024": 3}},
		// Embedded comma in a quoted subcategory (unmapped) — exercises the CSV parser.
		{"Alpha", "Homicide", "Murder accessory, conspiracy", map[string]int{"Jul 2024": 1}},
		// Bravo carries a parenthetical suffix that must normalise to "bravo".
		{"Bravo (NSW)", "Theft", "Break and enter dwelling", map[string]int{"Jul 2024": 5}},
		// Ghosttown is not in the registry → unmatched, dropped.
		{"Ghosttown", "Theft", "Break and enter dwelling", map[string]int{"Jul 2024": 9}},
	}
	csvBytes := buildNSWCSV(t, rows)

	nameToSal := map[string]string{"alpha": "SAL1", "bravo": "SAL2"}
	jd, err := meltNSW(bytes.NewReader(csvBytes), nameToSal)
	if err != nil {
		t.Fatal(err)
	}

	if jd.matched != 2 || jd.unmatched != 1 {
		t.Errorf("matched/unmatched = %d/%d, want 2/1", jd.matched, jd.unmatched)
	}

	count := func(sal string, ct crimeType, fy int) (float64, bool) {
		for _, r := range jd.rows {
			if r.salCode == sal && r.crimeType == ct && r.fy == fy {
				return r.count, true
			}
		}
		return 0, false
	}
	assertCount := func(sal string, ct crimeType, fy int, want float64) {
		got, ok := count(sal, ct, fy)
		if !ok {
			t.Errorf("no row for %s/%s/FY%d", sal, ct, fy)
			return
		}
		if got != want {
			t.Errorf("%s/%s/FY%d = %v, want %v", sal, ct, fy, got, want)
		}
	}

	assertCount("SAL1", crimeBreakIns, 2025, 12)
	assertCount("SAL1", crimeMotorVehicle, 2025, 2) // the 999 steal-from is NOT here
	assertCount("SAL1", crimeViolent, 2025, 2)      // 1 DV + 1 non-DV
	assertCount("SAL1", crimePropertyDamage, 2025, 3)
	assertCount("SAL2", crimeBreakIns, 2025, 5)
	// Implicit zeros: SAL2 gets 0-count rows for the other core types.
	assertCount("SAL2", crimeMotorVehicle, 2025, 0)

	// The partial FY2026 must not appear.
	if _, ok := count("SAL1", crimeBreakIns, 2026); ok {
		t.Error("partial FY2026 should have been dropped")
	}
	// Ghosttown never bridges to a SAL.
	for _, r := range jd.rows {
		if r.salCode == "" {
			t.Error("emitted a row with empty sal_code")
		}
	}
}

func TestNormCrimeSuburb(t *testing.T) {
	if normCrimeSuburb("Bravo (NSW)") != "bravo" {
		t.Errorf("parenthetical strip failed: %q", normCrimeSuburb("Bravo (NSW)"))
	}
	// The O'Connor / O'connor apostrophe-casing landmine must collapse identically.
	if normCrimeSuburb("O'Connor") != normCrimeSuburb("O'connor") {
		t.Errorf("apostrophe casing not normalised: %q vs %q", normCrimeSuburb("O'Connor"), normCrimeSuburb("O'connor"))
	}
	if normCrimeSuburb("  Mount   Druitt ") != "mount druitt" {
		t.Errorf("whitespace collapse failed: %q", normCrimeSuburb("  Mount   Druitt "))
	}
}

func TestMonthFY(t *testing.T) {
	cases := []struct {
		m, y, want int
	}{
		{7, 2024, 2025}, {12, 2024, 2025}, {1, 2025, 2025}, {6, 2025, 2025}, {6, 1995, 1995},
	}
	for _, c := range cases {
		if got := monthFY(c.m, c.y); got != c.want {
			t.Errorf("monthFY(%d,%d) = %d, want %d", c.m, c.y, got, c.want)
		}
	}
}
