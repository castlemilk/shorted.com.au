package sync

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
)

// A gap in the ASX session list is not a session for the next provider. Yahoo
// has no trade for ASX:SLM on 24 Dec 2025; asking Alpha Vantage for SLM.AX
// returned NASDAQ's SLM for that day, and it was stored as ASX:SLM.
func TestRepairGapDoesNotFillFromTheNextProviderOnNoData(t *testing.T) {
	day := time.Date(2025, 12, 24, 0, 0, 0, 0, time.UTC)
	primary := &fakeProvider{name: "Yahoo Finance (Direct)", fn: func(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
		return nil, providers.NewNoDataError("SLM", "yahoo: no quote data")
	}}
	fallback := &fakeProvider{name: "Alpha Vantage", fn: func(symbol string, from, _ time.Time) ([]providers.PriceRecord, error) {
		return []providers.PriceRecord{{StockCode: symbol, Date: from, Close: 27.66}}, nil
	}}
	// db is nil: reaching the insert would panic, so a stored row fails the test loudly.
	g := &GapDetector{providers: []providers.DataProvider{primary, fallback}}

	n, err := g.RepairGap(context.Background(), Gap{StockCode: "SLM", StartDate: day, EndDate: day, Days: 1})
	if err == nil {
		t.Fatalf("filled a no-data session from the next provider (%d rows)", n)
	}
	if len(fallback.calls) != 0 {
		t.Fatalf("the fallback was asked for a session the primary answered no data for: %v", fallback.calls)
	}
}

// A provider that fails (not "no data") still hands the gap to the next one.
func TestRepairGapFallsThroughOnAFailure(t *testing.T) {
	day := time.Date(2025, 12, 24, 0, 0, 0, 0, time.UTC)
	primary := &fakeProvider{name: "Yahoo Finance (Direct)", fn: func(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
		return nil, errors.New("yahoo SLM.AX: HTTP 429")
	}}
	fallback := &fakeProvider{name: "Alpha Vantage", fn: func(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
		return nil, providers.NewNoDataError("SLM", "alpha vantage answered for \"SLM\"")
	}}
	g := &GapDetector{providers: []providers.DataProvider{primary, fallback}}

	if _, err := g.RepairGap(context.Background(), Gap{StockCode: "SLM", StartDate: day, EndDate: day, Days: 1}); err == nil {
		t.Fatal("expected an error when no provider has the session")
	}
	if len(fallback.calls) != 1 {
		t.Fatalf("a failed primary must hand the gap to the next provider, got %d calls", len(fallback.calls))
	}
}
