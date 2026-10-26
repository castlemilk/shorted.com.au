package alerts

import (
	"flag"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

var updateGoldens = flag.Bool("update", false, "rewrite the golden email files in testdata/")

const (
	testSite   = "https://shorted.com.au"
	testSecret = "test-unsubscribe-secret"
	testMonID  = "mon-42"
)

// fixtures: the same events the golden files were rendered from.
func emailFixtures() map[string]Message {
	const (
		cad = alertevents.CadenceDaily
	)
	mk := func(scope, cond, cadence string) Message {
		return Message{Scope: scope, Condition: cond, Cadence: cadence, ReportDate: "2026-10-16", ComparedTo: "2026-10-15"}
	}
	stockAbove := mk(alertevents.ScopeStock, alertevents.ConditionShortInterestAbove, cad)
	stockAbove.Target, stockAbove.Threshold = "BHP", new(float64(5))
	stockAbove.Latest, stockAbove.Previous = new(5.42), new(4.80)
	stockAbove.Payload = payload([]alertevents.Company{{Code: "BHP", Name: "BHP Group Ltd", Latest: 5.42, Previous: new(4.80), Change: new(0.62)}})

	stockRises := mk(alertevents.ScopeStock, alertevents.ConditionShortInterestRises, cad)
	stockRises.Target, stockRises.Threshold = "BHP", new(float64(1))
	stockRises.Latest, stockRises.Previous = new(6.10), new(4.90)
	stockRises.Payload = payload([]alertevents.Company{{Code: "BHP", Name: "BHP Group Ltd", Latest: 6.10, Previous: new(4.90), Change: new(1.20)}})

	industryAbove := mk(alertevents.ScopeIndustry, alertevents.ConditionShortInterestAbove, cad)
	industryAbove.Target, industryAbove.Threshold = "Materials", new(float64(5))
	industryAbove.Payload = payload([]alertevents.Company{
		{Code: "AAA", Name: "Aaa & Co <Holdings>", Latest: 5.92, Previous: new(4.80), Change: new(1.12)},
		{Code: "EEE", Name: "Eee Resources Ltd", Latest: 5.10, Previous: new(4.99), Change: new(0.11)},
		{Code: "LTR", Name: "Lithium Texas", Latest: 5.00, Previous: new(4.10), Change: new(0.90)},
	})

	industryRises := mk(alertevents.ScopeIndustry, alertevents.ConditionShortInterestRises, cad)
	industryRises.Target, industryRises.Threshold = "Materials", new(float64(1))
	industryRises.Payload = payload([]alertevents.Company{
		{Code: "BBB", Name: "Bbb Metals", Latest: 9.00, Previous: new(5.00), Change: new(4.00)},
		{Code: "AAA", Name: "Aaa Mining", Latest: 6.00, Previous: new(4.00), Change: new(2.00)},
	})

	topTen := mk(alertevents.ScopeIndustry, alertevents.ConditionNewTopTenEntry, cad)
	topTen.Target = "Materials"
	topTen.Payload = payload([]alertevents.Company{
		{Code: "LTR", Name: "Lithium Texas", Latest: 7.20, Previous: new(3.10), Change: new(4.10), Rank: 4, PreviousRank: 0},
		{Code: "PLS", Name: "Pilbara Minerals", Latest: 6.80, Previous: new(6.00), Change: new(0.80), Rank: 7, PreviousRank: 12},
	})

	out := map[string]Message{}
	for name, m := range map[string]Message{
		"stock-above":     stockAbove,
		"stock-rises":     stockRises,
		"industry-above":  industryAbove,
		"industry-rises":  industryRises,
		"industry-topten": topTen,
	} {
		out[name+"-daily"] = m
		weekly := m
		weekly.Cadence = alertevents.CadenceWeekly
		out[name+"-weekly"] = weekly
	}
	return out
}

// TestEmailGoldens pins the subject and plain-text body of every scope, condition
// and cadence. Run with -update after an intended wording change.
func TestEmailGoldens(t *testing.T) {
	for name, m := range emailFixtures() {
		t.Run(name, func(t *testing.T) {
			r, err := renderMessage(testSite, testSecret, testMonID, m)
			if err != nil {
				t.Fatal(err)
			}
			got := "Subject: " + r.Subject + "\n\n" + r.Text
			path := filepath.Join("testdata", "email-"+name+".txt")
			if *updateGoldens {
				if err := os.MkdirAll("testdata", 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("missing golden %s (run go test -run TestEmailGoldens -update): %v", path, err)
			}
			if string(want) != got {
				t.Fatalf("golden %s differs:\n--- want\n%s\n--- got\n%s", path, want, got)
			}
		})
	}
}

func TestSubjectsAndPlurals(t *testing.T) {
	fx := emailFixtures()
	cases := map[string]string{
		"stock-above-daily":     "BHP short interest crossed 5% (now 5.42%)",
		"stock-rises-daily":     "BHP short interest up 1.20 pts to 6.10%",
		"industry-above-daily":  "Materials: 3 companies crossed 5% short interest",
		"industry-rises-daily":  "Materials: 2 companies' short interest rose 1+ pts",
		"industry-topten-daily": "Materials: LTR, PLS entered the top 10 most shorted",
		"stock-above-weekly":    "Weekly: BHP short interest crossed 5% (now 5.42%)",
	}
	for key, want := range cases {
		if got := subjectLine(fx[key]); got != want {
			t.Errorf("%s: subject %q, want %q", key, got, want)
		}
	}

	one := fx["industry-above-daily"]
	one.Payload = payload(one.Payload.Companies[:1])
	if got, want := subjectLine(one), "Materials: AAA crossed 5% short interest"; got != want {
		t.Errorf("one company: %q, want %q", got, want)
	}

	four := fx["industry-topten-daily"]
	four.Payload = payload([]alertevents.Company{
		{Code: "A1", Rank: 1}, {Code: "A2", Rank: 2}, {Code: "A3", Rank: 3}, {Code: "A4", Rank: 4},
	})
	if got, want := subjectLine(four), "Materials: 4 companies entered the top 10 most shorted"; got != want {
		t.Errorf("four entrants must not name codes: %q, want %q", got, want)
	}
}

func TestSummaryMirrorsTheWebDraft(t *testing.T) {
	fx := emailFixtures()
	if got, want := summaryLine(fx["stock-above-daily"]), "BHP - short interest above 5% - daily"; got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
	if got, want := summaryLine(fx["industry-topten-weekly"]), "Materials - new top-ten entry - weekly"; got != want {
		t.Errorf("top ten summary = %q, want %q", got, want)
	}
}

func TestHTMLTwinEscapesCompanyNames(t *testing.T) {
	r, err := renderMessage(testSite, testSecret, testMonID, emailFixtures()["industry-above-daily"])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.HTML, "Aaa & Co <Holdings>") {
		t.Fatal("company name must be escaped in HTML")
	}
	if !strings.Contains(r.HTML, "Aaa &amp; Co &lt;Holdings&gt;") {
		t.Fatalf("escaped company name missing from HTML")
	}
}

func TestTableTruncatesAtTwentyFiveAndCountsTheRest(t *testing.T) {
	m := emailFixtures()["industry-above-daily"]
	var cs []alertevents.Company
	for i := range 30 {
		cs = append(cs, alertevents.Company{Code: fmt.Sprintf("C%02d", i), Name: "Co", Latest: 6, Previous: new(float64(1)), Change: new(float64(5))})
	}
	m.Payload = payload(cs)
	r, err := renderMessage(testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.Text, "… and 5 more: "+testSite+"/industry/materials?utm_source=alerts&utm_medium=email") {
		t.Fatalf("truncation line missing:\n%s", r.Text)
	}
	if strings.Contains(r.Text, "C25 ") {
		t.Fatal("the 26th company must not be listed")
	}
}

func TestTruncationCountsStoredAndUnstoredCompanies(t *testing.T) {
	m := emailFixtures()["industry-above-daily"]
	var cs []alertevents.Company
	for i := range 50 {
		cs = append(cs, alertevents.Company{Code: fmt.Sprintf("C%02d", i), Name: "Co", Latest: 6, Previous: new(float64(1)), Change: new(float64(5))})
	}
	m.Payload = alertevents.Payload{Companies: cs, CompaniesTotal: 60}
	r, err := renderMessage(testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.Text, "… and 35 more:") {
		t.Fatalf("the email must count the companies the payload did not keep:\n%s", r.Text)
	}
}

func TestPauseTokenAndHeaders(t *testing.T) {
	r, err := renderMessage(testSite, testSecret, testMonID, emailFixtures()["stock-above-daily"])
	if err != nil {
		t.Fatal(err)
	}
	oneClick := r.Headers["List-Unsubscribe"]
	if !strings.HasPrefix(oneClick, "<"+testSite+"/api/alerts/unsubscribe?t=") || !strings.HasSuffix(oneClick, ">") {
		t.Fatalf("List-Unsubscribe = %q", oneClick)
	}
	if got := r.Headers["List-Unsubscribe-Post"]; got != "List-Unsubscribe=One-Click" {
		t.Fatalf("List-Unsubscribe-Post = %q", got)
	}
	token := strings.TrimSuffix(strings.TrimPrefix(oneClick, "<"+testSite+"/api/alerts/unsubscribe?t="), ">")
	id, ok := unsubscribe.ParseAlertMonitorToken(token, testSecret)
	if !ok || id != testMonID {
		t.Fatalf("the list-unsubscribe token must pause %s, got %q ok=%v", testMonID, id, ok)
	}
	if !strings.Contains(r.Text, "Pause this alert: "+testSite+"/alerts/unsubscribe?t="+token) {
		t.Fatal("the text body must carry the same pause token")
	}
	if !strings.Contains(r.HTML, testSite+"/alerts/unsubscribe?t=") {
		t.Fatal("the HTML body must carry the pause link")
	}
}

func TestTagsCarryCategoryAndCadence(t *testing.T) {
	r, err := renderMessage(testSite, testSecret, testMonID, emailFixtures()["stock-above-weekly"])
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, tag := range r.Tags {
		seen[tag.Name] = tag.Value
	}
	if seen["category"] != "alert" || seen["cadence"] != "weekly" {
		t.Fatalf("tags = %v", seen)
	}
}

func TestCanaryFixtureIsTheTestTicker(t *testing.T) {
	r, err := renderMessage(testSite, testSecret, canaryMonitorID, canaryMessage())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.Subject, "TEST short interest crossed") {
		t.Fatalf("canary subject = %q", r.Subject)
	}
}

