// Package news is the `shorted news` job, migrated from
// services/news-aggregator (docs/jobs-consolidation-plan.md Phase 2).
//
// It fetches the configured RSS/Atom sources through stealth HTTP, matches
// headlines to ASX codes, classifies sentiment (Gemini Flash with a keyword
// fallback) and stores them in news_articles — plus a set of one-shot
// maintenance modes that the standalone binary selected with the RUN_MODE env
// var:
//
//	-run-mode aggregate               fetch + store + cleanup + cluster + embed (default)
//	-run-mode backfill-images         scrape og:image for rows with no image_url
//	-run-mode resolve-googlenews      follow news.google.com redirects to the publisher
//	-run-mode cluster-news            group duplicate-event coverage into clusters
//	-run-mode embed-backfill          embed articles that have no vector yet
//	-run-mode embed-company-summaries embed company summaries + similar_to edges
//	-run-mode digest                  assemble the weekly news_digest broadcast draft
//	-run-mode serve                   legacy HTTP surface (/health + POST /run)
//
// RUN_MODE is still honoured as the DEFAULT for -run-mode, so the existing
// Cloud Scheduler container_overrides keep working unchanged; the flag wins
// when both are given.
package news

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/jobstatus"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// Run modes. The string values are the RUN_MODE values the deployed schedulers
// already set, so they must not be renamed.
const (
	modeAggregate    = "aggregate"
	modeBackfillImgs = "backfill-images"
	modeResolveGN    = "resolve-googlenews"
	modeCluster      = "cluster-news"
	modeEmbed        = "embed-backfill"
	modeEmbedCompany = "embed-company-summaries"
	modeDigest       = "digest"
	modeServe        = "serve"
)

const modeList = modeAggregate + " | " + modeBackfillImgs + " | " + modeResolveGN + " | " +
	modeCluster + " | " + modeEmbed + " | " + modeEmbedCompany + " | " + modeDigest + " | " + modeServe

// knownModes is every accepted -run-mode value.
var knownModes = map[string]bool{
	modeAggregate: true, modeBackfillImgs: true, modeResolveGN: true,
	modeCluster: true, modeEmbed: true, modeEmbedCompany: true,
	modeDigest: true, modeServe: true,
}

// dryRunModes are the modes whose write paths are actually gated by -dry-run.
// The others always write, so a -dry-run against them is refused rather than
// silently ignored (the standalone binary ignored it).
var dryRunModes = map[string]bool{
	modeAggregate:    true,
	modeBackfillImgs: true,
	modeResolveGN:    true,
	modeCluster:      true,
}

// otelServiceName is preserved from the standalone binary so existing
// dashboards/alerts keep resolving.
const otelServiceName = "news-aggregator"

// config is the parsed flag set. The standalone binary kept these in
// package-level flag vars; inside a shared binary those would leak across
// subcommands, so they are threaded explicitly instead.
type config struct {
	port    string
	limit   int
	dryRun  bool
	verbose bool
	runMode string
}

// Job returns the `shorted news` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "news",
		Desc:    "aggregate RSS news into news_articles (+ image/cluster/embedding/digest modes)",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the news aggregator. Flags match the standalone
// services/news-aggregator binary, with RUN_MODE promoted to a -run-mode flag.
func Run(parent context.Context, args []string) error {
	cfg, err := parseConfig(parent, args)
	if err != nil {
		return err
	}

	// OpenTelemetry (traces + metrics via OTLP); a no-op when
	// OTEL_EXPORTER_OTLP_ENDPOINT is unset. The service name is unchanged from
	// the standalone binary for dashboard continuity.
	otelShutdown, otelErr := shortedotel.InitProvider(parent, otelServiceName)
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

	db, err := platform.ConnectFromEnv(parent, platform.WithMaxConns(newsMaxConns))
	if err != nil {
		return err
	}
	defer db.Close()

	switch cfg.runMode {
	case modeBackfillImgs:
		return runBackfillImages(parent, db, cfg)
	case modeResolveGN:
		return runResolveGoogleNews(parent, db, cfg)
	case modeCluster:
		return runClusterNews(parent, db, cfg)
	case modeEmbed:
		return runEmbedBackfill(parent, db)
	case modeEmbedCompany:
		return runEmbedCompanySummaries(parent, db)
	case modeDigest:
		return runDigest(parent, db)
	case modeAggregate:
		return runAggregateMode(parent, db, cfg)
	case modeServe:
		return runServe(parent, db, cfg)
	default:
		return fmt.Errorf("unknown -run-mode %q (want %s)", cfg.runMode, modeList)
	}
}

