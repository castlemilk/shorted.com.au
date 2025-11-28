package integration

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/test/integration/testdata"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSearchStocks(t *testing.T) {
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data with specific industries and tags
		// CBA: Financial Services, Banks, [banking, financial-services]
		// BHP: Materials, Mining, [mining, resources]
		// CSL: Healthcare, Biotechnology, [healthcare, biotech]
		stockCodes := []string{"CBA", "BHP", "CSL"}
		testDate := time.Now().Truncate(24 * time.Hour)
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate, 1)

		// Customize metadata for the test as GetMultipleStocksTestData uses defaults
		for i := range metadata {
			switch metadata[i].StockCode {
			case "BHP":
				metadata[i].Industry = "Mining"
				metadata[i].Tags = []string{"mining", "resources", "iron-ore"}
			case "CSL":
				metadata[i].Industry = "Biotechnology"
				metadata[i].Tags = []string{"healthcare", "biotech", "pharma"}
			case "CBA":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services"}
			}
		}

		err := seeder.SeedCompanyMetadata(ctx, metadata)
		require.NoError(t, err)

		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err)

		// Helper function to perform search query directly against the database
		// mimicking the SearchStocks implementation
		search := func(query string) []string {
			rows, err := container.DB.Query(ctx, `
				WITH latest_shorts AS (
					SELECT DISTINCT ON ("PRODUCT_CODE") *
					FROM shorts
					ORDER BY "PRODUCT_CODE", "DATE" DESC
				),
				matched_stocks AS (
					SELECT 
						s."PRODUCT_CODE" as product_code,
						CASE 
							WHEN s."PRODUCT_CODE" = $1 THEN 1       -- Exact Code Match
							WHEN s."PRODUCT_CODE" ILIKE $2 THEN 2   -- Partial Code Match
							WHEN s."PRODUCT" ILIKE $2 THEN 3        -- Name Match
							WHEN m.industry ILIKE $2 THEN 4         -- Industry Match
							ELSE 5                                  -- Tag Match
						END as relevance
					FROM latest_shorts s
					LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
					WHERE 
						s."PRODUCT_CODE" ILIKE $2 OR
						s."PRODUCT" ILIKE $2 OR
						m.industry ILIKE $2 OR
						EXISTS (SELECT 1 FROM unnest(m.tags) tag WHERE tag ILIKE $2)
				)
				SELECT product_code FROM matched_stocks
				ORDER BY relevance ASC
			`, query, "%"+query+"%")
			require.NoError(t, err)
			defer rows.Close()

			var codes []string
			for rows.Next() {
				var code string
				err := rows.Scan(&code)
				require.NoError(t, err)
				codes = append(codes, code)
			}
			return codes
		}

		t.Run("Search by Industry", func(t *testing.T) {
			// "Banks" should find CBA
			results := search("Banks")
			assert.Contains(t, results, "CBA")
			assert.NotContains(t, results, "BHP")
		})

		t.Run("Search by Tag", func(t *testing.T) {
			// "biotech" should find CSL
			results := search("biotech")
			assert.Contains(t, results, "CSL")
			assert.NotContains(t, results, "CBA")
		})

		t.Run("Search by Code", func(t *testing.T) {
			results := search("BHP")
			assert.Contains(t, results, "BHP")
			assert.Equal(t, "BHP", results[0], "Exact match should be first")
		})

		t.Run("Search by Partial Name", func(t *testing.T) {
			results := search("Common") // Commonwealth Bank
			assert.Contains(t, results, "CBA")
		})

		t.Run("Search Case Insensitive", func(t *testing.T) {
			results := search("miNiNg")
			assert.Contains(t, results, "BHP")
		})

		t.Run("Search No Results", func(t *testing.T) {
			results := search("NonExistentThing")
			assert.Empty(t, results)
		})
	})
}

