package weeklyreport

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

// MonthlyReportSummary captures a monthly report's key data for yearly ingestion
type MonthlyReportSummary struct {
	Slug      string `json:"slug"`
	Headline  string `json:"headline"`
	Summary   string `json:"summary"`
	Narrative struct {
		OpeningHook    string `json:"opening_hook"`
		MoversAnalysis string `json:"movers_analysis"`
		Outlook        string `json:"outlook"`
	} `json:"narrative"`
	TopShorted []TopStock `json:"top_shorted"`
}

// FinancialReport is an alias for yearly-specific use (has Source field from crawler)
type FinancialReport = FinancialReportRef

// QuarterSnapshot captures the top shorts and stats for a single quarter
type QuarterSnapshot struct {
	Quarter      string     `json:"quarter"` // "Q1", "Q2", "Q3", "Q4"
	Date         string     `json:"date"`
	TopStocks    []TopStock `json:"top_stocks"`
	AvgShortPct  float64    `json:"avg_short_pct"`
	TotalShorted int        `json:"total_shorted"`
}

// YearlyDataCollector queries the database for year-in-review report data
type YearlyDataCollector struct {
	db *pgxpool.Pool
}

// NewYearlyDataCollector creates a new YearlyDataCollector
func NewYearlyDataCollector(db *pgxpool.Pool) *YearlyDataCollector {
	return &YearlyDataCollector{db: db}
}

// Collect gathers all data needed for the year-in-review report
func (c *YearlyDataCollector) Collect(ctx context.Context, yearSlug string) (*ReportData, error) {
	year, err := strconv.Atoi(yearSlug)
	if err != nil {
		return nil, fmt.Errorf("invalid year slug: %w", err)
	}

	dc := &DataCollector{db: c.db}

	// Find the last trading day of the year
	yearStart := fmt.Sprintf("%04d-01-01", year)
	yearEnd := fmt.Sprintf("%04d-12-31", year)
	reportDate, err := dc.findLatestTradingDay(ctx, yearStart, yearEnd)
	if err != nil {
		return nil, fmt.Errorf("no trading data for year %d: %w", year, err)
	}

	// Find the first trading day of the year
	firstDate, err := c.findEarliestTradingDay(ctx, dc, yearStart, fmt.Sprintf("%04d-01-31", year))
	if err != nil {
		return nil, fmt.Errorf("no data for start of year %d: %w", year, err)
	}

	log.Printf("Year %d: first trading day %s, last trading day %s", year, firstDate, reportDate)

	// Collect year-end and year-start stocks
	endStocks, err := dc.getStocksForDate(ctx, reportDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get year-end stocks: %w", err)
	}

	startStocks, err := dc.getStocksForDate(ctx, firstDate)
	if err != nil {
		return nil, fmt.Errorf("failed to get year-start stocks: %w", err)
	}

	// Shared snapshot: top 10 at year end with year-over-year changes
	// (WoWChange reused for YoY), movers v2, stats, and industry breakdown.
	// z-score is disabled: a yearly change compared against weekly-delta
	// history is not meaningful. Yearly keeps a wider mover list (10).
	snapshot := dc.buildSnapshot(ctx, reportDate, endStocks, startStocks, snapshotOpts{
		MoverLimit: 10,
		UseZScore:  false,
	})
	topShorted := snapshot.TopShorted
	risers := snapshot.Risers
	fallers := snapshot.Fallers
	stats := snapshot.Stats

	// Collect quarterly snapshots
	quarterlySnapshots := c.collectQuarterlySnapshots(ctx, dc, year)

	// Collect monthly reports from the database (previously generated)
	monthlyReports := c.collectMonthlyReports(ctx, year)
	log.Printf("Found %d monthly reports for %d", len(monthlyReports), year)

	// Collect company metadata, financial reports, extracted highlights, and price data for mentioned stocks
	mentionedCodes := collectMentionedCodes(topShorted, risers, fallers)
	companyCtx := dc.getCompanyMetadata(ctx, mentionedCodes)
	financialRefs := c.collectFinancialReports(ctx, mentionedCodes)
	finHighlights := dc.getFinancialHighlights(ctx, mentionedCodes)
	priceCtx := dc.getStockPrices(ctx, mentionedCodes, reportDate, yearStart, yearEnd)
	announcements := dc.getRecentAnnouncements(ctx, mentionedCodes, yearStart, yearEnd)
	log.Printf("Found financial reports for %d/%d stocks, highlights for %d", len(financialRefs), len(mentionedCodes), len(finHighlights))

	// Build extra context with all sources
	extraContext := c.buildYearlyExtraContext(quarterlySnapshots, monthlyReports, financialRefs)

	return &ReportData{
		WeekSlug:            yearSlug,
		ReportDate:          reportDate,
		PreviousDate:        firstDate,
		TopShorted:          topShorted,
		Risers:              risers,
		Fallers:             fallers,
		MarketStats:         stats,
		IndustryBreakdown:   snapshot.IndustryBreakdown,
		ReportType:          "yearly",
		ExtraContext:        extraContext,
		CompanyContext:      companyCtx,
		FinancialHighlights: finHighlights,
		PriceContext:        priceCtx,
		Announcements:       announcements,
	}, nil
}