// newsMaxConns preserves the standalone binary's pool posture (MaxConns = 3).
const newsMaxConns = 3

// parseConfig parses the job flags, defaulting -run-mode from $RUN_MODE and
// -dry-run/-verbose from the global flags, and rejecting an unknown mode or a
// -dry-run against a mode that would write anyway.
func parseConfig(ctx context.Context, args []string) (config, error) {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("news", flag.ContinueOnError)
	cfg := config{}
	fs.StringVar(&cfg.port, "port", "8080", "HTTP port for -run-mode serve (legacy Cloud Run service surface)")
	fs.IntVar(&cfg.limit, "limit", 100, "Max articles per source per run")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Fetch and parse but don't store")
	fs.BoolVar(&cfg.verbose, "verbose", globals.Verbose, "Verbose output")
	fs.StringVar(&cfg.runMode, "run-mode", platform.GetEnv("RUN_MODE", modeAggregate),
		"Which mode to run: "+modeList+" (defaults to $RUN_MODE)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return cfg, runner.ErrUsage
		}
		return cfg, err
	}
	if fs.NArg() > 0 {
		return cfg, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if !knownModes[cfg.runMode] {
		return cfg, fmt.Errorf("unknown -run-mode %q (want %s)", cfg.runMode, modeList)
	}
	if cfg.dryRun && !dryRunModes[cfg.runMode] {
		return cfg, fmt.Errorf("-run-mode %s always writes and does not honour -dry-run: refusing to run", cfg.runMode)
	}
	return cfg, nil
}

// aggregateDeps are the collaborators only the aggregate/serve modes need. The
// standalone binary built all of them up front, before the RUN_MODE switch, so
// a cluster-news or digest run paid for a stock-matcher query and a stealth
// engine it never used; they are constructed lazily here instead.
type aggregateDeps struct {
	fetcher *RSSFetcher
	matcher *StockMatcher
	store   *NewsStore
	close   func()
}

func newAggregateDeps(ctx context.Context, db *pgxpool.Pool, cfg config) (*aggregateDeps, error) {
	matcher, err := NewStockMatcher(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("build stock matcher: %w", err)
	}
	log.Printf("Loaded %d stock codes for matching", matcher.Count())

	// Sentiment analysis is best-effort: without a key (or on init failure) the
	// store falls back to the keyword heuristic.
	var analyzer *SentimentAnalyzer
	if geminiKey := os.Getenv("GEMINI_API_KEY"); geminiKey != "" {
		analyzer, err = NewSentimentAnalyzer(ctx, geminiKey)
		if err != nil {
			log.Printf("WARNING: Failed to create sentiment analyzer, falling back to keyword heuristic: %v", err)
			analyzer = nil
		} else {
			log.Println("Gemini Flash sentiment analyzer initialized")
		}
	}

	fetcher, err := NewRSSFetcher(cfg.verbose)
	if err != nil {
		return nil, err
	}
	return &aggregateDeps{
		fetcher: fetcher,
		matcher: matcher,
		store:   NewNewsStore(db, cfg.verbose, analyzer),
		close: func() {
			if err := fetcher.Close(); err != nil {
				log.Printf("WARNING: closing RSS fetcher: %v", err)
			}
			if analyzer != nil {
				analyzer.Close()
			}
		},
	}, nil
}

func runAggregateMode(ctx context.Context, db *pgxpool.Pool, cfg config) error {
	deps, err := newAggregateDeps(ctx, db, cfg)
	if err != nil {
		return err
	}
	defer deps.close()
	return runAggregation(ctx, deps.fetcher, deps.matcher, deps.store, cfg.limit, cfg.dryRun, cfg.verbose)
}

