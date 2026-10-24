package alerts

import (
	"bytes"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

var cidRef = regexp.MustCompile(`cid:([A-Za-z0-9_.\-]+)`)

// stockWithHistory is a stock event carrying the full detail: about six months of
// readings rising to a crossing, shares, rank and the 20-day change.
func stockWithHistory() Message {
	m := emailFixtures()["stock-above-daily"]
	m.Target = "GLC"
	m.Threshold = new(float64(10))
	m.Previous, m.Latest = new(float64(6.99)), new(float64(12.15))
	m.ReportDate, m.ComparedTo = "2026-10-16", "2026-10-15"
	m.Payload.Companies = []alertevents.Company{{Code: "GLC", Name: "Glencore", Latest: 12.15, Previous: new(float64(6.99)), Change: new(float64(5.16)), PreviousDate: "2026-10-15"}}
	m.Payload.CompaniesTotal = 1
	shares, onIssue, c20 := 1.24e9, 12.1e9, 6.3
	hist := canaryHistory(120, "2026-10-16", 12.15)
	m.Payload.Stock = &alertevents.StockDetail{
		Name: "Glencore", Industry: "Materials",
		SharesShort: &shares, SharesOnIssue: &onIssue, Rank: 12, Ranked: 640, Change20: &c20,
		Change20Date: hist[len(hist)-21].D,
		History:      hist,
	}
	return m
}

// allFixtures is every message the templates render: both scopes, each condition
// and cadence, the stock with its detail, and the canary.
func allFixtures() map[string]Message {
	out := emailFixtures()
	out["stock-with-history"] = stockWithHistory()
	out["stock-short-history"] = shortStock()
	out["canary"] = canaryMessage()
	return out
}

func renderFixture(t *testing.T, m Message) rendered {
	t.Helper()
	r, err := renderMessage(testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Rendering the same Message twice must give identical subject, HTML, text, headers,
// tags and attachment bytes. Resend dedupes a retry only when the body matches.
func TestRenderIsDeterministic(t *testing.T) {
	for name, m := range allFixtures() {
		t.Run(name, func(t *testing.T) {
			a := renderFixture(t, m)
			b := renderFixture(t, m)
			if !reflect.DeepEqual(a, b) {
				t.Fatal("two renders of the same message differ")
			}
		})
	}
}

// Every cid: reference in the HTML has an attachment with that Content-ID, and every
// inline attachment is referenced. An unmatched reference shows a broken image; an
// orphan attachment is mail that does not need to be sent.
func TestCIDReferencesMatchAttachments(t *testing.T) {
	for name, m := range allFixtures() {
		t.Run(name, func(t *testing.T) {
			r := renderFixture(t, m)
			refs := map[string]bool{}
			for _, sub := range cidRef.FindAllStringSubmatch(r.HTML, -1) {
				refs[sub[1]] = true
			}
			atts := map[string]bool{}
			for _, a := range r.Attachments {
				if a.ContentID == "" {
					t.Fatalf("attachment %s has no content id: an email attachment, not an inline image", a.Filename)
				}
				atts[a.ContentID] = true
			}
			if !reflect.DeepEqual(sortedKeys(refs), sortedKeys(atts)) {
				t.Fatalf("cid references %v do not match attachments %v", sortedKeys(refs), sortedKeys(atts))
			}
		})
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Optional parts: a stock with history gets its chart and the stats grid; an industry
// has neither; a stock without history has no chart.
func TestOptionalPartsFollowTheData(t *testing.T) {
	withHist := renderFixture(t, stockWithHistory())
	if !strings.Contains(withHist.HTML, `src="cid:chart"`) {
		t.Fatal("a stock with history must show its chart")
	}
	if !strings.Contains(withHist.HTML, "SHARES SHORT") || !strings.Contains(withHist.HTML, "MOST-SHORTED RANK") {
		t.Fatal("the stats grid must show the stock's figures")
	}

	noHist := stockWithHistory()
	noHist.Payload.Stock.History = nil
	r := renderFixture(t, noHist)
	if strings.Contains(r.HTML, "cid:chart") || len(r.Attachments) != 1 {
		t.Fatalf("no history must mean no chart and only the brand mark: %d attachments", len(r.Attachments))
	}

	ind := renderFixture(t, emailFixtures()["industry-above-daily"])
	if strings.Contains(ind.HTML, "cid:chart") || len(ind.Attachments) != 1 {
		t.Fatal("an industry alert has no chart")
	}
}

// The stats grid omits a cell whose figure is missing, and the whole grid when all
// are missing.
func TestStatsGridOmitsMissingCells(t *testing.T) {
	m := stockWithHistory()
	m.Payload.Stock.SharesShort = nil
	m.Payload.Stock.Change20 = nil
	r := renderFixture(t, m)
	if strings.Contains(r.HTML, "SHARES SHORT") || strings.Contains(r.HTML, "CHANGE SINCE") {
		t.Fatal("a missing figure must not render its cell")
	}
	if !strings.Contains(r.HTML, "SHARES ON ISSUE") || !strings.Contains(r.HTML, "MOST-SHORTED RANK") {
		t.Fatal("the cells that have data must still render")
	}

	m.Payload.Stock.SharesOnIssue = nil
	m.Payload.Stock.Rank = 0
	r = renderFixture(t, m)
	if strings.Contains(r.HTML, `class="stat-l`) {
		t.Fatal("with no stats at all the grid must be left out")
	}
}

// A company with no logo gets the monogram tile; one with a logo gets the image.
func TestMonogramWhenNoLogo(t *testing.T) {
	m := stockWithHistory()
	r := renderFixture(t, m)
	if strings.Contains(r.HTML, `src="https://`) {
		t.Fatal("no logo must mean no remote image")
	}
	if !strings.Contains(r.HTML, `class="tile"`) || !strings.Contains(r.HTML, ">GLC</td>") {
		t.Fatal("no logo must draw the monogram with the code")
	}

	m.Payload.Stock.LogoURL = "https://storage.googleapis.com/shorted-company-logos/logos/GLC_icon.png"
	r = renderFixture(t, m)
	if !strings.Contains(r.HTML, `src="https://storage.googleapis.com/shorted-company-logos/logos/GLC_icon.png"`) {
		t.Fatal("a logo must render as the remote image")
	}
	if strings.Contains(r.HTML, `class="tile"`) {
		t.Fatal("a logo must replace the monogram")
	}
}

// An industry table of 25 rows, each with a long name, stays under 60 KB, which is
// well inside the size Gmail clips at.
func TestIndustryHTMLStaysUnder60KB(t *testing.T) {
	m := emailFixtures()["industry-above-daily"]
	var cs []alertevents.Company
	for i := 0; i < 50; i++ {
		cs = append(cs, alertevents.Company{
			Code: fmt.Sprintf("C%02d", i), Name: strings.Repeat("Very Long Mining & Exploration Holdings ", 3),
			Latest: 6.12, Previous: new(float64(5.01)), Change: new(float64(1.11)), LogoURL: "https://storage.googleapis.com/shorted-company-logos/logos/x_icon.png",
		})
	}
	m.Payload = payload(cs)
	m.Payload.CompaniesTotal = 50
	r := renderFixture(t, m)
	if n := len(r.HTML); n >= 60*1024 {
		t.Fatalf("industry HTML is %d bytes, want under 60 KB", n)
	}
	if got := strings.Count(r.HTML, `alt="C`); got != emailTableRows {
		t.Fatalf("the table shows %d rows, want %d", got, emailTableRows)
	}
}

// An event written before the stock detail existed has no stock key. It must still
// render as the plain alert it was, with no chart and no stats.
func TestOldPayloadWithoutStockStillRenders(t *testing.T) {
	m := emailFixtures()["stock-above-daily"]
	if m.Payload.Stock != nil {
		t.Fatal("the fixture must predate the stock detail")
	}
	r := renderFixture(t, m)
	if !strings.Contains(r.HTML, "BHP") || !strings.Contains(r.Subject, "BHP") {
		t.Fatal("an old event must still name its stock")
	}
	if len(r.Attachments) != 1 || strings.Contains(r.HTML, "cid:chart") {
		t.Fatal("an old event has no chart")
	}
}

// The canary is the fixed fixture: it draws its chart and stats every day, so its
// attachments and cid references are exercised on every run.
func TestCanaryExercisesTheChartAndStats(t *testing.T) {
	r := renderFixture(t, canaryMessage())
	if len(r.Attachments) != 3 {
		t.Fatalf("the canary must carry the mark and both charts, got %d attachments", len(r.Attachments))
	}
	if !strings.Contains(r.HTML, "SHARES SHORT") || !strings.Contains(r.HTML, "Canary delivery check") {
		t.Fatal("the canary must render the stats and its name")
	}
	if got := len(canaryMessage().Payload.Stock.History); got != 60 {
		t.Fatalf("canary history has %d points, want 60", got)
	}
	again := canaryMessage()
	if !reflect.DeepEqual(again.Payload.Stock.History, canaryMessage().Payload.Stock.History) {
		t.Fatal("the canary history must be fixed, not random")
	}
}

// The text twin keeps the completeness of the old one for a stock: the figures, the
// stats, the provenance, the view link and the footer.
func TestTextTwinIsComplete(t *testing.T) {
	r := renderFixture(t, stockWithHistory())
	for _, want := range []string{
		"Previous: 6.99% (Thu 15 Oct 2026)",
		"Latest:   12.15% (Fri 16 Oct 2026)",
		"Change:   +5.16 pts",
		"Shares short:      1.24B",
		"Shares on issue:   12.1B",
		"Most-shorted rank: #12 of 640 (Fri 16 Oct 2026)",
		"Change since " + dayMonth(Date(stockWithHistory().Payload.Stock.Change20Date)) + ": +6.30 pts",
		"ASIC publishes positions four trading days after they are held.",
		"View GLC on Shorted:",
		"Pause this alert:",
		"Manage your alerts:",
		"General information only, not financial advice.",
	} {
		if !strings.Contains(r.Text, want) {
			t.Errorf("text twin is missing %q:\n%s", want, r.Text)
		}
	}
	if bytes.Contains([]byte(r.Text), []byte("<")) {
		t.Fatal("the plain text must carry no markup")
	}
}

func TestCompactSharesUsesThreeSignificantFigures(t *testing.T) {
	cases := map[float64]string{
		1.24e9:    "1.24B",
		12.1e9:    "12.1B",
		850_000:   "850K",
		2.5e6:     "2.50M",
		999_400:   "999K",
		999_999:   "1.00M", // 999.999K rounds up into the next unit
		0:         "0.00",
		123_456:   "123K",
		999.9e6:   "1.00B",
		9_999_999: "10.0M", // 9.999999M rounds to 10.0M
	}
	for in, want := range cases {
		if got := compactShares(in); got != want {
			t.Errorf("compactShares(%v) = %q, want %q", in, got, want)
		}
	}
}
