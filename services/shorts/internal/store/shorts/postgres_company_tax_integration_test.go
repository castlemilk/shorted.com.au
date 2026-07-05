//go:build integration

package shorts

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetCompanyTaxProfile_IntegrationResolvesMappedEntityAndNullTax(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	ctx := context.Background()
	migrationSQL, err := os.ReadFile("../../../../migrations/000071_add_corporate_tax.up.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(migrationSQL))
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO entity_asx_map (abn, stock_code, entity_name, match_method, confidence)
		VALUES
			('11111111111', 'BHP', 'LOW CONFIDENCE BHP ENTITY', 'name_exact', 0.5),
			('49004028077', 'BHP', 'BHP GROUP LIMITED', 'name_exact', 1.0);

		INSERT INTO corporate_tax
			(abn, entity_name, income_year, total_income, taxable_income, tax_payable)
		VALUES
			('11111111111', 'LOW CONFIDENCE BHP ENTITY', 2024, 1, 1, 1),
			('49004028077', 'BHP GROUP LIMITED', 2023, 85000000000, 42000000000, 0),
			('49004028077', 'BHP GROUP LIMITED', 2024, 79000000000, NULL, NULL);
	`)
	require.NoError(t, err)

	store := &postgresStore{db: pool}
	profile, err := store.GetCompanyTaxProfile("BHP")
	require.NoError(t, err)

	assert.Equal(t, "BHP GROUP LIMITED", profile.EntityName)
	assert.Equal(t, "49004028077", profile.ABN)
	require.Len(t, profile.Years, 2)

	reportedZero := profile.Years[0]
	assert.Equal(t, int32(2023), reportedZero.IncomeYear)
	require.NotNil(t, reportedZero.TaxableIncome)
	assert.InDelta(t, 42_000_000_000.0, *reportedZero.TaxableIncome, 1)
	require.NotNil(t, reportedZero.TaxPayable)
	assert.Equal(t, 0.0, *reportedZero.TaxPayable)

	notReported := profile.Years[1]
	assert.Equal(t, int32(2024), notReported.IncomeYear)
	assert.Nil(t, notReported.TaxableIncome)
	assert.Nil(t, notReported.TaxPayable)
}