// runServe is the legacy Cloud Run SERVICE surface (/health + POST /run). In
// production news-aggregator is a Cloud Run JOB — which always sets
// CLOUD_RUN_JOB, so the standalone binary never reached this branch there. It
// is kept behind an explicit -run-mode serve rather than as the default
// fallback, so `shorted news` on a laptop aggregates and exits instead of
// silently becoming a server. See the README migration notes.
func runServe(ctx context.Context, db *pgxpool.Pool, cfg config) error {
	deps, err := newAggregateDeps(ctx, db, cfg)
	if err != nil {
		return err
	}
	defer deps.close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		go func() {
			if err := runAggregation(ctx, deps.fetcher, deps.matcher, deps.store, cfg.limit, cfg.dryRun, cfg.verbose); err != nil {
				log.Printf("WARN: aggregation failed: %v", err)
			}
		}()
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprint(w, "aggregation started")
	})

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	// SIGTERM cancels ctx; drain instead of dying mid-request.
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Printf("News aggregator listening on %s", srv.Addr)

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("news http server: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("news http shutdown: %w", err)
		}
		return nil
	}
}

// runBackfillImages scrapes og:image for stored articles that have none.
func runBackfillImages(ctx context.Context, db *pgxpool.Pool, cfg config) error {
	limit := envIntOr("BACKFILL_LIMIT", cfg.limit)
	concurrency := envIntOr("BACKFILL_CONCURRENCY", 4)
	// googlenews URLs are redirects through Google — skip them.
	// asx URLs are PDF announcements with no og:image — skip them.
	skip := []string{"googlenews", "asx"}
	if err := BackfillImages(ctx, db, BackfillImagesOpts{
		Limit:       limit,
		Concurrency: concurrency,
		SkipSources: skip,
		DryRun:      cfg.dryRun,
	}); err != nil {
		return fmt.Errorf("BackfillImages: %w", err)
	}
	return nil
}

// runResolveGoogleNews follows news.google.com redirects to the source
// publisher, scrapes og:image and (by default) rewrites the stored URL.
func runResolveGoogleNews(ctx context.Context, db *pgxpool.Pool, cfg config) error {
	// Defaults to UpdateURL=true so /shorts/[code]/news links go directly to
	// the publisher rather than Google's redirector.
	updateURL := true
	if v := os.Getenv("BACKFILL_UPDATE_URL"); v == "false" || v == "0" {
		updateURL = false
	}
	if err := ResolveGoogleNews(ctx, db, ResolveGoogleNewsOpts{
		Limit:       envIntOr("BACKFILL_LIMIT", 500),
		Concurrency: envIntOr("BACKFILL_CONCURRENCY", 4),
		DryRun:      cfg.dryRun,
		UpdateURL:   updateURL,
	}); err != nil {
		return fmt.Errorf("ResolveGoogleNews: %w", err)
	}
	return nil
}

// runClusterNews groups duplicate-event coverage by (stock_code, 3-gram
// headline shingles, 12h window) and writes shared cluster_id markers.
func runClusterNews(ctx context.Context, db *pgxpool.Pool, cfg config) error {
	if err := ClusterNews(ctx, db, ClusterNewsOpts{
		LookbackHours:     envIntOr("CLUSTER_LOOKBACK_HOURS", 48),
		MinShingleOverlap: envIntOr("CLUSTER_MIN_OVERLAP", 3),
		DryRun:            cfg.dryRun,
	}); err != nil {
		return fmt.Errorf("ClusterNews: %w", err)
	}
	return nil
}

