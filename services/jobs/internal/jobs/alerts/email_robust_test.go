package alerts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertchart"
)

// withChartHook installs hook for the duration of one test.
func withChartHook(t *testing.T, hook func(alertchart.Spec)) {
	t.Helper()
	testChartHook = hook
	t.Cleanup(func() { testChartHook = nil })
}

// A panic in the chart renderer costs the chart, not the email: the alert goes out with
// its figures and no image.
func TestChartPanicStillSendsTheEmail(t *testing.T) {
	withChartHook(t, func(alertchart.Spec) { panic("renderer fault") })
	r, err := renderMessage(testSite, testSecret, testMonID, stockWithHistory())
	if err != nil {
		t.Fatalf("a renderer panic must not fail the render: %v", err)
	}
	if strings.Contains(r.HTML, "cid:chart") || len(r.Attachments) != 1 {
		t.Fatalf("the email must go without its chart: %d attachments", len(r.Attachments))
	}
	if !strings.Contains(r.Subject, "GLC short interest crossed") || !strings.Contains(r.Text, "Previous:") {
		t.Fatal("the figures must still be in the email")
	}
}

// Owners of the same stock share one render: the memo draws the chart once, and the
// bytes match a fresh render exactly.
func TestChartMemoDrawsOnceAndMatchesAFreshRender(t *testing.T) {
	draws := 0
	withChartHook(t, func(alertchart.Spec) { draws++ })
	memo := newChartMemo()
	m := stockWithHistory()

	first, err := renderMessageCharts(memo, testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderMessageCharts(memo, testSite, testSecret, testMonID, m)
	if err != nil {
		t.Fatal(err)
	}
	if draws != 1 {
		t.Fatalf("two owners of one stock drew the chart %d times, want once", draws)
	}
	fresh := renderFixture(t, m)
	for _, r := range []rendered{first, second} {
		if r.Attachments[1].Content != fresh.Attachments[1].Content || r.Attachments[2].Content != fresh.Attachments[2].Content {
			t.Fatal("a memoised chart differs from a fresh render")
		}
	}
	if first.HTML != fresh.HTML || second.HTML != fresh.HTML {
		t.Fatal("the memo must not change the HTML")
	}
}

// Any change to the chart spec is a different key: a moved threshold, a new point or a
// different compared date each draw again.
func TestChartMemoKeyCoversTheWholeSpec(t *testing.T) {
	draws := 0
	withChartHook(t, func(alertchart.Spec) { draws++ })
	memo := newChartMemo()

	base := stockWithHistory()
	memo.get(base)
	if draws != 1 {
		t.Fatalf("first draw: %d", draws)
	}

	moved := stockWithHistory()
	t2 := 11.0
	moved.Threshold = &t2
	memo.get(moved)

	pointChanged := stockWithHistory()
	pointChanged.Payload.Stock.History[len(pointChanged.Payload.Stock.History)-2].P += 0.01
	memo.get(pointChanged)

	comparedChanged := stockWithHistory()
	comparedChanged.ComparedTo = "2026-10-14"
	memo.get(comparedChanged)

	if draws != 4 {
		t.Fatalf("four different specs must draw four times, drew %d", draws)
	}
	memo.get(base)
	if draws != 4 {
		t.Fatalf("the same spec must be served from the memo, drew %d", draws)
	}
}

// A chart that panics is not memoised, so the next owner gets a fresh attempt.
func TestChartMemoDoesNotKeepAFault(t *testing.T) {
	calls := 0
	withChartHook(t, func(alertchart.Spec) {
		calls++
		if calls == 1 {
			panic("first attempt fails")
		}
	})
	memo := newChartMemo()
	if light, _ := memo.get(stockWithHistory()); light != nil {
		t.Fatal("the faulting attempt must draw no chart")
	}
	if light, _ := memo.get(stockWithHistory()); light == nil {
		t.Fatal("the next owner must get a fresh chart, not the fault")
	}
}

// The stock email's HTML is compared with a committed golden, byte for byte. A clock,
// a locale or a map order that leaked into the markup would fail here, not in a run.
// The fixture is the preview's first stock case, so the golden is the reviewed design.
func TestStockHTMLGolden(t *testing.T) {
	cases, err := previewCases("")
	if err != nil {
		t.Fatal(err)
	}
	r := renderFixture(t, previewStock(cases[0]))
	path := filepath.Join("testdata", "stock.html.golden")
	if *updateGoldens {
		if err := os.WriteFile(path, []byte(r.HTML), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -args -update): %v", path, err)
	}
	if string(want) != r.HTML {
		t.Fatalf("the stock HTML drifted from %s; review the change and run with -args -update", path)
	}
}
