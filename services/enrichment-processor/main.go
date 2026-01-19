package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"cloud.google.com/go/pubsub" //nolint:staticcheck // TODO: migrate to cloud.google.com/go/pubsub/v2
	"cloud.google.com/go/storage"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts"
	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"
)

type enrichmentJobMessage struct {
	JobID     string `json:"job_id"`
	StockCode string `json:"stock_code"`
	Force     bool   `json:"force"`
}

// findVenvPython looks for a Python virtual environment in the enrichment-processor directory
// Returns the path to the venv Python executable if found, empty string otherwise
func findVenvPython() string {
	// Check for venv in enrichment-processor directory
	venvPath := filepath.Join("enrichment-processor", "venv", "bin", "python3")
	if _, err := os.Stat(venvPath); err == nil {
		absPath, err := filepath.Abs(venvPath)
		if err == nil {
			return absPath
		}
	}
	
	// Also check current directory (when running from services/)
	venvPath = filepath.Join(".", "enrichment-processor", "venv", "bin", "python3")
	if _, err := os.Stat(venvPath); err == nil {
		absPath, err := filepath.Abs(venvPath)
		if err == nil {
			return absPath
		}
	}
	
	return ""
}

func main() {
	ctx := context.Background()
	logger := log.NewLogger()
	logger.SetLevel("debug")

	// Load configuration from environment
	projectID := os.Getenv("GCP_PROJECT_ID")
	topicName := os.Getenv("ENRICHMENT_PUBSUB_TOPIC")
	if topicName == "" {
		topicName = "enrichment-jobs"
	}

	subscriptionName := os.Getenv("ENRICHMENT_PUBSUB_SUBSCRIPTION")
	if subscriptionName == "" {
		subscriptionName = "enrichment-jobs-subscription"
	}

	// Initialize store
	storeConfig := shorts.EnrichmentStoreConfig{
		PostgresAddress:  os.Getenv("APP_STORE_POSTGRES_ADDRESS"),
		PostgresDatabase: os.Getenv("APP_STORE_POSTGRES_DATABASE"),
		PostgresUsername: os.Getenv("APP_STORE_POSTGRES_USERNAME"),
		PostgresPassword: os.Getenv("APP_STORE_POSTGRES_PASSWORD"),
	}

	if storeConfig.PostgresAddress == "" || storeConfig.PostgresDatabase == "" || storeConfig.PostgresUsername == "" || storeConfig.PostgresPassword == "" {
		log.Fatalf("PostgreSQL environment variables are required: APP_STORE_POSTGRES_ADDRESS, APP_STORE_POSTGRES_DATABASE, APP_STORE_POSTGRES_USERNAME, APP_STORE_POSTGRES_PASSWORD")
	}

	enrichmentStore, err := shorts.NewEnrichmentStore(storeConfig)
	if err != nil {
		log.Fatalf("failed to create store: %v", err)
	}

	// Initialize LLM client (OpenAI or Gemini)
	// Default to OpenAI, but allow override with ENRICHMENT_MODEL env var
	modelProvider := strings.ToLower(strings.TrimSpace(os.Getenv("ENRICHMENT_MODEL")))
	if modelProvider == "" {
		modelProvider = "openai" // Default
	}

	var gptClient enrichment.GPTClient
	switch modelProvider {
	case "gemini":
		geminiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
		if geminiKey == "" {
			log.Fatalf("GEMINI_API_KEY environment variable is required when ENRICHMENT_MODEL=gemini")
		}
		gptClient, err = enrichment.NewGeminiGPTClient(geminiKey)
		if err != nil {
			log.Fatalf("failed to create Gemini client: %v", err)
		}
		logger.Infof("Using Gemini model for enrichment")
	case "openai", "":
		openAIKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		if openAIKey == "" {
			log.Fatalf("OPENAI_API_KEY environment variable is required")
		}
		gptClient, err = enrichment.NewOpenAIGPTClient(openAIKey)
		if err != nil {
			log.Fatalf("failed to create OpenAI client: %v", err)
		}
		logger.Infof("Using OpenAI model for enrichment")
	default:
		log.Fatalf("Invalid ENRICHMENT_MODEL: %s (must be 'openai' or 'gemini')", modelProvider)
	}

	// Initialize report crawler
	reportCrawler := enrichment.NewReportCrawler()

	// Initialize metadata scraper
	metadataScraper := enrichment.NewMetadataScraper()

	// Initialize logo discoverer
	logoDiscoverer := enrichment.NewLogoDiscoverer()

	// Initialize Exa client (optional)
	var exaClient enrichment.ExaClient
	exaKey := strings.TrimSpace(os.Getenv("EXA_API_KEY"))
	if exaKey != "" {
		var exaErr error
		exaClient, exaErr = enrichment.NewExaClient(exaKey)
		if exaErr != nil {
			logger.Warnf("Failed to create Exa client: %v (continuing without Exa search)", exaErr)
			exaClient = nil
		} else {
			logger.Infof("Exa AI client initialized for people search")
		}
	}

	// Initialize Pub/Sub client (only if GCP_PROJECT_ID is set)
	// If Pub/Sub fails, fall back to local polling mode
	var subscription *pubsub.Subscription
	if projectID != "" {
		pubsubClient, err := pubsub.NewClient(ctx, projectID)
		if err != nil {
			logger.Warnf("Failed to create Pub/Sub client: %v (falling back to local polling mode)", err)
			projectID = "" // Force local polling mode
		} else {
			defer func() {
				if err := pubsubClient.Close(); err != nil {
					logger.Warnf("Failed to close Pub/Sub client: %v", err)
				}
			}()

			// Get subscription - assume it exists (created by Terraform)
			// If subscription name is provided via env var, we trust it exists
			// The Receive() call will fail gracefully if it doesn't exist or we lack permissions
			subscription = pubsubClient.Subscription(subscriptionName)
			logger.Infof("Using subscription: %s (assuming it exists, created by infrastructure)", subscriptionName)
		}
	}

	// Create processor
	processor := &enrichmentProcessor{
		store:            enrichmentStore,
		gptClient:        gptClient,
		reportCrawler:    reportCrawler,
		metadataScraper:  metadataScraper,
		logoDiscoverer:   logoDiscoverer,
		exaClient:        exaClient,
		logger:           logger,
		timeout:          DefaultJobTimeout,
		qualityThreshold: DefaultQualityThreshold,
		gcsBucket:        os.Getenv("GCS_LOGO_BUCKET"),
	}

	// Check if running as Cloud Run Service (PORT env var set)
	// Use pull subscription mode for queue-based auto-scaling, but also start HTTP server for manual triggers
	portStr := os.Getenv("PORT")
	if portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			log.Fatalf("Invalid PORT environment variable: %v", err)
		}

		// If we have a subscription, use pull mode (better for auto-scaling based on queue depth)
		// But also start HTTP server for /process-queued endpoint
		if subscription != nil {
			logger.Infof("Running as Cloud Run Service with Pub/Sub pull (topic: %s, subscription: %s)", topicName, subscriptionName)
			logger.Infof("HTTP server on port %d for manual triggers (/process-queued)", port)

			// Start both pull subscription processor and HTTP server
			g, gCtx := errgroup.WithContext(ctx)
			g.Go(func() error {
				return processor.processMessages(gCtx, subscription)
			})
			g.Go(func() error {
				return processor.startHTTPServer(gCtx, port)
			})
			g.Go(signalListener(gCtx))

			if err := g.Wait(); err != nil {
				logger.Errorf("processor terminated with error: %v", err)
				os.Exit(1)
			}
			return
		}

		// Fallback: HTTP push mode if no subscription (legacy)
		logger.Infof("Running as Cloud Run Service (HTTP push mode) on port %d", port)
		logger.Infof("Pub/Sub topic: %s", topicName)

		// Process any existing queued jobs on startup (in case they were created before Pub/Sub was configured)
		logger.Infof("Checking for existing queued jobs on startup...")
		go func() {
			startupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			
			status := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED
			jobs, _, err := processor.store.ListEnrichmentJobs(10, 0, &status)
			if err != nil {
				logger.Warnf("Failed to list queued jobs on startup: %v", err)
				return
			}
			
			if len(jobs) > 0 {
				logger.Infof("Found %d queued job(s) on startup, processing them...", len(jobs))
				for _, job := range jobs {
					if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED {
						logger.Infof("Processing queued job %s for stock %s (force=%v)", job.JobId, job.StockCode, job.Force)
						if err := processor.processJob(startupCtx, job.JobId, job.StockCode, job.Force); err != nil {
							logger.Errorf("Failed to process queued job %s on startup: %v", job.JobId, err)
						} else {
							logger.Infof("Successfully processed queued job %s on startup", job.JobId)
						}
					}
				}
			} else {
				logger.Infof("No queued jobs found on startup")
			}
		}()

		// Start HTTP server for Pub/Sub push messages
		g, gCtx := errgroup.WithContext(ctx)
		g.Go(func() error {
			return processor.startHTTPServer(gCtx, port)
		})
		g.Go(signalListener(gCtx))

		if err := g.Wait(); err != nil {
			logger.Errorf("processor terminated with error: %v", err)
			os.Exit(1)
		}
		return
	}

	// Check if Pub/Sub is available (GCP_PROJECT_ID set and subscription created successfully)
	// If not, fall back to local polling mode
	if projectID == "" || subscription == nil {
		logger.Infof("Running in local polling mode (will poll database for queued jobs every %v)", DefaultPollingInterval)
		g, gCtx := errgroup.WithContext(ctx)
		g.Go(func() error {
			return runLocalProcessor(gCtx, processor)
		})
		g.Go(signalListener(gCtx))

		if err := g.Wait(); err != nil {
			logger.Errorf("processor terminated with error: %v", err)
			os.Exit(1)
		}
	} else {
		logger.Infof("Starting enrichment processor with Pub/Sub pull (topic: %s, subscription: %s)", topicName, subscriptionName)

		// Start processing with pull subscription
		g, gCtx := errgroup.WithContext(ctx)
		g.Go(func() error {
			return processor.processMessages(gCtx, subscription)
		})
		g.Go(signalListener(gCtx))

		if err := g.Wait(); err != nil {
			logger.Errorf("processor terminated with error: %v", err)
			os.Exit(1)
		}
	}
}

