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
	t.Parallel() // Enable parallel execution - each test gets its own container with random port
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

// TestFullTextSearch tests PostgreSQL full-text search capabilities with search_vector
func TestFullTextSearch(t *testing.T) {
	t.Parallel() // Enable parallel execution - each test gets its own container with random port
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()

		// First, check if search_vector column exists (migration may not be applied)
		var hasSearchVector bool
		err := container.DB.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns 
				WHERE table_name = 'company-metadata' 
				AND column_name = 'search_vector'
			)
		`).Scan(&hasSearchVector)
		require.NoError(t, err)

		if !hasSearchVector {
			t.Skip("search_vector column not present - migration not applied")
		}

		seeder := container.GetSeeder()

		// Seed test data with rich metadata for full-text search
		testDate := time.Now().Truncate(24 * time.Hour)
		stockCodes := []string{"CBA", "BHP", "CSL"}
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate, 1)

		// Customize metadata with detailed descriptions
		for i := range metadata {
			switch metadata[i].StockCode {
			case "BHP":
				metadata[i].Industry = "Mining"
				metadata[i].Tags = []string{"mining", "resources", "iron-ore", "copper", "commodities"}
				metadata[i].Description = "World's largest mining company producing iron ore, copper, and other commodities"
			case "CSL":
				metadata[i].Industry = "Biotechnology"
				metadata[i].Tags = []string{"healthcare", "biotech", "pharma", "plasma"}
				metadata[i].Description = "Global biotechnology company specializing in blood plasma products and vaccines"
			case "CBA":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services", "mortgages"}
				metadata[i].Description = "Australia's largest bank offering retail and commercial banking services"
			}
		}

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		// Helper for full-text search using plainto_tsquery
		fullTextSearch := func(query string) []string {
			rows, err := container.DB.Query(ctx, `
				WITH latest_shorts AS (
					SELECT DISTINCT ON ("PRODUCT_CODE") *
					FROM shorts
					ORDER BY "PRODUCT_CODE", "DATE" DESC
				)
				SELECT s."PRODUCT_CODE"
				FROM latest_shorts s
				LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
				WHERE m.search_vector @@ plainto_tsquery('english', $1)
				ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', $1)) DESC
			`, query)
			require.NoError(t, err)
			defer rows.Close()

			var codes []string
			for rows.Next() {
				var code string
				require.NoError(t, rows.Scan(&code))
				codes = append(codes, code)
			}
			return codes
		}

		t.Run("FTS Search by Description Term", func(t *testing.T) {
			// "copper" should find BHP via its description
			results := fullTextSearch("copper")
			assert.Contains(t, results, "BHP", "Should find BHP when searching for 'copper'")
		})

		t.Run("FTS Search by Medical Term", func(t *testing.T) {
			// "plasma" should find CSL via its tags/description
			results := fullTextSearch("plasma")
			assert.Contains(t, results, "CSL", "Should find CSL when searching for 'plasma'")
		})

		t.Run("FTS Search by Banking", func(t *testing.T) {
			// "retail banking" should find CBA
			results := fullTextSearch("retail banking")
			assert.Contains(t, results, "CBA", "Should find CBA when searching for 'retail banking'")
		})

		t.Run("FTS Multi-word Query", func(t *testing.T) {
			// "iron ore mining" should find BHP
			results := fullTextSearch("iron ore mining")
			assert.Contains(t, results, "BHP", "Should find BHP when searching for 'iron ore mining'")
		})

		t.Run("FTS No Results", func(t *testing.T) {
			results := fullTextSearch("quantum computing blockchain")
			assert.Empty(t, results, "Should find no results for unrelated terms")
		})
	})
}

// TestSearchRelevanceRanking tests that search results are properly ranked
func TestSearchRelevanceRanking(t *testing.T) {
	t.Parallel() // Enable parallel execution - each test gets its own container with random port
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		testDate := time.Now().Truncate(24 * time.Hour)

		// Create test data where BHP is both a stock code and appears in another stock's description
		shorts := []testdata.ShortData{
			testdata.NewShortData("BHP", "BHP GROUP LIMITED", testDate),
			testdata.NewShortData("XXX", "XXX MINING CORP", testDate),
		}
		shorts[0].PercentOfShares = 5.0
		shorts[1].PercentOfShares = 3.0

		metadata := []testdata.CompanyMetadata{
			{
				StockCode:   "BHP",
				CompanyName: "BHP Group Limited",
				Industry:    "Mining",
				Tags:        []string{"mining", "resources"},
				Description: "Major mining company",
			},
			{
				StockCode:   "XXX",
				CompanyName: "XXX Mining Corp",
				Industry:    "Mining",
				Tags:        []string{"mining"},
				Description: "Small company similar to BHP in mining operations",
			},
		}

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		t.Run("Exact Code Match Ranked First", func(t *testing.T) {
			// When searching for "BHP", the exact match should come first
			rows, err := container.DB.Query(ctx, `
				WITH latest_shorts AS (
					SELECT DISTINCT ON ("PRODUCT_CODE") *
					FROM shorts
					ORDER BY "PRODUCT_CODE", "DATE" DESC
				),
				search_results AS (
					SELECT 
						s."PRODUCT_CODE" as product_code,
						CASE 
							WHEN s."PRODUCT_CODE" = 'BHP' THEN 100
							WHEN s."PRODUCT_CODE" ILIKE '%BHP%' THEN 50
							WHEN s."PRODUCT" ILIKE '%BHP%' THEN 20
							ELSE 1
						END as relevance
					FROM latest_shorts s
					LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
					WHERE 
						s."PRODUCT_CODE" ILIKE '%BHP%' OR
						s."PRODUCT" ILIKE '%BHP%' OR
						m.description ILIKE '%BHP%'
				)
				SELECT product_code FROM search_results
				ORDER BY relevance DESC
			`)
			require.NoError(t, err)
			defer rows.Close()

			var codes []string
			for rows.Next() {
				var code string
				require.NoError(t, rows.Scan(&code))
				codes = append(codes, code)
			}

			require.NotEmpty(t, codes, "Should find results")
			assert.Equal(t, "BHP", codes[0], "Exact code match should be ranked first")
		})
	})
}

