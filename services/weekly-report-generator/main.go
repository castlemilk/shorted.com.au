package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

func main() {
	weekFlag := flag.String("week", "", "ISO week slug (e.g., 2026-W06). Defaults to current week.")
	monthFlag := flag.String("month", "", "Month slug (e.g., 2026-01). Generates monthly report instead of weekly.")
	yearFlag := flag.String("year", "", "Year (e.g., 2025). Generates year-in-review report.")
	dryRun := flag.Bool("dry-run", false, "Generate report but don't store it")
	forceFlag := flag.Bool("force", false, "Re-generate even if report already exists")
	maxRetries := flag.Int("max-retries", 1, "Maximum retry attempts on quality failure")
	flag.Parse()

	ctx := context.Background()

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "weekly-report-generator")
	if otelErr != nil {
		log.Printf("WARNING: Failed to initialize OpenTelemetry: %v", otelErr)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("Error shutting down OpenTelemetry: %v", err)
			}
		}()
	}

	// Determine report type and slug
	isYearly := *yearFlag != ""
	isMonthly := *monthFlag != ""
	slug := *weekFlag
	if isYearly {
		slug = *yearFlag
		log.Printf("Generating year-in-review report for %s", slug)
	} else if isMonthly {
		slug = *monthFlag
		log.Printf("Generating monthly report for %s", slug)
	} else {
		if slug == "" {
			year, week := time.Now().ISOWeek()
			slug = fmt.Sprintf("%d-W%02d", year, week)
		}
		log.Printf("Generating weekly report for %s", slug)
	}

	// Connect to database
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}

	poolConfig, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("Failed to parse database URL: %v", err)
	}
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	poolConfig.MaxConns = 2

	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Track sync metrics for observability
	syncStart := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "weekly-report-generator"))
	recordSyncResult := func(success bool) {
		shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
		status := "success"
		if !success {
			status = "failure"
		}
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "weekly-report-generator"),
			attribute.String("status", status),
		))
		if success {
			shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
		}
	}

	// Step 1: Collect data
	log.Println("Step 1: Collecting report data...")
	var data *ReportData
	if isYearly {
		collector := NewYearlyDataCollector(db)
		data, err = collector.Collect(ctx, slug)
	} else if isMonthly {
		collector := NewMonthlyDataCollector(db)
		data, err = collector.Collect(ctx, slug)
	} else {
		collector := NewDataCollector(db)
		data, err = collector.Collect(ctx, slug)
	}
	if err != nil {
		recordSyncResult(false)
		log.Fatalf("Failed to collect data: %v", err)
	}
	log.Printf("Collected data: %d top stocks, %d risers, %d fallers",
		len(data.TopShorted), len(data.Risers), len(data.Fallers))

	// Step 2: Generate narrative with LLM
	log.Println("Step 2: Generating narrative...")
	openaiKey := os.Getenv("OPENAI_API_KEY")
	if openaiKey == "" {
		log.Println("OPENAI_API_KEY not set, skipping narrative generation")
		if err := storeDataOnlyReport(ctx, db, slug, data, *dryRun); err != nil {
			recordSyncResult(false)
			log.Fatalf("Failed to store data-only report: %v", err)
		}
		recordSyncResult(true)
		log.Println("Stored data-only report (no narrative)")
		return
	}

	generator := NewLLMGenerator(openaiKey, os.Getenv("GEMINI_API_KEY"))
	narrative, err := generator.Generate(ctx, data)
	if err != nil {
		log.Printf("WARNING: LLM generation failed: %v", err)
		log.Println("Storing data-only report...")
		if err := storeDataOnlyReport(ctx, db, slug, data, *dryRun); err != nil {
			recordSyncResult(false)
			log.Fatalf("Failed to store data-only report: %v", err)
		}
		recordSyncResult(true)
		return
	}

	// Step 3: Quality check with best-of-N selection
	log.Println("Step 3: Running quality checks...")
	checker := NewQualityChecker(os.Getenv("GEMINI_API_KEY"))
	result, err := checker.Check(ctx, data, narrative)
	if err != nil {
		log.Printf("WARNING: Quality check failed: %v", err)
		result = &QualityResult{Score: 0.5, PublishReady: true}
	}

	// Track the best result across retries
	bestNarrative := narrative
	bestResult := result

	for attempt := 1; attempt <= *maxRetries && !result.PublishReady; attempt++ {
		log.Printf("Quality check failed (score: %.2f), retrying (%d/%d) with feedback...", result.Score, attempt, *maxRetries)
		narrative.RetryCount = attempt
		retryNarrative, retryErr := generator.GenerateWithFeedback(ctx, data, result.Feedback)
		if retryErr != nil {
			log.Printf("WARNING: Retry %d generation failed: %v", attempt, retryErr)
			break
		}

		retryResult, retryQErr := checker.Check(ctx, data, retryNarrative)
		if retryQErr != nil {
			log.Printf("WARNING: Retry %d quality check failed: %v", attempt, retryQErr)
			retryResult = &QualityResult{Score: 0.5, PublishReady: true}
		}

		// Keep the best result
		if retryResult.Score > bestResult.Score {
			bestNarrative = retryNarrative
			bestResult = retryResult
			log.Printf("  New best score: %.2f (attempt %d)", retryResult.Score, attempt)
		}

		result = retryResult
		narrative = retryNarrative
	}

	// Use the best result across all attempts
	narrative = bestNarrative
	result = bestResult
	log.Printf("Final quality: %.2f (publish_ready: %v, retries: %d)", result.Score, result.PublishReady, narrative.RetryCount)

	// Step 4: Store report (with generation history if force-overwriting)
	log.Println("Step 4: Storing report...")
	if *dryRun {
		log.Println("DRY RUN - would store report:")
		log.Printf("  Headline: %s", narrative.Headline)
		log.Printf("  Quality: %.2f (publish_ready: %v)", result.Score, result.PublishReady)
		reportJSON, _ := json.MarshalIndent(narrative, "", "  ")
		fmt.Println(string(reportJSON))
		return
	}

	// If --force, save previous version to generation_history before overwriting
	if *forceFlag {
		if err := appendGenerationHistory(ctx, db, slug); err != nil {
			log.Printf("WARNING: Failed to save generation history: %v", err)
		}
	}

	if err := storeReport(ctx, db, slug, data, narrative, result); err != nil {
		recordSyncResult(false)
		log.Fatalf("Failed to store report: %v", err)
	}
	recordSyncResult(true)

	log.Printf("Report stored: %s (quality: %.2f, published: %v)",
		slug, result.Score, result.PublishReady)

	// Trigger Next.js on-demand revalidation (if configured)
	revalidateURL := os.Getenv("REVALIDATION_URL")
	revalidateSecret := os.Getenv("REVALIDATION_SECRET")
	if revalidateURL != "" && revalidateSecret != "" {
		tag := "report-" + slug
		revalidateReq := fmt.Sprintf("%s?secret=%s&tag=%s", revalidateURL, revalidateSecret, tag)
		resp, err := http.Post(revalidateReq, "application/json", nil)
		if err != nil {
			log.Printf("WARNING: Failed to trigger revalidation: %v", err)
		} else {
			_ = resp.Body.Close()
			log.Printf("Triggered revalidation for tag=%s (status: %d)", tag, resp.StatusCode)
		}
	}
}