type enrichmentProcessor struct {
	store            enrichment.EnrichmentStore
	gptClient        enrichment.GPTClient
	reportCrawler    enrichment.FinancialReportCrawler
	metadataScraper  enrichment.CompanyMetadataScraper
	logoDiscoverer   enrichment.LogoDiscoverer
	exaClient        enrichment.ExaClient
	logger           *log.Logger
	timeout          time.Duration
	qualityThreshold float64
	gcsBucket        string
}

func (p *enrichmentProcessor) processMessages(ctx context.Context, subscription *pubsub.Subscription) error {
	// Start periodic cleanup of stuck jobs in background
	go func() {
		ticker := time.NewTicker(5 * time.Minute) // Check every 5 minutes
		defer ticker.Stop()
		
		// Run immediately on startup
		if count, err := p.store.ResetStuckJobs(5); err != nil {
			p.logger.Warnf("Failed to reset stuck jobs on startup: %v", err)
		} else if count > 0 {
			p.logger.Infof("Reset %d stuck job(s) on startup", count)
		}
		
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Reset jobs stuck in processing for more than 5 minutes
				if count, err := p.store.ResetStuckJobs(5); err != nil {
					p.logger.Warnf("Failed to reset stuck jobs: %v", err)
				} else if count > 0 {
					p.logger.Infof("Reset %d stuck job(s) back to queued", count)
				}
			}
		}
	}()
	
	return subscription.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
		var jobMsg enrichmentJobMessage
		if err := json.Unmarshal(msg.Data, &jobMsg); err != nil {
			p.logger.Errorf("failed to unmarshal message: %v", err)
			msg.Nack()
			return
		}

		p.logger.Infof("Processing enrichment job %s for stock %s", jobMsg.JobID, jobMsg.StockCode)

		// Get the job from database to check its current status and force flag
		// This ensures we use the authoritative source, not just the message
		job, err := p.store.GetEnrichmentJob(jobMsg.JobID)
		if err != nil {
			p.logger.Errorf("failed to get job %s from database: %v", jobMsg.JobID, err)
			// If job doesn't exist, ACK the message (permanent failure)
			msg.Ack()
			return
		}

		// If job is already in a final state, ACK the message (already handled)
		if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED ||
			job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED ||
			job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_CANCELLED {
			p.logger.Infof("Job %s already in final state %s, acknowledging message", jobMsg.JobID, job.Status)
			msg.Ack()
			return
		}

		// If job is already processing, ACK the message (another worker is handling it)
		if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING {
			p.logger.Infof("Job %s already processing, acknowledging message (duplicate)", jobMsg.JobID)
			msg.Ack()
			return
		}

		// Use the force flag from the database job record (authoritative source)
		force := job.Force

		// Process the job
		err = p.processJob(ctx, jobMsg.JobID, jobMsg.StockCode, force)
		if err != nil {
			// Check if this is a permanent failure (already enriched without force)
			// In that case, ACK the message instead of NACKing
			if strings.Contains(err.Error(), "stock already enriched") && !force {
				p.logger.Warnf("Job %s failed permanently (already enriched without force), acknowledging message: %v", jobMsg.JobID, err)
				msg.Ack()
				return
			}

			// For transient errors, NACK to retry
			p.logger.Errorf("failed to process job %s (will retry): %v", jobMsg.JobID, err)
			msg.Nack()
			return
		}

		msg.Ack()
		p.logger.Infof("Completed enrichment job %s for stock %s", jobMsg.JobID, jobMsg.StockCode)
	})
}

