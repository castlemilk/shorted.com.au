package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Alpha Vantage does not reject an exchange suffix it does not carry: asked for
// "AMD.AX" it answers with NASDAQ's AMD. These tests pin the check that catches
// it, because the failure is invisible downstream — a price for the wrong
// company reads as a return, not as missing data.

func avServer(t *testing.T, metaSymbol string) *httptest.Server {
	t.Helper()
	body := map[string]any{
		"Meta Data": map[string]string{
			"1. Information": "Daily Prices",
			"2. Symbol":      metaSymbol,
		},
		"Time Series (Daily)": map[string]map[string]string{
			time.Now().AddDate(0, 0, -1).Format("2006-01-02"): {
				"1. open": "214.00", "2. high": "216.00", "3. low": "213.00",
				"4. close": "214.99", "5. volume": "15792558",
			},
		},
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
}

func TestAlphaVantageRejectsAResponseForADifferentSecurity(t *testing.T) {
	// Asked for AMD.AX (Arrow Minerals, ~$0.02); answered for AMD (NASDAQ, $214.99).
	srv := avServer(t, "AMD")
	defer srv.Close()
	p := newAlphaVantageForTest(srv.URL, "test-key")

	_, err := p.FetchHistoricalData(context.Background(), "AMD",
		time.Now().AddDate(0, 0, -7), time.Now())
	if err == nil {
		t.Fatal("accepted a price series for a different security")
	}
	if !strings.Contains(err.Error(), "different security") {
		t.Errorf("error should name the cause, got: %v", err)
	}
}

func TestAlphaVantageAcceptsTheSymbolItWasAskedFor(t *testing.T) {
	srv := avServer(t, "AMD.AX")
	defer srv.Close()
	p := newAlphaVantageForTest(srv.URL, "test-key")

	recs, err := p.FetchHistoricalData(context.Background(), "AMD",
		time.Now().AddDate(0, 0, -7), time.Now())
	if err != nil {
		t.Fatalf("rejected a correct response: %v", err)
	}
	if len(recs) == 0 {
		t.Fatal("no records returned for a matching symbol")
	}
}

func TestAlphaVantageMatchIsCaseInsensitive(t *testing.T) {
	srv := avServer(t, "amd.ax")
	defer srv.Close()
	p := newAlphaVantageForTest(srv.URL, "test-key")
	if _, err := p.FetchHistoricalData(context.Background(), "AMD",
		time.Now().AddDate(0, 0, -7), time.Now()); err != nil {
		t.Fatalf("case difference should not be a mismatch: %v", err)
	}
}

func TestAlphaVantageToleratesAbsentMetaData(t *testing.T) {
	// An older or trimmed payload carries no Meta Data. Absent is not proof of a
	// mismatch, so it must not become a hard failure — that would take the whole
	// provider offline on a response-shape change.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Time Series (Daily)": map[string]map[string]string{
				time.Now().AddDate(0, 0, -1).Format("2006-01-02"): {
					"1. open": "1.00", "2. high": "1.10", "3. low": "0.90",
					"4. close": "1.05", "5. volume": "1000",
				},
			},
		})
	}))
	defer srv.Close()
	p := newAlphaVantageForTest(srv.URL, "test-key")
	if _, err := p.FetchHistoricalData(context.Background(), "XYZ",
		time.Now().AddDate(0, 0, -7), time.Now()); err != nil {
		t.Fatalf("absent Meta Data must not fail the fetch: %v", err)
	}
}
