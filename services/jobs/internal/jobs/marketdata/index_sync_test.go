package marketdata

import (
	"strings"
	"testing"
	"time"
)

func chartJSON(body string) []byte { return []byte(body) }

// A well-formed two-session response.
const twoSessions = `{"chart":{"result":[{"meta":{"symbol":"^AXJO","currency":"AUD"},
 "timestamp":[1693440000,1693526400],
 "indicators":{"quote":[{"open":[7300.1,7310.2],"high":[7320.5,7330.6],
 "low":[7290.0,7300.1],"close":[7310.4,7325.9],"volume":[1000,2000]}]}}],"error":null}}`

func TestParseIndexChart(t *testing.T) {
	bars, currency, err := parseIndexChart(chartJSON(twoSessions))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if currency != "AUD" {
		t.Errorf("currency = %q, want AUD", currency)
	}
	if len(bars) != 2 {
		t.Fatalf("got %d bars, want 2", len(bars))
	}
	if got := bars[0].Date.Format("2006-01-02"); got != "2023-08-31" {
		t.Errorf("first date = %s", got)
	}
	if *bars[1].Close != 7325.9 {
		t.Errorf("second close = %v", *bars[1].Close)
	}
	if *bars[0].Volume != 1000 {
		t.Errorf("first volume = %v", *bars[0].Volume)
	}
}

// A session with no close is DROPPED, never stored as zero. An index level of 0
// is not a quiet gap — it is a 100% drawdown, and any return computed across it
// is catastrophically wrong in a way that looks like data rather than an error.
func TestParseIndexChartDropsSessionsWithNoClose(t *testing.T) {
	const withHole = `{"chart":{"result":[{"meta":{"symbol":"^AXJO","currency":"AUD"},
	 "timestamp":[1693440000,1693526400,1693612800],
	 "indicators":{"quote":[{"open":[7300.1,null,7320.0],"high":[7320.5,null,7340.0],
	 "low":[7290.0,null,7310.0],"close":[7310.4,null,7335.0],"volume":[1000,null,3000]}]}}],"error":null}}`

	bars, _, err := parseIndexChart(chartJSON(withHole))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(bars) != 2 {
		t.Fatalf("got %d bars, want the 2 sessions that have a close", len(bars))
	}
	for _, b := range bars {
		if b.Close == nil || *b.Close == 0 {
			t.Errorf("a bar survived with no usable close: %+v", b)
		}
	}
}

// XJT only exists from 2019, so a longer window legitimately errors for it
// while every other series succeeds. That must surface as an error the caller
// can skip past, not as an empty-but-successful series that would silently
// leave a benchmark unpopulated.
func TestParseIndexChartSurfacesUpstreamErrors(t *testing.T) {
	const upstreamErr = `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`
	_, _, err := parseIndexChart(chartJSON(upstreamErr))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "Not Found") {
		t.Errorf("error should carry the upstream code, got: %v", err)
	}
}

func TestParseIndexChartRejectsGarbage(t *testing.T) {
	for _, body := range []string{``, `not json`, `{}`, `{"chart":{"result":[]}}`} {
		if _, _, err := parseIndexChart(chartJSON(body)); err == nil {
			t.Errorf("parseIndexChart(%q) returned no error", body)
		}
	}
}

// A result with no quote block is empty, not an error: the symbol resolved and
// simply has no sessions in the window.
func TestParseIndexChartHandlesAnEmptyWindow(t *testing.T) {
	const empty = `{"chart":{"result":[{"meta":{"symbol":"^AXJT","currency":"AUD"},"timestamp":[],"indicators":{"quote":[]}}],"error":null}}`
	bars, currency, err := parseIndexChart(chartJSON(empty))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(bars) != 0 {
		t.Errorf("got %d bars, want none", len(bars))
	}
	if currency != "AUD" {
		t.Errorf("currency = %q", currency)
	}
}

// The URL has to carry an explicit window: range=max silently returns MONTHLY
// data (406 points for 34 years), which would look like a successful daily sync
// and quietly leave the series unusable for anything daily.
func TestIndexChartURLRequestsAnExplicitDailyWindow(t *testing.T) {
	from := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	got := indexChartURL("^AXJO", from, to)

	for _, want := range []string{"interval=1d", "period1=1672531200", "period2=1704067200"} {
		if !strings.Contains(got, want) {
			t.Errorf("URL %q is missing %q", got, want)
		}
	}
	if strings.Contains(got, "range=") {
		t.Error("URL uses range=, which returns monthly data for long windows")
	}
	if !strings.Contains(got, "%5EAXJO") {
		t.Errorf("the ^ in the symbol must be escaped, got %q", got)
	}
}