func (p *enrichmentProcessor) processJob(ctx context.Context, jobID, stockCode string, force bool) (err error) {
	// Track if we've updated the job status to avoid duplicate updates
	statusUpdated := false
	
	// Panic recovery to ensure job is always marked as failed if processing crashes
	defer func() {
		if r := recover(); r != nil {
			errMsg := fmt.Sprintf("panic during processing: %v", r)
			p.logger.Errorf("Panic in processJob for %s: %v", jobID, r)
			// Try to mark job as failed (ignore error if this fails)
			_ = p.store.UpdateEnrichmentJobStatus(
				jobID,
				shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
				nil,
				&errMsg,
			)
			err = fmt.Errorf("%s", errMsg)
		} else if err != nil && !statusUpdated {
			// Safety net: if there's an error and status wasn't updated by normal error handling,
			// update it now. This handles edge cases where error handling might have failed.
			errMsg := err.Error()
			if updateErr := p.store.UpdateEnrichmentJobStatus(
				jobID,
				shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
				nil,
				&errMsg,
			); updateErr != nil {
				p.logger.Warnf("Failed to update job %s status to failed in defer (original error: %v): %v", jobID, err, updateErr)
			}
		}
	}()

	// Update job status to processing
	err = p.store.UpdateEnrichmentJobStatus(
		jobID,
		shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING,
		nil,
		nil,
	)
	if err != nil {
		return fmt.Errorf("failed to update job status to processing: %w", err)
	}

	// Get stock details
	details, err := p.store.GetStockDetails(stockCode)
	if err != nil {
		errMsg := fmt.Sprintf("failed to get stock details: %v", err)
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			p.logger.Warnf("Failed to update job status: %v", updateErr)
		} else {
			statusUpdated = true
		}
		return fmt.Errorf("%s", errMsg)
	}

	// Check if already enriched and not forced
	if !force && strings.EqualFold(details.EnrichmentStatus, "completed") {
		errMsg := "stock already enriched (use force=true to re-enrich)"
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			p.logger.Warnf("Failed to update job status: %v", updateErr)
		} else {
			statusUpdated = true
		}
		return fmt.Errorf("%s", errMsg)
	}

	// Bound the enrichment end-to-end time
	enrichCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	// Check for timeout at the end
	defer func() {
		if enrichCtx.Err() == context.DeadlineExceeded && err == nil {
			errMsg := fmt.Sprintf("enrichment timeout after %v", p.timeout)
			err = fmt.Errorf("%s", errMsg)
			_ = p.store.UpdateEnrichmentJobStatus(
				jobID,
				shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
				nil,
				&errMsg,
			)
		}
	}()

	// Run all enrichment phases
	enriched, quality, err := p.runEnrichmentPhases(enrichCtx, stockCode, details)
	if err != nil {
		errMsg := err.Error()
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			p.logger.Warnf("Failed to update job status: %v", updateErr)
		} else {
			statusUpdated = true
		}
		return err
	}

	// Save to enrichment-pending
	proposedEnrichmentID := uuid.NewString()
	enrichmentID, err := p.store.SavePendingEnrichment(
		proposedEnrichmentID,
		stockCode,
		shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
		enriched,
		quality,
	)
	if err != nil {
		errMsg := fmt.Sprintf("failed to save pending enrichment: %v", err)
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			p.logger.Warnf("Failed to update job status: %v", updateErr)
		} else {
			statusUpdated = true
		}
		return fmt.Errorf("%s", errMsg)
	}

	// Update job status to completed
	err = p.store.UpdateEnrichmentJobStatus(
		jobID,
		shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED,
		&enrichmentID,
		nil,
	)
	if err != nil {
		p.logger.Errorf("failed to update job status to completed: %v", err)
		// Don't fail the job - enrichment was saved successfully
	}

	return nil
}

