// Package weeklyreport is the `shorted weekly-report` job, migrated from
// services/weekly-report-generator (docs/jobs-consolidation-plan.md Phase 2).
//
// It snapshots the week/month/year of short-position data, synthesises a
// narrative with a two-pass multi-model LLM pipeline, quality-gates it and
// upserts the result into weekly_reports as JSONB.
//
// CRITICAL: the struct json tags in this package are a wire contract with the
// proto — the shorts API json.Unmarshals these JSONB columns straight into
// generated proto structs. json_contract_test.go enforces it; do not rename a
// tag without regenerating the proto.
//
//	-week 2026-W06    explicit ISO week slug (default: current ISO week)
//	-month 2026-01    generate a monthly report instead
//	-year 2025        generate a year-in-review report instead
//	-report-type      weekly|monthly|yearly hint when no slug is given
//	                  (also read from $REPORT_TYPE, for Cloud Scheduler)
//	-dry-run          generate but don't store
//	-force            archive the existing report into generation_history first
//	-max-retries N    retry attempts on a quality-gate failure
//	-print-data       dump the collected ReportData JSON and exit
//	-print-prompt     print the exact LLM user prompt and exit
package weeklyreport

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// otelServiceName is preserved from the standalone binary so existing
// dashboards/alerts keep resolving.
const otelServiceName = "weekly-report-generator"

// maxConns preserves the standalone binary's pool posture (MaxConns = 2).
const maxConns = 2

// config is the parsed flag set. The standalone binary kept these in
// package-level flag vars; inside a shared binary those would leak across
// subcommands, so they are threaded explicitly instead.
type config struct {
	week        string
	month       string
	year        string
	reportType  string
	dryRun      bool
	force       bool
	maxRetries  int
	printData   bool
	printPrompt bool
}

