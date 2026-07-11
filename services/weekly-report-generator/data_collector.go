package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
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
	WeekSlug            string
	ReportDate          string // Latest trading day in the period (YYYY-MM-DD)
	PreviousDate        string // Latest trading day in the comparison period (YYYY-MM-DD)
	TopShorted          []TopStock
	Risers              []Mover
	Fallers             []Mover
	MarketStats         MarketStats
	IndustryBreakdown   []IndustryStat                  // Aggregate short interest by industry (top 12 by avg short %)
	ReportType          string                          // "weekly", "monthly", "yearly"
	ExtraContext        string                          // Optional extra context (e.g., quarterly snapshots for yearly)
	CompanyContext      map[string]CompanyMeta          // stock_code → metadata for LLM context
	FinancialRefs       map[string][]FinancialReportRef // stock_code → financial report links
	FinancialHighlights map[string][]FinancialHighlight // stock_code → extracted financial metrics
	PriceContext        map[string]StockPriceContext    // stock_code → price data
	Announcements       map[string][]Announcement       // stock_code → recent announcements
	TrendInsights       map[string]TrendInsight         // stock_code → trend insight
}

// ParsedKeyMetrics holds parsed financial metrics from key_metrics JSONB
type ParsedKeyMetrics struct {
	PERatio       *float64 `json:"pe_ratio,omitempty"`
	EPS           *float64 `json:"eps,omitempty"`
	DividendYield *float64 `json:"dividend_yield,omitempty"`
	Beta          *float64 `json:"beta,omitempty"`
}

// CompanyMeta holds company metadata for enriching LLM context
type CompanyMeta struct {
	Industry           string            `json:"industry"`
	MarketCap          int64             `json:"market_cap"`
	EnhancedSummary    string            `json:"enhanced_summary"`
	RecentDevelopments string            `json:"recent_developments"`
	RiskFactors        string            `json:"risk_factors"`
	KeyMetrics         string            `json:"key_metrics"` // raw JSONB string
	ParsedMetrics      *ParsedKeyMetrics `json:"parsed_metrics,omitempty"`
}

// FinancialReportRef represents a company's financial report link
type FinancialReportRef struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	Date  string `json:"date"`
}

// FinancialHighlight holds extracted financial metrics from a company's reports
type FinancialHighlight struct {
	ReportTitle string                         `json:"report_title"`
	ReportType  string                         `json:"report_type"`
	ReportDate  string                         `json:"report_date"`
	Metrics     map[string][]map[string]string `json:"metrics"` // e.g. {"revenue": [{"value_millions": "5142", "period": "H1 FY2025"}]}
}

// TopStock represents a top shorted stock entry.
// JSON tags MUST match the proto snake_case field names of WeeklyReportStock —
// the shorts service json.Unmarshals these JSONB snapshots directly into
// generated proto structs. Never add logo_url here (hydrated at read time).
type TopStock struct {
	Rank         int       `json:"rank"`
	Code         string    `json:"code"`
	Name         string    `json:"name"`
	ShortPct     float64   `json:"short_pct"`
	WoWChange    float64   `json:"wow_change"`
	DaysToCover  float64   `json:"days_to_cover"`  // Short shares / 20-day avg volume (0 = unknown)
	IsNewEntrant bool      `json:"is_new_entrant"` // New to the top 10 this period
	Industry     string    `json:"industry"`
	History      []float64 `json:"history,omitempty"` // Weekly short % history, oldest first (~13 points)
}

// Mover represents a stock that moved significantly in short interest.
// JSON tags MUST match the proto snake_case field names of WeeklyReportMover.
// Never add logo_url here (hydrated at read time).
type Mover struct {
	Code         string    `json:"code"`
	Name         string    `json:"name"`
	CurrentPct   float64   `json:"current_pct"`
	PreviousPct  float64   `json:"previous_pct"`
	Change       float64   `json:"change"`
	DaysToCover  float64   `json:"days_to_cover"` // Short shares / 20-day avg volume (0 = unknown)
	ZScore       float64   `json:"z_score"`       // Change vs the stock's own weekly-delta history (0 = insufficient history)
	StreakWeeks  int       `json:"streak_weeks"`  // Consecutive weeks moving in the same direction (incl. current)
	Industry     string    `json:"industry"`
	History      []float64 `json:"history,omitempty"` // Weekly short % history, oldest first (~13 points)
	Significance float64   `json:"significance"`      // Composite score used to rank movers
}

// MarketStats contains aggregate market statistics.
// JSON tags MUST match the proto snake_case field names of WeeklyMarketStats.
type MarketStats struct {
	TotalStocksShorted int     `json:"total_stocks_shorted"`
	AvgShortPct        float64 `json:"avg_short_pct"`
	MaxShortPct        float64 `json:"max_short_pct"`
	MaxShortCode       string  `json:"max_short_code"`
	WoWAvgChange       float64 `json:"wow_avg_change"`
	MedianShortPct     float64 `json:"median_short_pct"`
	StocksAbove10Pct   int     `json:"stocks_above_10pct"` // Count of stocks with short interest >= 10%
	StocksAbove5Pct    int     `json:"stocks_above_5pct"`  // Count of stocks with short interest >= 5%
	RiserCount         int     `json:"riser_count"`        // Market-wide count of stocks whose short % rose >0.01pp
	FallerCount        int     `json:"faller_count"`       // Market-wide count of stocks whose short % fell >0.01pp
}

