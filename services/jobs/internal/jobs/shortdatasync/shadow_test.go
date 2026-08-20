package shortdatasync

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestChecksumIsOrderIndependentAndDataSensitive(t *testing.T) {
	rows := sampleRows()
	shuffled := []shortsRow{rows[2], rows[0], rows[1]}

	if checksumRows(rows) != checksumRows(shuffled) {
		t.Fatal("checksum must not depend on row order")
	}
	if checksumRows(nil) == checksumRows(rows) {
		t.Fatal("empty and non-empty row sets must differ")
	}

	changed := append([]shortsRow(nil), rows...)
	changed[1].ReportedShortPositions = 999
	if checksumRows(rows) == checksumRows(changed) {
		t.Fatal("a changed position must change the checksum")
	}

	// Only (date, code, positions) participate: the other columns are not part
	// of the comparison contract documented in the README.
	sameKey := append([]shortsRow(nil), rows...)
	sameKey[0].Product = "RENAMED"
	sameKey[0].TotalProductInIssue = 12345
	if checksumRows(rows) != checksumRows(sameKey) {
		t.Fatal("checksum should cover (date, code, positions) only")
	}
}

func TestChecksumIsStableAcrossRuns(t *testing.T) {
	rows := sampleRows()
	first := checksumRows(rows)
	for i := 0; i < 5; i++ {
		if got := checksumRows(rows); got != first {
			t.Fatalf("checksum drifted between runs: %s vs %s", got, first)
		}
	}
}

func TestClassifyInsertUpdateDuplicate(t *testing.T) {
	d := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	existing := map[string]struct{}{rowKey(d, "AAA"): {}}
	seen := map[string]struct{}{}

	rows := append(sampleRows(), shortsRow{Date: d, ProductCode: "BBB"}) // BBB repeated
	ins, upd, dup := classify(rows, existing, seen)

	if upd != 1 {
		t.Fatalf("would-update = %d, want 1 (AAA already present)", upd)
	}
	if ins != 2 {
		t.Fatalf("would-insert = %d, want 2", ins)
	}
	if dup != 1 {
		t.Fatalf("duplicate keys = %d, want 1", dup)
	}
}

func TestShadowSummaryJSONRoundTrip(t *testing.T) {
	sum := newShadowSummary(time.Date(2026, 8, 20, 1, 2, 3, 0, time.UTC), 7)
	sum.RowsParsed = 10
	sum.Checksum = "abc"

	var buf bytes.Buffer
	if err := sum.writeJSON(&buf); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	var back shadowSummary
	if err := json.Unmarshal(buf.Bytes(), &back); err != nil {
		t.Fatalf("summary must be machine-readable: %v", err)
	}
	if back.Mode != "shadow" || back.SyncDays != 7 || back.RowsParsed != 10 || back.Checksum != "abc" {
		t.Fatalf("round trip lost fields: %+v", back)
	}
	if back.GeneratedAt != "2026-08-20T01:02:03Z" {
		t.Fatalf("generated_at = %q", back.GeneratedAt)
	}
}

// TestShadowSummaryEmptySlicesSerialiseAsArrays keeps a diff of two summaries
// free of null-vs-[] noise.
func TestShadowSummaryEmptySlicesSerialiseAsArrays(t *testing.T) {
	var buf bytes.Buffer
	if err := newShadowSummary(time.Now(), 7).writeJSON(&buf); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	if bytes.Contains(buf.Bytes(), []byte("null")) {
		t.Fatalf("summary must not contain nulls:\n%s", buf.String())
	}
}

func TestSortShadowDates(t *testing.T) {
	dates := []shadowDate{{Date: "2026-08-14"}, {Date: "2026-08-12"}, {Date: "2026-08-13"}}
	sortShadowDates(dates)
	for i, want := range []string{"2026-08-12", "2026-08-13", "2026-08-14"} {
		if dates[i].Date != want {
			t.Fatalf("dates[%d] = %s, want %s", i, dates[i].Date, want)
		}
	}
}
