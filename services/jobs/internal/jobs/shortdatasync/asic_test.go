package shortdatasync

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDownloadURL(t *testing.T) {
	got := asicFile{Date: 20260814, Version: "001"}.downloadURL()
	want := "https://download.asic.gov.au/short-selling/RR20260814-001-SSDailyAggShortPos.csv"
	if got != want {
		t.Fatalf("downloadURL = %q, want %q", got, want)
	}
	if name := (asicFile{Date: 20260814, Version: "001"}).fileName(); name != "RR20260814-001-SSDailyAggShortPos.csv" {
		t.Fatalf("fileName = %q", name)
	}
}

func TestSelectFilesKeepsIndexOrder(t *testing.T) {
	index := []asicFile{
		{Date: 20260814, Version: "001"},
		{Date: 20260813, Version: "001"},
		{Date: 20260812, Version: "002"},
		{Date: 20260811, Version: "001"},
	}
	got := selectFiles(index, 20260813)
	if len(got) != 2 {
		t.Fatalf("selected %d files, want 2", len(got))
	}
	// Newest first, exactly as ASIC serves it — the order decides which row
	// wins when one date appears twice.
	if got[0].Date != 20260814 || got[1].Date != 20260813 {
		t.Fatalf("order not preserved: %+v", got)
	}
}

func TestYYYYMMDD(t *testing.T) {
	if got := yyyymmdd(time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)); got != 20260804 {
		t.Fatalf("yyyymmdd = %d", got)
	}
}

func TestDateFromFileName(t *testing.T) {
	d, err := dateFromFileName("RR20260814-001-SSDailyAggShortPos.csv")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !d.Equal(time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("date = %s", d)
	}
	if _, err := dateFromFileName("not-a-file.csv"); err == nil {
		t.Fatal("expected an error for a name with no date")
	}
}

