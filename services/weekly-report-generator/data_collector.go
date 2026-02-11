package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// StockPriceContext holds price data for enriching LLM context
type StockPriceContext struct {
	Code             string  `json:"code"`
	CurrentPrice     float64 `json:"current_price"`
	WeeklyChangePct  float64 `json:"weekly_change_pct"`
	MonthlyChangePct float64 `json:"monthly_change_pct"`
	WeekHigh         float64 `json:"week_high"`
	WeekLow          float64 `json:"week_low"`
	AvgVolume        int64   `json:"avg_volume"`
}

// Announcement represents an ASX announcement for LLM context
type Announcement struct {
	Date             string `json:"date"`
	Headline         string `json:"headline"`
	IsPriceSensitive bool   `json:"is_price_sensitive"`
	Type             string `json:"type"`
}

// ReportData holds all collected data for a report (weekly, monthly, or yearly)
type ReportData struct {
	WeekSlug        string
	ReportDate      string // Latest trading day in the period (YYYY-MM-DD)
	PreviousDate    string // Latest trading day in the comparison period (YYYY-MM-DD)
	TopShorted      []TopStock
	Risers          []Mover
	Fallers         []Mover
	MarketStats     MarketStats
	ReportType      string // "weekly", "monthly", "yearly"
	ExtraContext    string // Optional extra context (e.g., quarterly snapshots for yearly)
	CompanyContext       map[string]CompanyMeta             // stock_code → metadata for LLM context
	FinancialRefs       map[string][]FinancialReportRef    // stock_code → financial report links
	FinancialHighlights map[string][]FinancialHighlight    // stock_code → extracted financial metrics
	PriceContext         map[string]StockPriceContext       // stock_code → price data
	Announcements        map[string][]Announcement          // stock_code → recent announcements
}

// CompanyMeta holds company metadata for enriching LLM context
type CompanyMeta struct {
	Industry            string `json:"industry"`
	MarketCap           int64  `json:"market_cap"`
	EnhancedSummary     string `json:"enhanced_summary"`
	RecentDevelopments  string `json:"recent_developments"`
	RiskFactors         string `json:"risk_factors"`
	KeyMetrics          string `json:"key_metrics"` // raw JSONB string
}

// FinancialReportRef represents a company's financial report link
type FinancialReportRef struct {
	Title  string `json:"title"`
	URL    string `json:"url"`
	Date   string `json:"date"`
}

// FinancialHighlight holds extracted financial metrics from a company's reports
type FinancialHighlight struct {
	ReportTitle string                         `json:"report_title"`
	ReportType  string                         `json:"report_type"`
	ReportDate  string                         `json:"report_date"`
	Metrics     map[string][]map[string]string `json:"metrics"` // e.g. {"revenue": [{"value_millions": "5142", "period": "H1 FY2025"}]}
}