// runEnrichmentPhases executes the 5 logical phases of enrichment
func (p *enrichmentProcessor) runEnrichmentPhases(ctx context.Context, stockCode string, details *stocksv1alpha1.StockDetails) (*shortsv1alpha1.EnrichmentData, *shortsv1alpha1.QualityScore, error) {
	// Phase 1: Static scraping - scrape company metadata (leadership, about pages, key links)
	p.logger.Infof("Phase 1: Scraping metadata for %s from %s", stockCode, details.Website)
	metadata, metadataErr := p.metadataScraper.ScrapeMetadata(ctx, details.Website, details.CompanyName, p.exaClient)
	if metadataErr != nil {
		p.logger.Warnf("metadata scraping failed for %s: %v", stockCode, metadataErr)
		metadata = nil // Continue with nil metadata
	} else {
		p.logger.Infof("Scraped %d leadership pages, %d about pages, %d key links for %s",
			len(metadata.LeadershipPages), len(metadata.AboutPages), len(metadata.KeyLinks), stockCode)
	}

	// Phase 2: Crawl financial reports
	p.logger.Infof("Phase 2: Crawling financial reports for %s", stockCode)
	reports, crawlErr := p.reportCrawler.CrawlFinancialReports(ctx, details.Website)
	if crawlErr != nil {
		p.logger.Warnf("report crawl failed for %s: %v", stockCode, crawlErr)
		reports = nil
	}

	// Phase 3: LLM enrichment with scraped metadata context
	p.logger.Infof("Phase 3: Enriching %s with LLM (using scraped metadata context)", stockCode)
	enriched, err := p.gptClient.EnrichCompany(
		ctx,
		stockCode,
		details.CompanyName,
		details.Industry,
		details.Website,
		details.Summary,
		reports,
		metadata, // Pass scraped metadata to LLM
	)
	if err != nil {
		return nil, nil, fmt.Errorf("gpt enrichment failed: %w", err)
	}

	// Phase 4: Logo Discovery and Optimization
	p.logger.Infof("Phase 4: Starting logo discovery for %s (logoDiscoverer=%v, gcsBucket=%s, website=%s)",
		stockCode, p.logoDiscoverer != nil, p.gcsBucket, details.Website)
	if p.logoDiscoverer != nil {
		p.performLogoPhase(ctx, stockCode, details, enriched)
	} else {
		p.logger.Warnf("Phase 4: Skipped for %s (logoDiscoverer is nil)", stockCode)
	}

	// Phase 5: Evaluate quality
	p.logger.Infof("Phase 5: Evaluating enrichment quality for %s", stockCode)
	quality, err := p.gptClient.EvaluateQuality(ctx, stockCode, enriched)
	if err != nil {
		p.logger.Warnf("quality evaluation failed for %s: %v", stockCode, err)
		quality = &shortsv1alpha1.QualityScore{
			Warnings: []string{"quality evaluation failed: " + err.Error()},
		}
	}

	// Check quality threshold
	if quality != nil && quality.OverallScore > 0 && quality.OverallScore < p.qualityThreshold {
		quality.Warnings = append(quality.Warnings, fmt.Sprintf("overall_score %.2f is below threshold %.2f", quality.OverallScore, p.qualityThreshold))
	}

	return enriched, quality, nil
}

// performLogoPhase handles Phase 4: Logo Discovery and Optimization
func (p *enrichmentProcessor) performLogoPhase(ctx context.Context, stockCode string, details *stocksv1alpha1.StockDetails, enriched *shortsv1alpha1.EnrichmentData) {
	p.logger.Infof("Phase 4: Discovering optimal logo for %s", stockCode)
	logo, logoErr := p.logoDiscoverer.DiscoverLogo(ctx, details.Website, details.CompanyName, stockCode)
	if logoErr != nil {
		p.logger.Warnf("logo discovery failed for %s: %v", stockCode, logoErr)
		return
	}
	if logo == nil {
		p.logger.Warnf("Phase 4: Logo discovery returned nil for %s (no logo found)", stockCode)
		return
	}

	p.logger.Infof("Logo discovered for %s: %s (format: %s, score: %.2f)", stockCode, logo.SourceURL, logo.Format, logo.QualityScore)

	// Process logo
	processedPaths, procErr := p.processLogo(ctx, logo, stockCode)
	if procErr != nil {
		p.logger.Warnf("logo processing failed for %s: %v", stockCode, procErr)
		return
	}

	p.logger.Infof("Logo processed for %s, uploading %d variants to GCS", stockCode, len(processedPaths))

	// Upload to GCS
	mainLogoURL, iconLogoURL, svgLogoURL, uploadErr := p.uploadLogosToGCS(ctx, processedPaths, stockCode, logo)
	if uploadErr != nil {
		p.logger.Warnf("logo upload to GCS failed for %s: %v", stockCode, uploadErr)
		return
	}

	p.logger.Infof("Logo uploaded to GCS for %s: main=%s, icon=%s, svg=%s", stockCode, mainLogoURL, iconLogoURL, svgLogoURL)
	// Store logo URLs in enrichment data for review
	enriched.LogoGcsUrl = mainLogoURL
	enriched.LogoIconGcsUrl = iconLogoURL
	enriched.LogoSvgGcsUrl = svgLogoURL
	enriched.LogoSourceUrl = logo.SourceURL
	enriched.LogoFormat = logo.Format
	p.logger.Infof("Logo URLs staged for review in enrichment data for %s", stockCode)
}

