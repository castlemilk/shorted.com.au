package alerts

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// TestAlertEmailPreview writes the four email designs as HTML files for a visual
// review. It runs only when ALERT_EMAIL_PREVIEW_DIR names a directory:
//
//	ALERT_EMAIL_PREVIEW_DIR=/some/dir go test -run TestAlertEmailPreview ./internal/jobs/alerts/
//
// Each cid: reference is rewritten to a sibling file, so a browser shows the chart
// and the mark: chart-<name>.png and shorted-mark.png. The real email keeps cid:.
func TestAlertEmailPreview(t *testing.T) {
	dir := os.Getenv("ALERT_EMAIL_PREVIEW_DIR")
	if dir == "" {
		t.Skip("set ALERT_EMAIL_PREVIEW_DIR to write the email previews")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	writePreview(t, dir, "stock", previewStock("GLC", "Glencore", ""))
	writePreview(t, dir, "stock-logo", previewStock("BHP", "BHP Group", "https://storage.googleapis.com/shorted-company-logos/logos/BHP_icon.png"))
	writePreview(t, dir, "industry", previewIndustry())
	writePreview(t, dir, "canary", canaryMessage())
}

// previewStock is the review case: GLC crossing a 10% alert level on 16 Oct, from
// 6.99% the day before, with shares, rank and a six-month history.
func previewStock(code, name, logo string) Message {
	thr := 10.0
	prev, latest := 6.99, 12.15
	shares, onIssue := 1.24e9, 12.1e9
	change20 := 6.30
	return Message{
		Scope:      alertevents.ScopeStock,
		Target:     code,
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  &thr,
		ReportDate: "2026-10-16",
		ComparedTo: "2026-10-15",
		Latest:     &latest,
		Previous:   &prev,
		Payload: alertevents.Payload{
			Companies: []alertevents.Company{{
				Code: code, Name: name, Latest: latest, Previous: &prev, Change: fpv(latest - prev),
				PreviousDate: "2026-10-15",
			}},
			CompaniesTotal: 1,
			Stock: &alertevents.StockDetail{
				Name:          name,
				Industry:      "Materials",
				LogoURL:       logo,
				SharesShort:   &shares,
				SharesOnIssue: &onIssue,
				Rank:          12,
				Ranked:        640,
				Change20:      &change20,
				History:       previewHistory(120, "2026-10-16", prev, latest),
			},
		},
	}
}

// previewHistory is about six months of trading days ending on last. It climbs
// smoothly from about 3% to prev on the second-last report, then jumps to latest on
// the last one, which is the crossing the email reports. The numbers are a sketch
// for the design review, not data.
func previewHistory(n int, last string, prev, latest float64) []alertevents.Point {
	day, _ := time.Parse(dateLayout, last)
	days := make([]time.Time, 0, n)
	for d := day; len(days) < n; d = d.AddDate(0, 0, -1) {
		if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
			continue
		}
		days = append(days, d)
	}
	out := make([]alertevents.Point, n)
	for i := range out {
		// i counts from the oldest reading; days is newest first.
		d := days[n-1-i]
		var v float64
		switch i {
		case n - 1:
			v = latest
		case n - 2:
			v = prev
		default:
			v = 3 + (prev-3)*float64(i)/float64(n-2)
		}
		out[i] = alertevents.Point{D: d.Format(dateLayout), P: round2(v)}
	}
	return out
}

// previewIndustry is four Materials companies, one with a logo and three without, one
// name carrying "&" and "<" to show the escaping, and one lookback reading.
func previewIndustry() Message {
	m := Message{
		Scope:      alertevents.ScopeIndustry,
		Target:     "Materials",
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  fpv(5),
		ReportDate: "2026-10-16",
		ComparedTo: "2026-10-15",
	}
	// Only BHP has a logo in this preview, from the real icon path; the rest show the
	// monogram, as they do when a company has no logo on file.
	m.Payload = payload([]alertevents.Company{
		{Code: "AAA", Name: "Aaa & Co <Holdings>", Latest: 5.92, Previous: fpv(4.80), Change: fpv(1.12)},
		{Code: "BHP", Name: "BHP Group Ltd", Latest: 5.60, Previous: fpv(4.40), Change: fpv(1.20),
			LogoURL: "https://storage.googleapis.com/shorted-company-logos/logos/BHP_icon.png"},
		{Code: "LTR", Name: "Lithium Texas", Latest: 5.40, Previous: fpv(4.10), Change: fpv(1.30), PreviousDate: "2026-10-14"},
		{Code: "EEE", Name: "Eee Resources Ltd", Latest: 5.10, Previous: fpv(4.99), Change: fpv(0.11)},
	})
	return m
}

// writePreview renders m and writes name.html beside its chart and the mark.
func writePreview(t *testing.T, dir, name string, m Message) {
	t.Helper()
	r, err := renderMessage(testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	html := r.HTML
	for _, a := range r.Attachments {
		file := a.ContentID + ".png"
		if a.ContentID == chartCID {
			file = "chart-" + name + ".png"
		}
		data, err := base64.StdEncoding.DecodeString(a.Content)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), data, 0o644); err != nil {
			t.Fatal(err)
		}
		html = strings.ReplaceAll(html, "cid:"+a.ContentID, file)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".html"), []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
}