func (c *YearlyDataCollector) findEarliestTradingDay(ctx context.Context, dc *DataCollector, startDate, endDate string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var date string
	query := `
		SELECT DISTINCT "DATE"::date::text
		FROM shorts
		WHERE "DATE" >= $1::timestamp AND "DATE" <= ($2::text || ' 23:59:59')::timestamp
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "DATE"::date::text ASC
		LIMIT 1
	`
	err := dc.db.QueryRow(queryCtx, query, startDate, endDate).Scan(&date)
	if err != nil {
		return "", err
	}
	return date, nil
}

func (c *YearlyDataCollector) collectQuarterlySnapshots(ctx context.Context, dc *DataCollector, year int) []QuarterSnapshot {
	quarters := []struct {
		name  string
		start string
		end   string
	}{
		{"Q1", fmt.Sprintf("%d-01-01", year), fmt.Sprintf("%d-03-31", year)},
		{"Q2", fmt.Sprintf("%d-04-01", year), fmt.Sprintf("%d-06-30", year)},
		{"Q3", fmt.Sprintf("%d-07-01", year), fmt.Sprintf("%d-09-30", year)},
		{"Q4", fmt.Sprintf("%d-10-01", year), fmt.Sprintf("%d-12-31", year)},
	}

	var snapshots []QuarterSnapshot
	for _, q := range quarters {
		date, err := dc.findLatestTradingDay(ctx, q.start, q.end)
		if err != nil {
			log.Printf("No data for %s %d: %v", q.name, year, err)
			continue
		}

		stocks, err := dc.getStocksForDate(ctx, date)
		if err != nil {
			log.Printf("Failed to get stocks for %s: %v", q.name, err)
			continue
		}

		var topStocks []TopStock
		for i, s := range stocks {
			if i >= 5 {
				break
			}
			topStocks = append(topStocks, TopStock{
				Rank:     i + 1,
				Code:     s.Code,
				Name:     s.Name,
				ShortPct: s.ShortPct,
			})
		}

		var totalPct float64
		for _, s := range stocks {
			totalPct += s.ShortPct
		}
		avgPct := 0.0
		if len(stocks) > 0 {
			avgPct = math.Round(totalPct/float64(len(stocks))*100) / 100
		}

		snapshots = append(snapshots, QuarterSnapshot{
			Quarter:      q.name,
			Date:         date,
			TopStocks:    topStocks,
			AvgShortPct:  avgPct,
			TotalShorted: len(stocks),
		})
	}

	return snapshots
}