func (p *enrichmentProcessor) processLogo(ctx context.Context, logo *enrichment.DiscoveredLogo, stockCode string) ([]string, error) {
	tmpDir := os.TempDir()
	
	// Handle SVG separately - render to PNG using cairosvg
	if logo.IsSVG || logo.Format == "svg" {
		return p.processSVGLogo(ctx, logo, stockCode, tmpDir)
	}
	
	// 1. Save original image to a temporary file
	inputPath := filepath.Join(tmpDir, fmt.Sprintf("%s_raw.%s", stockCode, logo.Format))
	err := os.WriteFile(inputPath, logo.ImageData, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to save raw logo: %w", err)
	}
	defer func() {
		if err := os.Remove(inputPath); err != nil {
			p.logger.Warnf("Failed to remove input file %s: %v", inputPath, err)
		}
	}()

	outputDir := filepath.Join(tmpDir, fmt.Sprintf("%s_logos", stockCode))
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output dir: %w", err)
	}
	defer func() {
		if err := os.RemoveAll(outputDir); err != nil {
			p.logger.Warnf("Failed to remove output dir %s: %v", outputDir, err)
		}
	}()

	// 2. Call Python script for background removal and resizing
	// Try to use venv Python if available, otherwise fall back to system python3
	pythonCmd := "python3"
	if venvPython := findVenvPython(); venvPython != "" {
		pythonCmd = venvPython
		p.logger.Debugf("Using venv Python: %s", venvPython)
	}
	
	// Find logo_processor.py script (could be in current dir or enrichment-processor/)
	scriptPath := "logo_processor.py"
	if _, err := os.Stat(scriptPath); os.IsNotExist(err) {
		altPath := filepath.Join("enrichment-processor", "logo_processor.py")
		if _, err := os.Stat(altPath); err == nil {
			scriptPath = altPath
		}
	}
	
	// Get absolute path for script
	absScriptPath, err := filepath.Abs(scriptPath)
	if err != nil {
		absScriptPath = scriptPath // Fallback to relative if abs fails
	}
	
	// Set working directory to enrichment-processor for mobile_sam.pt lookup
	cmdDir := filepath.Dir(absScriptPath)
	if cmdDir == "." || cmdDir == "" {
		// Try to find enrichment-processor directory
		if absDir, err := filepath.Abs("enrichment-processor"); err == nil {
			if _, err := os.Stat(absDir); err == nil {
				cmdDir = absDir
			}
		}
	}
	
	// Use just the filename when setting working directory
	scriptName := filepath.Base(absScriptPath)
	
	cmd := exec.CommandContext(ctx, pythonCmd, scriptName,
		"--input", inputPath,
		"--output-dir", outputDir,
		"--stock-code", stockCode,
	)
	cmd.Dir = cmdDir
	p.logger.Debugf("Running logo processor: python=%s, script=%s, dir=%s", pythonCmd, scriptName, cmdDir)
	
	output, err := cmd.CombinedOutput()
	
	// Log Python script output for debugging (stderr messages from logo_processor.py)
	outputStr := string(output)
	var jsonLines []string
	var logLines []string
	
	if outputStr != "" {
		// Try to extract JSON result and log separately
		lines := strings.Split(outputStr, "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if strings.HasPrefix(line, "{") || strings.HasPrefix(line, "[") {
				jsonLines = append(jsonLines, line)
			} else {
				logLines = append(logLines, line)
			}
		}
		if len(logLines) > 0 {
			p.logger.Infof("Logo processor stderr output:\n%s", strings.Join(logLines, "\n"))
		}
	}
	
	if err != nil {
		return nil, fmt.Errorf("logo processor failed: %v (output: %s)", err, outputStr)
	}

	var result struct {
		Success     bool     `json:"success"`
		Error       string   `json:"error"`
		OutputFiles []string `json:"output_files"`
		HasIcon     bool     `json:"has_icon"`
	}
	
	// Find JSON in output (might be mixed with stderr)
	jsonOutput := strings.Join(jsonLines, "\n")
	if jsonOutput == "" {
		jsonOutput = outputStr
	}
	
	if err := json.Unmarshal([]byte(jsonOutput), &result); err != nil {
		return nil, fmt.Errorf("failed to parse logo processor output: %w (raw output: %s)", err, outputStr)
	}

	if !result.Success {
		return nil, fmt.Errorf("logo processing failed: %s", result.Error)
	}

	p.logger.Infof("Logo processor completed: has_icon=%v, output_files=%d", result.HasIcon, len(result.OutputFiles))
	p.logger.Infof("Logo processor JSON response: %s", jsonOutput)
	for _, f := range result.OutputFiles {
		p.logger.Infof("  Output file: %s", f)
	}
	if !result.HasIcon {
		p.logger.Warnf("Icon extraction returned None - no icon file generated")
	}

	// Move files to a more permanent temporary location or read them
	// For simplicity, we'll copy them to a stable temp dir that we'll clean up later
	finalPaths := []string{}
	for _, path := range result.OutputFiles {
		stablePath := filepath.Join(tmpDir, filepath.Base(path))
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if err := os.WriteFile(stablePath, data, 0644); err == nil {
			finalPaths = append(finalPaths, stablePath)
		}
	}

	return finalPaths, nil
}

// processSVGLogo handles SVG logos using a hybrid approach:
// 1. First try to remove text elements directly from SVG XML (preserves vector quality)
// 2. If that fails, fall back to raster processing (render to PNG, use logo_processor.py)
func (p *enrichmentProcessor) processSVGLogo(ctx context.Context, logo *enrichment.DiscoveredLogo, stockCode string, tmpDir string) ([]string, error) {
	p.logger.Infof("Processing SVG logo for %s from %s", stockCode, logo.SourceURL)

	// Save the SVG file
	svgPath := filepath.Join(tmpDir, fmt.Sprintf("%s.svg", stockCode))
	svgData := logo.SVGData
	if len(svgData) == 0 {
		svgData = logo.ImageData
	}
	if err := os.WriteFile(svgPath, svgData, 0644); err != nil {
		return nil, fmt.Errorf("failed to save SVG: %w", err)
	}

	// Try to use venv Python if available
	pythonCmd := "python3"
	if venvPython := findVenvPython(); venvPython != "" {
		pythonCmd = venvPython
		p.logger.Debugf("Using venv Python for SVG processing: %s", venvPython)
	}

	// Phase 1: Try SVG text removal (direct XML manipulation)
	outputPaths, svgRemovalSucceeded := p.trySVGTextRemoval(ctx, pythonCmd, svgPath, tmpDir, stockCode)
	if svgRemovalSucceeded && len(outputPaths) > 0 {
		p.logger.Infof("SVG text removal successful for %s, generated %d files", stockCode, len(outputPaths))
		return outputPaths, nil
	}

	// Phase 2: Fallback to raster processing
	p.logger.Infof("Falling back to raster processing for %s", stockCode)
	return p.processSVGWithRasterFallback(ctx, pythonCmd, svgPath, tmpDir, stockCode)
}

