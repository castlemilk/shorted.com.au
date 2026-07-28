package weeklyreport

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// appendGenerationHistory fetches the current report and appends it to the
// generation_history JSONB array.
func appendGenerationHistory(ctx context.Context, db *pgxpool.Pool, weekSlug string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Fetch current report metadata
	var headline string
	var qualityScore *float64
	var model *string
	var createdAt time.Time
	err := db.QueryRow(queryCtx, `
		SELECT headline, quality_score, llm_model, created_at
		FROM weekly_reports WHERE week_slug = $1
	`, weekSlug).Scan(&headline, &qualityScore, &model, &createdAt)
	if err != nil {
		return nil // No existing report to archive
	}

	historyEntry := map[string]interface{}{
		"headline":      headline,
		"quality_score": qualityScore,
		"model":         model,
		"generated_at":  createdAt.Format(time.RFC3339),
	}
	entryJSON, err := json.Marshal(historyEntry)
	if err != nil {
		return fmt.Errorf("marshal history entry: %w", err)
	}

	_, err = db.Exec(queryCtx, `
		UPDATE weekly_reports
		SET generation_history = COALESCE(generation_history, '[]'::jsonb) || $1::jsonb
		WHERE week_slug = $2
	`, string(entryJSON), weekSlug)

	if err != nil {
		return fmt.Errorf("failed to append history: %w", err)
	}

	log.Printf("Archived previous report version for %s (headline: %s)", weekSlug, headline)
	return nil
}

func storeDataOnlyReport(ctx context.Context, db *pgxpool.Pool, weekSlug string, data *ReportData, dryRun bool) error {
	if dryRun {
		log.Println("DRY RUN - would store data-only report")
		return nil
	}

	// The standalone binary ignored these marshal errors; a failure there wrote
	// an empty string into a jsonb column and failed obscurely at the Exec.
	cols, err := marshalReportColumns(data)
	if err != nil {
		return err
	}

	headline := fmt.Sprintf("ASX Short Selling Report: Week %s", weekSlug)
	summary := fmt.Sprintf("Weekly short position data for %s. %d stocks tracked with an average short position of %.2f%%.",
		weekSlug, data.MarketStats.TotalStocksShorted, data.MarketStats.AvgShortPct)

	query := `
		INSERT INTO weekly_reports (
			week_slug, report_date, previous_date, headline, summary,
			narrative, top_shorted, risers, fallers, market_stats,
			industry_breakdown, published_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
		ON CONFLICT (week_slug) DO UPDATE SET
			report_date = EXCLUDED.report_date,
			previous_date = EXCLUDED.previous_date,
			headline = EXCLUDED.headline,
			summary = EXCLUDED.summary,
			top_shorted = EXCLUDED.top_shorted,
			risers = EXCLUDED.risers,
			fallers = EXCLUDED.fallers,
			market_stats = EXCLUDED.market_stats,
			-- Enrichment is WARN-and-continue: a failed industry query yields a
			-- NULL breakdown, which must never clobber a previously stored one.
			industry_breakdown = COALESCE(EXCLUDED.industry_breakdown, weekly_reports.industry_breakdown),
			published_at = NOW()
	`

	_, err = db.Exec(ctx, query,
		weekSlug, data.ReportDate, data.PreviousDate, headline, summary,
		`{}`, cols.top, cols.risers, cols.fallers, cols.stats,
		cols.industry,
	)
	return err
}

// reportColumns holds the JSONB-encoded data columns shared by both store paths.
type reportColumns struct {
	top, risers, fallers, stats string
	// industry is an interface so it can be SQL NULL when there is nothing to
	// store (a NULL must never clobber a previously stored breakdown).
	industry interface{}
}