func (c *YearlyDataCollector) buildYearlyExtraContext(snapshots []QuarterSnapshot, monthlyReports []MonthlyReportSummary, financialRefs map[string][]FinancialReport) string {
	var sb strings.Builder

	// Quarterly snapshots
	if len(snapshots) > 0 {
		sb.WriteString("\nQUARTERLY JOURNEY THROUGH THE YEAR:\n\n")
		for _, q := range snapshots {
			fmt.Fprintf(&sb, "=== %s (as at %s) ===\n", q.Quarter, q.Date)
			fmt.Fprintf(&sb, "Stocks shorted: %d | Average short %%: %.2f%%\n", q.TotalShorted, q.AvgShortPct)
			sb.WriteString("Top 5 most shorted:\n")
			for _, s := range q.TopStocks {
				fmt.Fprintf(&sb, "  %d. %s (%s): %.2f%%\n", s.Rank, s.Name, s.Code, s.ShortPct)
			}
			sb.WriteString("\n")
		}
	}

	// Monthly report narratives — the month-by-month story
	if len(monthlyReports) > 0 {
		sb.WriteString("\nMONTHLY REPORT NARRATIVES (previously published analysis — use to build the year's story arc):\n\n")
		for _, r := range monthlyReports {
			fmt.Fprintf(&sb, "=== %s: \"%s\" ===\n", r.Slug, r.Headline)
			if r.Summary != "" {
				fmt.Fprintf(&sb, "Summary: %s\n", r.Summary)
			}
			if r.Narrative.OpeningHook != "" {
				hook := r.Narrative.OpeningHook
				if len(hook) > 300 {
					hook = hook[:300] + "..."
				}
				fmt.Fprintf(&sb, "Key insight: %s\n", hook)
			}
			if r.Narrative.MoversAnalysis != "" {
				movers := r.Narrative.MoversAnalysis
				if len(movers) > 300 {
					movers = movers[:300] + "..."
				}
				fmt.Fprintf(&sb, "Movers: %s\n", movers)
			}
			// Top 3 stocks that month
			if len(r.TopShorted) > 0 {
				sb.WriteString("Top 3: ")
				limit := 3
				if len(r.TopShorted) < limit {
					limit = len(r.TopShorted)
				}
				for i := 0; i < limit; i++ {
					if i > 0 {
						sb.WriteString(", ")
					}
					fmt.Fprintf(&sb, "%s (%.2f%%)", r.TopShorted[i].Code, r.TopShorted[i].ShortPct)
				}
				sb.WriteString("\n")
			}
			sb.WriteString("\n")
		}
	}

	// Financial report references — for deep company-level context
	if len(financialRefs) > 0 {
		sb.WriteString("\nCOMPANY FINANCIAL REPORTS (reference these for deeper analysis — cite title and link where relevant):\n\n")
		for code, reports := range financialRefs {
			fmt.Fprintf(&sb, "%s:\n", code)
			for _, r := range reports {
				fmt.Fprintf(&sb, "  - \"%s\" (%s)", r.Title, r.Date)
				if r.URL != "" {
					fmt.Fprintf(&sb, " [%s]", r.URL)
				}
				sb.WriteString("\n")
			}
		}
	}

	return sb.String()
}

// collectMonthlyReports fetches all monthly reports for a given year from weekly_reports table
func (c *YearlyDataCollector) collectMonthlyReports(ctx context.Context, year int) []MonthlyReportSummary {
	queryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Monthly slugs are like "2025-01" through "2025-12"
	query := `
		SELECT week_slug, headline, COALESCE(summary, ''),
			   COALESCE(narrative::text, '{}'),
			   COALESCE(top_shorted::text, '[]')
		FROM weekly_reports
		WHERE week_slug LIKE $1
		  AND published_at IS NOT NULL
		ORDER BY week_slug ASC
	`
	pattern := fmt.Sprintf("%d-__", year) // matches "2025-01" through "2025-12"

	rows, err := c.db.Query(queryCtx, query, pattern)
	if err != nil {
		log.Printf("WARNING: failed to fetch monthly reports: %v", err)
		return nil
	}
	defer rows.Close()

	var reports []MonthlyReportSummary
	for rows.Next() {
		var r MonthlyReportSummary
		var narrativeJSON, topJSON string
		if err := rows.Scan(&r.Slug, &r.Headline, &r.Summary, &narrativeJSON, &topJSON); err != nil {
			log.Printf("WARNING: failed to scan monthly report: %v", err)
			continue
		}
		// Filter out weekly slugs that accidentally match (e.g., "2025-W48" won't match "2025-__")
		if strings.Contains(r.Slug, "W") {
			continue
		}
		_ = json.Unmarshal([]byte(narrativeJSON), &r.Narrative)
		_ = json.Unmarshal([]byte(topJSON), &r.TopShorted)
		reports = append(reports, r)
	}

	return reports
}

// collectFinancialReports fetches financial report links from company-metadata for given stock codes
func (c *YearlyDataCollector) collectFinancialReports(ctx context.Context, codes []string) map[string][]FinancialReport {
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

	result := make(map[string][]FinancialReport)
	for rows.Next() {
		var code, reportsJSON string
		if err := rows.Scan(&code, &reportsJSON); err != nil {
			log.Printf("WARNING: failed to scan financial reports: %v", err)
			continue
		}
		var reports []FinancialReport
		if err := json.Unmarshal([]byte(reportsJSON), &reports); err != nil {
			log.Printf("WARNING: failed to parse financial reports for %s: %v", code, err)
			continue
		}
		// Keep only the most recent 3 reports per company to limit context size
		if len(reports) > 3 {
			reports = reports[:3]
		}
		if len(reports) > 0 {
			result[code] = reports
		}
	}

	return result
}