// TopStock represents a top shorted stock entry
type TopStock struct {
	Rank      int     `json:"rank"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	ShortPct  float64 `json:"short_pct"`
	WoWChange float64 `json:"wow_change"`
}

// Mover represents a stock that moved significantly in short interest
type Mover struct {
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	CurrentPct  float64 `json:"current_pct"`
	PreviousPct float64 `json:"previous_pct"`
	Change      float64 `json:"change"`
}

// MarketStats contains aggregate market statistics
type MarketStats struct {
	TotalStocksShorted int     `json:"total_stocks_shorted"`
	AvgShortPct        float64 `json:"avg_short_pct"`
	MaxShortPct        float64 `json:"max_short_pct"`
	MaxShortCode       string  `json:"max_short_code"`
	WoWAvgChange       float64 `json:"wow_avg_change"`
}

// DataCollector queries the database for report data
type DataCollector struct {
	db *pgxpool.Pool
}

// NewDataCollector creates a new DataCollector
func NewDataCollector(db *pgxpool.Pool) *DataCollector {
	return &DataCollector{db: db}
}

// Collect gathers all data needed for the weekly report
func (c *DataCollector) Collect(ctx context.Context, weekSlug string) (*ReportData, error) {
	// Parse week slug to get date range
	year, week, err := parseWeekSlug(weekSlug)
	if err != nil {
		return nil, fmt.Errorf("invalid week slug: %w", err)
	}

	// Find the latest trading day in the target week
	startDate, endDate := isoWeekDateRange(year, week)
	reportDate, err := c.findLatestTradingDay(ctx, startDate, endDate)
	if err != nil {
		return nil, fmt.Errorf("no trading data for week %s: %w", weekSlug, err)
	}

	// Find previous week's latest trading day
	prevStart, prevEnd := isoWeekDateRange(year, week-1)
	if week == 1 {
		prevStart, prevEnd = isoWeekDateRange(year-1, 52)
	}
	previousDate, err := c.findLatestTradingDay(ctx, prevStart, prevEnd)
	if err != nil {
		// Try week before that
		log.Printf("No data for previous week, trying earlier: %v", err)
		prevStart2, prevEnd2 := isoWeekDateRange(year, week-2)
		previousDate, err = c.findLatestTradingDay(ctx, prevStart2, prevEnd2)
		if err != nil {
			return nil, fmt.Errorf("no previous week data: %w", err)
		}
	}

	log.Printf("Report date: %s, Previous date: %s", reportDate, previousDate)

	// Collect current week's top stocks
	currentStocks, err := c.getStocksForDate(ctx, reportDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get current stocks: %w", err)
	}

	// Collect previous week's stocks for comparison
	previousStocks, err := c.getStocksForDate(ctx, previousDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get previous stocks: %w", err)
	}

	// Build lookup map for previous week
	prevMap := make(map[string]float64)
	for _, s := range previousStocks {
		prevMap[s.Code] = s.ShortPct
	}

	// Calculate WoW changes and build top 10
	var topShorted []TopStock
	for i, s := range currentStocks {
		if i >= 10 {
			break
		}
		var wowChange float64
		if prev, ok := prevMap[s.Code]; ok {
			wowChange = s.ShortPct - prev
		}
		topShorted = append(topShorted, TopStock{
			Rank:      i + 1,
			Code:      s.Code,
			Name:      s.Name,
			ShortPct:  s.ShortPct,
			WoWChange: math.Round(wowChange*100) / 100,
		})
	}

	// Calculate risers and fallers
	type stockChange struct {
		code        string
		name        string
		currentPct  float64
		previousPct float64
		change      float64
	}
	var changes []stockChange
	for _, s := range currentStocks {
		prev, ok := prevMap[s.Code]
		if !ok {
			continue
		}
		change := s.ShortPct - prev
		if math.Abs(change) > 0.01 { // Only include meaningful changes
			changes = append(changes, stockChange{
				code:        s.Code,
				name:        s.Name,
				currentPct:  s.ShortPct,
				previousPct: prev,
				change:      math.Round(change*100) / 100,
			})
		}
	}

	// Sort by change magnitude
	sort.Slice(changes, func(i, j int) bool {
		return changes[i].change > changes[j].change
	})

	// Top 5 risers (biggest increase in short %)
	var risers []Mover
	for i := 0; i < len(changes) && i < 5; i++ {
		if changes[i].change <= 0 {
			break
		}
		risers = append(risers, Mover{
			Code:        changes[i].code,
			Name:        changes[i].name,
			CurrentPct:  changes[i].currentPct,
			PreviousPct: changes[i].previousPct,
			Change:      changes[i].change,
		})
	}

	// Top 5 fallers (biggest decrease in short %)
	var fallers []Mover
	for i := len(changes) - 1; i >= 0 && len(fallers) < 5; i-- {
		if changes[i].change >= 0 {
			break
		}
		fallers = append(fallers, Mover{
			Code:        changes[i].code,
			Name:        changes[i].name,
			CurrentPct:  changes[i].currentPct,
			PreviousPct: changes[i].previousPct,
			Change:      changes[i].change,
		})
	}

	// Calculate market stats
	stats := c.calculateStats(currentStocks, previousStocks)

	// Collect company metadata, financial reports, extracted highlights, and price data for all mentioned stocks
	mentionedCodes := collectMentionedCodes(topShorted, risers, fallers)
	companyCtx := c.getCompanyMetadata(ctx, mentionedCodes)
	finRefs := c.getFinancialReports(ctx, mentionedCodes)
	finHighlights := c.getFinancialHighlights(ctx, mentionedCodes)
	priceCtx := c.getStockPrices(ctx, mentionedCodes, reportDate, startDate, endDate)
	announcements := c.getRecentAnnouncements(ctx, mentionedCodes, startDate, endDate)

	return &ReportData{
		WeekSlug:            weekSlug,
		ReportDate:          reportDate,
		PreviousDate:        previousDate,
		TopShorted:          topShorted,
		Risers:              risers,
		Fallers:             fallers,
		MarketStats:         stats,
		ReportType:          "weekly",
		CompanyContext:       companyCtx,
		FinancialRefs:       finRefs,
		FinancialHighlights: finHighlights,
		PriceContext:         priceCtx,
		Announcements:       announcements,
	}, nil
}

type stockRow struct {
	Code     string
	Name     string
	ShortPct float64
}

func (c *DataCollector) findLatestTradingDay(ctx context.Context, startDate, endDate string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var date string
	query := `
		SELECT DISTINCT "DATE"::date::text
		FROM shorts
		WHERE "DATE" >= $1::timestamp AND "DATE" <= ($2::text || ' 23:59:59')::timestamp
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "DATE"::date::text DESC
		LIMIT 1
	`
	err := c.db.QueryRow(queryCtx, query, startDate, endDate).Scan(&date)
	if err != nil {
		return "", err
	}
	return date, nil
}

func (c *DataCollector) getStocksForDate(ctx context.Context, date string) ([]stockRow, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	dateStart := date + " 00:00:00"
	dateEnd := date + " 23:59:59"

	query := `
		SELECT
			s."PRODUCT_CODE",
			COALESCE(s."PRODUCT", ''),
			s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts s
		WHERE s."DATE" >= $1 AND s."DATE" <= $2
		  AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
	`

	rows, err := c.db.Query(queryCtx, query, dateStart, dateEnd)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stocks []stockRow
	for rows.Next() {
		var s stockRow
		if err := rows.Scan(&s.Code, &s.Name, &s.ShortPct); err != nil {
			return nil, err
		}
		stocks = append(stocks, s)
	}
	return stocks, rows.Err()
}

func (c *DataCollector) calculateStats(current, previous []stockRow) MarketStats {
	stats := MarketStats{
		TotalStocksShorted: len(current),
	}

	if len(current) == 0 {
		return stats
	}

	var totalPct float64
	for _, s := range current {
		totalPct += s.ShortPct
		if s.ShortPct > stats.MaxShortPct {
			stats.MaxShortPct = s.ShortPct
			stats.MaxShortCode = s.Code
		}
	}
	stats.AvgShortPct = math.Round(totalPct/float64(len(current))*100) / 100

	// Calculate previous average for WoW comparison
	if len(previous) > 0 {
		var prevTotalPct float64
		for _, s := range previous {
			prevTotalPct += s.ShortPct
		}
		prevAvg := prevTotalPct / float64(len(previous))
		stats.WoWAvgChange = math.Round((stats.AvgShortPct-prevAvg)*100) / 100
	}

	return stats
}

// parseWeekSlug parses "2026-W06" into year and week number
func parseWeekSlug(slug string) (int, int, error) {
	parts := strings.Split(slug, "-W")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid format: %s", slug)
	}
	year, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid year: %s", parts[0])
	}
	week, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid week: %s", parts[1])
	}
	if week < 1 || week > 53 {
		return 0, 0, fmt.Errorf("week out of range: %d", week)
	}
	return year, week, nil
}

// isoWeekDateRange returns the Monday and Sunday of an ISO week
func isoWeekDateRange(year, week int) (string, string) {
	// Find January 4th of the year (always in week 1)
	jan4 := time.Date(year, time.January, 4, 0, 0, 0, 0, time.UTC)
	// Find the Monday of week 1
	_, isoWeek := jan4.ISOWeek()
	daysSinceMonday := int(jan4.Weekday()+6) % 7
	monday := jan4.AddDate(0, 0, -daysSinceMonday)

	// Adjust to target week
	if isoWeek != 1 {
		monday = monday.AddDate(0, 0, (1-isoWeek)*7)
	}
	targetMonday := monday.AddDate(0, 0, (week-1)*7)
	targetFriday := targetMonday.AddDate(0, 0, 4)

	return targetMonday.Format("2006-01-02"), targetFriday.Format("2006-01-02")
}

// collectMentionedCodes gathers all unique stock codes from top stocks, risers, and fallers
func collectMentionedCodes(top []TopStock, risers, fallers []Mover) []string {
	seen := make(map[string]bool)
	for _, s := range top {
		seen[s.Code] = true
	}
	for _, m := range risers {
		seen[m.Code] = true
	}
	for _, m := range fallers {
		seen[m.Code] = true
	}
	codes := make([]string, 0, len(seen))
	for code := range seen {
		codes = append(codes, code)
	}
	return codes
}

// getCompanyMetadata fetches metadata from company-metadata table for a list of stock codes
func (c *DataCollector) getCompanyMetadata(ctx context.Context, codes []string) map[string]CompanyMeta {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Build parameterised query with ANY($1)
	// Note: production schema has no 'sector' column, market_cap is text, industry is text
	query := `
		SELECT
			stock_code,
			COALESCE(industry, ''),
			COALESCE(market_cap, ''),
			COALESCE(enhanced_summary, ''),
			COALESCE(recent_developments, ''),
			COALESCE(risk_factors, ''),
			COALESCE(key_metrics::text, '{}')
		FROM "company-metadata"
		WHERE stock_code = ANY($1)
	`

	rows, err := c.db.Query(queryCtx, query, codes)
	if err != nil {
		log.Printf("WARNING: failed to fetch company metadata: %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string]CompanyMeta)
	for rows.Next() {
		var code, marketCapStr string
		var m CompanyMeta
		if err := rows.Scan(&code, &m.Industry, &marketCapStr, &m.EnhancedSummary, &m.RecentDevelopments, &m.RiskFactors, &m.KeyMetrics); err != nil {
			log.Printf("WARNING: failed to scan company metadata row: %v", err)
			continue
		}
		// Parse market_cap from text to int64
		if marketCapStr != "" {
			fmt.Sscanf(marketCapStr, "%d", &m.MarketCap)
		}
		result[code] = m
	}

	log.Printf("Fetched company metadata for %d/%d stocks", len(result), len(codes))
	return result
}

// getFinancialHighlights fetches extracted financial metrics from financial_report_extractions for a list of stock codes
func (c *DataCollector) getFinancialHighlights(ctx context.Context, codes []string) map[string][]FinancialHighlight {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	query := `
		SELECT stock_code, report_title, COALESCE(report_type, ''), report_date::text, COALESCE(metrics::text, '{}')
		FROM financial_report_extractions
		WHERE stock_code = ANY($1)
		  AND metrics::text != '{}'
		ORDER BY stock_code, report_date DESC
	`

	rows, err := c.db.Query(queryCtx, query, codes)
	if err != nil {
		log.Printf("WARNING: failed to fetch financial highlights: %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string][]FinancialHighlight)
	for rows.Next() {
		var code, title, reportType, reportDate, metricsJSON string
		if err := rows.Scan(&code, &title, &reportType, &reportDate, &metricsJSON); err != nil {
			log.Printf("WARNING: failed to scan financial highlight row: %v", err)
			continue
		}
		// Metrics can be map[string]object or map[string][]object — normalize to []object
		var rawMetrics map[string]json.RawMessage
		if err := json.Unmarshal([]byte(metricsJSON), &rawMetrics); err != nil {
			log.Printf("WARNING: failed to parse metrics for %s: %v", code, err)
			continue
		}
		metrics := make(map[string][]map[string]string)
		for key, raw := range rawMetrics {
			// Try array first
			var arr []map[string]string
			if err := json.Unmarshal(raw, &arr); err == nil {
				metrics[key] = arr
				continue
			}
			// Fall back to single object
			var single map[string]string
			if err := json.Unmarshal(raw, &single); err == nil {
				metrics[key] = []map[string]string{single}
			}
		}
		// Keep only the most recent 2 reports per company to limit context size
		if len(result[code]) >= 2 {
			continue
		}
		result[code] = append(result[code], FinancialHighlight{
			ReportTitle: title,
			ReportType:  reportType,
			ReportDate:  reportDate,
			Metrics:     metrics,
		})
	}

	log.Printf("Fetched financial highlights for %d/%d stocks", len(result), len(codes))
	return result
}

// getStockPrices fetches price data from stock_prices and stock_price_changes for a list of stock codes
func (c *DataCollector) getStockPrices(ctx context.Context, codes []string, reportDate, startDate, endDate string) map[string]StockPriceContext {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	result := make(map[string]StockPriceContext)

	// Get current price and change percentages from stock_price_changes VIEW (if it exists)
	priceQuery := `
		SELECT stock_code, close, COALESCE(weekly_change_pct, 0), COALESCE(monthly_change_pct, 0)
		FROM stock_price_changes
		WHERE stock_code = ANY($1) AND date = $2
	`
	rows, err := c.db.Query(queryCtx, priceQuery, codes, reportDate)
	if err != nil {
		log.Printf("WARNING: stock_price_changes query failed (view may not exist): %v", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var code string
			var p StockPriceContext
			if err := rows.Scan(&code, &p.CurrentPrice, &p.WeeklyChangePct, &p.MonthlyChangePct); err != nil {
				log.Printf("WARNING: failed to scan price change row: %v", err)
				continue
			}
			p.Code = code
			result[code] = p
		}
	}

	// Get week high/low/avg volume from stock_prices
	rangeQuery := `
		SELECT stock_code, COALESCE(MAX(high), 0), COALESCE(MIN(low), 0), COALESCE(AVG(volume)::bigint, 0)
		FROM stock_prices
		WHERE stock_code = ANY($1) AND date BETWEEN $2 AND $3
		GROUP BY stock_code
	`
	rangeCtx, rangeCancel := context.WithTimeout(ctx, 15*time.Second)
	defer rangeCancel()

	rangeRows, err := c.db.Query(rangeCtx, rangeQuery, codes, startDate, endDate)
	if err != nil {
		log.Printf("WARNING: stock_prices range query failed: %v", err)
		return result
	}
	defer rangeRows.Close()

	for rangeRows.Next() {
		var code string
		var weekHigh, weekLow float64
		var avgVol int64
		if err := rangeRows.Scan(&code, &weekHigh, &weekLow, &avgVol); err != nil {
			log.Printf("WARNING: failed to scan price range row: %v", err)
			continue
		}
		p := result[code]
		p.Code = code
		p.WeekHigh = weekHigh
		p.WeekLow = weekLow
		p.AvgVolume = avgVol
		result[code] = p
	}

	log.Printf("Fetched price context for %d/%d stocks", len(result), len(codes))
	return result
}

// getRecentAnnouncements fetches ASX announcements for a list of stock codes within a date range
func (c *DataCollector) getRecentAnnouncements(ctx context.Context, codes []string, startDate, endDate string) map[string][]Announcement {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	query := `
		SELECT stock_code, announcement_date::text, headline, COALESCE(is_price_sensitive, false), COALESCE(announcement_type, 'other')
		FROM asx_announcements
		WHERE stock_code = ANY($1)
		  AND announcement_date BETWEEN $2 AND $3
		ORDER BY stock_code, announcement_date DESC
	`

	rows, err := c.db.Query(queryCtx, query, codes, startDate, endDate)
	if err != nil {
		log.Printf("WARNING: asx_announcements query failed (table may not exist yet): %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string][]Announcement)
	for rows.Next() {
		var code string
		var a Announcement
		if err := rows.Scan(&code, &a.Date, &a.Headline, &a.IsPriceSensitive, &a.Type); err != nil {
			log.Printf("WARNING: failed to scan announcement row: %v", err)
			continue
		}
		result[code] = append(result[code], a)
	}

	log.Printf("Fetched announcements for %d/%d stocks", len(result), len(codes))
	return result
}

// getFinancialReports fetches financial report links from company-metadata for a list of stock codes
func (c *DataCollector) getFinancialReports(ctx context.Context, codes []string) map[string][]FinancialReportRef {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	query := `
		SELECT stock_code, COALESCE(financial_reports::text, '[]')
		FROM "company-metadata"
		WHERE stock_code = ANY($1)
		  AND financial_reports IS NOT NULL
		  AND financial_reports::text != '[]'
	`

	rows, err := c.db.Query(queryCtx, query, codes)
	if err != nil {
		log.Printf("WARNING: failed to fetch financial reports: %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string][]FinancialReportRef)
	for rows.Next() {
		var code, reportsJSON string
		if err := rows.Scan(&code, &reportsJSON); err != nil {
			continue
		}
		var reports []FinancialReportRef
		if err := json.Unmarshal([]byte(reportsJSON), &reports); err != nil {
			continue
		}
		// Keep only the most recent 3 reports per company
		if len(reports) > 3 {
			reports = reports[:3]
		}
		if len(reports) > 0 {
			result[code] = reports
		}
	}

	return result
}
