package shorts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
)

// LatestPath serves a tiny, conditional-GET-friendly document describing the
// newest published panel.
const LatestPath = "/v1/latest"

// LatestResponse is deliberately small and stable: it is polled, so every byte
// and every spurious change costs someone a request.
type LatestResponse struct {
	// The newest trading date the panel holds data for.
	LatestDate string `json:"latest_date"`
	// When that observation became public. ASIC publishes T+4, so this is what
	// a caller polling for "is there new data" actually cares about.
	AvailableFrom string `json:"available_from"`
	// The oldest date held, and how many trading dates in total, so a client
	// can tell a backfill from an increment without a second call.
	EarliestDate              string `json:"earliest_date"`
	TotalDates                int    `json:"total_dates"`
	PublicationLagTradingDays int    `json:"publication_lag_trading_days"`
}

// LatestHandler answers "has a new ASIC report landed?" in one cheap request.
//
// The only way to ask before this was to poll GetAvailableDates and diff. That
// is the wrong shape for the question: the data updates about once a business
// day at an hour the caller cannot predict, and the anonymous quota is 500
// requests a month — so hourly polling burns more than the entire free quota
// to detect roughly 22 events, spending almost all of it on "nothing has
// changed". Bad for the integrator and worse for our egress.
//
// This is issue #559's option 3, chosen over a webhook because it needs no
// subscription registry, no delivery retries and no per-caller state, and
// because a conditional GET that answers 304 is about as cheap as an HTTP
// request gets. A caller who wants push can still build it on top; a caller
// who just wants to stop wasting quota is done.
func (s *ShortsServer) LatestHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writePanelError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}

		// One page of dates is enough: the store returns the newest first and
		// reports the dataset's true bounds and total alongside them.
		dates, earliest, _, total, err := s.store.GetAvailableDates(1, "")
		if err != nil || len(dates) == 0 {
			s.logger.Errorf("latest feed: %v", err)
			writePanelError(w, http.StatusInternalServerError, "could not read the latest publication")
			return
		}

		availableFrom := ""
		if t, ok := parseStoreTimestamp(dates[0]); ok {
			availableFrom = asxcalendar.AvailableFrom(t).Format("2006-01-02")
		}

		body := LatestResponse{
			LatestDate:                dates[0],
			AvailableFrom:             availableFrom,
			EarliestDate:              earliest,
			TotalDates:                total,
			PublicationLagTradingDays: asxcalendar.PublicationLagTradingDays,
		}

		// The ETag is derived from the CONTENT, so it changes exactly when the
		// answer changes and never merely because time passed. A date-derived
		// tag would look right and would churn on any field we later add.
		payload, err := json.Marshal(body)
		if err != nil {
			writePanelError(w, http.StatusInternalServerError, "could not encode the latest publication")
			return
		}
		sum := sha256.Sum256(payload)
		etag := `"` + hex.EncodeToString(sum[:16]) + `"`

		w.Header().Set("ETag", etag)
		// Short, because the value of this endpoint is that a poll is cheap,
		// not that it is rare. A caller polling hourly should get a 304 within
		// the same publication day.
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			// 304 carries no body, which is the entire point: the poll costs a
			// round trip and nothing else.
			w.WriteHeader(http.StatusNotModified)
			return
		}

		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(payload)
	}
}

// etagMatches implements the If-None-Match comparison a poller actually needs:
// a comma-separated list, "*" as a wildcard, and the weak "W/" prefix ignored.
// A naive string equality would 200 a client that sent a perfectly good tag,
// silently undoing the saving this endpoint exists to provide.
func etagMatches(ifNoneMatch, etag string) bool {
	ifNoneMatch = strings.TrimSpace(ifNoneMatch)
	if ifNoneMatch == "" {
		return false
	}
	if ifNoneMatch == "*" {
		return true
	}
	for _, candidate := range strings.Split(ifNoneMatch, ",") {
		if strings.TrimPrefix(strings.TrimSpace(candidate), "W/") == etag {
			return true
		}
	}
	return false
}
