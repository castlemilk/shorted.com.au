package ownership

import "testing"

// TestParseAPRADate reads the period cell as xlsxSheet returns it. The real
// cell is A8 of Table 2a in the June 2025 workbook: GetRows gives "06-30-25"
// (Excel's built-in format 14 over serial 45838), for all 72 funds.
func TestParseAPRADate(t *testing.T) {
	for _, tc := range []struct{ cell, want string }{
		// The observed text, and the serial it displays.
		{"06-30-25", "2025-06-30"},
		{" 06-30-25 ", "2025-06-30"},
		{"45838", "2025-06-30"},
		{"45473", "2024-06-30"},
		// Format 14 is month first: 7 June, not 6 July.
		{"06-07-25", "2025-06-07"},
		{"6-7-25", "2025-06-07"},
		{"12-31-25", "2025-12-31"},
		// ISO dates, and datetimes that start with one.
		{"2025-06-30", "2025-06-30"},
		{"2025-06-30T00:00:00", "2025-06-30"},
		{"2025-06-30 00:00:00", "2025-06-30"},
		// dd/mm/yyyy and d/m/yy.
		{"30/06/2025", "2025-06-30"},
		{"30/6/25", "2025-06-30"},
		{"6/7/25", "2025-07-06"},
		// d Mon yyyy and d-Mon-yy.
		{"30 Jun 2025", "2025-06-30"},
		{"5 June 2025", "2025-06-05"},
		{"30-Jun-25", "2025-06-30"},
		{"30-Jun-2025", "2025-06-30"},
		// Month-level text is the month's last day, leap years included.
		{"Jun-25", "2025-06-30"},
		{"Jun 2025", "2025-06-30"},
		{"June 2025", "2025-06-30"},
		{"2025-06", "2025-06-30"},
		{"Feb 2024", "2024-02-29"},
		{"Feb 2025", "2025-02-28"},
		// Blank or unparseable cells stay empty rather than guessed.
		{"", ""},
		{"   ", ""},
		{"n/a", ""},
		{"Q4 2025", ""},
		{"30 Feb 2025", ""},
		{"02-30-25", ""},
		{"13-13-25", ""},
		{"6/30/25", ""},
	} {
		if got := parseAPRADate(tc.cell); got != tc.want {
			t.Errorf("parseAPRADate(%q) = %q, want %q", tc.cell, got, tc.want)
		}
	}
}

// TestParseAPRAFundsDisplayedPeriod runs a row shaped as the workbook gives it,
// with the period shown as text, through parseAPRAFunds.
func TestParseAPRAFundsDisplayedPeriod(t *testing.T) {
	rows := [][]string{
		{"Period", "Fund name", "ABN", "RSE Regulatory classification", "Fund type", "RSE Membership base", "Fund's RSE licensee", "RSE licensee ownership type", "RSE licensee profit status", "RSE licensee board structure", "RSE Balance date", "Duration", "RSE Wind up date", "Total assets"},
		{"06-30-25", "AustralianSuper", "65714394898", "Public offer", "Industry", "General base", "AustralianSuper Pty Ltd", "", "", "", "", "12", "", "365000000"},
	}
	funds, err := parseAPRAFunds(rows, "u")
	if err != nil {
		t.Fatal(err)
	}
	if len(funds) != 1 || funds[0].AsAt != "2025-06-30" {
		t.Errorf("funds %+v, want one fund as at 2025-06-30", funds)
	}
}
