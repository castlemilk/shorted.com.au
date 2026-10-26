package alerts

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// TestAlertEmailPreview writes the email designs as HTML files for a visual review.
// It runs only when ALERT_EMAIL_PREVIEW_DIR names a directory:
//
//	ALERT_EMAIL_PREVIEW_DIR=/some/dir go test -run TestAlertEmailPreview ./internal/jobs/alerts/
//
// ALERT_EMAIL_PREVIEW_HISTORY, when set, names a JSON file of real histories,
// [{code, points:[{d,p}]}], and the stock previews use them. Unset, they use
// synthetic histories of the same shape. The file is never committed.
//
// Each cid: reference is rewritten to a sibling file, so a browser shows the charts
// and the mark: chart-<name>.png, chart-dark-<name>.png and shorted-mark.png. The
// real email keeps cid:.
func TestAlertEmailPreview(t *testing.T) {
	dir := os.Getenv("ALERT_EMAIL_PREVIEW_DIR")
	if dir == "" {
		t.Skip("set ALERT_EMAIL_PREVIEW_DIR to write the email previews")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cases, err := previewCases(os.Getenv("ALERT_EMAIL_PREVIEW_HISTORY"))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		writePreview(t, dir, c.name, previewStock(c))
	}
	writePreview(t, dir, "industry", previewIndustry())
	writePreview(t, dir, "canary", canaryMessage())
}

// previewCase is one stock review scenario.
type previewCase struct {
	name, code, company, logo string
	threshold                 float64
	compared, report          string
	prev, latest              float64
	history                   []alertevents.Point
	shares, onIssue           float64
	rank, ranked              int // rank 0 leaves the rank out
}

// previewCases returns the stock scenarios: PLS crossing 13.2, GLC with only three
// readings, and BHP cut to 14 October. Real histories come from the file when one
// is named, otherwise synthetic ones of the same shape stand in.
func previewCases(histFile string) ([]previewCase, error) {
	real := map[string][]alertevents.Point{}
	if histFile != "" {
		b, err := os.ReadFile(histFile)
		if err != nil {
			return nil, err
		}
		var rows []struct {
			Code   string `json:"code"`
			Points []struct {
				D string  `json:"d"`
				P float64 `json:"p"`
			} `json:"points"`
		}
		if err := json.Unmarshal(b, &rows); err != nil {
			return nil, fmt.Errorf("history file: %w", err)
		}
		for _, r := range rows {
			pts := make([]alertevents.Point, 0, len(r.Points))
			for _, p := range r.Points {
				pts = append(pts, alertevents.Point{D: p.D, P: p.P})
			}
			real[r.Code] = pts
		}
	}
	pick := func(code string, synthetic func() []alertevents.Point) []alertevents.Point {
		if pts, ok := real[code]; ok && len(pts) > 0 {
			return pts
		}
		return synthetic()
	}
	pls := pick("PLS", func() []alertevents.Point { return previewHistory(130, "2026-10-16", 13.08, 13.26) })
	glc := pick("GLC", func() []alertevents.Point {
		return []alertevents.Point{{D: "2026-10-14", P: 5.83}, {D: "2026-10-15", P: 6.99}, {D: "2026-10-16", P: 12.15}}
	})
	bhp := pick("BHP", func() []alertevents.Point { return previewHistory(130, "2026-10-14", 1.61, 1.63) })
	// BHP is cut to its first report window ending 14 October, whether real or not.
	bhp = truncateAt(bhp, "2026-10-14")

	// Short histories: the last readings of PLS, so the x labels of an eleven- and a
	// fourteen-reading chart can be checked by eye.
	short := func(n int) []alertevents.Point { return pls[len(pls)-n:] }

	return []previewCase{
		{name: "pls", code: "PLS", company: "Pilbara Minerals", threshold: 13.2,
			compared: "2026-10-15", report: "2026-10-16", prev: 13.08, latest: 13.26,
			history: pls, shares: 2.14e8, onIssue: 1.63e9, rank: 4, ranked: 640},
		{name: "short11", code: "PLS", company: "Pilbara Minerals", threshold: 13.2,
			compared: "2026-10-15", report: "2026-10-16", prev: 13.08, latest: 13.26,
			history: short(11), shares: 2.14e8, onIssue: 1.63e9},
		{name: "short14", code: "PLS", company: "Pilbara Minerals", threshold: 13.2,
			compared: "2026-10-15", report: "2026-10-16", prev: 13.08, latest: 13.26,
			history: short(14), shares: 2.14e8, onIssue: 1.63e9},
		{name: "glc", code: "GLC", company: "Glencore", threshold: 10,
			compared: "2026-10-15", report: "2026-10-16", prev: 6.99, latest: 12.15,
			history: glc, shares: 1.24e9, onIssue: 12.1e9},
		{name: "bhp", code: "BHP", company: "BHP Group", logo: "https://storage.googleapis.com/shorted-company-logos/logos/BHP_icon.png",
			threshold: 1.62, compared: "2026-10-13", report: "2026-10-14", prev: 1.61, latest: 1.63,
			history: bhp, shares: 1.1e8, onIssue: 2.27e9, rank: 9, ranked: 640},
	}, nil
}

