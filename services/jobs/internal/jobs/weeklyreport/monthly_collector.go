package weeklyreport

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MonthlyDataCollector queries the database for monthly report data
type MonthlyDataCollector struct {
	db *pgxpool.Pool
}

// NewMonthlyDataCollector creates a new MonthlyDataCollector
func NewMonthlyDataCollector(db *pgxpool.Pool) *MonthlyDataCollector {
	return &MonthlyDataCollector{db: db}
}

// Collect gathers all data needed for the monthly report
func (c *MonthlyDataCollector) Collect(ctx context.Context, monthSlug string) (*ReportData, error) {
	year, month, err := parseMonthSlug(monthSlug)
	if err != nil {
		return nil, fmt.Errorf("invalid month slug: %w", err)
	}

	// Date range for current month
	startDate := fmt.Sprintf("%04d-%02d-01", year, month)
	endDate := time.Date(year, time.Month(month+1), 0, 0, 0, 0, 0, time.UTC).Format("2006-01-02")

	// Find the latest trading day in the month
	dc := &DataCollector{db: c.db}
	reportDate, err := dc.findLatestTradingDay(ctx, startDate, endDate)
	if err != nil {
		return nil, fmt.Errorf("no trading data for month %s: %w", monthSlug, err)
	}

	// Find the latest trading day in the previous month
	prevYear, prevMonth := year, month-1
	if prevMonth < 1 {
		prevYear--
		prevMonth = 12
	}
	prevStartDate := fmt.Sprintf("%04d-%02d-01", prevYear, prevMonth)
	prevEndDate := time.Date(prevYear, time.Month(prevMonth+1), 0, 0, 0, 0, 0, time.UTC).Format("2006-01-02")

	previousDate, err := dc.findLatestTradingDay(ctx, prevStartDate, prevEndDate)
	if err != nil {
		log.Printf("No data for previous month, trying month before: %v", err)
		pp2Year, pp2Month := prevYear, prevMonth-1
		if pp2Month < 1 {
			pp2Year--
			pp2Month = 12
		}
		pp2Start := fmt.Sprintf("%04d-%02d-01", pp2Year, pp2Month)
		pp2End := time.Date(pp2Year, time.Month(pp2Month+1), 0, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		previousDate, err = dc.findLatestTradingDay(ctx, pp2Start, pp2End)
		if err != nil {
			return nil, fmt.Errorf("no previous month data: %w", err)
		}
	}

	log.Printf("Report date: %s, Previous date: %s", reportDate, previousDate)

	// Collect current month's top stocks
	currentStocks, err := dc.getStocksForDate(ctx, reportDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get current stocks: %w", err)
	}

	// Collect previous month's stocks for comparison
	previousStocks, err := dc.getStocksForDate(ctx, previousDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get previous stocks: %w", err)
	}

	// Shared snapshot: top 10 with month-on-month changes (WoWChange reused for
	// MoM), movers v2, stats, and industry breakdown. z-score is disabled: a
	// monthly change compared against weekly-delta history is not meaningful.
	snapshot := dc.buildSnapshot(ctx, reportDate, currentStocks, previousStocks, snapshotOpts{
		MoverLimit: 6,
		UseZScore:  false,
	})
	topShorted := snapshot.TopShorted
	risers := snapshot.Risers
	fallers := snapshot.Fallers
	stats := snapshot.Stats

	// Collect company metadata, financial reports, extracted highlights, and price data for all mentioned stocks
	mentionedCodes := collectMentionedCodes(topShorted, risers, fallers)
	companyCtx := dc.getCompanyMetadata(ctx, mentionedCodes)
	finRefs := dc.getFinancialReports(ctx, mentionedCodes)
	finHighlights := dc.getFinancialHighlights(ctx, mentionedCodes)
	priceCtx := dc.getStockPrices(ctx, mentionedCodes, reportDate, startDate, endDate)
	announcements := dc.getRecentAnnouncements(ctx, mentionedCodes, startDate, endDate)

	return &ReportData{
		WeekSlug:            monthSlug,
		ReportDate:          reportDate,
		PreviousDate:        previousDate,
		TopShorted:          topShorted,
		Risers:              risers,
		Fallers:             fallers,
		MarketStats:         stats,
		IndustryBreakdown:   snapshot.IndustryBreakdown,
		ReportType:          "monthly",
		CompanyContext:      companyCtx,
		FinancialRefs:       finRefs,
		FinancialHighlights: finHighlights,
		PriceContext:        priceCtx,
		Announcements:       announcements,
	}, nil
}

// parseMonthSlug parses "2026-01" into year and month
func parseMonthSlug(slug string) (int, int, error) {
	parts := strings.Split(slug, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid format: %s", slug)
	}
	year, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid year: %s", parts[0])
	}
	month, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid month: %s", parts[1])
	}
	if month < 1 || month > 12 {
		return 0, 0, fmt.Errorf("month out of range: %d", month)
	}
	return year, month, nil
}