// IndustryStat aggregates short interest for one industry.
// JSON tags MUST match the proto snake_case field names of WeeklyIndustryStat.
type IndustryStat struct {
	Industry     string  `json:"industry"`
	AvgShortPct  float64 `json:"avg_short_pct"`
	WoWChange    float64 `json:"wow_change"` // Change in the industry average vs the prior period
	StockCount   int     `json:"stock_count"`
	TopStockCode string  `json:"top_stock_code"`
	TopStockPct  float64 `json:"top_stock_pct"`
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

	// Build top 10, movers v2, market stats, and industry breakdown with
	// shared per-stock enrichment (history, days-to-cover, industry).
	snapshot := c.buildSnapshot(ctx, reportDate, currentStocks, previousStocks, snapshotOpts{
		MoverLimit: 6,
		UseZScore:  true, // weekly change vs weekly-delta history is meaningful
	})
	topShorted := snapshot.TopShorted
	risers := snapshot.Risers
	fallers := snapshot.Fallers
	stats := snapshot.Stats

	// Collect company metadata, financial reports, extracted highlights, and price data for all mentioned stocks
	mentionedCodes := collectMentionedCodes(topShorted, risers, fallers)
	companyCtx := c.getCompanyMetadata(ctx, mentionedCodes)
	finRefs := c.getFinancialReports(ctx, mentionedCodes)
	finHighlights := c.getFinancialHighlights(ctx, mentionedCodes)
	priceCtx := c.getStockPrices(ctx, mentionedCodes, reportDate, startDate, endDate)
	announcements := c.getRecentAnnouncements(ctx, mentionedCodes, startDate, endDate)

	data := &ReportData{
		WeekSlug:            weekSlug,
		ReportDate:          reportDate,
		PreviousDate:        previousDate,
		TopShorted:          topShorted,
		Risers:              risers,
		Fallers:             fallers,
		MarketStats:         stats,
		IndustryBreakdown:   snapshot.IndustryBreakdown,
		ReportType:          "weekly",
		CompanyContext:      companyCtx,
		FinancialRefs:       finRefs,
		FinancialHighlights: finHighlights,
		PriceContext:        priceCtx,
		Announcements:       announcements,
	}

	// Build trend insights for risers/fallers
	data.TrendInsights = NewTrendAnalyzer().Analyze(data)
	log.Printf("Generated trend insights for %d movers", len(data.TrendInsights))

	return data, nil
}

type stockRow struct {
	Code        string
	Name        string
	ShortPct    float64
	ShortShares float64 // REPORTED_SHORT_POSITIONS (number of shares short)
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
			s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
			COALESCE(s."REPORTED_SHORT_POSITIONS", 0)
		FROM shorts s
		WHERE s."DATE" >= $1 AND s."DATE" <= $2
		  AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		  AND s."PRODUCT" NOT ILIKE '%DEFERRED%'
		  AND s."PRODUCT" !~* 'ETF\M'
		  AND LENGTH(s."PRODUCT_CODE") <= 4
		  AND s."PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
		  AND (s."TOTAL_PRODUCT_IN_ISSUE" IS NULL OR s."TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
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
		if err := rows.Scan(&s.Code, &s.Name, &s.ShortPct, &s.ShortShares); err != nil {
			return nil, err
		}
		stocks = append(stocks, s)
	}
	return stocks, rows.Err()
}

// getShortHistory fetches ~13 weeks of short % history for the given codes in
// ONE query, bucketed by ISO week in Go (latest value per week), producing
// oldest-first series ending at the report week. WARNING-log-and-continue.
func (c *DataCollector) getShortHistory(ctx context.Context, codes []string, reportDate string) map[string][]float64 {
	if len(codes) == 0 {
		return nil
	}
	rd, err := time.Parse("2006-01-02", reportDate)
	if err != nil {
		log.Printf("WARNING: invalid report date %q for history: %v", reportDate, err)
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	query := `
		SELECT
			"PRODUCT_CODE",
			"DATE"::date::text,
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts
		WHERE "PRODUCT_CODE" = ANY($1)
		  AND "DATE" >= ($2::date - INTERVAL '92 days')
		  AND "DATE" <= ($2::text || ' 23:59:59')::timestamp
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "PRODUCT_CODE", "DATE"
	`

	rows, err := c.db.Query(queryCtx, query, codes, reportDate)
	if err != nil {
		log.Printf("WARNING: short history query failed: %v", err)
		return nil
	}
	defer rows.Close()

	var hist []historyPoint
	for rows.Next() {
		var code, dateStr string
		var pct float64
		if err := rows.Scan(&code, &dateStr, &pct); err != nil {
			log.Printf("WARNING: failed to scan history row: %v", err)
			continue
		}
		d, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			continue
		}
		hist = append(hist, historyPoint{Code: code, Date: d, Pct: pct})
	}

	result := bucketWeeklyHistory(hist, rd, maxHistoryPoints)
	log.Printf("Fetched short history for %d/%d stocks", len(result), len(codes))
	return result
}

