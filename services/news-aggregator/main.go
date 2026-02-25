package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	portFlag := flag.String("port", "8080", "HTTP port for Cloud Run health checks")
	limitFlag := flag.Int("limit", 100, "Max articles per source per run")
	dryRun := flag.Bool("dry-run", false, "Fetch and parse but don't store")
	verbose := flag.Bool("verbose", false, "Verbose output")
	flag.Parse()

	ctx := context.Background()

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

	// Create news store
	store := NewNewsStore(db, *verbose)

	// Create RSS fetcher
	fetcher := NewRSSFetcher(*verbose)

	// For Cloud Run Jobs: process and exit
	// For Cloud Run Services: serve health check and process on schedule
	if os.Getenv("CLOUD_RUN_JOB") == "true" {
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

	duration := time.Since(startTime)
	log.Printf("Aggregation complete! Fetched: %d, Stored: %d, Duration: %s",
		totalFetched, totalStored, duration.Round(time.Millisecond))
}
