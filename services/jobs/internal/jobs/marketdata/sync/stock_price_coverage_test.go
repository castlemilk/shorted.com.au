package sync

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLatestPriceDatesPrefersStockPriceCoverageView(t *testing.T) {
	require.Contains(t, latestPriceDatesQuery, "mv_stock_price_coverage")
	require.Contains(t, latestPriceDatesFallbackQuery, "GROUP BY stock_code")
}

func TestDetectAllGapsPrefersStockPriceCoverageView(t *testing.T) {
	require.Contains(t, stockCodesWithPriceDataQuery, "mv_stock_price_coverage")
	require.Contains(t, stockCodesWithPriceDataFallbackQuery, "SELECT DISTINCT stock_code")
	require.Contains(t, stockCodesWithPriceDataFallbackQuery, "FROM stock_prices")
}

func TestRefreshStockPriceCoverageUsesConcurrentRefresh(t *testing.T) {
	require.Contains(t, refreshStockPriceCoverageQuery, "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage")
}
