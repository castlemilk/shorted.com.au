package main

import (
	"strings"
	"testing"
)

func ann(date, headline, url string) ASXAnnouncement {
	return ASXAnnouncement{Date: date, Headline: headline, PDFURL: url}
}

func TestFilterNewAnnouncements(t *testing.T) {
	existing := map[string]struct{}{
		announcementKey("2025-01-02", "Half Year Results"): {},
	}
	in := []ASXAnnouncement{
		ann("2025-01-02", "Half Year Results", "u1"), // already stored
		ann("2025-01-03", "Trading Halt", "u2"),      // new
		ann("2025-01-03", "Trading Halt", "u2"),      // in-batch duplicate (two crawled years)
		ann("2025-01-04", "Half Year Results", "u3"), // same headline, different date -> new
	}

	got := filterNewAnnouncements(in, existing)
	if len(got) != 2 {
		t.Fatalf("expected 2 fresh announcements, got %d: %+v", len(got), got)
	}
	if got[0].Headline != "Trading Halt" || got[1].Date != "2025-01-04" {
		t.Fatalf("unexpected order/content: %+v", got)
	}
}

func TestFilterNewAnnouncementsAllExisting(t *testing.T) {
	in := []ASXAnnouncement{ann("2025-01-02", "A", "u1"), ann("2025-01-03", "B", "u2")}
	existing := map[string]struct{}{
		announcementKey("2025-01-02", "A"): {},
		announcementKey("2025-01-03", "B"): {},
	}
	if got := filterNewAnnouncements(in, existing); len(got) != 0 {
		t.Fatalf("expected no inserts on a steady-state run, got %d", len(got))
	}
	if got := filterNewAnnouncements(nil, existing); got != nil {
		t.Fatalf("expected nil for empty input, got %+v", got)
	}
}

func TestFilterNewNewsArticles(t *testing.T) {
	existing := map[string]struct{}{"https://asx/1.pdf": {}}
	in := []ASXAnnouncement{
		ann("2025-01-02", "A", "https://asx/1.pdf"), // stored
		ann("2025-01-03", "B", "https://asx/2.pdf"), // new
		ann("2025-01-03", "B", "https://asx/2.pdf"), // in-batch dup on the url conflict key
		ann("2025-01-04", "C", ""),                  // no url -> never insertable
	}

	got := filterNewNewsArticles(in, existing)
	if len(got) != 1 || got[0].PDFURL != "https://asx/2.pdf" {
		t.Fatalf("expected only the one new url, got %+v", got)
	}
}

func TestChunkAnnouncements(t *testing.T) {
	in := make([]ASXAnnouncement, 5)
	chunks := chunkAnnouncements(in, 2)
	if len(chunks) != 3 || len(chunks[0]) != 2 || len(chunks[2]) != 1 {
		t.Fatalf("unexpected chunking: %d chunks", len(chunks))
	}
	if chunkAnnouncements(nil, 2) != nil {
		t.Fatal("expected nil chunks for empty input")
	}
	if got := chunkAnnouncements(in, 0); len(got) != 5 {
		t.Fatalf("size<1 should fall back to 1-row chunks, got %d", len(got))
	}
}

func TestBuildAnnouncementInsert(t *testing.T) {
	batch := []ASXAnnouncement{
		{Date: "2025-01-02", Headline: "Trading Halt", IsPriceSens: true, PDFURL: "u1"},
		{Date: "2025-01-03", Headline: "O'Brien's Update", PDFURL: "u2"},
	}

	query, args := buildAnnouncementInsert("BHP", batch)

	if strings.Count(query, "VALUES") != 1 {
		t.Fatalf("expected a single multi-row INSERT statement: %s", query)
	}
	if !strings.Contains(query, "($1, $2::date, $3, $4, $5, $6, 'asx_announcements')") ||
		!strings.Contains(query, "($7, $8::date, $9, $10, $11, $12, 'asx_announcements')") {
		t.Fatalf("unexpected placeholders: %s", query)
	}
	if !strings.Contains(query, "ON CONFLICT (stock_code, announcement_date, headline) DO NOTHING") {
		t.Fatalf("conflict guard must be retained: %s", query)
	}
	if len(args) != 12 {
		t.Fatalf("expected 12 bind args for 2 rows, got %d", len(args))
	}
	// Values must travel as parameters — never interpolated into the SQL text.
	if strings.Contains(query, "O'Brien") || strings.Contains(query, "BHP") {
		t.Fatalf("query must not embed literal values: %s", query)
	}
	if args[0] != "BHP" || args[1] != "2025-01-02" || args[2] != "Trading Halt" || args[3] != true {
		t.Fatalf("unexpected first-row args: %+v", args[:6])
	}
	if args[4] != "trading_halt" {
		t.Fatalf("announcement_type should be classified, got %v", args[4])
	}
	if args[8] != "O'Brien's Update" {
		t.Fatalf("unexpected second-row headline arg: %v", args[8])
	}

	if q, a := buildAnnouncementInsert("BHP", nil); q != "" || a != nil {
		t.Fatal("empty batch must produce no statement")
	}
}

func TestBuildNewsArticleInsert(t *testing.T) {
	batch := []ASXAnnouncement{
		{Date: "2025-01-02", Headline: "Record profit", IsPriceSens: true, PDFURL: "u1"},
		{Date: "2025-01-03", Headline: "Trading Halt", PDFURL: "u2"},
	}

	query, args := buildNewsArticleInsert("BHP", batch)

	if !strings.Contains(query, "($1, 'asx', $2, $3, $4::timestamptz, $5, $6, $7, $8)") ||
		!strings.Contains(query, "($9, 'asx', $10, $11, $12::timestamptz, $13, $14, $15, $16)") {
		t.Fatalf("unexpected placeholders: %s", query)
	}
	if !strings.Contains(query, "ON CONFLICT (url) DO NOTHING") {
		t.Fatalf("conflict guard must be retained: %s", query)
	}
	if len(args) != 16 {
		t.Fatalf("expected 16 bind args for 2 rows, got %d", len(args))
	}
	if args[3] != "2025-01-02T00:00:00+10:00" {
		t.Fatalf("published_at should carry the AEST offset, got %v", args[3])
	}
	if args[4] != "positive" || args[5] != 0.9 || args[6] != true {
		t.Fatalf("unexpected sentiment/relevance/price-sensitive args: %+v", args[4:7])
	}
	if args[13] != 0.5 {
		t.Fatalf("non price-sensitive rows should score 0.5, got %v", args[13])
	}
	if args[15] != "trading_halt announcement" {
		t.Fatalf("unexpected summary arg: %v", args[15])
	}
}
