package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// ScreenerStock represents a single row from the screener materialized view
type ScreenerStock struct {
	StockCode           string
	CompanyName         string
	Industry            string
	ShortPct            float64
	ShortPctChange4w    float64
	LatestPrice         float64
	PriceChange1m       float64
	LatestVolume        int64
	MarketCap           float64
	PERatio             float64
	DividendYield       float64
	NetDirectorBuyValue float64
	DirectorBuyCount    int32
	DirectorSellCount   int32
	NewsCount30d        int32
	AvgSentiment        float64
	PriceSensitiveCount int32
	Trailing12mDividend float64
	AvgFrankingPct      float64
	LogoURL             string
	DaysToCover         float64
	AvgVolume20d        int64
}

// screenerSortFieldToColumn maps proto sort fields to SQL column names
var screenerSortFieldToColumn = map[shortsv1alpha1.ScreenerSortField]string{
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT:        "short_pct",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT_CHANGE: "short_pct_change_4w",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_MARKET_CAP:       "market_cap",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_PRICE_CHANGE_1M:  "price_change_1m",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_PE_RATIO:         "pe_ratio",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_DIVIDEND_YIELD:   "dividend_yield",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NET_DIRECTOR_BUY: "net_director_buy_value",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NEWS_SENTIMENT:   "avg_sentiment",
	shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_DAYS_TO_COVER:    "days_to_cover",
}

// ScreenStocks queries the screener materialized view with dynamic filters
func (s *postgresStore) ScreenStocks(
	filters *shortsv1alpha1.ScreenerFilters,
	sortField shortsv1alpha1.ScreenerSortField,
	sortDir shortsv1alpha1.SortDirection,
	limit, offset int32,
) ([]*ScreenerStock, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Build WHERE clauses dynamically
	var conditions []string
	var args []interface{}
	argIdx := 1

	if filters != nil {
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "short_pct", filters.ShortPct)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "short_pct_change_4w", filters.ShortPctChange)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "market_cap", filters.MarketCap)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "price_change_1m", filters.PriceChange_1M)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "pe_ratio", filters.PeRatio)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "dividend_yield", filters.DividendYield)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "net_director_buy_value", filters.NetDirectorBuy)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "avg_sentiment", filters.AvgSentiment)
		argIdx = appendRangeFilter(&conditions, &args, argIdx, "days_to_cover", filters.DaysToCover)

		if len(filters.Industries) > 0 {
			conditions = append(conditions, fmt.Sprintf("industry = ANY($%d)", argIdx))
			args = append(args, filters.Industries)
			argIdx++
		}

		if filters.HasDirectorBuys {
			conditions = append(conditions, "director_buy_count > 0")
		}
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = "WHERE " + strings.Join(conditions, " AND ")
	}

	// Build ORDER BY
	sortColumn := "short_pct"
	if col, ok := screenerSortFieldToColumn[sortField]; ok {
		sortColumn = col
	}
	sortDirection := "DESC"
	if sortDir == shortsv1alpha1.SortDirection_SORT_DIRECTION_ASC {
		sortDirection = "ASC"
	}
	orderClause := fmt.Sprintf("ORDER BY %s %s", sortColumn, sortDirection)

	// Count query
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM mv_screener_data %s", whereClause)
	var totalCount int
	err := s.db.QueryRow(ctx, countQuery, args...).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count screener results: %w", err)
	}

	// Data query
	dataQuery := fmt.Sprintf(`
		SELECT
			stock_code, company_name, industry,
			short_pct, short_pct_change_4w,
			latest_price, price_change_1m, latest_volume,
			market_cap, pe_ratio, dividend_yield,
			net_director_buy_value, director_buy_count, director_sell_count,
			news_count_30d, avg_sentiment, price_sensitive_count,
			trailing_12m_dividend, avg_franking_pct, logo_url,
			COALESCE(avg_volume_20d, 0), COALESCE(days_to_cover, 0)
		FROM mv_screener_data
		%s
		%s
		LIMIT $%d OFFSET $%d
	`, whereClause, orderClause, argIdx, argIdx+1)

	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, dataQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query screener data: %w", err)
	}
	defer rows.Close()

	var stocks []*ScreenerStock
	for rows.Next() {
		stock := &ScreenerStock{}
		if err := rows.Scan(
			&stock.StockCode, &stock.CompanyName, &stock.Industry,
			&stock.ShortPct, &stock.ShortPctChange4w,
			&stock.LatestPrice, &stock.PriceChange1m, &stock.LatestVolume,
			&stock.MarketCap, &stock.PERatio, &stock.DividendYield,
			&stock.NetDirectorBuyValue, &stock.DirectorBuyCount, &stock.DirectorSellCount,
			&stock.NewsCount30d, &stock.AvgSentiment, &stock.PriceSensitiveCount,
			&stock.Trailing12mDividend, &stock.AvgFrankingPct, &stock.LogoURL,
			&stock.AvgVolume20d, &stock.DaysToCover,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan screener stock: %w", err)
		}
		stocks = append(stocks, stock)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating screener rows: %w", err)
	}

	return stocks, totalCount, nil
}

// appendRangeFilter adds WHERE conditions for a RangeFilter, returning the updated arg index
func appendRangeFilter(conditions *[]string, args *[]interface{}, argIdx int, column string, rf *shortsv1alpha1.RangeFilter) int {
	if rf == nil {
		return argIdx
	}
	if rf.HasMin {
		*conditions = append(*conditions, fmt.Sprintf("%s >= $%d", column, argIdx))
		*args = append(*args, rf.Min)
		argIdx++
	}
	if rf.HasMax {
		*conditions = append(*conditions, fmt.Sprintf("%s <= $%d", column, argIdx))
		*args = append(*args, rf.Max)
		argIdx++
	}
	return argIdx
}