func TestNormaliseHeader(t *testing.T) {
	cases := map[string]string{
		"Product":                  "PRODUCT",
		"Product Code":             "PRODUCT_CODE",
		"Reported Short Positions": "REPORTED_SHORT_POSITIONS",
		"Total Product in Issue":   "TOTAL_PRODUCT_IN_ISSUE",
		"% of Total Product in Issue Reported as Short Positions": colPercent,
		"  product  ": "PRODUCT",
	}
	for in, want := range cases {
		if got := normaliseHeader(in); got != want {
			t.Errorf("normaliseHeader(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseNumeric(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{".03453257", 0.03453257, true},
		{"181029", 181029, true},
		{" 1,245,921,802 ", 1245921802, true},
		{"", 0, true},
		{"n/a", 0, false},
	}
	for _, c := range cases {
		got, ok := parseNumeric(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseNumeric(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

// TestParseFileModern is the golden test over a real (trimmed) ASIC daily file:
// comma-separated UTF-8 with CRLF line endings, a leading-dot percentage and a
// quoted product name containing a comma.
func TestParseFileModern(t *testing.T) {
	name := "RR20260814-001-SSDailyAggShortPos.csv"
	rows, err := parseFile(name, readFixture(t, name))
	if err != nil {
		t.Fatalf("parseFile: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("parsed %d rows, want 4", len(rows))
	}
	want := shortsRow{
		Date:                   time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC),
		Product:                "3D ENERGI LTD ORDINARY",
		ProductCode:            "TDO",
		ReportedShortPositions: 181029,
		TotalProductInIssue:    524226804,
		Percent:                0.03453257,
	}
	if rows[0] != want {
		t.Fatalf("row 0 = %+v, want %+v", rows[0], want)
	}
	// Quoted field with an embedded comma stays one product name.
	if rows[2].Product != "SALUDA MEDICAL, INC. CDI USPROHEXCLQIB" || rows[2].ProductCode != "SLD" {
		t.Fatalf("quoted row mis-parsed: %+v", rows[2])
	}
	// Trailing whitespace is stripped from the code (the Python .str.strip()).
	if rows[3].ProductCode != "ZIP" {
		t.Fatalf("code not trimmed: %q", rows[3].ProductCode)
	}
	// Every row carries the FILENAME date, never a column.
	for _, r := range rows {
		if !r.Date.Equal(want.Date) {
			t.Fatalf("row date = %s, want %s", r.Date, want.Date)
		}
	}
}

// TestParseFileLegacyUTF16Tab covers the pre-2023 ASIC format (UTF-16LE + BOM,
// tab separated). The deployed Python silently produced ZERO rows for these;
// this is the documented divergence.
func TestParseFileLegacyUTF16Tab(t *testing.T) {
	name := "RR20200401-001-SSDailyAggShortPos.csv"
	rows, err := parseFile(name, readFixture(t, name))
	if err != nil {
		t.Fatalf("parseFile: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("parsed %d rows, want 2", len(rows))
	}
	if rows[0].ProductCode != "5GN" || rows[0].ReportedShortPositions != 27725 {
		t.Fatalf("row 0 = %+v", rows[0])
	}
	if !rows[0].Date.Equal(time.Date(2020, 4, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("date = %s", rows[0].Date)
	}
}

// TestParseFileCP1252 proves the non-UTF-8 fallback keeps accented product
// names readable rather than corrupting them into replacement characters.
func TestParseFileCP1252(t *testing.T) {
	name := "RR20240102-001-SSDailyAggShortPos.csv"
	rows, err := parseFile(name, readFixture(t, name))
	if err != nil {
		t.Fatalf("parseFile: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("parsed %d rows, want 1", len(rows))
	}
	if rows[0].Product != "CAFÉ HOLDINGS — ORDINARY" {
		t.Fatalf("product = %q", rows[0].Product)
	}
}

func TestParseFileRejectsUnknownHeader(t *testing.T) {
	body := []byte("Alpha,Beta\n1,2\n")
	_, err := parseFile("RR20260814-001-SSDailyAggShortPos.csv", body)
	if !errors.Is(err, errNoUsableHeader) {
		t.Fatalf("err = %v, want errNoUsableHeader", err)
	}
}

func TestParseFileDropsUnparseableRows(t *testing.T) {
	body := []byte("Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions\n" +
		"GOOD LTD,GUD,1,2,3\n" +
		"BAD LTD,BAD,not-a-number,2,3\n" +
		"SHORT ROW,SRT\n" +
		"BLANK LTD,BLK,,2,3\n")
	rows, err := parseFile("RR20260814-001-SSDailyAggShortPos.csv", body)
	if err != nil {
		t.Fatalf("parseFile: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("parsed %d rows, want 2 (good + blank-as-zero)", len(rows))
	}
	if rows[0].ProductCode != "GUD" || rows[1].ProductCode != "BLK" {
		t.Fatalf("unexpected rows: %+v", rows)
	}
	if rows[1].ReportedShortPositions != 0 {
		t.Fatalf("blank numeric should be 0, got %v", rows[1].ReportedShortPositions)
	}
}

func TestDecodeBytes(t *testing.T) {
	if got := decodeBytes([]byte{0xEF, 0xBB, 0xBF, 'h', 'i'}); got != "hi" {
		t.Fatalf("utf-8 BOM: %q", got)
	}
	if got := decodeBytes([]byte{0xFE, 0xFF, 0x00, 'h', 0x00, 'i'}); got != "hi" {
		t.Fatalf("utf-16be: %q", got)
	}
	if got := decodeBytes([]byte{0xFF, 0xFE, 'h', 0x00, 'i', 0x00}); got != "hi" {
		t.Fatalf("utf-16le: %q", got)
	}
	if got := decodeBytes([]byte("plain")); got != "plain" {
		t.Fatalf("utf-8: %q", got)
	}
	// 0x92 is a CP1252 right single quote and invalid UTF-8.
	if got := decodeBytes([]byte{'i', 't', 0x92, 's'}); got != "it’s" {
		t.Fatalf("cp1252: %q", got)
	}
}

func TestSniffDelimiter(t *testing.T) {
	if got := sniffDelimiter("a,b,c\n1,2,3"); got != ',' {
		t.Fatalf("comma sniff = %q", got)
	}
	if got := sniffDelimiter("a\tb\tc\r\n1\t2\t3"); got != '\t' {
		t.Fatalf("tab sniff = %q", got)
	}
}

func TestDownloadFile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index":
			_, _ = w.Write([]byte(`[{"date":20260814,"version":"001"}]`))
		case "/file":
			_, _ = w.Write([]byte("ok"))
		default:
			// ASIC answers a missing day with an HTML 404 page.
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("<html>not found</html>"))
		}
	}))
	defer srv.Close()

	body, err := downloadFile(context.Background(), srv.Client(), srv.URL+"/file")
	if err != nil || string(body) != "ok" {
		t.Fatalf("downloadFile = %q, %v", body, err)
	}
	if _, err := downloadFile(context.Background(), srv.Client(), srv.URL+"/missing"); err == nil {
		t.Fatal("expected an error for a 404 file")
	}
}