// getAvgDailyVolumes fetches the average daily volume over the last 20 trading
// days (as at reportDate) per code, in one grouped query. WARNING-log-and-continue.
func (c *DataCollector) getAvgDailyVolumes(ctx context.Context, codes []string, reportDate string) map[string]float64 {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	query := `
		SELECT stock_code, COALESCE(AVG(volume), 0)::float8
		FROM (
			SELECT stock_code, volume,
			       ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
			FROM stock_prices
			WHERE stock_code = ANY($1) AND date <= $2 AND volume > 0
		) t
		WHERE rn <= 20
		GROUP BY stock_code
	`

	rows, err := c.db.Query(queryCtx, query, codes, reportDate)
	if err != nil {
		log.Printf("WARNING: avg volume query failed: %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string]float64)
	for rows.Next() {
		var code string
		var avgVol float64
		if err := rows.Scan(&code, &avgVol); err != nil {
			log.Printf("WARNING: failed to scan avg volume row: %v", err)
			continue
		}
		result[code] = avgVol
	}

	log.Printf("Fetched avg daily volume for %d/%d stocks", len(result), len(codes))
	return result
}

// getIndustryMap fetches the industry for ALL given codes in one ANY($1) query.
// WARNING-log-and-continue.
func (c *DataCollector) getIndustryMap(ctx context.Context, codes []string) map[string]string {
	if len(codes) == 0 {
		return nil
	}

	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	query := `
		SELECT stock_code, COALESCE(industry, '')
		FROM "company-metadata"
		WHERE stock_code = ANY($1)
	`

	rows, err := c.db.Query(queryCtx, query, codes)
	if err != nil {
		log.Printf("WARNING: industry map query failed: %v", err)
		return nil
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var code, industry string
		if err := rows.Scan(&code, &industry); err != nil {
			log.Printf("WARNING: failed to scan industry row: %v", err)
			continue
		}
		if industry != "" {
			result[code] = industry
		}
	}

	log.Printf("Fetched industry for %d/%d stocks", len(result), len(codes))
	return result
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
			_, _ = fmt.Sscanf(marketCapStr, "%d", &m.MarketCap)
		}
		m.ParsedMetrics = parseKeyMetrics(m.KeyMetrics)
		result[code] = m
	}

	log.Printf("Fetched company metadata for %d/%d stocks", len(result), len(codes))
	return result
}

// parseKeyMetrics extracts known financial metrics from key_metrics JSONB
func parseKeyMetrics(raw string) *ParsedKeyMetrics {
	if raw == "" || raw == "{}" {
		return nil
	}

	var data map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil
	}

	pm := &ParsedKeyMetrics{}
	hasAny := false

	// finite rejects NaN/±Inf — enrichment JSONB contains literal "Infinity"
	// strings (e.g. pe_ratio for zero-EPS companies) that ParseFloat accepts,
	// and a non-finite value poisons both the LLM prompt and json.Marshal of
	// the snapshot (encoding/json cannot encode ±Inf).
	finite := func(v float64) *float64 {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return &v
	}

	// Helper to extract a float from various shapes: number, string, or object with "value" key
	extractFloat := func(key string) *float64 {
		raw, ok := data[key]
		if !ok {
			return nil
		}
		// Try direct number
		var f float64
		if err := json.Unmarshal(raw, &f); err == nil {
			return finite(f)
		}
		// Try string
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(s, "%"), "x"))
			if v, err := strconv.ParseFloat(s, 64); err == nil {
				return finite(v)
			}
		}
		// Try object with "value" key
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err == nil {
			if valRaw, ok := obj["value"]; ok {
				var v float64
				if err := json.Unmarshal(valRaw, &v); err == nil {
					return finite(v)
				}
			}
		}
		return nil
	}

	for _, key := range []string{"pe_ratio", "p_e_ratio", "PE Ratio", "pe"} {
		if v := extractFloat(key); v != nil {
			pm.PERatio = v
			hasAny = true
			break
		}
	}
	for _, key := range []string{"eps", "EPS", "earnings_per_share"} {
		if v := extractFloat(key); v != nil {
			pm.EPS = v
			hasAny = true
			break
		}
	}
	for _, key := range []string{"dividend_yield", "Dividend Yield", "div_yield"} {
		if v := extractFloat(key); v != nil {
			pm.DividendYield = v
			hasAny = true
			break
		}
	}
	for _, key := range []string{"beta", "Beta"} {
		if v := extractFloat(key); v != nil {
			pm.Beta = v
			hasAny = true
			break
		}
	}

	if !hasAny {
		return nil
	}
	return pm
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
		SELECT stock_code, current_price, COALESCE(weekly_change_pct, 0), COALESCE(monthly_change_pct, 0)
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
