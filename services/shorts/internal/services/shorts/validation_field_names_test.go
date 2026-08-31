package shorts

import (
	"strings"
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// An integrator could not call GetStockNews at all (issue #539): the request
// field is stock_code, but every validation error named "product code", so they
// tried productCode, product_code, code, symbol and ticker — all rejected with
// the same message — and concluded the endpoint was auth-gated behind a
// misleading 400. An error must name the field the caller actually has to set.
func TestValidationErrorsNameTheRequestsOwnField(t *testing.T) {
	tests := []struct {
		name  string
		call  func() error
		field string
	}{
		{"GetStock", func() error {
			return ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{})
		}, "product_code"},
		{"GetStockData", func() error {
			return ValidateGetStockDataRequest(&shortsv1alpha1.GetStockDataRequest{})
		}, "product_code"},
		{"GetStockDetails", func() error {
			return ValidateGetStockDetailsRequest(&shortsv1alpha1.GetStockDetailsRequest{})
		}, "product_code"},
		{"GetStockNews", func() error {
			return ValidateGetStockNewsRequest(&shortsv1alpha1.GetStockNewsRequest{})
		}, "stock_code"},
		{"GetDirectorTrades", func() error {
			return ValidateGetDirectorTradesRequest(&shortsv1alpha1.GetDirectorTradesRequest{})
		}, "stock_code"},
		{"GetDividendHistory", func() error {
			return ValidateGetDividendHistoryRequest(&shortsv1alpha1.GetDividendHistoryRequest{})
		}, "stock_code"},
		{"GetPeerComparison", func() error {
			return ValidateGetPeerComparisonRequest(&shortsv1alpha1.GetPeerComparisonRequest{})
		}, "stock_code"},
	}

	// The wrong name, spelled the way the old message did.
	wrong := map[string]string{"product_code": "stock code", "stock_code": "product code"}

	for _, tc := range tests {
		t.Run(tc.name+"/missing", func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected an error for an empty code")
			}
			msg := err.Error()
			if !strings.Contains(msg, tc.field) {
				t.Errorf("error does not name the request field %q: %s", tc.field, msg)
			}
			if strings.Contains(msg, wrong[tc.field]) {
				t.Errorf("error names a field this request does not have (%q): %s", wrong[tc.field], msg)
			}
		})
	}

	// The format error has to name the right field too — it is the one a caller
	// hits after they have found the correct spelling.
	t.Run("GetStockNews/malformed names stock_code", func(t *testing.T) {
		err := ValidateGetStockNewsRequest(&shortsv1alpha1.GetStockNewsRequest{StockCode: "TOOLONG"})
		if err == nil {
			t.Fatal("expected an error for a malformed code")
		}
		if !strings.Contains(err.Error(), "stock_code") {
			t.Errorf("format error does not name stock_code: %s", err)
		}
	})
}
