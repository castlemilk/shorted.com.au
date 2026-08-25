package shorts

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The cache key is derived from the filters, so codes must be normalized
// before the key is built or "bhp" and "BHP" cache separately.
func TestSetDefaultValues_ScreenStocksNormalizesProductCodes(t *testing.T) {
	req := &shortsv1alpha1.ScreenStocksRequest{
		Filters: &shortsv1alpha1.ScreenerFilters{
			ProductCodes: []string{" pls ", "min", "PLS", ""},
		},
	}

	SetDefaultValues(req)

	assert.Equal(t, []string{"PLS", "MIN"}, req.Filters.ProductCodes)
	assert.Equal(t, int32(50), req.Limit)
}

func TestSetDefaultValues_ScreenStocksLeavesEmptyProductCodesAlone(t *testing.T) {
	req := &shortsv1alpha1.ScreenStocksRequest{
		Filters: &shortsv1alpha1.ScreenerFilters{},
	}

	SetDefaultValues(req)

	assert.Empty(t, req.Filters.ProductCodes)
}

func TestValidateScreenStocksRequest_ProductCodes(t *testing.T) {
	overCap := make([]string, shortsstore.MaxScreenerProductCodes+1)
	for i := range overCap {
		overCap[i] = "ABC"
	}
	atCap := make([]string, shortsstore.MaxScreenerProductCodes)
	for i := range atCap {
		atCap[i] = "ABC"
	}

	tests := []struct {
		name        string
		filters     *shortsv1alpha1.ScreenerFilters
		expectError bool
	}{
		{name: "no filters", filters: nil},
		{name: "empty product codes", filters: &shortsv1alpha1.ScreenerFilters{}},
		{name: "a handful of codes", filters: &shortsv1alpha1.ScreenerFilters{ProductCodes: []string{"PLS", "MIN", "LTR"}}},
		{name: "at the cap", filters: &shortsv1alpha1.ScreenerFilters{ProductCodes: atCap}},
		{name: "over the cap", filters: &shortsv1alpha1.ScreenerFilters{ProductCodes: overCap}, expectError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateScreenStocksRequest(&shortsv1alpha1.ScreenStocksRequest{
				Filters: tt.filters,
				Limit:   50,
			})
			if tt.expectError {
				require.Error(t, err)
				assert.Contains(t, err.Error(), "product_codes")
				return
			}
			assert.NoError(t, err)
		})
	}
}
