package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrCompanyTaxNotFound signals that a product code has no ABN→ASX mapping, or the
// mapped entity has no rows in the ATO corporate-tax dataset.
var ErrCompanyTaxNotFound = errors.New("no corporate tax profile for stock")

// CompanyTaxYearRow is one income year of ATO corporate-tax data. TaxableIncome
// and TaxPayable are pointers because a NULL (not reported / nil) is meaningful
// and must be distinguished from a genuine 0 in the UI.
type CompanyTaxYearRow struct {
	IncomeYear    int32
	TotalIncome   float64
	TaxableIncome *float64
	TaxPayable    *float64
}

// CompanyTaxProfile is an ASX-listed entity's multi-year corporate-tax profile.
type CompanyTaxProfile struct {
	EntityName string
	ABN        string
	Years      []CompanyTaxYearRow
}

// GetCompanyTaxProfile resolves a product code to its mapped ABN (highest-confidence
// mapping) and returns that entity's ATO corporate-tax years, oldest first.
// Returns ErrCompanyTaxNotFound when there is no mapping or no tax rows.
func (s *postgresStore) GetCompanyTaxProfile(productCode string) (*CompanyTaxProfile, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const query = `
		WITH picked AS (
			SELECT abn, COALESCE(entity_name, '') AS entity_name
			FROM entity_asx_map
			WHERE upper(stock_code) = $1
			ORDER BY confidence DESC, abn
			LIMIT 1
		)
		SELECT p.entity_name, p.abn,
		       ct.income_year,
		       COALESCE(ct.total_income, 0)::double precision,
		       ct.taxable_income::double precision,
		       ct.tax_payable::double precision
		FROM picked p
		JOIN corporate_tax ct ON ct.abn = p.abn
		ORDER BY ct.income_year
	`

	rows, err := s.db.Query(ctx, query, productCode)
	if err != nil {
		return nil, fmt.Errorf("failed to query company tax profile: %w", err)
	}
	defer rows.Close()

	profile := &CompanyTaxProfile{}
	for rows.Next() {
		var (
			year       int32
			total      float64
			taxable    *float64
			taxPayable *float64
		)
		if err := rows.Scan(&profile.EntityName, &profile.ABN, &year, &total, &taxable, &taxPayable); err != nil {
			return nil, fmt.Errorf("failed to scan company tax row: %w", err)
		}
		profile.Years = append(profile.Years, CompanyTaxYearRow{
			IncomeYear:    year,
			TotalIncome:   total,
			TaxableIncome: taxable,
			TaxPayable:    taxPayable,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating company tax rows: %w", err)
	}
	if len(profile.Years) == 0 {
		return nil, ErrCompanyTaxNotFound
	}
	return profile, nil
}
