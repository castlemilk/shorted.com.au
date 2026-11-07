package marketdata

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
)

// chainStub answers from fn and counts how often it was asked.
type chainStub struct {
	name  string
	calls int
	fn    func() ([]providers.PriceRecord, error)
}

func (c *chainStub) Name() string                { return c.name }
func (c *chainStub) GetRateLimit() time.Duration { return 0 }
func (c *chainStub) FetchHistoricalData(context.Context, string, time.Time, time.Time) ([]providers.PriceRecord, error) {
	c.calls++
	return c.fn()
}

// The historical backfill must end a provider chain on "no data", as the daily
// sweep does. Otherwise a session Yahoo has no trade for is filled from Alpha
// Vantage, which answers ASX:SLM with NASDAQ's SLM.
func TestBackfillChainStopsOnNoData(t *testing.T) {
	start := time.Date(2025, 12, 24, 0, 0, 0, 0, time.UTC)
	primary := &chainStub{name: "Yahoo Finance (Direct)", fn: func() ([]providers.PriceRecord, error) {
		return nil, providers.NewNoDataError("SLM", "yahoo: no quote data")
	}}
	fallback := &chainStub{name: "Alpha Vantage", fn: func() ([]providers.PriceRecord, error) {
		return []providers.PriceRecord{{StockCode: "SLM", Date: start, Close: 27.66}}, nil
	}}

	got := fetchPlan(context.Background(), []providers.DataProvider{primary, fallback}, "SLM",
		backfillPlan{fullFetch: true}, start, start, 0, 1)
	if len(got) != 0 {
		t.Fatalf("stored %d records from the next provider after a no-data answer", len(got))
	}
	if fallback.calls != 0 {
		t.Fatalf("the fallback was asked after the primary answered no data (%d calls)", fallback.calls)
	}
}

func TestBackfillChainFallsThroughOnAFailure(t *testing.T) {
	start := time.Date(2025, 12, 24, 0, 0, 0, 0, time.UTC)
	primary := &chainStub{name: "Yahoo Finance (Direct)", fn: func() ([]providers.PriceRecord, error) {
		return nil, errors.New("yahoo SLM.AX: HTTP 429")
	}}
	fallback := &chainStub{name: "Alpha Vantage", fn: func() ([]providers.PriceRecord, error) {
		return []providers.PriceRecord{{StockCode: "SLM", Date: start, Close: 0.04}}, nil
	}}

	got := fetchPlan(context.Background(), []providers.DataProvider{primary, fallback}, "SLM",
		backfillPlan{fullFetch: true}, start, start, 0, 1)
	if len(got) != 1 || fallback.calls != 1 {
		t.Fatalf("a failed primary must fall through: got %d records, %d fallback calls", len(got), fallback.calls)
	}
}
