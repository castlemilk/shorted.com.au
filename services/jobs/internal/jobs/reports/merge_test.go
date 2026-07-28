package reports

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeDB / fakeTx are the minimum needed to drive the read-merge-write path
// without a database. pgx.Tx is embedded (nil) so any method the code under test
// starts calling that we haven't stubbed panics loudly instead of silently
// misbehaving.
type fakeDB struct {
	tx       *fakeTx
	beginErr error
}

func (f *fakeDB) Begin(ctx context.Context) (pgx.Tx, error) {
	if f.beginErr != nil {
		return nil, f.beginErr
	}
	return f.tx, nil
}

type fakeTx struct {
	pgx.Tx // nil: unstubbed methods panic

	existingJSON string // what SELECT ... FOR UPDATE returns
	scanErr      error

	execSQL     []string
	writtenJSON string
	writtenCode string
	committed   bool
	rolledBack  bool
}

type fakeRow struct {
	value string
	err   error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	p, ok := dest[0].(*string)
	if !ok {
		return errors.New("fakeRow: want *string dest")
	}
	*p = r.value
	return nil
}

func (t *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return fakeRow{value: t.existingJSON, err: t.scanErr}
}

func (t *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execSQL = append(t.execSQL, sql)
	if len(args) == 2 {
		t.writtenJSON, _ = args[0].(string)
		t.writtenCode, _ = args[1].(string)
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (t *fakeTx) Commit(ctx context.Context) error {
	t.committed = true
	return nil
}

func (t *fakeTx) Rollback(ctx context.Context) error {
	t.rolledBack = true
	return nil
}

func mustMarshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestMergeReportsCorruptExistingJSONDoesNotWrite(t *testing.T) {
	tx := &fakeTx{existingJSON: `{"not":"an array"`}
	db := &fakeDB{tx: tx}

	updated, err := mergeReports(context.Background(), db, "BHP",
		[]FinancialReport{{URL: "https://x.com/new.pdf", Source: "links_import"}}, false)

	if err == nil {
		t.Fatal("want an error for corrupt financial_reports, got nil")
	}
	if !strings.Contains(err.Error(), "corrupt financial_reports for BHP") {
		t.Errorf("unexpected error text: %v", err)
	}
	if updated {
		t.Error("updated must be false when the merge aborts")
	}
	if len(tx.execSQL) != 0 {
		t.Fatalf("corrupt row must NOT be written; got %d exec(s): %v", len(tx.execSQL), tx.execSQL)
	}
	if tx.committed {
		t.Error("transaction must not commit after a decode failure")
	}
	if !tx.rolledBack {
		t.Error("transaction should have rolled back")
	}
}

func TestMergeReportsAppendsAndDedupes(t *testing.T) {
	existing := []FinancialReport{
		{URL: "https://x.com/2023-annual-report.pdf", Date: "2023-12-31", Source: "links_import", GcsURL: "https://storage/x.pdf"},
	}
	tx := &fakeTx{existingJSON: mustMarshal(t, existing)}
	db := &fakeDB{tx: tx}

	newReports := []FinancialReport{
		// same URL in different case — must dedupe, not duplicate
		{URL: "https://X.com/2023-Annual-Report.pdf", Date: "2023-12-31", Source: "asx_announcements"},
		{URL: "https://x.com/2024-annual-report.pdf", Date: "2024-12-31", Source: "asx_announcements"},
	}

	updated, err := mergeReports(context.Background(), db, "BHP", newReports, false)
	if err != nil {
		t.Fatalf("mergeReports: %v", err)
	}
	if !updated {
		t.Fatal("want updated=true")
	}
	if !tx.committed {
		t.Error("want commit")
	}
	if tx.writtenCode != "BHP" {
		t.Errorf("wrote wrong stock code: %q", tx.writtenCode)
	}

	var got []FinancialReport
	if err := json.Unmarshal([]byte(tx.writtenJSON), &got); err != nil {
		t.Fatalf("written payload is not valid JSON: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 reports after dedupe, got %d: %+v", len(got), got)
	}
	// The existing entry (and its gcsUrl) must survive the round trip.
	var kept bool
	for _, r := range got {
		if r.URL == existing[0].URL {
			kept = true
			if r.GcsURL != existing[0].GcsURL {
				t.Errorf("gcsUrl stripped on merge: %+v", r)
			}
		}
	}
	if !kept {
		t.Errorf("existing report dropped: %+v", got)
	}
	// Sorted by source priority: asx_announcements (0) before links_import (4).
	if got[0].Source != "asx_announcements" {
		t.Errorf("want source-priority ordering, got %+v", got)
	}
}

func TestMergeReportsNoNewURLsShortCircuits(t *testing.T) {
	existing := []FinancialReport{{URL: "https://x.com/a.pdf", Source: "links_import"}}
	tx := &fakeTx{existingJSON: mustMarshal(t, existing)}
	db := &fakeDB{tx: tx}

	updated, err := mergeReports(context.Background(), db, "BHP",
		[]FinancialReport{{URL: "https://x.com/A.PDF", Source: "live_crawl"}}, false)
	if err != nil {
		t.Fatalf("mergeReports: %v", err)
	}
	if updated {
		t.Error("want updated=false when every URL is already present")
	}
	if len(tx.execSQL) != 0 {
		t.Errorf("no-op merge must not write: %v", tx.execSQL)
	}
	if tx.committed {
		t.Error("no-op merge must not commit")
	}
}

func TestMergeReportsEmptyArrayIsNotCorrupt(t *testing.T) {
	tx := &fakeTx{existingJSON: "[]"}
	db := &fakeDB{tx: tx}

	updated, err := mergeReports(context.Background(), db, "BHP",
		[]FinancialReport{{URL: "https://x.com/a.pdf", Source: "links_import"}}, false)
	if err != nil {
		t.Fatalf("mergeReports: %v", err)
	}
	if !updated || !tx.committed {
		t.Fatalf("first report for a company should be written (updated=%v committed=%v)", updated, tx.committed)
	}
}

func TestUpdateReportsCorruptCurrentJSONDoesNotWrite(t *testing.T) {
	tx := &fakeTx{existingJSON: "not json at all"}
	db := &fakeDB{tx: tx}

	err := updateReports(context.Background(), db, "CBA",
		[]FinancialReport{{URL: "https://x.com/a.pdf", GcsURL: "https://storage/a.pdf"}})
	if err == nil {
		t.Fatal("want an error for corrupt financial_reports, got nil")
	}
	if !strings.Contains(err.Error(), "corrupt financial_reports for CBA") {
		t.Errorf("unexpected error text: %v", err)
	}
	if len(tx.execSQL) != 0 {
		t.Fatalf("corrupt row must NOT be written; got %v", tx.execSQL)
	}
	if tx.committed {
		t.Error("transaction must not commit after a decode failure")
	}
}

func TestUpdateReportsAppliesGcsURLsToCurrentState(t *testing.T) {
	current := []FinancialReport{
		{URL: "https://x.com/a.pdf", Source: "links_import"},
		{URL: "https://x.com/b.pdf", Source: "links_import", GcsURL: "https://storage/b-old.pdf"},
		{URL: "https://x.com/c.pdf", Source: "links_import"},
	}
	tx := &fakeTx{existingJSON: mustMarshal(t, current)}
	db := &fakeDB{tx: tx}

	// In-memory state carries new GCS URLs for a and b; b already has one in the
	// DB and must not be overwritten.
	inMemory := []FinancialReport{
		{URL: "https://X.com/A.pdf", GcsURL: "https://storage/a-new.pdf"},
		{URL: "https://x.com/b.pdf", GcsURL: "https://storage/b-new.pdf"},
	}

	if err := updateReports(context.Background(), db, "CBA", inMemory); err != nil {
		t.Fatalf("updateReports: %v", err)
	}
	if !tx.committed {
		t.Fatal("want commit")
	}

	var got []FinancialReport
	if err := json.Unmarshal([]byte(tx.writtenJSON), &got); err != nil {
		t.Fatalf("written payload is not valid JSON: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("row length changed: %+v", got)
	}
	want := map[string]string{
		"https://x.com/a.pdf": "https://storage/a-new.pdf",
		"https://x.com/b.pdf": "https://storage/b-old.pdf",
		"https://x.com/c.pdf": "",
	}
	for _, r := range got {
		if want[r.URL] != r.GcsURL {
			t.Errorf("%s: want gcsUrl %q, got %q", r.URL, want[r.URL], r.GcsURL)
		}
	}
}

func TestMergeReportsBeginError(t *testing.T) {
	db := &fakeDB{beginErr: errors.New("pool exhausted")}
	if _, err := mergeReports(context.Background(), db, "BHP",
		[]FinancialReport{{URL: "https://x.com/a.pdf"}}, false); err == nil ||
		!strings.Contains(err.Error(), "begin tx") {
		t.Fatalf("want begin tx error, got %v", err)
	}
}
