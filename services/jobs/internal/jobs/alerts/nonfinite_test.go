package alerts

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// NaN and Infinity are valid float8 values in Postgres and cannot be encoded in JSON.
// A single one must not reach the payload, and must not cost the event its detail.
func TestStockDetailDropsNonFiniteReadingsAndShares(t *testing.T) {
	rows := dates(30, "2026-10-16")
	nan, inf := math.NaN(), math.Inf(1)
	rows[3].pct = nan  // an earlier point in the history
	rows[10].pct = inf // another
	rows[20].sharesShort = &nan
	rows[20].sharesOnIss = &inf
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 5}}, nil)

	d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-16")
	if d == nil {
		t.Fatal("a finite report must still get a detail")
	}
	if _, err := json.Marshal(d); err != nil {
		t.Fatalf("the detail must encode: %v", err)
	}
	for _, p := range d.History {
		if math.IsNaN(p.P) || math.IsInf(p.P, 0) {
			t.Fatalf("a non-finite point reached the history: %+v", p)
		}
	}
	if len(d.History) != 28 {
		t.Fatalf("history has %d points, want the 28 finite readings", len(d.History))
	}
	if d.SharesShort != nil || d.SharesOnIssue != nil {
		t.Fatal("non-finite share counts must read as unknown")
	}
}

// A non-finite report reading leaves no detail: the email shows the figures and no chart.
func TestStockDetailNilWhenTheReportReadingIsNonFinite(t *testing.T) {
	rows := dates(5, "2026-10-16")
	rows[4].pct = math.NaN()
	snap := NewSnapshot(nil, nil, nil)
	if d := stockDetailOf(snap, "AAA", CompanyInfo{}, rows, "2026-10-16"); d != nil {
		t.Fatalf("a NaN report reading must give no detail, got %+v", d)
	}
}

// If a payload still will not encode, the event is committed without its stock detail.
func TestEncodePayloadFallsBackWithoutStock(t *testing.T) {
	p := alertevents.Payload{
		Companies:      []alertevents.Company{{Code: "AAA", Latest: 5}},
		CompaniesTotal: 1,
		Stock:          &alertevents.StockDetail{Name: "Aaa", History: []alertevents.Point{{D: "2026-10-16", P: math.NaN()}}},
	}
	b, err := encodePayload(p)
	if err != nil {
		t.Fatalf("a bad stock detail must not fail the encode: %v", err)
	}
	if strings.Contains(string(b), `"stock"`) {
		t.Fatalf("the fallback must drop the stock detail: %s", b)
	}
	if !strings.Contains(string(b), `"companies"`) {
		t.Fatalf("the figures must survive the fallback: %s", b)
	}
}
