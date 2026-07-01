package main

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/xuri/excelize/v2"
)

// TestFetchVICLGPRFDebug is a live, opt-in probe that fetches the LGPRF workbook
// via stealth and dumps its sheet/row structure so the parser can be written to
// the real layout. Run: VIC_FETCH_DEBUG=1 go test ./house-price-collector -run
// TestFetchVICLGPRFDebug -v. Skipped by default (network + Cloudflare).
func TestFetchVICLGPRFDebug(t *testing.T) {
	if os.Getenv("VIC_FETCH_DEBUG") == "" {
		t.Skip("set VIC_FETCH_DEBUG=1 to run the live LGPRF fetch probe")
	}
	b, err := fetchVICLGPRF(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile("/tmp/vic-lgprf.xlsx", b, 0o644)
	t.Logf("fetched %d bytes → /tmp/vic-lgprf.xlsx", len(b))
	f, err := excelize.OpenReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range f.GetSheetList() {
		rows, _ := f.GetRows(s)
		n := len(rows)
		t.Logf("SHEET %q rows=%d", s, n)
		for i := 0; i < 6 && i < n; i++ {
			t.Logf("  [%d] %v", i, rows[i])
		}
	}
}