// appendGenerationHistory fetches the current report and appends it to the generation_history JSONB array
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
	entryJSON, _ := json.Marshal(historyEntry)

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

	topJSON, _ := json.Marshal(data.TopShorted)
	risersJSON, _ := json.Marshal(data.Risers)
	fallersJSON, _ := json.Marshal(data.Fallers)
	statsJSON, _ := json.Marshal(data.MarketStats)

	headline := fmt.Sprintf("ASX Short Selling Report: Week %s", weekSlug)
	summary := fmt.Sprintf("Weekly short position data for %s. %d stocks tracked with an average short position of %.2f%%.",
		weekSlug, data.MarketStats.TotalStocksShorted, data.MarketStats.AvgShortPct)

	query := `
		INSERT INTO weekly_reports (
			week_slug, report_date, previous_date, headline, summary,
			narrative, top_shorted, risers, fallers, market_stats,
			published_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		ON CONFLICT (week_slug) DO UPDATE SET
			report_date = EXCLUDED.report_date,
			previous_date = EXCLUDED.previous_date,
			headline = EXCLUDED.headline,
			summary = EXCLUDED.summary,
			top_shorted = EXCLUDED.top_shorted,
			risers = EXCLUDED.risers,
			fallers = EXCLUDED.fallers,
			market_stats = EXCLUDED.market_stats,
			published_at = NOW()
	`

	_, err := db.Exec(ctx, query,
		weekSlug, data.ReportDate, data.PreviousDate, headline, summary,
		string(`{}`), string(topJSON), string(risersJSON), string(fallersJSON), string(statsJSON),
	)
	return err
}

func storeReport(ctx context.Context, db *pgxpool.Pool, weekSlug string, data *ReportData, narrative *NarrativeResult, quality *QualityResult) error {
	topJSON, _ := json.Marshal(data.TopShorted)
	risersJSON, _ := json.Marshal(data.Risers)
	fallersJSON, _ := json.Marshal(data.Fallers)
	statsJSON, _ := json.Marshal(data.MarketStats)
	narrativeJSON, _ := json.Marshal(narrative.Narrative)
	faqsJSON, _ := json.Marshal(narrative.FAQs)

	// Marshal citations (may be nil/empty)
	var citationsJSON []byte
	if len(narrative.Citations) > 0 {
		citationsJSON, _ = json.Marshal(narrative.Citations)
	}

	// Marshal trend insights (may be nil/empty)
	var trendInsightsJSON []byte
	if len(data.TrendInsights) > 0 {
		trendInsightsJSON, _ = json.Marshal(data.TrendInsights)
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
			citations, trend_insights
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
			trend_insights = EXCLUDED.trend_insights
	`

	// Use nil for null JSONB columns
	var citationsArg, trendInsightsArg interface{}
	if citationsJSON != nil {
		citationsArg = string(citationsJSON)
	}
	if trendInsightsJSON != nil {
		trendInsightsArg = string(trendInsightsJSON)
	}

	_, err := db.Exec(ctx, query,
		weekSlug, data.ReportDate, data.PreviousDate, narrative.Headline, narrative.Summary,
		string(narrativeJSON), string(topJSON), string(risersJSON), string(fallersJSON), string(statsJSON), string(faqsJSON),
		quality.Score, narrative.Model, narrative.RetryCount, publishedAt,
		citationsArg, trendInsightsArg,
	)
	return err
}