func marshalReportColumns(data *ReportData) (reportColumns, error) {
	var cols reportColumns
	for _, f := range []struct {
		name string
		v    interface{}
		dst  *string
	}{
		{"top_shorted", data.TopShorted, &cols.top},
		{"risers", data.Risers, &cols.risers},
		{"fallers", data.Fallers, &cols.fallers},
		{"market_stats", data.MarketStats, &cols.stats},
	} {
		b, err := json.Marshal(f.v)
		if err != nil {
			return cols, fmt.Errorf("marshal %s: %w", f.name, err)
		}
		*f.dst = string(b)
	}
	cols.industry = marshalIndustryBreakdown(data)
	return cols, nil
}

// marshalIndustryBreakdown returns the industry breakdown as a JSONB arg,
// or nil (SQL NULL) when there is nothing to store.
func marshalIndustryBreakdown(data *ReportData) interface{} {
	if len(data.IndustryBreakdown) == 0 {
		return nil
	}
	b, err := json.Marshal(data.IndustryBreakdown)
	if err != nil {
		log.Printf("WARNING: failed to marshal industry breakdown: %v", err)
		return nil
	}
	return string(b)
}

func storeReport(ctx context.Context, db *pgxpool.Pool, weekSlug string, data *ReportData, narrative *NarrativeResult, quality *QualityResult) error {
	cols, err := marshalReportColumns(data)
	if err != nil {
		return err
	}
	narrativeJSON, err := json.Marshal(narrative.Narrative)
	if err != nil {
		return fmt.Errorf("marshal narrative: %w", err)
	}
	faqsJSON, err := json.Marshal(narrative.FAQs)
	if err != nil {
		return fmt.Errorf("marshal faqs: %w", err)
	}

	// Citations and trend insights may be empty — they stay SQL NULL then.
	var citationsArg, trendInsightsArg interface{}
	if len(narrative.Citations) > 0 {
		b, err := json.Marshal(narrative.Citations)
		if err != nil {
			return fmt.Errorf("marshal citations: %w", err)
		}
		citationsArg = string(b)
	}
	if len(data.TrendInsights) > 0 {
		b, err := json.Marshal(data.TrendInsights)
		if err != nil {
			return fmt.Errorf("marshal trend insights: %w", err)
		}
		trendInsightsArg = string(b)
	}

	var publishedAt *time.Time
	if quality.PublishReady {
		now := time.Now()
		publishedAt = &now
	}

	query := `
		INSERT INTO weekly_reports (
			week_slug, report_date, previous_date, headline, summary,
			narrative, top_shorted, risers, fallers, market_stats, faqs,
			quality_score, llm_model, retry_count, published_at,
			citations, trend_insights, industry_breakdown
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
		ON CONFLICT (week_slug) DO UPDATE SET
			report_date = EXCLUDED.report_date,
			previous_date = EXCLUDED.previous_date,
			headline = EXCLUDED.headline,
			summary = EXCLUDED.summary,
			narrative = EXCLUDED.narrative,
			top_shorted = EXCLUDED.top_shorted,
			risers = EXCLUDED.risers,
			fallers = EXCLUDED.fallers,
			market_stats = EXCLUDED.market_stats,
			faqs = EXCLUDED.faqs,
			quality_score = EXCLUDED.quality_score,
			llm_model = EXCLUDED.llm_model,
			retry_count = EXCLUDED.retry_count,
			published_at = EXCLUDED.published_at,
			citations = EXCLUDED.citations,
			trend_insights = EXCLUDED.trend_insights,
			-- Enrichment is WARN-and-continue: a failed industry query yields a
			-- NULL breakdown, which must never clobber a previously stored one.
			industry_breakdown = COALESCE(EXCLUDED.industry_breakdown, weekly_reports.industry_breakdown)
	`

	_, err = db.Exec(ctx, query,
		weekSlug, data.ReportDate, data.PreviousDate, narrative.Headline, narrative.Summary,
		string(narrativeJSON), cols.top, cols.risers, cols.fallers, cols.stats, string(faqsJSON),
		quality.Score, narrative.Model, narrative.RetryCount, publishedAt,
		citationsArg, trendInsightsArg, cols.industry,
	)
	return err
}
