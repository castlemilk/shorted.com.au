//go:build integration

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

// Run explicitly with -tags=integration -run '^$' -bench MultipleStockPricesQuery
// -benchtime=3x. Uses the existing temporary Postgres harness, not production.
func BenchmarkMultipleStockPricesQuery(b *testing.B) {
	pool := quoteTestPool(b)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO stock_prices (stock_code,date,open,high,low,close,volume,adjusted_close)
		SELECT 'Z' || chr(65 + symbol / 26) || chr(65 + symbol % 26),
			DATE '2000-01-01' + day, 100, 101, 99, 100, 1000, 100
		FROM generate_series(0,199) symbol
		CROSS JOIN generate_series(1,5000) day;
		ANALYZE stock_prices
	`)
	require.NoError(b, err)

	for _, count := range []int{1, 20, 50} {
		codes := make([]string, count)
		for i := range codes {
			codes[i] = fmt.Sprintf("Z%c%c", 'A'+i/26, 'A'+i%26)
		}
		requireQuoteQueryEquivalence(b, pool, append(append([]string{}, codes...), codes[0], "ZZZ"))
		for _, candidate := range []struct{ name, query string }{
			{"historical", previousMultipleStockPricesQuery},
			{"indexed", multipleStockPricesQuery},
		} {
			b.Run(fmt.Sprintf("%d/%s", count, candidate.name), func(b *testing.B) {
				var executionMS, examinedRows, sharedBlocks float64
				for i := 0; i < b.N; i++ {
					var raw []byte
					err := pool.QueryRow(context.Background(),
						"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+candidate.query, codes).Scan(&raw)
					require.NoError(b, err)
					var plans []struct {
						Plan          map[string]any
						ExecutionTime float64 `json:"Execution Time"`
					}
					require.NoError(b, json.Unmarshal(raw, &plans))
					require.Len(b, plans, 1)
					plan := plans[0]
					executionMS += plan.ExecutionTime
					examinedRows += quotePlanRows(plan.Plan)
					sharedBlocks += planNumber(plan.Plan, "Shared Hit Blocks") + planNumber(plan.Plan, "Shared Read Blocks")
					if candidate.name == "indexed" {
						require.LessOrEqual(b, quotePlanRows(plan.Plan), float64(2*count), "index seeks examined history")
					}
					if i == 0 {
						b.Logf("EXPLAIN %d/%s: %s", count, candidate.name, raw)
					}
				}
				b.ReportMetric(executionMS/float64(b.N), "db_ms/op")
				b.ReportMetric(examinedRows/float64(b.N), "price_rows/op")
				b.ReportMetric(sharedBlocks/float64(b.N), "shared_blocks/op")
			})
		}
	}
}

func planNumber(plan map[string]any, key string) float64 {
	v, _ := plan[key].(float64)
	return v
}

func quotePlanRows(plan map[string]any) float64 {
	var rows float64
	if plan["Relation Name"] == "stock_prices" {
		rows = (planNumber(plan, "Actual Rows") + planNumber(plan, "Rows Removed by Filter") +
			planNumber(plan, "Rows Removed by Index Recheck")) * planNumber(plan, "Actual Loops")
	}
	if children, ok := plan["Plans"].([]any); ok {
		for _, child := range children {
			if node, ok := child.(map[string]any); ok {
				rows += quotePlanRows(node)
			}
		}
	}
	return rows
}