// runEmbedBackfill generates Gemini embeddings for articles that have none yet,
// one embedBatchSize chunk at a time until the BACKFILL_LIMIT ceiling is hit or
// nothing is left.
func runEmbedBackfill(ctx context.Context, db *pgxpool.Pool) error {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return errors.New("embed-backfill requires GEMINI_API_KEY")
	}
	embedder, err := NewEmbedder(ctx, apiKey)
	if err != nil {
		return fmt.Errorf("NewEmbedder: %w", err)
	}
	defer func() { _ = embedder.Close() }()

	limit := envIntOr("BACKFILL_LIMIT", 500)
	total := 0
	for {
		// Cancellation must stop the walk: each chunk is a batch of Gemini
		// calls, and there is no point starting another one after SIGTERM.
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("embed-backfill cancelled after %d embedded: %w", total, err)
		}
		n, err := EmbedBackfill(ctx, db, embedder, EmbedBackfillOpts{Limit: embedBatchSize})
		if err != nil {
			return fmt.Errorf("EmbedBackfill: %w", err)
		}
		total += n
		if n == 0 || total >= limit {
			break
		}
		log.Printf("embed-backfill: %d embedded so far", total)
	}
	log.Printf("embed-backfill complete: %d articles embedded", total)
	return nil
}

// runEmbedCompanySummaries embeds company summaries then recomputes the
// similar_to entity edges from the resulting vectors.
func runEmbedCompanySummaries(ctx context.Context, db *pgxpool.Pool) error {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return errors.New("embed-company-summaries requires GEMINI_API_KEY")
	}
	embedder, err := NewEmbedder(ctx, apiKey)
	if err != nil {
		return fmt.Errorf("NewEmbedder: %w", err)
	}
	defer func() { _ = embedder.Close() }()

	// 0 = all eligible companies.
	limit := envIntOr("BACKFILL_LIMIT", 0)

	embedded, err := EmbedCompanySummaries(ctx, db, embedder, CompanyEmbedOpts{Limit: limit})
	if err != nil {
		return fmt.Errorf("EmbedCompanySummaries: %w", err)
	}
	log.Printf("embed-company-summaries: step 1 complete — %d company summaries embedded", embedded)

	edges, err := ComputeSimilarCompanies(ctx, db)
	if err != nil {
		return fmt.Errorf("ComputeSimilarCompanies: %w", err)
	}
	log.Printf("embed-company-summaries: step 2 complete — %d similar_to edges written", edges)
	log.Printf("embed-company-summaries complete: embedded=%d edges=%d", embedded, edges)
	return nil
}

// envIntOr reads an int env var, warning (and keeping def) when it is set but
// unparseable. The standalone binary used fmt.Sscanf and silently ignored the
// parse error on most of these call sites.
func envIntOr(key string, def int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		log.Printf("WARN: invalid %s %q, using %d", key, raw, def)
		return def
	}
	return n
}

type sourceFetcher interface {
	Fetch(context.Context, NewsSource, int) ([]*NewsArticleRaw, error)
}

type articleStore interface {
	StoreArticles(context.Context, []*NewsArticleRaw) (int, error)
}

type aggregationStats struct {
	fetched        int
	stored         int
	sourceFailures int
	storeFailures  int
	sources        int
}

func aggregateSources(ctx context.Context, fetcher sourceFetcher, matcher *StockMatcher, store articleStore, sources []NewsSource, limit int, dryRun, verbose bool) (aggregationStats, error) {
	stats := aggregationStats{sources: len(sources)}

	for _, source := range sources {
		// Each source is a network fetch plus a write; stop promptly on
		// SIGTERM rather than walking the rest of the feed list.
		if err := ctx.Err(); err != nil {
			return stats, fmt.Errorf("aggregation cancelled after %d/%d sources: %w", stats.fetched, stats.sources, err)
		}
		log.Printf("Fetching from %s (%s)...", source.Name, source.URL)

		articles, err := fetcher.Fetch(ctx, source, limit)
		if err != nil {
			stats.sourceFailures++
			log.Printf("  WARN: fetching %s failed: %v", source.Name, err)
			continue
		}

		stats.fetched += len(articles)
		log.Printf("  Fetched %d articles from %s", len(articles), source.Name)

		// Match articles to stock codes
		for _, article := range articles {
			if article.StockCode == "" {
				matched := matcher.Match(article.Headline)
				if matched != "" {
					article.StockCode = matched
				}
			}
		}

		if dryRun {
			for _, a := range articles {
				log.Printf("    [%s] %s — %s (%s)", a.StockCode, a.Headline, a.Source, a.PublishedAt)
			}
			continue
		}

		stored, err := store.StoreArticles(ctx, articles)
		if err != nil {
			stats.storeFailures++
			log.Printf("  WARN: storing articles from %s failed: %v", source.Name, err)
			continue
		}
		stats.stored += stored
		if verbose {
			log.Printf("  Stored %d new articles from %s", stored, source.Name)
		}
	}

	if stats.sources > 0 && stats.fetched == 0 && stats.sourceFailures == stats.sources {
		return stats, fmt.Errorf("all %d news sources failed; fetched 0 articles", stats.sources)
	}

	return stats, nil
}

