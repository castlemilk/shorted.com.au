package shorts

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/mock/gomock"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

// datesStore returns a fixed availability answer.
type datesStore struct {
	ShortsStore
	dates    []string
	earliest string
	latest   string
	total    int
	err      error
}

func (d *datesStore) GetAvailableDates(int, string) ([]string, string, string, int, error) {
	return d.dates, d.earliest, d.latest, d.total, d.err
}

func latestServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	logger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(logger)
	return &ShortsServer{config: DefaultConfig(), store: store, logger: logger}
}

func freshStore() *datesStore {
	return &datesStore{
		dates: []string{"2026-08-25"}, earliest: "2010-06-16", latest: "2026-08-25", total: 4091,
	}
}

// A daily engine had to poll GetAvailableDates and diff. Hourly polling costs
// ~700 requests a month against a 500-request quota to detect ~22 events,
// spending nearly all of it on "nothing has changed" (#559).
func TestLatestFeed(t *testing.T) {
	t.Run("reports the newest publication and when it became public", func(t *testing.T) {
		rec := httptest.NewRecorder()
		latestServer(t, freshStore()).LatestHandler()(rec, httptest.NewRequest(http.MethodGet, LatestPath, nil))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		var body LatestResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("not valid JSON: %v", err)
		}
		if body.LatestDate != "2026-08-25" {
			t.Errorf("latest_date = %q", body.LatestDate)
		}
		// 2026-08-25 is a Tuesday; four trading days later is Monday the 31st.
		if body.AvailableFrom != "2026-08-31" {
			t.Errorf("available_from = %q, want 2026-08-31", body.AvailableFrom)
		}
		if body.TotalDates != 4091 || body.EarliestDate != "2010-06-16" {
			t.Errorf("span fields wrong: %+v", body)
		}
		if body.PublicationLagTradingDays != 4 {
			t.Errorf("publication_lag_trading_days = %d, want 4", body.PublicationLagTradingDays)
		}
		if rec.Header().Get("ETag") == "" {
			t.Error("no ETag, so a poll cannot be made conditional — the whole point")
		}
	})

	t.Run("a matching If-None-Match is answered 304 with no body", func(t *testing.T) {
		srv := latestServer(t, freshStore())

		first := httptest.NewRecorder()
		srv.LatestHandler()(first, httptest.NewRequest(http.MethodGet, LatestPath, nil))
		etag := first.Header().Get("ETag")

		second := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, LatestPath, nil)
		req.Header.Set("If-None-Match", etag)
		srv.LatestHandler()(second, req)

		if second.Code != http.StatusNotModified {
			t.Fatalf("status = %d, want 304 (body: %s)", second.Code, second.Body.String())
		}
		if second.Body.Len() != 0 {
			t.Errorf("304 carried %d bytes; it must carry none", second.Body.Len())
		}
	})

	t.Run("the ETag changes when, and only when, the answer changes", func(t *testing.T) {
		before := httptest.NewRecorder()
		latestServer(t, freshStore()).LatestHandler()(before, httptest.NewRequest(http.MethodGet, LatestPath, nil))

		same := httptest.NewRecorder()
		latestServer(t, freshStore()).LatestHandler()(same, httptest.NewRequest(http.MethodGet, LatestPath, nil))
		if before.Header().Get("ETag") != same.Header().Get("ETag") {
			t.Error("identical state produced different ETags; every poll would re-download")
		}

		moved := freshStore()
		moved.dates = []string{"2026-08-26"}
		moved.total = 4092
		after := httptest.NewRecorder()
		latestServer(t, moved).LatestHandler()(after, httptest.NewRequest(http.MethodGet, LatestPath, nil))
		if before.Header().Get("ETag") == after.Header().Get("ETag") {
			t.Error("a new publication produced the same ETag; the poller would never notice")
		}
	})

	t.Run("a stale If-None-Match still gets the new answer", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, LatestPath, nil)
		req.Header.Set("If-None-Match", `"0000000000000000"`)
		latestServer(t, freshStore()).LatestHandler()(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("HEAD carries the ETag but no body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		latestServer(t, freshStore()).LatestHandler()(rec, httptest.NewRequest(http.MethodHead, LatestPath, nil))
		if rec.Code != http.StatusOK || rec.Header().Get("ETag") == "" {
			t.Errorf("status = %d, etag = %q", rec.Code, rec.Header().Get("ETag"))
		}
		if rec.Body.Len() != 0 {
			t.Errorf("HEAD returned %d bytes", rec.Body.Len())
		}
	})

	t.Run("a write method is refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		latestServer(t, freshStore()).LatestHandler()(rec, httptest.NewRequest(http.MethodPost, LatestPath, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", rec.Code)
		}
	})
}

// A poller sends back exactly what it was given, and clients legitimately send
// lists and weak tags. Naive string equality would 200 a client that sent a
// perfectly good tag, silently undoing the saving this endpoint provides.
func TestETagMatches(t *testing.T) {
	const tag = `"abc123"`
	cases := map[string]bool{
		`"abc123"`:              true,
		` "abc123" `:            true,
		`W/"abc123"`:            true,
		`"other", "abc123"`:     true,
		`W/"other", W/"abc123"`: true,
		`*`:                     true,
		`"other"`:               false,
		``:                      false,
		`   `:                   false,
		`"abc12"`:               false,
	}
	for header, want := range cases {
		if got := etagMatches(header, tag); got != want {
			t.Errorf("etagMatches(%q, %q) = %v, want %v", header, tag, got, want)
		}
	}
}
