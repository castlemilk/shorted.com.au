package absdata

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestColIndex(t *testing.T) {
	idx := ColIndex([]string{"DATAFLOW", "REGION: Region", "TIME_PERIOD: Time", "OBS_VALUE"})
	if idx["REGION"] != 1 || idx["OBS_VALUE"] != 3 {
		t.Fatalf("unexpected index map: %#v", idx)
	}
}

func TestCodeLabel(t *testing.T) {
	if Code("1: New South Wales") != "1" {
		t.Fatalf("Code failed")
	}
	if Label("1: New South Wales") != "New South Wales" {
		t.Fatalf("Label failed")
	}
	if Code("plain") != "plain" {
		t.Fatalf("Code passthrough failed")
	}
}

func TestApplyMult(t *testing.T) {
	if got := ApplyMult(5, "6: Millions"); got != 5e6 {
		t.Fatalf("ApplyMult = %v, want 5e6", got)
	}
	if got := ApplyMult(5, ""); got != 5 {
		t.Fatalf("ApplyMult empty = %v, want 5", got)
	}
}

func TestPeriodDate(t *testing.T) {
	cases := []struct {
		in       string
		wantDate string
		wantFreq string
		ok       bool
	}{
		{"2024", "2024-01-01", "annual", true},
		{"2024-Q3", "2024-07-01", "quarterly", true},
		{"2024-05", "2024-05-01", "monthly", true},
		{"garbage", "", "", false},
	}
	for _, c := range cases {
		d, freq, ok := PeriodDate(c.in)
		if ok != c.ok {
			t.Fatalf("%s: ok=%v want %v", c.in, ok, c.ok)
		}
		if ok && (d.Format("2006-01-02") != c.wantDate || freq != c.wantFreq) {
			t.Fatalf("%s: got %s/%s want %s/%s", c.in, d.Format("2006-01-02"), freq, c.wantDate, c.wantFreq)
		}
	}
}

func TestFindRBASeries(t *testing.T) {
	rows := [][]string{
		{"F1.1 Interest Rates"},
		{"Series ID", "FIRMMCRT", "FOOBAR"},
		{"04/06/2025", "3.85", "1.0"},
	}
	col, start, ok := FindRBASeries(rows, "FIRMMCRT")
	if !ok || col != 1 || start != 2 {
		t.Fatalf("FindRBASeries = %d,%d,%v", col, start, ok)
	}
	if _, _, ok := FindRBASeries(rows, "MISSING"); ok {
		t.Fatalf("expected miss")
	}
}

func TestParseRBADate(t *testing.T) {
	d, ok := ParseRBADate("04/06/2025")
	if !ok || !d.Equal(time.Date(2025, 6, 4, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("ParseRBADate slash form failed: %v %v", d, ok)
	}
	if _, ok := ParseRBADate("Jun-2025"); !ok {
		t.Fatalf("Mon-YYYY form failed")
	}
}

// A missing dataflow is a 404 the caller can recognise without matching text —
// the council collector probes for next year's flow and must tell "not
// published yet" from a real failure — while the message keeps its wording.
func TestFetchSDMXCSVStatusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "MISSING") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("Could not find Dataflow"))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()
	c := (&Client{http: srv.Client(), attempts: 1, backoff: time.Millisecond}).WithBaseURL(srv.URL + "/")

	_, err := c.FetchSDMXCSV(context.Background(), "MISSING_FLOW", "all", "2025")
	if !IsNotFound(err) {
		t.Fatalf("IsNotFound(%v) = false, want true", err)
	}
	if want := "ABS MISSING_FLOW/all: HTTP 404: Could not find Dataflow"; err.Error() != want {
		t.Errorf("message = %q, want %q", err.Error(), want)
	}
	_, err = c.FetchSDMXCSV(context.Background(), "BAD_FLOW", "all", "2025")
	if err == nil || IsNotFound(err) {
		t.Errorf("a 400 must be an error but not a not-found: %v", err)
	}
	if IsNotFound(fmt.Errorf("wrapped: %w", &StatusError{Status: http.StatusNotFound})) != true {
		t.Error("IsNotFound must see through wrapping")
	}
}