// trySVGTextRemoval attempts to remove text elements directly from SVG XML
func (p *enrichmentProcessor) trySVGTextRemoval(ctx context.Context, pythonCmd, svgPath, tmpDir, stockCode string) ([]string, bool) {
	// Find svg_text_remover.py script
	scriptPath := findScript("svg_text_remover.py")
	if scriptPath == "" {
		p.logger.Warnf("svg_text_remover.py not found, skipping SVG text removal")
		return nil, false
	}

	absScriptPath, _ := filepath.Abs(scriptPath)
	cmdDir := filepath.Dir(absScriptPath)
	scriptName := filepath.Base(absScriptPath)

	// Run SVG text remover
	cmd := exec.CommandContext(ctx, pythonCmd, scriptName,
		"--input", svgPath,
		"--output-dir", tmpDir,
		"--stock-code", stockCode)
	cmd.Dir = cmdDir

	output, err := cmd.CombinedOutput()
	if err != nil {
		p.logger.Warnf("SVG text removal failed: %v (output: %s)", err, string(output))
		return nil, false
	}

	// Parse JSON result
	var result struct {
		Success      bool     `json:"success"`
		HasText      bool     `json:"has_text"`
		TextRemoved  bool     `json:"text_removed"`
		NumRemoved   int      `json:"num_text_elements"`
		OutputFiles  []string `json:"output_files"`
		IconSVGPath  string   `json:"icon_svg_path"`
		IconPNGPath  string   `json:"icon_png_path"`
		Error        string   `json:"error"`
	}

	// Find JSON in output (last line should be JSON)
	lines := strings.Split(string(output), "\n")
	var jsonLine string
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "{") {
			jsonLine = line
			break
		}
	}

	if jsonLine == "" {
		p.logger.Warnf("No JSON output from svg_text_remover.py")
		return nil, false
	}

	if err := json.Unmarshal([]byte(jsonLine), &result); err != nil {
		p.logger.Warnf("Failed to parse svg_text_remover.py output: %v", err)
		return nil, false
	}

	if !result.Success {
		p.logger.Warnf("SVG text removal reported failure: %s", result.Error)
		return nil, false
	}

	if result.HasText && !result.TextRemoved {
		// SVG has text elements but we couldn't remove them - need raster fallback
		p.logger.Infof("SVG has text elements but removal failed (complex structure), using raster fallback")
		return nil, false
	}

	if !result.HasText {
		// SVG has no <text> elements, but text might be rendered as paths
		// This is common in professional logos where text is "converted to outlines"
		// We should still try raster processing to detect and remove text paths
		p.logger.Infof("SVG has no text elements (text may be rendered as paths), using raster fallback")
		return nil, false
	}

	p.logger.Infof("SVG text removal successful: removed=%d text elements, files=%d",
		result.NumRemoved, len(result.OutputFiles))

	return result.OutputFiles, true
}

// processSVGWithRasterFallback renders SVG to high-res PNG and uses logo_processor.py
func (p *enrichmentProcessor) processSVGWithRasterFallback(ctx context.Context, pythonCmd, svgPath, tmpDir, stockCode string) ([]string, error) {
	var outputPaths []string
	outputPaths = append(outputPaths, svgPath)

	// Render SVG to high-res PNG (512px for better OCR/text detection)
	highResPNGPath := filepath.Join(tmpDir, fmt.Sprintf("%s_highres.png", stockCode))

	scriptPath := findScript("svg_renderer.py")
	if scriptPath == "" {
		return outputPaths, fmt.Errorf("svg_renderer.py not found")
	}

	absScriptPath, _ := filepath.Abs(scriptPath)
	cmdDir := filepath.Dir(absScriptPath)
	scriptName := filepath.Base(absScriptPath)

	// Render at 512px for better quality text detection
	cmd := exec.CommandContext(ctx, pythonCmd, scriptName, svgPath, highResPNGPath, "512")
	cmd.Dir = cmdDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		p.logger.Warnf("SVG to PNG rendering failed: %v (output: %s)", err, string(output))
		return outputPaths, fmt.Errorf("SVG render failed: %w", err)
	}

	p.logger.Infof("Rendered SVG to high-res PNG (512px) for raster processing: %s", highResPNGPath)

	// Now use logo_processor.py on the rendered PNG
	logoScriptPath := findScript("logo_processor.py")
	if logoScriptPath == "" {
		// Fallback: just use the rendered PNG
		outputPaths = append(outputPaths, highResPNGPath)
		return outputPaths, nil
	}

	absLogoScript, _ := filepath.Abs(logoScriptPath)
	logoDir := filepath.Dir(absLogoScript)
	logoScript := filepath.Base(absLogoScript)

	cmd = exec.CommandContext(ctx, pythonCmd, logoScript,
		"--input", highResPNGPath,
		"--output-dir", tmpDir,
		"--stock-code", stockCode)
	cmd.Dir = logoDir

	output, err = cmd.CombinedOutput()
	if err != nil {
		p.logger.Warnf("Logo processor failed: %v (output: %s)", err, string(output))
		// Still return the high-res PNG
		outputPaths = append(outputPaths, highResPNGPath)
		return outputPaths, nil
	}

	// Parse logo_processor.py result
	var result struct {
		Success     bool     `json:"success"`
		OutputFiles []string `json:"output_files"`
		HasIcon     bool     `json:"has_icon"`
		Error       string   `json:"error"`
	}

	lines := strings.Split(string(output), "\n")
	var jsonLine string
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "{") {
			jsonLine = line
			break
		}
	}

	if jsonLine != "" {
		if err := json.Unmarshal([]byte(jsonLine), &result); err == nil && result.Success {
			p.logger.Infof("Raster logo processing successful: %d files, has_icon=%v", len(result.OutputFiles), result.HasIcon)
			return result.OutputFiles, nil
		}
	}

	// Fallback
	outputPaths = append(outputPaths, highResPNGPath)
	return outputPaths, nil
}

