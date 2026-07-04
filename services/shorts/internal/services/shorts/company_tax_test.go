package shorts

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func f64(v float64) *float64 { return &v }

func TestGetCompanyTaxProfile_HappyPathMapsYearsAndNulls(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// Lowercase + whitespace input proves the handler normalizes before the store call.
	mockStore.EXPECT().
		GetCompanyTaxProfile("BHP").
		Return(&shortsstore.CompanyTaxProfile{
			EntityName: "BHP GROUP LIMITED",
			ABN:        "49004028077",
			Years: []shortsstore.CompanyTaxYearRow{
				// Year with full data.
				{IncomeYear: 2023, TotalIncome: 8.5e10, TaxableIncome: f64(4.2e10), TaxPayable: f64(1.2e10)},
				// Year with NULL taxable income + NULL tax payable (meaningful, not zero).
				{IncomeYear: 2024, TotalIncome: 7.9e10, TaxableIncome: nil, TaxPayable: nil},
			},
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetCompanyTaxProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCompanyTaxProfileRequest{
		ProductCode: " bhp ",
	}))

	require.NoError(t, err)
	assert.Equal(t, "BHP GROUP LIMITED", resp.Msg.EntityName)
	assert.Equal(t, "49004028077", resp.Msg.Abn)
	assert.Equal(t, "ATO Corporate Tax Transparency (data.gov.au), CC BY 3.0 AU", resp.Msg.SourceAttribution)
	require.Len(t, resp.Msg.Years, 2)

	full := resp.Msg.Years[0]
	assert.Equal(t, int32(2023), full.IncomeYear)
	assert.InDelta(t, 8.5e10, full.TotalIncome, 1)
	assert.True(t, full.HasTaxableIncome)
	assert.InDelta(t, 4.2e10, full.TaxableIncome, 1)
	assert.True(t, full.HasTaxPayable)
	assert.InDelta(t, 1.2e10, full.TaxPayable, 1)

	nilYear := resp.Msg.Years[1]
	assert.Equal(t, int32(2024), nilYear.IncomeYear)
	assert.InDelta(t, 7.9e10, nilYear.TotalIncome, 1)
	// NULL taxable income / tax payable must be signalled via has_* = false, and the
	// value left at zero — the client must not treat it as a genuine $0.
	assert.False(t, nilYear.HasTaxableIncome)
	assert.Equal(t, float64(0), nilYear.TaxableIncome)
	assert.False(t, nilYear.HasTaxPayable)
	assert.Equal(t, float64(0), nilYear.TaxPayable)
}

func TestGetCompanyTaxProfile_RejectsInvalidProductCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// The store must never be called for invalid requests.
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	for _, tc := range []struct {
		name string
		code string
	}{
		{"empty", ""},
		{"whitespace only", "   "},
		{"too long", "ABCDEFGHIJK"},
		{"non-alphanumeric", "BHP;DROP"},
		{"sql-ish", "BHP'--"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetCompanyTaxProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCompanyTaxProfileRequest{
				ProductCode: tc.code,
			}))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestGetCompanyTaxProfile_UnmappedStockReturnsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetCompanyTaxProfile("ZZZ").
		Return(nil, shortsstore.ErrCompanyTaxNotFound)

	srv := newTestServer(t, mockStore)
	_, err := srv.GetCompanyTaxProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCompanyTaxProfileRequest{
		ProductCode: "ZZZ",
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestGetCompanyTaxProfile_StoreErrorReturnsInternalWithoutLeaking(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetCompanyTaxProfile("BHP").
		Return(nil, errors.New("pq: connection refused to host db-internal-1"))

	srv := newTestServer(t, mockStore)
	_, err := srv.GetCompanyTaxProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCompanyTaxProfileRequest{
		ProductCode: "BHP",
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	// The raw DB error must not leak to clients.
	assert.NotContains(t, err.Error(), "db-internal-1")
	assert.Contains(t, err.Error(), "failed to get company tax profile")
}
