package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const companyTaxMaxCodeLength = 10

// companyTaxAttribution is rendered as the card footer. Editorial standards
// require every figure to carry source + licence attribution.
const companyTaxAttribution = "ATO Corporate Tax Transparency (data.gov.au), CC BY 3.0 AU"

// GetCompanyTaxProfile returns an ASX-listed entity's annual corporate-tax profile
// from the ATO Corporate Tax Transparency dataset. Only entities mapped to an ASX
// code by exact ABN or exact normalized name (entity_asx_map) surface here.
func (s *ShortsServer) GetCompanyTaxProfile(ctx context.Context, req *connect.Request[shortsv1alpha1.GetCompanyTaxProfileRequest]) (*connect.Response[shortsv1alpha1.GetCompanyTaxProfileResponse], error) {
	productCode := strings.ToUpper(strings.TrimSpace(req.Msg.ProductCode))
	if productCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code is required"))
	}
	if len(productCode) > companyTaxMaxCodeLength {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code must be at most %d characters", companyTaxMaxCodeLength))
	}
	for _, r := range productCode {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code must be alphanumeric"))
		}
	}

	s.logger.Debugf("company tax profile: product_code=%s", productCode)

	cacheKey := s.cache.GetCompanyTaxProfileKey(productCode)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		profile, err := s.store.GetCompanyTaxProfile(productCode)
		if err != nil {
			return nil, err
		}
		return buildCompanyTaxResponse(profile), nil
	})

	if err != nil {
		if errors.Is(err, shortsstore.ErrCompanyTaxNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no tax profile for stock: %s", productCode))
		}
		s.logger.Errorf("database error in GetCompanyTaxProfile: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get company tax profile"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetCompanyTaxProfileResponse)
	return connect.NewResponse(response), nil
}

// buildCompanyTaxResponse maps the store profile into the proto response. NULL
// taxable income / tax payable are conveyed with has_* flags so the client can
// distinguish "not reported" (nil, often legitimate) from a genuine zero.
func buildCompanyTaxResponse(profile *shortsstore.CompanyTaxProfile) *shortsv1alpha1.GetCompanyTaxProfileResponse {
	years := make([]*shortsv1alpha1.CompanyTaxYear, 0, len(profile.Years))
	for _, y := range profile.Years {
		cy := &shortsv1alpha1.CompanyTaxYear{
			IncomeYear:  y.IncomeYear,
			TotalIncome: y.TotalIncome,
		}
		if y.TaxableIncome != nil {
			cy.HasTaxableIncome = true
			cy.TaxableIncome = *y.TaxableIncome
		}
		if y.TaxPayable != nil {
			cy.HasTaxPayable = true
			cy.TaxPayable = *y.TaxPayable
		}
		years = append(years, cy)
	}

	return &shortsv1alpha1.GetCompanyTaxProfileResponse{
		EntityName:        profile.EntityName,
		Abn:               profile.ABN,
		Years:             years,
		SourceAttribution: companyTaxAttribution,
	}
}
