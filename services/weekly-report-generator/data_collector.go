package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ReportData holds all collected data for the weekly report
type ReportData struct {
	WeekSlug     string
	ReportDate   string // Latest trading day in the week (YYYY-MM-DD)
	PreviousDate string // Latest trading day in the previous week (YYYY-MM-DD)
	TopShorted   []TopStock
	Risers       []Mover
	Fallers      []Mover
	MarketStats  MarketStats
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
		wowChange := s.ShortPct - prevMap[s.Code]
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

	return &ReportData{
		WeekSlug:     weekSlug,
		ReportDate:   reportDate,
		PreviousDate: previousDate,
		TopShorted:   topShorted,
		Risers:       risers,
		Fallers:      fallers,
		MarketStats:  stats,
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
