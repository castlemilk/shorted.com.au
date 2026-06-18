package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

func main() {
	portFlag := flag.String("port", "8080", "HTTP port for Cloud Run health checks")
	limitFlag := flag.Int("limit", 100, "Max articles per source per run")
	dryRun := flag.Bool("dry-run", false, "Fetch and parse but don't store")
	verbose := flag.Bool("verbose", false, "Verbose output")
	flag.Parse()

	ctx := context.Background()

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "news-aggregator")
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
	poolConfig.MaxConns = 3

	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Load stock code to company name mapping for matching
	matcher, err := NewStockMatcher(ctx, db)
	if err != nil {
		log.Fatalf("Failed to build stock matcher: %v", err)
	}
	log.Printf("Loaded %d stock codes for matching", matcher.Count())

	// Create sentiment analyzer if Gemini API key is available
	var analyzer *SentimentAnalyzer
	if geminiKey := os.Getenv("GEMINI_API_KEY"); geminiKey != "" {
		var analyzerErr error
		analyzer, analyzerErr = NewSentimentAnalyzer(ctx, geminiKey)
		if analyzerErr != nil {
			log.Printf("WARNING: Failed to create sentiment analyzer, falling back to keyword heuristic: %v", analyzerErr)
		} else {
			log.Println("Gemini Flash sentiment analyzer initialized")
		}
	}

	// Create news store
	store := NewNewsStore(db, *verbose, analyzer)

	// Create RSS fetcher (stealth HTTP backed)
	fetcher := NewRSSFetcher(*verbose)
	defer func() { _ = fetcher.Close() }()

	// One-shot OG-image backfill mode: RUN_MODE=backfill-images
	// Scrapes og:image from existing article URLs that have no image_url.
	if os.Getenv("RUN_MODE") == "backfill-images" {
		limit := *limitFlag
		if envLimit := os.Getenv("BACKFILL_LIMIT"); envLimit != "" {
			if n, parseErr := fmt.Sscanf(envLimit, "%d", &limit); parseErr != nil || n != 1 {
				log.Printf("WARN: invalid BACKFILL_LIMIT %q, using %d", envLimit, limit)
			}
		}
		concurrency := 4
		if envC := os.Getenv("BACKFILL_CONCURRENCY"); envC != "" {
			_, _ = fmt.Sscanf(envC, "%d", &concurrency)
		}
		// googlenews URLs are redirects through Google — skip them.
		// asx URLs are PDF announcements with no og:image — skip them.
		skip := []string{"googlenews", "asx"}
		if err := BackfillImages(ctx, db, BackfillImagesOpts{
			Limit:       limit,
			Concurrency: concurrency,
			SkipSources: skip,
			DryRun:      *dryRun,
		}); err != nil {
			log.Fatalf("BackfillImages failed: %v", err)
		}
		return
	}

	// One-shot Google News resolver mode: RUN_MODE=resolve-googlenews
	// Follows the news.google.com redirect to the source publisher,
	// scrapes og:image, and updates the article row (optionally also
	// rewriting url to the resolved publisher URL).
	if os.Getenv("RUN_MODE") == "resolve-googlenews" {
		limit := 500
		if envLimit := os.Getenv("BACKFILL_LIMIT"); envLimit != "" {
			_, _ = fmt.Sscanf(envLimit, "%d", &limit)
		}
		concurrency := 4
		if envC := os.Getenv("BACKFILL_CONCURRENCY"); envC != "" {
			_, _ = fmt.Sscanf(envC, "%d", &concurrency)
		}
		// Defaults to UpdateURL=true so /shorts/[code]/news links go
		// directly to the publisher rather than Google's redirector.
		updateURL := true
		if v := os.Getenv("BACKFILL_UPDATE_URL"); v == "false" || v == "0" {
			updateURL = false
		}
		if err := ResolveGoogleNews(ctx, db, ResolveGoogleNewsOpts{
			Limit:       limit,
			Concurrency: concurrency,
			DryRun:      *dryRun,
			UpdateURL:   updateURL,
		}); err != nil {
			log.Fatalf("ResolveGoogleNews failed: %v", err)
		}
		return
	}

	// One-shot story-clustering mode: RUN_MODE=cluster-news
	// Groups duplicate-event coverage by (stock_code, 3-gram headline
	// shingles, 12h window) and writes shared cluster_id markers.
	if os.Getenv("RUN_MODE") == "cluster-news" {
		lookbackHours := 48
		if v := os.Getenv("CLUSTER_LOOKBACK_HOURS"); v != "" {
			_, _ = fmt.Sscanf(v, "%d", &lookbackHours)
		}
		minOverlap := 3
		if v := os.Getenv("CLUSTER_MIN_OVERLAP"); v != "" {
			_, _ = fmt.Sscanf(v, "%d", &minOverlap)
		}
		if err := ClusterNews(ctx, db, ClusterNewsOpts{
			LookbackHours:     lookbackHours,
			MinShingleOverlap: minOverlap,
			DryRun:            *dryRun,
		}); err != nil {
			log.Fatalf("ClusterNews failed: %v", err)
		}
		return
	}

	// One-shot embedding backfill mode: RUN_MODE=embed-backfill
	// Generates Gemini text-embedding-004 vectors for articles that have none yet.
	if os.Getenv("RUN_MODE") == "embed-backfill" {
		apiKey := os.Getenv("GEMINI_API_KEY")
		if apiKey == "" {
			log.Fatal("embed-backfill requires GEMINI_API_KEY")
		}
		embedder, err := NewEmbedder(ctx, apiKey)
		if err != nil {
			log.Fatalf("NewEmbedder failed: %v", err)
		}
		defer embedder.Close()

		limit := 500
		if v := os.Getenv("BACKFILL_LIMIT"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				limit = n
			} else {
				log.Printf("WARN: invalid BACKFILL_LIMIT %q, using %d", v, limit)
			}
		}
		total := 0
		for {
			n, err := EmbedBackfill(ctx, db, embedder, EmbedBackfillOpts{Limit: embedBatchSize})
			if err != nil {
				log.Fatalf("EmbedBackfill failed: %v", err)
			}
			total += n
			if n == 0 || total >= limit {
				break
			}
			log.Printf("embed-backfill: %d embedded so far", total)
		}
		log.Printf("embed-backfill complete: %d articles embedded", total)
		return
	}

	// For Cloud Run Jobs: process and exit
	// For Cloud Run Services: serve health check and process on schedule
	if os.Getenv("CLOUD_RUN_JOB") != "" {
		runAggregation(ctx, fetcher, matcher, store, *limitFlag, *dryRun, *verbose)
		return
	}

	// HTTP server for Cloud Run service mode
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "ok")
	})
	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		go runAggregation(ctx, fetcher, matcher, store, *limitFlag, *dryRun, *verbose)
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprintf(w, "aggregation started")
	})

	addr := ":" + *portFlag
	log.Printf("News aggregator listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func runAggregation(ctx context.Context, fetcher *RSSFetcher, matcher *StockMatcher, store *NewsStore, limit int, dryRun, verbose bool) {
	startTime := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "news-aggregator"))
	log.Println("Starting news aggregation run...")

	sources := GetDefaultSources()
	totalFetched := 0
	totalStored := 0

	for _, source := range sources {
		log.Printf("Fetching from %s (%s)...", source.Name, source.URL)

		articles, err := fetcher.Fetch(ctx, source, limit)
		if err != nil {
			log.Printf("  ERROR fetching %s: %v", source.Name, err)
			continue
		}

		totalFetched += len(articles)
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
			log.Printf("  ERROR storing articles from %s: %v", source.Name, err)
			continue
		}
		totalStored += stored
		if verbose {
			log.Printf("  Stored %d new articles from %s", stored, source.Name)
		}
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
	// RUN_MODE=cluster-news remains for manual/backfill runs.
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
			defer embedder.Close()
			if n, err := EmbedBackfill(ctx, store.db, embedder, EmbedBackfillOpts{Limit: 200}); err != nil {
				log.Printf("  WARNING: embedding step failed: %v", err)
			} else {
				log.Printf("  embedded %d new articles", n)
			}
		}
	}

	duration := time.Since(startTime)
	log.Printf("Aggregation complete! Fetched: %d, Stored: %d, Duration: %s",
		totalFetched, totalStored, duration.Round(time.Millisecond))

	// Record sync metrics
	shortedotel.SyncDuration.Record(ctx, duration.Seconds(), syncAttrs)
	shortedotel.SyncRecordsProcessed.Add(ctx, int64(totalStored), syncAttrs)
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", "news-aggregator"),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
}
