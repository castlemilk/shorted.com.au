package main

import (
	"os"
	"strings"
	"testing"
)

// The LGPRF workbook gets a new asset path every release. The URL comes from
// the data directory's CKAN record (captured 2026-09-23), so the next release
// needs no code change — and a record that stops being CC-BY is refused.
func TestPickVICLGPRFURL(t *testing.T) {
	raw, err := os.ReadFile("testdata/vic-lgprf-package.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := pickVICLGPRFURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got != vicLGPRFURL {
		t.Errorf("url = %q, want the captured release %q", got, vicLGPRFURL)
	}

	next := strings.ReplaceAll(string(raw), "LGPRF-2020-2025-Full-Council-Data-Set-Nov25-Final-Release", "LGPRF-2021-2026-Full-Council-Data-Set-Nov26")
	if got, _ := pickVICLGPRFURL([]byte(next)); !strings.Contains(got, "2021-2026") {
		t.Errorf("a new release was not picked up: %q", got)
	}

	for name, bad := range map[string]string{
		"licence changed": strings.Replace(string(raw), `"cc-by"`, `"other-closed"`, 1),
		"no workbook":     strings.Replace(string(raw), `"XLSX"`, `"PDF"`, 1),
		"not success":     strings.Replace(string(raw), `"success": true`, `"success": false`, 1),
		"not json":        "<html>",
	} {
		if _, err := pickVICLGPRFURL([]byte(bad)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}
