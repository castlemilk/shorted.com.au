package announcements

import (
	"strings"
	"testing"
)

func trade(code, name, date, kind, url string) *DirectorTradeRecord {
	return &DirectorTradeRecord{StockCode: code, DirectorName: name, TradeDate: date, TradeType: kind, AnnouncementURL: url}
}

func TestFilterNewDirectorTrades(t *testing.T) {
	existing := map[string]struct{}{
		directorTradeKey("J Smith", "2025-01-02", "buy", 0, "https://asx/1.pdf"): {},
	}
	in := []*DirectorTradeRecord{
		trade("BHP", "J Smith", "2025-01-02", "buy", "https://asx/1.pdf"),  // stored
		trade("BHP", "J Smith", "2025-01-03", "buy", "https://asx/2.pdf"),  // new
		trade("BHP", "J Smith", "2025-01-03", "buy", "https://asx/2.pdf"),  // in-batch repeat
		trade("BHP", "J Smith", "2025-01-02", "sell", "https://asx/1.pdf"), // same notice, other type: new
		trade("BHP", "A Jones", "2025-01-02", "buy", ""),                   // no URL: its own key
	}
	got := filterNewDirectorTrades(in, existing)
	if len(got) != 3 {
		t.Fatalf("want 3 fresh trades, got %d: %+v", len(got), got)
	}
	if got[0].TradeDate != "2025-01-03" || got[1].TradeType != "sell" || got[2].DirectorName != "A Jones" {
		t.Fatalf("order or content changed: %+v %+v %+v", got[0], got[1], got[2])
	}
	if fresh := filterNewDirectorTrades(in[:1], existing); len(fresh) != 0 {
		t.Fatalf("a steady-state run inserts nothing, got %d", len(fresh))
	}
}

func TestGroupDirectorTradesByCode(t *testing.T) {
	groups := groupDirectorTradesByCode([]*DirectorTradeRecord{
		trade("BHP", "a", "2025-01-01", "buy", "u1"),
		trade("CBA", "b", "2025-01-01", "buy", "u2"),
		trade("BHP", "c", "2025-01-01", "buy", "u3"),
	})
	if len(groups) != 2 || len(groups[0]) != 2 || groups[0][1].DirectorName != "c" || groups[1][0].StockCode != "CBA" {
		t.Fatalf("groups: %+v", groups)
	}
}

func TestBuildDirectorTradeInsertIsParameterized(t *testing.T) {
	price := 12.5
	batch := []*DirectorTradeRecord{
		trade("BHP", "O'Brien", "2025-01-02", "buy", "https://asx/1.pdf"),
		{StockCode: "BHP", DirectorName: "J Smith", TradeType: "sell", SharesTraded: 1000, PricePerShare: &price, TradeDate: "2025-01-03", AnnouncementURL: "u"},
	}
	query, args := buildDirectorTradeInsert(batch)
	if len(args) != 16 {
		t.Fatalf("want 8 args per row, got %d", len(args))
	}
	for _, want := range []string{
		"($1, $2, $3, $4::bigint, $5::numeric, $6::numeric, $7::date, $8)",
		"($9, $10, $11, $12::bigint, $13::numeric, $14::numeric, $15::date, $16)",
		"ON CONFLICT DO NOTHING",
	} {
		if !strings.Contains(query, want) {
			t.Errorf("query missing %q:\n%s", want, query)
		}
	}
	if strings.Contains(query, "O'Brien") || strings.Contains(query, "asx/1.pdf") {
		t.Fatalf("values must travel as parameters, not literals:\n%s", query)
	}
	if args[1] != "O'Brien" || args[12] != batch[1].PricePerShare {
		t.Fatalf("args out of order: %v", args)
	}
	if q, a := buildDirectorTradeInsert(nil); q != "" || a != nil {
		t.Fatal("an empty batch builds nothing")
	}
}