// truncateAt keeps the readings up to and including date.
func truncateAt(pts []alertevents.Point, date string) []alertevents.Point {
	for i, p := range pts {
		if p.D > date {
			return pts[:i]
		}
	}
	return pts
}

// previewStock is one review case as a stock alert. Its change20 is read from the
// history, so it is never made up, and the chart's threshold line is the case's.
func previewStock(c previewCase) Message {
	thr := c.threshold
	prev, latest := c.prev, c.latest
	shares, onIssue := c.shares, c.onIssue
	st := &alertevents.StockDetail{
		Name:          c.company,
		Industry:      "Materials",
		LogoURL:       c.logo,
		SharesShort:   &shares,
		SharesOnIssue: &onIssue,
		History:       c.history,
	}
	if c.rank > 0 {
		st.Rank, st.Ranked = c.rank, c.ranked
	}
	if n := len(c.history); n > 20 {
		ch := round2(c.history[n-1].P - c.history[n-21].P)
		st.Change20 = &ch
		st.Change20Date = c.history[n-21].D
	}
	return Message{
		Scope:      alertevents.ScopeStock,
		Target:     c.code,
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  &thr,
		ReportDate: Date(c.report),
		ComparedTo: Date(c.compared),
		Latest:     &latest,
		Previous:   &prev,
		Payload: alertevents.Payload{
			Companies: []alertevents.Company{{
				Code: c.code, Name: c.company, Latest: latest, Previous: &prev, Change: new(round2(latest - prev)),
				PreviousDate: c.compared,
			}},
			CompaniesTotal: 1,
			Stock:          st,
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
		Threshold:  new(float64(5)),
		ReportDate: "2026-10-16",
		ComparedTo: "2026-10-15",
	}
	// Only BHP has a logo in this preview, from the real icon path; the rest show the
	// monogram, as they do when a company has no logo on file.
	m.Payload = payload([]alertevents.Company{
		{Code: "AAA", Name: "Aaa & Co <Holdings>", Latest: 5.92, Previous: new(float64(4.80)), Change: new(float64(1.12))},
		{Code: "BHP", Name: "BHP Group Ltd", Latest: 5.60, Previous: new(float64(4.40)), Change: new(float64(1.20)),
			LogoURL: "https://storage.googleapis.com/shorted-company-logos/logos/BHP_icon.png"},
		{Code: "LTR", Name: "Lithium Texas", Latest: 5.40, Previous: new(float64(4.10)), Change: new(float64(1.30)), PreviousDate: "2026-10-14"},
		{Code: "EEE", Name: "Eee Resources Ltd", Latest: 5.10, Previous: new(float64(4.99)), Change: new(float64(0.11))},
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
		switch a.ContentID {
		case chartCID:
			file = "chart-" + name + ".png"
		case chartDarkCID:
			file = "chart-dark-" + name + ".png"
		}
		data, err := base64.StdEncoding.DecodeString(a.Content)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), data, 0o644); err != nil {
			t.Fatal(err)
		}
		// Match the closing quote too, so cid:chart does not also rewrite cid:chart-dark.
		html = strings.ReplaceAll(html, `cid:`+a.ContentID+`"`, file+`"`)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".html"), []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
}
