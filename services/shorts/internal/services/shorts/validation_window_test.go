package shorts

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// GetStockData grew from/to and max_points without growing validation for
// them, while GetStockPrices — added in the same change — validated all three.
// Found by driving both against a running server: a malformed `from` came back
// as not_found ("stock data not found for period 1M"), blaming the stock and a
// period the caller never asked about, because the bad date reached Postgres
// and the cast error was mapped to NotFound. A negative max_points was ignored
// in silence, and a transposed window returned an empty series that looks like
// a real answer.
//
// Two endpoints taking the same three options must reject the same inputs the
// same way, or the difference is just an accident of which one was written
// second.
func TestWindowOptionsAreValidatedOnBothEndpoints(t *testing.T) {
	tests := []struct {
		name     string
		wantIn   string // substring the message must contain
		stockErr error
		priceErr error
	}{
		{
			name:   "malformed from",
			wantIn: "from",
			stockErr: ValidateGetStockDataRequest(&shortsv1alpha1.GetStockDataRequest{
				ProductCode: "BHP", From: "not-a-date"}),
			priceErr: ValidateGetStockPricesRequest(&shortsv1alpha1.GetStockPricesRequest{
				ProductCode: "BHP", From: "not-a-date"}),
		},
		{
			name:   "malformed to",
			wantIn: "to",
			stockErr: ValidateGetStockDataRequest(&shortsv1alpha1.GetStockDataRequest{
				ProductCode: "BHP", To: "soon"}),
			priceErr: ValidateGetStockPricesRequest(&shortsv1alpha1.GetStockPricesRequest{
				ProductCode: "BHP", To: "soon"}),
		},
		{
			name:   "negative max_points",
			wantIn: "max_points",
			stockErr: ValidateGetStockDataRequest(&shortsv1alpha1.GetStockDataRequest{
				ProductCode: "BHP", MaxPoints: -5}),
			priceErr: ValidateGetStockPricesRequest(&shortsv1alpha1.GetStockPricesRequest{
				ProductCode: "BHP", MaxPoints: -5}),
		},
		{
			// A transposed window is always a mistake, and returning an empty
			// series for it hands back something that looks like an answer.
			name:   "reversed window",
			wantIn: "before",
			stockErr: ValidateGetStockDataRequest(&shortsv1alpha1.GetStockDataRequest{
				ProductCode: "BHP", From: "2026-07-01", To: "2026-03-01"}),
			priceErr: ValidateGetStockPricesRequest(&shortsv1alpha1.GetStockPricesRequest{
				ProductCode: "BHP", From: "2026-07-01", To: "2026-03-01"}),
		},
	}

	for _, tc := range tests {
		for endpoint, err := range map[string]error{
			"GetStockData": tc.stockErr, "GetStockPrices": tc.priceErr,
		} {
			t.Run(tc.name+"/"+endpoint, func(t *testing.T) {
				if err == nil {
					t.Fatalf("%s accepted %s", endpoint, tc.name)
				}
				if got := connect.CodeOf(err); got != connect.CodeInvalidArgument {
					t.Errorf("code = %v, want invalid_argument — a bad request must not read as a missing stock", got)
				}
				if !strings.Contains(err.Error(), tc.wantIn) {
					t.Errorf("message %q does not mention %q", err.Error(), tc.wantIn)
				}
			})
		}
	}
}

// The valid combinations must keep working — validation that rejects real
// requests is worse than the gap it closes.
func TestWindowOptionsAcceptValidRequests(t *testing.T) {
	ok := []struct {
		name  string
		stock *shortsv1alpha1.GetStockDataRequest
		price *shortsv1alpha1.GetStockPricesRequest
	}{
		{"period only",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", Period: "1M"},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", Period: "1M"}},
		{"from only",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", From: "2020-01-01"},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", From: "2020-01-01"}},
		{"to only",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", To: "2020-01-01"},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", To: "2020-01-01"}},
		{"full window",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", From: "2020-01-01", To: "2020-12-31", MaxPoints: 100},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", From: "2020-01-01", To: "2020-12-31", MaxPoints: 100}},
		{"same day both ends",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", From: "2020-01-01", To: "2020-01-01"},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", From: "2020-01-01", To: "2020-01-01"}},
		{"zero max_points means no cap",
			&shortsv1alpha1.GetStockDataRequest{ProductCode: "BHP", MaxPoints: 0},
			&shortsv1alpha1.GetStockPricesRequest{ProductCode: "BHP", MaxPoints: 0}},
	}
	for _, tc := range ok {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateGetStockDataRequest(tc.stock); err != nil {
				t.Errorf("GetStockData rejected a valid request: %v", err)
			}
			if err := ValidateGetStockPricesRequest(tc.price); err != nil {
				t.Errorf("GetStockPrices rejected a valid request: %v", err)
			}
		})
	}
}