// Job returns the `shorted weekly-report` subcommand. It honours -dry-run (the
// snapshot + LLM passes still run; nothing is written).
func Job() runner.Job {
	return runner.Func{
		JobName: "weekly-report",
		Desc:    "generate the weekly/monthly/yearly short-selling report (snapshot → LLM → quality gate → store)",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the report generator. Flags are identical to the standalone
// services/weekly-report-generator binary.
//
// The original called log.Fatalf on every failure path; inside a shared binary
// that would skip deferred cleanup (pool close, otel flush, the per-run LLM
// usage summary) and bypass the runner's end-of-job logging, so each returns an
// error with the same message text instead.
func Run(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("weekly-report", flag.ContinueOnError)
	cfg := config{}
	fs.StringVar(&cfg.week, "week", "", "ISO week slug (e.g., 2026-W06). Defaults to current week.")
	fs.StringVar(&cfg.month, "month", "", "Month slug (e.g., 2026-01). Generates monthly report instead of weekly.")
	fs.StringVar(&cfg.year, "year", "", "Year (e.g., 2025). Generates year-in-review report.")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Generate report but don't store it")
	fs.BoolVar(&cfg.force, "force", false, "Re-generate even if report already exists")
	fs.IntVar(&cfg.maxRetries, "max-retries", 1, "Maximum retry attempts on quality failure")
	fs.StringVar(&cfg.reportType, "report-type", "", "Report type hint: 'weekly', 'monthly', or 'yearly'. Used by Cloud Scheduler to disambiguate when no explicit slug is provided.")
	fs.BoolVar(&cfg.printData, "print-data", false, "Collect data, dump the ReportData JSON to stdout, and exit (prompt-iteration workflow)")
	fs.BoolVar(&cfg.printPrompt, "print-prompt", false, "Collect data, print the exact LLM user prompt, and exit (prompt-iteration workflow)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	// OpenTelemetry (traces + metrics via OTLP); a no-op when
	// OTEL_EXPORTER_OTLP_ENDPOINT is unset. Service name unchanged from the
	// standalone binary for dashboard continuity.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, otelServiceName)
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

	kind, slug := resolveTarget(cfg, time.Now())
	switch kind {
	case reportYearly:
		log.Printf("Generating year-in-review report for %s", slug)
	case reportMonthly:
		log.Printf("Generating monthly report for %s", slug)
	default:
		log.Printf("Generating weekly report for %s", slug)
	}

	db, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(maxConns))
	if err != nil {
		return err
	}
	defer db.Close()

	return generate(ctx, db, cfg, kind, slug)
}

// reportKind is which cadence of report a run produces.
type reportKind int

const (
	reportWeekly reportKind = iota
	reportMonthly
	reportYearly
)

// resolveTarget picks the report cadence and slug from the flags, falling back
// to the REPORT_TYPE env var (Cloud Scheduler env overrides can't pass args)
// and finally to the current ISO week. `now` is injected so the auto-detect
// branches are testable.
func resolveTarget(cfg config, now time.Time) (reportKind, string) {
	if cfg.year != "" {
		return reportYearly, cfg.year
	}
	if cfg.month != "" {
		return reportMonthly, cfg.month
	}

	hint := cfg.reportType
	if hint == "" {
		hint = os.Getenv("REPORT_TYPE")
	}
	switch hint {
	case "monthly":
		// Auto monthly: previous month.
		prev := now.AddDate(0, -1, 0)
		return reportMonthly, fmt.Sprintf("%d-%02d", prev.Year(), prev.Month())
	case "yearly":
		// Auto yearly: previous year.
		return reportYearly, fmt.Sprintf("%d", now.Year()-1)
	default:
		// Auto weekly: current ISO week.
		if cfg.week != "" {
			return reportWeekly, cfg.week
		}
		year, week := now.ISOWeek()
		return reportWeekly, fmt.Sprintf("%d-W%02d", year, week)
	}
}

// generate runs the four report steps: collect → narrate → quality-gate →
// store (+ broadcast draft + cache bust).
func generate(ctx context.Context, db *pgxpool.Pool, cfg config, kind reportKind, slug string) error {
	// Track sync metrics for observability.
	syncStart := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", otelServiceName))
	recordSyncResult := func(success bool) {
		shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
		status := "success"
		if !success {
			status = "failure"
		}
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", otelServiceName),
			attribute.String("status", status),
		))
		if success {
			shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
		}
	}

	// Step 1: Collect data
	log.Println("Step 1: Collecting report data...")
	var (
		data *ReportData
		err  error
	)
	switch kind {
	case reportYearly:
		data, err = NewYearlyDataCollector(db).Collect(ctx, slug)
	case reportMonthly:
		data, err = NewMonthlyDataCollector(db).Collect(ctx, slug)
	default:
		data, err = NewDataCollector(db).Collect(ctx, slug)
	}
	if err != nil {
		recordSyncResult(false)
		return fmt.Errorf("collect data: %w", err)
	}
	log.Printf("Collected data: %d top stocks, %d risers, %d fallers, %d industries",
		len(data.TopShorted), len(data.Risers), len(data.Fallers), len(data.IndustryBreakdown))

	// Debug workflows: dump the collected data or the exact LLM user prompt, then exit.
	if cfg.printData {
		out, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal report data: %w", err)
		}
		fmt.Println(string(out))
		return nil
	}
	if cfg.printPrompt {
		fmt.Println(buildUserPrompt(data, ""))
		return nil
	}

	// Step 2: Generate narrative with LLM
	log.Println("Step 2: Generating narrative...")
	openaiKey := os.Getenv("OPENAI_API_KEY")
	if openaiKey == "" {
		log.Println("OPENAI_API_KEY not set, skipping narrative generation")
		if err := storeDataOnlyReport(ctx, db, slug, data, cfg.dryRun); err != nil {
			recordSyncResult(false)
			return fmt.Errorf("store data-only report: %w", err)
		}
		recordSyncResult(true)
		log.Println("Stored data-only report (no narrative)")
		return nil
	}

	generator := NewLLMGenerator(openaiKey, os.Getenv("GEMINI_API_KEY"))
	// Per-model token usage/cost totals for the run — logged on every exit
	// path past this point (LLM calls have been made by then). Unlike the
	// standalone binary's log.Fatalf paths, the error returns below DO reach
	// this deferred summary.
	defer logRunUsageSummary(slug)

	narrative, err := generator.Generate(ctx, data)
	if err != nil {
		log.Printf("WARNING: LLM generation failed: %v", err)
		log.Println("Storing data-only report...")
		if err := storeDataOnlyReport(ctx, db, slug, data, cfg.dryRun); err != nil {
			recordSyncResult(false)
			return fmt.Errorf("store data-only report: %w", err)
		}
		recordSyncResult(true)
		return nil
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

	for attempt := 1; attempt <= cfg.maxRetries && !result.PublishReady; attempt++ {
		// Each retry is another multi-model round trip; don't start one after
		// SIGTERM.
		if ctxErr := ctx.Err(); ctxErr != nil {
			log.Printf("WARNING: cancelled before retry %d: %v", attempt, ctxErr)
			break
		}
		log.Printf("Quality check failed (score: %.2f), retrying (%d/%d) with feedback...", result.Score, attempt, cfg.maxRetries)
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
	if cfg.dryRun {
		log.Println("DRY RUN - would store report:")
		log.Printf("  Headline: %s", narrative.Headline)
		log.Printf("  Quality: %.2f (publish_ready: %v)", result.Score, result.PublishReady)
		reportJSON, err := json.MarshalIndent(narrative, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal narrative: %w", err)
		}
		fmt.Println(string(reportJSON))
		return nil
	}

	// With -force, save the previous version to generation_history before
	// overwriting it.
	if cfg.force {
		if err := appendGenerationHistory(ctx, db, slug); err != nil {
			log.Printf("WARNING: Failed to save generation history: %v", err)
		}
	}

	if err := storeReport(ctx, db, slug, data, narrative, result); err != nil {
		recordSyncResult(false)
		return fmt.Errorf("store report: %w", err)
	}
	recordSyncResult(true)

	log.Printf("Report stored: %s (quality: %.2f, published: %v)",
		slug, result.Score, result.PublishReady)

	// Insert a draft broadcast row so an admin can review + send the email.
	// Non-fatal: a broadcast draft failure must never abort the report run.
	// Yearly reports are not broadcast (type not in CHECK constraint).
	if result.PublishReady && kind != reportYearly {
		broadcastKind := "weekly_report"
		if kind == reportMonthly {
			broadcastKind = "monthly_report"
		}
		if err := insertReportBroadcastDraft(ctx, db, broadcastKind, slug, narrative.Headline, narrative.Summary); err != nil {
			log.Printf("broadcast draft (non-fatal): %v", err)
		}
	}

	// Trigger Next.js on-demand revalidation (no-op when REVALIDATION_URL /
	// REVALIDATION_SECRET are unset). This job busts by TAG (report-<slug>),
	// not by path — the shared helper now carries a Tag as well as Paths.
	platform.PingRevalidate(platform.RevalidateRequest{
		Reason: "weekly-report",
		Tag:    "report-" + slug,
	})
	return nil
}
