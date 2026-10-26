package alerts

import (
	"fmt"
	"testing"
	"time"
)

// dates returns n consecutive calendar dates ending at last, oldest first.
func dates(n int, last string) []historyRow {
	end, _ := time.Parse(dateLayout, last)
	out := make([]historyRow, 0, n)
	for i := n - 1; i >= 0; i-- {
		d := end.AddDate(0, 0, -i)
		out = append(out, historyRow{date: Date(d.Format(dateLayout)), pct: float64(n-1-i) / 10})
	}
	return out
}

func TestStockDetailHistoryIsCappedAndEndsAtTheReport(t *testing.T) {
	rows := dates(200, "2026-10-16")
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 5}}, nil)
	d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-16")
	if d == nil {
		t.Fatal("a report with a reading must yield a detail")
	}
	if len(d.History) != historyPoints {
		t.Fatalf("history has %d points, want the cap of %d", len(d.History), historyPoints)
	}
	if last := d.History[len(d.History)-1]; last.D != "2026-10-16" {
		t.Fatalf("history must end on the report date, ends on %s", last.D)
	}
	for i := 1; i < len(d.History); i++ {
		if d.History[i-1].D >= d.History[i].D {
			t.Fatalf("history is not oldest first at %d", i)
		}
	}
}

// A detail for an older report must not see the later readings.
func TestStockDetailIgnoresReadingsAfterTheReport(t *testing.T) {
	rows := dates(30, "2026-10-16")
	snap := NewSnapshot([]Date{"2026-10-10"}, map[Date]map[string]float64{"2026-10-10": {"AAA": 5}}, nil)
	d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-10")
	if d == nil {
		t.Fatal("expected a detail")
	}
	if last := d.History[len(d.History)-1]; last.D != "2026-10-10" {
		t.Fatalf("an older event must stop at its own report, got %s", last.D)
	}
}

func TestStockDetailChange20NeedsTwentyEarlierReports(t *testing.T) {
	rows := dates(21, "2026-10-16")
	// The 21st reading is 2.0 after the first, so the change over twenty reports is
	// the last reading minus the first.
	rows[20].pct = 7.5
	rows[0].pct = 5.5
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 7.5}}, nil)
	d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-16")
	if d.Change20 == nil || *d.Change20 != 2 {
		t.Fatalf("change20 = %v, want 2", d.Change20)
	}

	short := dates(20, "2026-10-16")
	d = stockDetailOf(snap, "AAA", CompanyInfo{}, short, "2026-10-16")
	if d.Change20 != nil {
		t.Fatalf("with only 20 readings there is no 20-report change, got %v", *d.Change20)
	}
}

func TestStockDetailIsNilWithoutAReadingOnTheReport(t *testing.T) {
	rows := dates(10, "2026-10-14")
	snap := NewSnapshot(nil, nil, nil)
	if d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-16"); d != nil {
		t.Fatalf("no reading on the report must give no detail, got %+v", d)
	}
	if d := stockDetailOf(snap, "AAA", CompanyInfo{}, nil, "2026-10-16"); d != nil {
		t.Fatal("no history must give no detail")
	}
}

func TestStockDetailCarriesIdentityAndUnknownShares(t *testing.T) {
	rows := dates(3, "2026-10-16")
	rows[2].sharesShort = nil
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 5}}, nil)
	info := CompanyInfo{Name: "Aaa Ltd", Industry: "Materials", LogoURL: "https://logos.test/a.png"}
	d := stockDetailOf(snap, "AAA", info, rows, "2026-10-16")
	if d.Name != "Aaa Ltd" || d.Industry != "Materials" || d.LogoURL != "https://logos.test/a.png" {
		t.Fatalf("identity not carried: %+v", d)
	}
	if d.SharesShort != nil {
		t.Fatal("a missing share count must stay nil, never zero")
	}
}

// Rank counts every code with a positive reading that day. Ties share an order by
// code, and a code with no positive reading is not ranked.
func TestMarketRank(t *testing.T) {
	readings := map[string]float64{"BBB": 9, "AAA": 9, "CCC": 4, "ZZZ": 0}
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": readings}, nil)
	cases := []struct {
		code     string
		rank, of int
	}{
		{"AAA", 1, 3}, // ties with BBB, AAA first by code
		{"BBB", 2, 3},
		{"CCC", 3, 3},
		{"ZZZ", 0, 3}, // zero reading is not ranked
		{"NOPE", 0, 3},
	}
	for _, tc := range cases {
		rank, of := snap.marketRank(tc.code, "2026-10-16")
		if rank != tc.rank || of != tc.of {
			t.Errorf("%s: rank %d of %d, want %d of %d", tc.code, rank, of, tc.rank, tc.of)
		}
	}
}

func TestMarketRankAmongManyCodes(t *testing.T) {
	readings := map[string]float64{}
	for i := 0; i < 640; i++ {
		readings[fmt.Sprintf("C%03d", i)] = float64(640 - i)
	}
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": readings}, nil)
	if rank, of := snap.marketRank("C011", "2026-10-16"); rank != 12 || of != 640 {
		t.Fatalf("rank %d of %d, want 12 of 640", rank, of)
	}
}