// A figure that came from an earlier report than the compared one carries that report's
// date. The intro still names the compared report, so the lookback reading is never
// attributed to it.
func TestLookbackFiguresAreLabelledWithTheirOwnDate(t *testing.T) {
	m := Message{
		Scope:      alertevents.ScopeIndustry,
		Target:     "Materials",
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  new(float64(5)),
		ReportDate: "2026-10-16",
		ComparedTo: "2026-10-15",
		Payload: alertevents.Payload{
			Companies: []alertevents.Company{
				{Code: "LTR", Name: "Lithium Texas", Latest: 5.4, Previous: new(4.1), Change: new(1.3), PreviousDate: "2026-10-14"},
				{Code: "PLS", Name: "Pilbara", Latest: 5.6, Previous: new(4.4), Change: new(1.2), PreviousDate: "2026-10-15"},
			},
			CompaniesTotal: 2,
		},
	}
	r, err := renderMessage("https://shorted.com.au", "secret", "m1", m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.Text, "4.10% (Wed 14 Oct 2026)") {
		t.Fatalf("the lookback figure must carry its own report date:\n%s", r.Text)
	}
	if strings.Contains(r.Text, "4.40% (") {
		t.Fatalf("a figure from the compared report needs no date of its own:\n%s", r.Text)
	}
	if !strings.Contains(r.Text, "compared with Thu 15 Oct 2026") {
		t.Fatalf("the intro must still name the compared report:\n%s", r.Text)
	}
	// The HTML sets the short date on its own line under the figure.
	if !strings.Contains(r.HTML, "4.10%") || !strings.Contains(r.HTML, ">14 Oct<") {
		t.Fatal("the HTML twin must carry the figure and its own short report date")
	}
}