// findScript searches for a Python script in common locations
func findScript(scriptName string) string {
	searchPaths := []string{
		scriptName,
		filepath.Join("enrichment-processor", scriptName),
		filepath.Join("services", "enrichment-processor", scriptName),
	}

	// Also try relative to executable
	if execPath, err := os.Executable(); err == nil {
		searchPaths = append(searchPaths, filepath.Join(filepath.Dir(execPath), scriptName))
	}

	for _, path := range searchPaths {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}

	return ""
}

func (p *enrichmentProcessor) uploadLogosToGCS(ctx context.Context, filePaths []string, stockCode string, logo *enrichment.DiscoveredLogo) (string, string, string, error) {
	if p.gcsBucket == "" {
		return "", "", "", fmt.Errorf("GCS bucket not configured")
	}

	client, err := storage.NewClient(ctx)
	if err != nil {
		return "", "", "", fmt.Errorf("failed to create storage client: %w", err)
	}
	defer func() {
		if err := client.Close(); err != nil {
			p.logger.Warnf("Failed to close storage client: %v", err)
		}
	}()

	bucket := client.Bucket(p.gcsBucket)
	var mainLogoURL string
	var iconLogoURL string
	var svgLogoURL string      // Full SVG URL
	var iconSVGURL string      // Icon-only SVG URL

	for _, path := range filePaths {
		filename := filepath.Base(path)

		// Determine content type and object path based on file type
		var contentType string
		var objectName string

		if strings.HasSuffix(filename, ".svg") {
			contentType = "image/svg+xml"
			objectName = fmt.Sprintf("logos/svg/%s", filename)
		} else {
			contentType = "image/png"
			objectName = fmt.Sprintf("logos/%s", filename)
		}

		f, err := os.Open(path)
		if err != nil {
			p.logger.Warnf("failed to open processed logo %s: %v", path, err)
			continue
		}

		wc := bucket.Object(objectName).NewWriter(ctx)
		wc.ContentType = contentType
		// Set cache control for logos
		wc.CacheControl = GCSCacheControl

		if _, err = io.Copy(wc, f); err != nil {
			if closeErr := f.Close(); closeErr != nil {
				p.logger.Warnf("failed to close file %s: %v", path, closeErr)
			}
			if closeErr := wc.Close(); closeErr != nil {
				p.logger.Warnf("failed to close GCS writer for %s: %v", objectName, closeErr)
			}
			p.logger.Warnf("failed to upload logo %s to GCS: %v", objectName, err)
			continue
		}
		if err := f.Close(); err != nil {
			p.logger.Warnf("failed to close file %s: %v", path, err)
		}
		if err := wc.Close(); err != nil {
			p.logger.Warnf("failed to close GCS writer for %s: %v", objectName, err)
			continue
		}

		gcsURL := fmt.Sprintf("https://storage.googleapis.com/%s/%s", p.gcsBucket, objectName)

		// Track SVG URLs - distinguish between full and icon SVG
		if strings.HasSuffix(filename, ".svg") {
			if filename == fmt.Sprintf("%s_icon.svg", stockCode) {
				iconSVGURL = gcsURL
				p.logger.Infof("Uploaded icon SVG to GCS: %s", gcsURL)
			} else if filename == fmt.Sprintf("%s.svg", stockCode) {
				svgLogoURL = gcsURL
				p.logger.Infof("Uploaded full SVG logo to GCS: %s", gcsURL)
			} else {
				// Other SVG file
				p.logger.Infof("Uploaded SVG to GCS: %s", gcsURL)
				if svgLogoURL == "" {
					svgLogoURL = gcsURL
				}
			}
		}

		// The main logo is {STOCK_CODE}.png
		if filename == fmt.Sprintf("%s.png", stockCode) {
			mainLogoURL = gcsURL
		}
		// The icon-only logo is {STOCK_CODE}_icon.png
		if filename == fmt.Sprintf("%s_icon.png", stockCode) {
			iconLogoURL = gcsURL
		}

		// Clean up local file
		if err := os.Remove(path); err != nil {
			p.logger.Warnf("failed to remove local file %s: %v", path, err)
		}
	}

	// If we have an icon SVG but no icon PNG, use icon SVG for icon URL
	if iconLogoURL == "" && iconSVGURL != "" {
		p.logger.Infof("No icon PNG, using icon SVG URL instead: %s", iconSVGURL)
		iconLogoURL = iconSVGURL
	}

	// If we have an SVG but no PNG main logo, use SVG as main
	if mainLogoURL == "" && svgLogoURL != "" {
		p.logger.Warnf("No PNG main logo, using SVG URL instead: %s", svgLogoURL)
		mainLogoURL = svgLogoURL
	}

	// Prefer icon SVG for svgLogoURL if we have it (it's the clean, text-free version)
	if iconSVGURL != "" {
		svgLogoURL = iconSVGURL
	}

	if mainLogoURL == "" {
		return "", "", "", fmt.Errorf("failed to upload main logo")
	}

	return mainLogoURL, iconLogoURL, svgLogoURL, nil
}

// Pub/Sub push message format
type pubsubPushMessage struct {
	Message struct {
		Data        string            `json:"data"`
		Attributes  map[string]string  `json:"attributes"`
		MessageID   string            `json:"messageId"`
		PublishTime string            `json:"publishTime"`
	} `json:"message"`
	Subscription string `json:"subscription"`
}

