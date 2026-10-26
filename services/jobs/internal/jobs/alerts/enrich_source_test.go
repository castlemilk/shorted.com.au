package alerts

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// fakeSource is an enrichSource whose reads succeed or fail as the test sets.
type fakeSource struct {
	hist     map[string][]historyRow
	histErr  error
	deferred map[string]bool
	defErr   error
	histCall int
}

func (f *fakeSource) loadStockHistory(_ context.Context, _ []string, _ Date) (map[string][]historyRow, error) {
	f.histCall++
	return f.hist, f.histErr
}

func (f *fakeSource) deferredCodes(_ context.Context, _ Date) (map[string]bool, error) {
	return f.deferred, f.defErr
}

// firingStock is a stock candidate on 16 Oct for code AAA, with a companies payload.
func firingStock() Candidate {
	latest, prev, thr := 12.15, 6.99, 10.0
	return Candidate{
		Monitor: Monitor{
			ID: "m1", Scope: alertevents.ScopeStock, Target: "AAA",
			Condition: alertevents.ConditionShortInterestAbove, Cadence: alertevents.CadenceDaily,
			Threshold: &thr,
		},
		ReportDate: "2026-10-16",
		ComparedTo: "2026-10-15",
		Latest:     &latest,
		Previous:   &prev,
		Payload: alertevents.Payload{
			Companies:      []alertevents.Company{{Code: "AAA", Name: "Aaa Ltd", Latest: latest, Previous: &prev}},
			CompaniesTotal: 1,
		},
	}
}

// When the history read fails, the event goes out without its stock detail, and its
// figures are untouched. The alert is still built, so the email is still sent.
func TestEnrichmentFailureKeepsTheAlert(t *testing.T) {
	src := &fakeSource{histErr: errors.New("connection reset")}
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 12.15}}, nil)
	cands := []Candidate{firingStock()}

	enrichFrom(context.Background(), src, cands, snap, map[string]CompanyInfo{"AAA": {Name: "Aaa Ltd", LogoURL: "https://logos.test/a.png"}})

	if cands[0].Payload.Stock != nil {
		t.Fatal("a failed history read must leave the stock detail nil")
	}
	if len(cands[0].Payload.Companies) != 1 || cands[0].Payload.Companies[0].Latest != 12.15 {
		t.Fatalf("the figures must survive a failed enrichment: %+v", cands[0].Payload)
	}
	if cands[0].Payload.Companies[0].LogoURL != "https://logos.test/a.png" {
		t.Fatal("the logo is read from metadata, not the history, and must still be filled")
	}
	r, err := renderMessage(testSite, testSecret, testMonID, messageOf(cands[0]))
	if err != nil {
		t.Fatalf("the alert must still render: %v", err)
	}
	if !strings.Contains(r.Subject, "AAA short interest crossed") {
		t.Fatalf("the alert subject is missing: %q", r.Subject)
	}
	if strings.Contains(r.HTML, "cid:chart") {
		t.Fatal("no history means no chart")
	}
}

// A failed DEFERRED read leaves the rank counting every code, and does not drop the
// detail: the history read is independent of it.
func TestRankSurvivesADeferredReadFailure(t *testing.T) {
	src := &fakeSource{
		hist:   map[string][]historyRow{"AAA": dates(25, "2026-10-16")},
		defErr: errors.New("read deferred products failed"),
	}
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{"2026-10-16": {"AAA": 5, "BBB": 9}}, nil)
	cands := []Candidate{firingStock()}
	enrichFrom(context.Background(), src, cands, snap, nil)
	if cands[0].Payload.Stock == nil {
		t.Fatal("a failed DEFERRED read must not drop the stock detail")
	}
	if got := cands[0].Payload.Stock.Ranked; got != 2 {
		t.Fatalf("with the exclusion unavailable every code counts: ranked %d, want 2", got)
	}
}

// DEFERRED product lines are left out of the rank and of the count it is out of.
func TestRankExcludesDeferredProducts(t *testing.T) {
	src := &fakeSource{
		hist:     map[string][]historyRow{"AAA": dates(25, "2026-10-16")},
		deferred: map[string]bool{"ZZZ": true},
	}
	snap := NewSnapshot([]Date{"2026-10-16"}, map[Date]map[string]float64{
		"2026-10-16": {"AAA": 5, "BBB": 9, "ZZZ": 20},
	}, nil)
	cands := []Candidate{firingStock()}
	enrichFrom(context.Background(), src, cands, snap, nil)
	d := cands[0].Payload.Stock
	if d == nil {
		t.Fatal("expected a stock detail")
	}
	if d.Rank != 2 || d.Ranked != 2 {
		t.Fatalf("rank %d of %d, want 2 of 2: ZZZ is a DEFERRED product and is not ranked", d.Rank, d.Ranked)
	}
}

// The change label names the day the change is measured from, and a change with no
// such day is left out rather than labelled with a span it cannot name.
func TestChangeCellNamesItsDayOrIsOmitted(t *testing.T) {
	m := stockWithHistory()
	got := statsOf(m)
	var found bool
	for _, c := range got {
		if strings.HasPrefix(c.Label, "CHANGE SINCE ") {
			found = true
			if !strings.Contains(c.Label, strings.ToUpper(dayMonth(Date(m.Payload.Stock.Change20Date)))) {
				t.Fatalf("label %q does not name %s", c.Label, m.Payload.Stock.Change20Date)
			}
		}
	}
	if !found {
		t.Fatal("a change with its day must render its cell")
	}
	m.Payload.Stock.Change20Date = ""
	for _, c := range statsOf(m) {
		if strings.HasPrefix(c.Label, "CHANGE") {
			t.Fatalf("a change without its day must be omitted, got %q", c.Label)
		}
	}
}