func runAggregation(ctx context.Context, fetcher *RSSFetcher, matcher *StockMatcher, store *NewsStore, limit int, dryRun, verbose bool) error {
	startTime := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", otelServiceName))
	log.Println("Starting news aggregation run...")

	// Record this run in job_runs (skip dry-runs / local previews). Panic-safe:
	// a crash still lands a 'failed' row before propagating.
	var run *jobstatus.Run
	if !dryRun {
		run = jobstatus.Start(store.db, otelServiceName, "")
		defer func() {
			if rec := recover(); rec != nil {
				run.Fail(fmt.Errorf("panic: %v", rec))
				panic(rec)
			}
		}()
	}

	sources := GetDefaultSources()
	stats, err := aggregateSources(ctx, fetcher, matcher, store, sources, limit, dryRun, verbose)
	if err != nil {
		if run != nil {
			run.Fail(err)
		}
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", otelServiceName),
			attribute.String("status", "failed"),
		))
		return err
	}

	// Clean up old articles
	cleanupCtx, cleanupCancel := context.WithTimeout(ctx, 30*time.Second)
	defer cleanupCancel()
	tag, cleanupErr := store.db.Exec(cleanupCtx, "SELECT cleanup_old_news_articles()")
	if cleanupErr != nil {
		log.Printf("  WARNING: news cleanup failed (function may not exist yet): %v", cleanupErr)
	} else {
		log.Printf("  News cleanup completed: %v", tag)
	}

	// Cluster syndicated coverage (SMH/Age/WAtoday etc.) so the feed can
	// collapse duplicates. Inline so every run leaves the table clustered;
	// -run-mode cluster-news remains for manual/backfill runs.
	if !dryRun {
		if err := ClusterNews(ctx, store.db, ClusterNewsOpts{DryRun: dryRun}); err != nil {
			log.Printf("  WARNING: clustering failed: %v", err)
		}
	}

	// EMBED: generate vectors for any new, unembedded articles (best-effort)
	if apiKey := os.Getenv("GEMINI_API_KEY"); apiKey != "" && !dryRun {
		if embedder, err := NewEmbedder(ctx, apiKey); err != nil {
			log.Printf("  WARNING: embedder init failed: %v", err)
		} else {
			defer func() { _ = embedder.Close() }()
			if n, err := EmbedBackfill(ctx, store.db, embedder, EmbedBackfillOpts{Limit: 200}); err != nil {
				log.Printf("  WARNING: embedding step failed: %v", err)
			} else {
				log.Printf("  embedded %d new articles", n)
			}
		}
	}

	duration := time.Since(startTime)
	log.Printf("Aggregation complete! Fetched: %d, Stored: %d, Duration: %s",
		stats.fetched, stats.stored, duration.Round(time.Millisecond))

	if run != nil {
		run.CompleteWith(stats.stored, 0, map[string]any{
			"fetched": stats.fetched,
			"sources": len(sources),
		})
	}

	// Record sync metrics
	shortedotel.SyncDuration.Record(ctx, duration.Seconds(), syncAttrs)
	shortedotel.SyncRecordsProcessed.Add(ctx, int64(stats.stored), syncAttrs)
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", otelServiceName),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
	return nil
}