// startHTTPServer starts an HTTP server to handle Pub/Sub push messages
func (p *enrichmentProcessor) startHTTPServer(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", p.handlePubSubPush)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.HandleFunc("/process-queued", p.handleProcessQueued)

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}

	p.logger.Infof("Starting HTTP server on port %d for Pub/Sub push messages", port)

	// Start server in goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			p.logger.Errorf("HTTP server failed: %v", err)
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()
	p.logger.Infof("Shutting down HTTP server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return server.Shutdown(shutdownCtx)
}

// handlePubSubPush handles Pub/Sub push HTTP POST requests
// Jobs are processed asynchronously in a goroutine. We acknowledge the message quickly
// to satisfy Pub/Sub's ack deadline, then process in the background.
// With min_instance_count=1, Cloud Run keeps an instance warm so background jobs complete.
func (p *enrichmentProcessor) handlePubSubPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var pushMsg pubsubPushMessage
	if err := json.NewDecoder(r.Body).Decode(&pushMsg); err != nil {
		p.logger.Errorf("Failed to decode Pub/Sub push message: %v", err)
		http.Error(w, "Invalid message format", http.StatusBadRequest)
		return
	}

	// Decode base64 message data
	messageData, err := base64.StdEncoding.DecodeString(pushMsg.Message.Data)
	if err != nil {
		p.logger.Errorf("Failed to decode message data: %v", err)
		http.Error(w, "Invalid message data", http.StatusBadRequest)
		return
	}

	// Parse enrichment job message
	var jobMsg enrichmentJobMessage
	if err := json.Unmarshal(messageData, &jobMsg); err != nil {
		p.logger.Errorf("Failed to unmarshal job message: %v", err)
		http.Error(w, "Invalid job message", http.StatusBadRequest)
		return
	}

	p.logger.Infof("Received Pub/Sub push message for job %s (stock: %s)", jobMsg.JobID, jobMsg.StockCode)

	// Validate job exists and get its state before processing
	job, err := p.store.GetEnrichmentJob(jobMsg.JobID)
	if err != nil {
		p.logger.Errorf("Failed to get job %s from database: %v", jobMsg.JobID, err)
		// Return 500 so Pub/Sub will retry
		http.Error(w, "Failed to get job from database", http.StatusInternalServerError)
		return
	}

	// If job is already in a final state, acknowledge and skip
	if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED ||
		job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED ||
		job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_CANCELLED {
		p.logger.Infof("Job %s already in final state %s, skipping", jobMsg.JobID, job.Status)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Job already completed"))
		return
	}

	// If job is already processing, acknowledge and skip (duplicate message)
	if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING {
		p.logger.Infof("Job %s already processing, skipping (duplicate)", jobMsg.JobID)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Job already processing"))
		return
	}

	// Acknowledge message quickly (Pub/Sub expects fast response)
	// Then process asynchronously - the warm instance (min_instance_count=1) keeps it alive
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))

	// Process job in background goroutine
	// With min_instance_count=1, Cloud Run keeps the instance alive for background work
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		// Use the force flag from the database job record
		force := job.Force

		// Process the job
		if err := p.processJob(ctx, jobMsg.JobID, jobMsg.StockCode, force); err != nil {
			p.logger.Errorf("Failed to process job %s: %v", jobMsg.JobID, err)
		} else {
			p.logger.Infof("Successfully processed job %s", jobMsg.JobID)
		}
	}()
}

// handleProcessQueued manually triggers processing of queued jobs
// Useful for processing jobs that were created before Pub/Sub was configured
// Jobs are processed synchronously to prevent Cloud Run from terminating the instance
func (p *enrichmentProcessor) handleProcessQueued(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	p.logger.Infof("Manual trigger: Processing queued jobs...")

	// Set headers for streaming response
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	// Helper to write and flush response
	writeProgress := func(msg string) {
		_, _ = w.Write([]byte(msg + "\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	// Process jobs synchronously to keep HTTP connection alive
	// This prevents Cloud Run from terminating the instance mid-processing
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()

	status := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED
	jobs, total, err := p.store.ListEnrichmentJobs(100, 0, &status)
	if err != nil {
		p.logger.Errorf("Failed to list queued jobs: %v", err)
		writeProgress(fmt.Sprintf("Error: Failed to list queued jobs: %v", err))
		return
	}

	if len(jobs) == 0 {
		p.logger.Infof("No queued jobs found")
		writeProgress("No queued jobs found")
		return
	}

	p.logger.Infof("Found %d queued job(s) (total: %d), processing...", len(jobs), total)
	writeProgress(fmt.Sprintf("Found %d queued job(s) (total: %d), processing...", len(jobs), total))

	successCount := 0
	failCount := 0

	for _, job := range jobs {
		if job.Status == shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED {
			p.logger.Infof("Processing queued job %s for stock %s (force=%v)", job.JobId, job.StockCode, job.Force)
			writeProgress(fmt.Sprintf("Processing job %s for stock %s...", job.JobId, job.StockCode))

			if err := p.processJob(ctx, job.JobId, job.StockCode, job.Force); err != nil {
				p.logger.Errorf("Failed to process queued job %s: %v", job.JobId, err)
				writeProgress(fmt.Sprintf("  FAILED: %v", err))
				failCount++
			} else {
				p.logger.Infof("Successfully processed queued job %s", job.JobId)
				writeProgress(fmt.Sprintf("  SUCCESS: %s enriched", job.StockCode))
				successCount++
			}
		}
	}

	summary := fmt.Sprintf("Completed: %d succeeded, %d failed", successCount, failCount)
	p.logger.Infof(summary)
	writeProgress(summary)
}

func signalListener(ctx context.Context) func() error {
	return func() error {
		signalC := make(chan os.Signal, 1)
		defer close(signalC)
		signal.Notify(signalC, syscall.SIGTERM, syscall.SIGINT)

		select {
		case <-signalC:
			return fmt.Errorf("received signal")
		case <-ctx.Done():
			return nil
		}
	}
}