// An industry alert says that every company was checked, and that the email lists those
// that triggered. A stock alert watches one code, so it has no such line.
func TestIndustryEmailsSayEveryCompanyWasChecked(t *testing.T) {
	for _, tc := range []struct {
		condition string
		want      string
	}{
		{alertevents.ConditionShortInterestAbove, "Every company in Materials was checked. This lists each one that crossed 5% short interest."},
		{alertevents.ConditionShortInterestRises, "Every company in Materials was checked. This lists each one whose short interest rose by at least 1 pts."},
		{alertevents.ConditionNewTopTenEntry, "Every company in Materials was ranked. This lists each one that entered the industry's top ten."},
	} {
		m := Message{Scope: alertevents.ScopeIndustry, Target: "Materials", Condition: tc.condition, Cadence: alertevents.CadenceDaily,
			Threshold: new(float64(5)), ReportDate: "2026-10-16", ComparedTo: "2026-10-15",
			Payload: alertevents.Payload{Companies: []alertevents.Company{{Code: "AAA", Latest: 6}}, CompaniesTotal: 1}}
		if tc.condition == alertevents.ConditionShortInterestRises {
			m.Threshold = new(float64(1))
		}
		if tc.condition == alertevents.ConditionNewTopTenEntry {
			m.Threshold = nil
		}
		r, err := renderMessage("https://shorted.com.au", "secret", "m1", m)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(r.Text, tc.want) {
			t.Fatalf("%s: text must say every company was checked (want %q):\n%s", tc.condition, tc.want, r.Text)
		}
		if !strings.Contains(r.HTML, html.EscapeString(tc.want)) {
			t.Fatalf("%s: HTML must say every company was checked", tc.condition)
		}
	}

	stock := Message{Scope: alertevents.ScopeStock, Target: "BHP", Condition: alertevents.ConditionShortInterestAbove, Cadence: alertevents.CadenceDaily,
		Threshold: new(float64(5)), ReportDate: "2026-10-16", ComparedTo: "2026-10-15", Latest: new(5.4), Previous: new(4.8),
		Payload: alertevents.Payload{Companies: []alertevents.Company{{Code: "BHP", Latest: 5.4}}, CompaniesTotal: 1}}
	r, err := renderMessage("https://shorted.com.au", "secret", "m1", stock)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.Text, "Every company") {
		t.Fatal("a stock alert watches one code and must not say every company was checked")
	}
}
