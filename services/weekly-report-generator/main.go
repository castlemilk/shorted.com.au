package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	weekFlag := flag.String("week", "", "ISO week slug (e.g., 2026-W06). Defaults to current week.")
	dryRun := flag.Bool("dry-run", false, "Generate report but don't store it")
	flag.Parse()

	ctx := context.Background()

	// Determine week slug
	weekSlug := *weekFlag
	if weekSlug == "" {
		year, week := time.Now().ISOWeek()
		weekSlug = fmt.Sprintf("%d-W%02d", year, week)
	}
	log.Printf("Generating weekly report for %s", weekSlug)

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
	poolConfig.MaxConns = 5

	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Step 1: Collect data
	log.Println("Step 1: Collecting report data...")
	collector := NewDataCollector(db)
	data, err := collector.Collect(ctx, weekSlug)
	if err != nil {
		log.Fatalf("Failed to collect data: %v", err)
	}
	log.Printf("Collected data: %d top stocks, %d risers, %d fallers",
		len(data.TopShorted), len(data.Risers), len(data.Fallers))

	// Step 2: Generate narrative with LLM
	log.Println("Step 2: Generating narrative...")
	openaiKey := os.Getenv("OPENAI_API_KEY")
	if openaiKey == "" {
		log.Println("OPENAI_API_KEY not set, skipping narrative generation")
		if err := storeDataOnlyReport(ctx, db, weekSlug, data, *dryRun); err != nil {
			log.Fatalf("Failed to store data-only report: %v", err)
		}
		log.Println("Stored data-only report (no narrative)")
		return
	}

	generator := NewLLMGenerator(openaiKey)
	narrative, err := generator.Generate(ctx, data)
	if err != nil {
		log.Printf("WARNING: LLM generation failed: %v", err)
		log.Println("Storing data-only report...")
		if err := storeDataOnlyReport(ctx, db, weekSlug, data, *dryRun); err != nil {
			log.Fatalf("Failed to store data-only report: %v", err)
		}
		return
	}

	// Step 3: Quality check
	log.Println("Step 3: Running quality checks...")
	checker := NewQualityChecker(os.Getenv("GEMINI_API_KEY"))
	result, err := checker.Check(ctx, data, narrative)
	if err != nil {
		log.Printf("WARNING: Quality check failed: %v", err)
		result = &QualityResult{Score: 0.5, PublishReady: true}
	}

	if !result.PublishReady && narrative.RetryCount == 0 {
		log.Println("Quality check failed, retrying generation with feedback...")
		narrative.RetryCount = 1
		narrative, err = generator.GenerateWithFeedback(ctx, data, result.Feedback)
		if err != nil {
			log.Printf("WARNING: Retry generation failed: %v", err)
		} else {
			result, err = checker.Check(ctx, data, narrative)
			if err != nil {
				log.Printf("WARNING: Retry quality check failed: %v", err)
				result = &QualityResult{Score: 0.5, PublishReady: true}
			}
		}
	}

	// Step 4: Store report
	log.Println("Step 4: Storing report...")
	if *dryRun {
		log.Println("DRY RUN - would store report:")
		log.Printf("  Headline: %s", narrative.Headline)
		log.Printf("  Quality: %.2f (publish_ready: %v)", result.Score, result.PublishReady)
		reportJSON, _ := json.MarshalIndent(narrative, "", "  ")
		fmt.Println(string(reportJSON))
		return
	}

	if err := storeReport(ctx, db, weekSlug, data, narrative, result); err != nil {
		log.Fatalf("Failed to store report: %v", err)
	}

	log.Printf("Report stored: %s (quality: %.2f, published: %v)",
		weekSlug, result.Score, result.PublishReady)
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

	var publishedAt *time.Time
	if quality.PublishReady {
		now := time.Now()
		publishedAt = &now
	}

	query := `
		INSERT INTO weekly_reports (
			week_slug, report_date, previous_date, headline, summary,
			narrative, top_shorted, risers, fallers, market_stats, faqs,
			quality_score, llm_model, retry_count, published_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
			published_at = EXCLUDED.published_at
	`

	_, err := db.Exec(ctx, query,
		weekSlug, data.ReportDate, data.PreviousDate, narrative.Headline, narrative.Summary,
		string(narrativeJSON), string(topJSON), string(risersJSON), string(fallersJSON), string(statsJSON), string(faqsJSON),
		quality.Score, narrative.Model, narrative.RetryCount, publishedAt,
	)
	return err
}
