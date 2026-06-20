package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
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

	"cloud.google.com/go/storage"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/castlemilk/shorted.com.au/services/shorts"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
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
	// Parse CLI flags
	backfillPeople := flag.Bool("backfill-people", false, "Run person enrichment backfill on existing stocks")
	backfillImages := flag.Bool("backfill-images", false, "Fetch LinkedIn profile photos for people with LinkedIn URLs but no images")
	backfillLimit := flag.Int("limit", 50, "Maximum number of stocks to process in backfill mode")
	backfillForce := flag.Bool("force", false, "Re-process stocks even if already enriched (adds LinkedIn to existing data)")
	backfillAfter := flag.String("after", "", "Resume force backfill after this stock code (cursor pagination)")
	interactive := flag.Bool("interactive", false, "Run browser in non-headless mode (for initial LinkedIn login with verification)")
	flag.Parse()

	ctx := context.Background()
	logger := log.NewLogger()
	logger.SetLevel("debug")

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "enrichment-processor")
	if otelErr != nil {
		log.Errorf("failed to initialize OpenTelemetry: %v", otelErr)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Errorf("error shutting down OpenTelemetry: %v", err)
			}
		}()
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

	// Handle --backfill-people mode (only needs store + free data sources, no LLM/Pub/Sub)
	if *backfillPeople {
		logger.Infof("Running in people backfill mode (limit: %d)", *backfillLimit)

		wikipediaClient := enrichment.NewWikipediaClient()
		yahooPeopleClient := enrichment.NewYahooPeopleClient()

		gcsBucket := os.Getenv("GCS_LOGO_BUCKET")
		var personImageProcessor *enrichment.PersonImageProcessor
		if gcsBucket != "" {
			gcsClient, gcsErr := storage.NewClient(ctx)
			if gcsErr != nil {
				logger.Warnf("Failed to create GCS client for person images: %v (continuing without person image upload)", gcsErr)
			} else {
				personImageProcessor = enrichment.NewPersonImageProcessor(gcsClient, gcsBucket)
				logger.Infof("Person image processor initialized (bucket: %s)", gcsBucket)
			}
		}

		// LinkedIn person client (no Exa in backfill mode — uses slug guessing)
		linkedInPersonClient := enrichment.NewLinkedInPersonClient(nil)

		processor := &enrichmentProcessor{
			store:                  enrichmentStore,
			wikipediaClient:       wikipediaClient,
			yahooPeopleClient:     yahooPeopleClient,
			personImageProcessor:   personImageProcessor,
			linkedInPersonClient:   linkedInPersonClient,
			logger:                logger,
		}
		runPeopleBackfillMain(processor, *backfillLimit, *backfillForce, *backfillAfter)
		return
	}

	// Handle --backfill-images mode (authenticated LinkedIn photo scraping)
	if *backfillImages {
		logger.Infof("Running in image backfill mode (limit: %d)", *backfillLimit)
		runImageBackfillMain(enrichmentStore, logger, *backfillLimit, *backfillAfter, !*interactive)
		return
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
			logger.Warnf("OPENAI_API_KEY environment variable is not set - enrichment processor will not run")
			logger.Infof("To enable enrichment, set OPENAI_API_KEY in services/.env or environment")
			logger.Infof("Enrichment processor exiting gracefully (this is normal for local development without API keys)")
			return
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

	// Initialize metadata scraper with Chromium fallback for JS-rendered sites
	metadataScraper := enrichment.NewMetadataScraperWithChromium()

	// Initialize logo discoverer with Chromium fallback for JS-heavy sites
	logoDiscoverer := enrichment.NewLogoDiscovererWithChromium()

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

	// No Pub/Sub pull subscription — uses HTTP push only (scales to zero)

	// Initialize Wikipedia client (always available, no API key needed)
	wikipediaClient := enrichment.NewWikipediaClient()
	logger.Infof("Wikipedia client initialized")

	// Initialize Yahoo Finance people client (free, no API key needed)
	yahooPeopleClient := enrichment.NewYahooPeopleClient()
	logger.Infof("Yahoo Finance people client initialized")

	// Initialize person image processor (requires GCS bucket)
	gcsBucket := os.Getenv("GCS_LOGO_BUCKET")
	var personImageProcessor *enrichment.PersonImageProcessor
	if gcsBucket != "" {
		gcsClient, gcsErr := storage.NewClient(ctx)
		if gcsErr != nil {
			logger.Warnf("Failed to create GCS client for person images: %v (continuing without person image upload)", gcsErr)
		} else {
			personImageProcessor = enrichment.NewPersonImageProcessor(gcsClient, gcsBucket)
			logger.Infof("Person image processor initialized (bucket: %s)", gcsBucket)
		}
	}

	// Initialize LinkedIn person client (uses Exa + Chromium for profile scraping)
	linkedInPersonClient := enrichment.NewLinkedInPersonClient(exaClient)
	logger.Infof("LinkedIn person client initialized (exa: %v)", exaClient != nil)

	// Parse auto-approve threshold from environment
	autoApproveThreshold := DefaultAutoApproveThreshold
	if v := os.Getenv("AUTO_APPROVE_THRESHOLD"); v != "" {
		if parsed, parseErr := strconv.ParseFloat(v, 64); parseErr == nil && parsed >= 0 && parsed <= 1 {
			autoApproveThreshold = parsed
		} else {
			logger.Warnf("Invalid AUTO_APPROVE_THRESHOLD value: %s (using default %.2f)", v, DefaultAutoApproveThreshold)
		}
	}
	if autoApproveThreshold > 0 {
		logger.Infof("Auto-approve threshold: %.2f (enrichments scoring above this will be automatically approved)", autoApproveThreshold)
	} else {
		logger.Infof("Auto-approve disabled (threshold=0)")
	}

	// §6.5 People-only write: serve discovered key_people even when the whole-company
	// quality score is below the auto-approve gate (Yahoo-officer leadership ~0.74).
	writePeopleBelowGate := DefaultWritePeopleBelowGate
	if v := os.Getenv("WRITE_PEOPLE_BELOW_GATE"); v != "" {
		if parsed, parseErr := strconv.ParseBool(v); parseErr == nil {
			writePeopleBelowGate = parsed
		} else {
			logger.Warnf("Invalid WRITE_PEOPLE_BELOW_GATE value: %s (using default %v)", v, DefaultWritePeopleBelowGate)
		}
	}
	minPeopleWriteScore := DefaultMinPeopleWriteScore
	if v := os.Getenv("MIN_PEOPLE_WRITE_SCORE"); v != "" {
		if parsed, parseErr := strconv.ParseFloat(v, 64); parseErr == nil && parsed >= 0 && parsed <= 1 {
			minPeopleWriteScore = parsed
		} else {
			logger.Warnf("Invalid MIN_PEOPLE_WRITE_SCORE value: %s (using default %.2f)", v, DefaultMinPeopleWriteScore)
		}
	}
	if writePeopleBelowGate {
		logger.Infof("People-only write enabled: discovered key_people served below the auto-approve gate (min score %.2f, additive — fills empty rows only)", minPeopleWriteScore)
	}

	// Read shorts API URL for Algolia sync callbacks
	shortsAPIURL := strings.TrimSpace(os.Getenv("SHORTS_API_URL"))
	internalServiceSecret := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_SECRET"))
	if shortsAPIURL != "" {
		logger.Infof("Algolia sync callback configured: %s", shortsAPIURL)
	}

	// Create processor
	processor := &enrichmentProcessor{
		store:                 enrichmentStore,
		gptClient:             gptClient,
		reportCrawler:         reportCrawler,
		metadataScraper:       metadataScraper,
		logoDiscoverer:        logoDiscoverer,
		exaClient:             exaClient,
		wikipediaClient:       wikipediaClient,
		yahooPeopleClient:     yahooPeopleClient,
		personImageProcessor:   personImageProcessor,
		linkedInPersonClient:   linkedInPersonClient,
		logger:                logger,
		timeout:               DefaultJobTimeout,
		qualityThreshold:      DefaultQualityThreshold,
		autoApproveThreshold:  autoApproveThreshold,
		writePeopleBelowGate:  writePeopleBelowGate,
		minPeopleWriteScore:   minPeopleWriteScore,
		gcsBucket:             gcsBucket,
		shortsAPIURL:          shortsAPIURL,
		internalServiceSecret: internalServiceSecret,
	}

	// Check if running in batch mode (one-shot batch enrichment)
	runMode := strings.ToLower(strings.TrimSpace(os.Getenv("RUN_MODE")))
	if runMode == "batch" {
		logger.Infof("Running in batch mode")
		syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "enrichment-processor"))
		batchStart := time.Now()
		batchErr := runBatchProcessor(ctx, processor)
		shortedotel.SyncDuration.Record(ctx, time.Since(batchStart).Seconds(), syncAttrs)
		if batchErr != nil {
			shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
				attribute.String("sync_job", "enrichment-processor"),
				attribute.String("status", "failure"),
			))
			logger.Errorf("Batch enrichment failed: %v", batchErr)
			os.Exit(1)
		}
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "enrichment-processor"),
			attribute.String("status", "success"),
		))
		shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
		logger.Infof("Batch enrichment completed successfully")
		return
	}

	// Cloud Run Service mode: HTTP-only, Pub/Sub push, scales to zero.
	// No pull subscriptions, no polling, no background goroutines.
	portStr := os.Getenv("PORT")
	if portStr == "" {
		portStr = "8080"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		log.Fatalf("Invalid PORT: %v", err)
	}

	logger.Infof("Starting enrichment processor (HTTP push mode, port %d) — scales to zero", port)

	g, gCtx := errgroup.WithContext(ctx)
	g.Go(func() error {
		return processor.startHTTPServer(gCtx, port)
	})
	g.Go(signalListener(gCtx))

	if err := g.Wait(); err != nil {
		logger.Errorf("processor terminated with error: %v", err)
		os.Exit(1)
	}
}

type enrichmentProcessor struct {
	store                 enrichment.EnrichmentStore
	gptClient             enrichment.GPTClient
	reportCrawler         enrichment.FinancialReportCrawler
	metadataScraper       enrichment.CompanyMetadataScraper
	logoDiscoverer        enrichment.LogoDiscoverer
	exaClient             enrichment.ExaClient
	wikipediaClient       enrichment.WikipediaClient
	yahooPeopleClient     enrichment.YahooPeopleClient
	personImageProcessor   *enrichment.PersonImageProcessor
	linkedInPersonClient   *enrichment.LinkedInPersonClient
	linkedInPhotoClient    *enrichment.LinkedInPhotoClient
	stealthClient          *stealthhttp.Client
	lastScrape             time.Time
	google429Count         int
	logger                *log.Logger
	timeout               time.Duration
	qualityThreshold      float64
	autoApproveThreshold  float64
	writePeopleBelowGate  bool    // §6.5 write discovered key_people even below the auto-approve gate
	minPeopleWriteScore   float64 // floor below which even the people-only write is suppressed
	gcsBucket             string
	shortsAPIURL          string // URL of the shorts API (for Algolia sync callbacks)
	internalServiceSecret string // Auth secret for internal API calls
}

// buildPeopleOnlyWriteJSON converts discovered key_people into the served key_people
// JSON shape (matching backfillPerson / the DB parser), dropping empty and placeholder
// names. Returns the marshalled JSON and the number of people written; (nil, 0) when there
// is nothing worth writing. Used by the §6.5 below-gate people-only write.
func buildPeopleOnlyWriteJSON(people []*stocksv1alpha1.CompanyPerson) ([]byte, int) {
	out := make([]backfillPerson, 0, len(people))
	for _, person := range people {
		if person == nil {
			continue
		}
		name := strings.TrimSpace(person.GetName())
		if name == "" || enrichment.IsPlaceholderName(name) {
			continue
		}
		out = append(out, backfillPerson{
			Name:        name,
			Role:        strings.TrimSpace(person.GetRole()),
			Bio:         person.GetBio(),
			ImageURL:    person.GetImageUrl(),
			ImageGCSURL: person.GetImageGcsUrl(),
			LinkedInURL: person.GetLinkedinUrl(),
			SourceURL:   person.GetSourceUrl(),
			SourceType:  person.GetSourceType(),
		})
	}
	if len(out) == 0 {
		return nil, 0
	}
	j, err := json.Marshal(out)
	if err != nil {
		return nil, 0
	}
	return j, len(out)
}

// notifyAlgoliaSync sends an HTTP POST to the shorts API to sync a stock's enriched data to Algolia.
// Fire-and-forget with a 10-second timeout -- logs errors but doesn't block the caller.
func (p *enrichmentProcessor) notifyAlgoliaSync(stockCode string) {
	if p.shortsAPIURL == "" {
		p.logger.Debugf("SHORTS_API_URL not configured, skipping Algolia sync for %s", stockCode)
		return
	}


	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	body := fmt.Sprintf(`{"stock_code":"%s"}`, stockCode)
	url := fmt.Sprintf("%s/api/internal/algolia/sync-stock", strings.TrimRight(p.shortsAPIURL, "/"))

	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(body))
	if err != nil {
		p.logger.Warnf("Failed to create Algolia sync request for %s: %v", stockCode, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if p.internalServiceSecret != "" {
		req.Header.Set("Authorization", "Bearer "+p.internalServiceSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		p.logger.Warnf("Failed to notify Algolia sync for %s: %v", stockCode, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusOK {
		p.logger.Infof("Algolia sync triggered for %s", stockCode)
	} else {
		respBody, _ := io.ReadAll(resp.Body)
		p.logger.Warnf("Algolia sync for %s returned status %d: %s", stockCode, resp.StatusCode, string(respBody))
	}
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
			// update it now with retry logic. This ensures the job NEVER gets stuck.
			errMsg := err.Error()
			// Retry with exponential backoff - this MUST succeed
			updateErr := p.store.UpdateEnrichmentJobStatus(
				jobID,
				shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
				nil,
				&errMsg,
			)
			if updateErr != nil {
				// This is critical - log it but the retry logic in UpdateEnrichmentJobStatus should handle it
				p.logger.Errorf("CRITICAL: Failed to update job %s status to failed in defer after retries (original error: %v): %v", jobID, err, updateErr)
				// At this point, we've exhausted all retries - the database-level safeguard should catch this
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
		// UpdateEnrichmentJobStatus has retry logic - it should always succeed
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			// This is critical - retry logic failed after 5 attempts
			p.logger.Errorf("CRITICAL: Failed to update job %s status after retries: %v", jobID, updateErr)
		} else {
			statusUpdated = true
		}
		return fmt.Errorf("%s", errMsg)
	}

	// Check if already enriched and not forced
	if !force && strings.EqualFold(details.EnrichmentStatus, "completed") {
		errMsg := "stock already enriched (use force=true to re-enrich)"
		// UpdateEnrichmentJobStatus has retry logic - it should always succeed
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			// This is critical - retry logic failed after 5 attempts
			p.logger.Errorf("CRITICAL: Failed to update job %s status after retries: %v", jobID, updateErr)
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
		// UpdateEnrichmentJobStatus has retry logic - it should always succeed
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			// This is critical - retry logic failed after 5 attempts
			p.logger.Errorf("CRITICAL: Failed to update job %s status after retries: %v", jobID, updateErr)
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
		// UpdateEnrichmentJobStatus has retry logic - it should always succeed
		if updateErr := p.store.UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			&errMsg,
		); updateErr != nil {
			// This is critical - retry logic failed after 5 attempts
			p.logger.Errorf("CRITICAL: Failed to update job %s status after retries: %v", jobID, updateErr)
		} else {
			statusUpdated = true
		}
		return fmt.Errorf("%s", errMsg)
	}

	// Auto-approve if quality score exceeds the threshold
	if p.autoApproveThreshold > 0 && quality != nil && quality.OverallScore >= p.autoApproveThreshold {
		p.logger.Infof("Auto-approving enrichment for %s (quality score %.2f >= threshold %.2f)",
			stockCode, quality.OverallScore, p.autoApproveThreshold)

		// Approve the pending enrichment
		if reviewErr := p.store.ReviewEnrichment(enrichmentID, true, "auto-approve", fmt.Sprintf("Auto-approved: quality score %.2f >= threshold %.2f", quality.OverallScore, p.autoApproveThreshold)); reviewErr != nil {
			p.logger.Warnf("Failed to auto-approve enrichment %s for %s: %v (will remain in pending review)", enrichmentID, stockCode, reviewErr)
		} else {
			// Apply the enrichment to company-metadata
			if applyErr := p.store.ApplyEnrichment(stockCode, enriched); applyErr != nil {
				p.logger.Warnf("Failed to auto-apply enrichment for %s: %v (approved but not applied)", stockCode, applyErr)
			} else {
				p.logger.Infof("Auto-approved and applied enrichment for %s (enrichment_id=%s)", stockCode, enrichmentID)
				// Sync to Algolia (fire-and-forget)
				go p.notifyAlgoliaSync(stockCode)
			}
		}
	} else if quality != nil {
		p.logger.Infof("Enrichment for %s saved as pending review (quality score %.2f < threshold %.2f)",
			stockCode, quality.OverallScore, p.autoApproveThreshold)

		// §6.5 People-only write: leadership shouldn't be gated behind the whole-company
		// quality score. Even though the full enrichment stays in pending review, write the
		// discovered key_people to the served column — but ADDITIVELY (only when the row has
		// none), so a better prior people list is never clobbered. enrichment_status is left
		// untouched, so the rest of the enrichment is still gated and can be approved later.
		if p.writePeopleBelowGate && quality.OverallScore >= p.minPeopleWriteScore {
			if peopleJSON, count := buildPeopleOnlyWriteJSON(enriched.GetKeyPeople()); count > 0 {
				if wrote, perr := p.store.UpdateKeyPeopleIfEmpty(stockCode, peopleJSON); perr != nil {
					p.logger.Warnf("People-only write failed for %s: %v", stockCode, perr)
				} else if wrote {
					p.logger.Infof("People-only write for %s: served %d people below gate (score %.2f, status left pending)",
						stockCode, count, quality.OverallScore)
				} else {
					p.logger.Debugf("People-only write skipped for %s: served row already has people", stockCode)
				}
			}
		}
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

// Per-phase timeout constants — prevent any single phase from eating the whole budget
const (
	phaseWebsiteDiscoveryTimeout = 60 * time.Second  // Phase 0
	phaseScrapingTimeout         = 90 * time.Second   // Phase 1: metadata scraping
	phaseReportCrawlTimeout      = 60 * time.Second   // Phase 2: financial report crawling
	phaseLLMEnrichTimeout        = 4 * time.Minute    // Phase 3: LLM enrichment (includes retries)
	phaseFallbackPeopleTimeout   = 2 * time.Minute     // Phase 3a: fallback people discovery
	phasePersonEnrichTimeout     = 90 * time.Second   // Phase 3.5: people enrichment
	phaseLogoTimeout             = 2 * time.Minute    // Phase 4: logo discovery + processing
	phaseQualityTimeout          = 60 * time.Second   // Phase 5: quality evaluation
)

// runEnrichmentPhases executes the 6 logical phases of enrichment
func (p *enrichmentProcessor) runEnrichmentPhases(ctx context.Context, stockCode string, details *stocksv1alpha1.StockDetails) (*shortsv1alpha1.EnrichmentData, *shortsv1alpha1.QualityScore, error) {
	// Track discovered website for later storage
	var discoveredWebsite string

	// Phase 0: Website Discovery (if missing)
	if strings.TrimSpace(details.Website) == "" {
		p.logger.Infof("Phase 0: Website missing for %s, attempting discovery...", stockCode)
		phase0Ctx, phase0Cancel := context.WithTimeout(ctx, phaseWebsiteDiscoveryTimeout)
		website, err := p.gptClient.DiscoverWebsite(phase0Ctx, stockCode, details.CompanyName, details.Industry)
		phase0Cancel()
		if err != nil {
			p.logger.Warnf("Phase 0: Website discovery failed for %s: %v", stockCode, err)
		} else if website != "" {
			p.logger.Infof("Phase 0: Discovered website for %s: %s", stockCode, website)
			details.Website = website
			discoveredWebsite = website
		} else {
			p.logger.Infof("Phase 0: No website found for %s", stockCode)
		}
	} else {
		p.logger.Infof("Phase 0: Skipped for %s (website already exists: %s)", stockCode, details.Website)
	}

	// Check parent context before proceeding
	if ctx.Err() != nil {
		return nil, nil, fmt.Errorf("context cancelled before Phase 1: %w", ctx.Err())
	}

	// Phase 1: Static scraping - scrape company metadata (leadership, about pages, key links)
	p.logger.Infof("Phase 1: Scraping metadata for %s from %s", stockCode, details.Website)
	phase1Ctx, phase1Cancel := context.WithTimeout(ctx, phaseScrapingTimeout)
	metadata, metadataErr := p.metadataScraper.ScrapeMetadata(phase1Ctx, details.Website, details.CompanyName, p.exaClient)
	phase1Cancel()
	if metadataErr != nil {
		p.logger.Warnf("metadata scraping failed for %s (continuing without): %v", stockCode, metadataErr)
		metadata = nil // Continue with nil metadata — scraping is best-effort
	} else {
		p.logger.Infof("Scraped %d leadership pages, %d about pages, %d key links for %s",
			len(metadata.LeadershipPages), len(metadata.AboutPages), len(metadata.KeyLinks), stockCode)
	}

	// Check parent context before LLM call
	if ctx.Err() != nil {
		return nil, nil, fmt.Errorf("context cancelled before Phase 2: %w", ctx.Err())
	}

	// Phase 2: Crawl financial reports
	p.logger.Infof("Phase 2: Crawling financial reports for %s", stockCode)
	phase2Ctx, phase2Cancel := context.WithTimeout(ctx, phaseReportCrawlTimeout)
	reports, crawlErr := p.reportCrawler.CrawlFinancialReports(phase2Ctx, details.Website)
	phase2Cancel()
	if crawlErr != nil {
		p.logger.Warnf("report crawl failed for %s (continuing without): %v", stockCode, crawlErr)
		reports = nil
	}

	// Check parent context before the critical LLM phase
	if ctx.Err() != nil {
		return nil, nil, fmt.Errorf("context cancelled before Phase 3: %w", ctx.Err())
	}

	// Phase 3: LLM enrichment with scraped metadata context
	p.logger.Infof("Phase 3: Enriching %s with LLM (using scraped metadata context)", stockCode)
	phase3Ctx, phase3Cancel := context.WithTimeout(ctx, phaseLLMEnrichTimeout)
	enriched, err := p.gptClient.EnrichCompany(
		phase3Ctx,
		stockCode,
		details.CompanyName,
		details.Industry,
		details.Website,
		details.Summary,
		reports,
		metadata, // Pass scraped metadata to LLM
	)
	phase3Cancel()
	if err != nil {
		p.logger.Warnf("Phase 3: LLM enrichment failed for %s, creating minimal enrichment: %v", stockCode, err)
		// Fallback: create minimal enrichment from existing DB data so the stock
		// is never left in a permanently failed state.
		enriched = &shortsv1alpha1.EnrichmentData{
			EnhancedSummary: details.Summary,
		}
		if details.Industry != "" {
			enriched.Tags = []string{details.Industry}
		}
	}

	// Post-process: filter out key_people entries with empty names (LLM placeholder artifacts)
	if enriched != nil && len(enriched.KeyPeople) > 0 {
		filtered := make([]*stocksv1alpha1.CompanyPerson, 0, len(enriched.KeyPeople))
		for _, person := range enriched.KeyPeople {
			if person != nil && strings.TrimSpace(person.Name) != "" {
				filtered = append(filtered, person)
			}
		}
		if len(filtered) != len(enriched.KeyPeople) {
			p.logger.Infof("Filtered %d empty-name people entries for %s (kept %d)", len(enriched.KeyPeople)-len(filtered), stockCode, len(filtered))
		}
		enriched.KeyPeople = filtered
	}

	// Phase 3a: Fallback people discovery when LLM returned 0 people
	if enriched != nil && len(enriched.KeyPeople) == 0 {
		phase3aCtx, phase3aCancel := context.WithTimeout(ctx, phaseFallbackPeopleTimeout)
		p.performFallbackPeopleDiscovery(phase3aCtx, stockCode, details, enriched)
		phase3aCancel()
	}

	// Phase 3.5: Person Image & LinkedIn Enrichment
	phase35Ctx, phase35Cancel := context.WithTimeout(ctx, phasePersonEnrichTimeout)
	p.performPersonEnrichmentPhase(phase35Ctx, stockCode, details.CompanyName, enriched)
	phase35Cancel()

	// Phase 4: Logo Discovery and Optimization
	p.logger.Infof("Phase 4: Starting logo discovery for %s (logoDiscoverer=%v, gcsBucket=%s, website=%s)",
		stockCode, p.logoDiscoverer != nil, p.gcsBucket, details.Website)
	if p.logoDiscoverer != nil {
		phase4Ctx, phase4Cancel := context.WithTimeout(ctx, phaseLogoTimeout)
		p.performLogoPhase(phase4Ctx, stockCode, details, enriched)
		phase4Cancel()
	} else {
		p.logger.Warnf("Phase 4: Skipped for %s (logoDiscoverer is nil)", stockCode)
	}

	// Phase 5: Evaluate quality
	p.logger.Infof("Phase 5: Evaluating enrichment quality for %s", stockCode)
	phase5Ctx, phase5Cancel := context.WithTimeout(ctx, phaseQualityTimeout)
	quality, err := p.gptClient.EvaluateQuality(phase5Ctx, stockCode, enriched)
	phase5Cancel()
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

	// Store discovered website in enrichment data for ApplyEnrichment to persist
	if discoveredWebsite != "" {
		enriched.DiscoveredWebsite = discoveredWebsite
		p.logger.Infof("Stored discovered website in enrichment data for %s: %s", stockCode, discoveredWebsite)
	}

	return enriched, quality, nil
}

// performPersonEnrichmentPhase handles Phase 3.5: Person Image & Data Enrichment
// Uses multiple data sources to enrich key people:
// 1. Yahoo Finance quoteSummary for officer names/titles (cross-reference + fill gaps)
// 2. Company website team pages for headshot images (via Chromium stealth)
// 3. Wikipedia for person images (headshots)
// 4. Upload images to GCS
func (p *enrichmentProcessor) performPersonEnrichmentPhase(ctx context.Context, stockCode, companyName string, enriched *shortsv1alpha1.EnrichmentData) {
	if enriched == nil || len(enriched.KeyPeople) == 0 {
		p.logger.Infof("Phase 3.5: Skipped for %s (no key people)", stockCode)
		return
	}

	p.logger.Infof("Phase 3.5: Enriching %d key people for %s", len(enriched.KeyPeople), stockCode)

	// Step 1: Fetch Yahoo Finance officers to cross-reference and supplement
	if p.yahooPeopleClient != nil {
		yahooOfficers, err := p.yahooPeopleClient.GetCompanyOfficers(ctx, stockCode)
		if err != nil {
			p.logger.Warnf("Phase 3.5: Yahoo Finance officers fetch failed for %s: %v", stockCode, err)
		} else if len(yahooOfficers) > 0 {
			p.logger.Infof("Phase 3.5: Got %d officers from Yahoo Finance for %s", len(yahooOfficers), stockCode)
			p.mergeYahooOfficers(enriched, yahooOfficers)
		}
	}

	// Step 2: Scrape company website team pages for headshot images
	// This uses the metadata scraper (with Chromium fallback) to find images
	// associated with person names on leadership/team pages.
	var websiteImages map[string]string // lowercase name → image URL
	website := "" // will be set from stock details
	if scraper, ok := p.metadataScraper.(*enrichment.MetadataScraper); ok {
		// Get website URL from store
		details, err := p.store.GetStockDetails(stockCode)
		if err == nil && details.Website != "" {
			website = details.Website
			personNames := make([]string, 0, len(enriched.KeyPeople))
			for _, person := range enriched.KeyPeople {
				if person != nil && person.Name != "" {
					personNames = append(personNames, person.Name)
				}
			}

			if len(personNames) > 0 {
				p.logger.Infof("Phase 3.5: Scraping team pages for headshots (%d people, website: %s)", len(personNames), website)
				images := scraper.ScrapePersonImages(ctx, website, personNames)
				if len(images) > 0 {
					websiteImages = make(map[string]string, len(images))
					for _, img := range images {
						key := strings.ToLower(strings.TrimSpace(img.PersonName))
						websiteImages[key] = img.ImageURL
						p.logger.Infof("Phase 3.5: Found headshot on team page for %s: %s", img.PersonName, img.ImageURL)
					}
				}
			}
		}
	}

	// Step 3: For each person, try to find an image
	// Priority: company website headshot > LinkedIn (verified) > Wikipedia
	maxPeople := min(5, len(enriched.KeyPeople))

	for i := 0; i < maxPeople; i++ {
		person := enriched.KeyPeople[i]
		if person == nil || person.Name == "" {
			continue
		}

		p.logger.Infof("Phase 3.5: Looking up image for %s (%s)", person.Name, person.Role)

		// Source A: Company website team page headshot (highest quality, most relevant)
		if person.ImageUrl == "" && websiteImages != nil {
			key := strings.ToLower(strings.TrimSpace(person.Name))
			if imgURL, ok := websiteImages[key]; ok {
				person.ImageUrl = imgURL
				person.SourceUrl = website
				person.SourceType = "company_website"
				p.logger.Infof("Phase 3.5: Found headshot from company website for %s: %s", person.Name, imgURL)
			}
		}

		// Source B: LinkedIn profile (verified employment at target company)
		if person.ImageUrl == "" && p.linkedInPersonClient != nil {
			liResult, err := p.linkedInPersonClient.FindAndVerifyPerson(ctx, person.Name, person.Role, companyName, stockCode)
			if err != nil {
				p.logger.Warnf("Phase 3.5: LinkedIn lookup failed for %s: %v", person.Name, err)
			} else if liResult != nil && liResult.ImageURL != "" {
				person.ImageUrl = liResult.ImageURL
				person.SourceUrl = liResult.ProfileURL
				person.SourceType = "linkedin"
				if liResult.ExperienceTitle != "" && person.Role == "" {
					person.Role = liResult.ExperienceTitle
				}
				p.logger.Infof("Phase 3.5: Found verified LinkedIn photo for %s (source: %s, company match: %s): %s",
					person.Name, liResult.Source, liResult.MatchedCompany, liResult.ImageURL)
			} else {
				p.logger.Debugf("Phase 3.5: LinkedIn lookup returned no result for %s", person.Name)
			}
		}

		// Source C: Wikipedia (good for well-known executives)
		if person.ImageUrl == "" && p.wikipediaClient != nil {
			imageURL, pageURL, err := p.wikipediaClient.GetPersonImage(ctx, person.Name)
			if err != nil {
				p.logger.Warnf("Phase 3.5: Wikipedia lookup failed for %s: %v", person.Name, err)
			} else if imageURL != "" {
				person.ImageUrl = imageURL
				person.SourceUrl = pageURL
				person.SourceType = "wikipedia"
				p.logger.Infof("Phase 3.5: Found image via Wikipedia for %s: %s", person.Name, imageURL)
			}
		}

		// Upload image to GCS if found from any source
		if person.ImageUrl != "" && p.personImageProcessor != nil {
			gcsURL, err := p.personImageProcessor.ProcessAndUpload(ctx, person.ImageUrl, stockCode, person.Name)
			if err != nil {
				p.logger.Warnf("Phase 3.5: Image upload failed for %s: %v", person.Name, err)
			} else {
				person.ImageGcsUrl = gcsURL
				p.logger.Infof("Phase 3.5: Uploaded image to GCS for %s: %s", person.Name, gcsURL)
			}
		}
	}

	// Close shared Chromium client used for LinkedIn searches
	if p.linkedInPersonClient != nil {
		p.linkedInPersonClient.Close()
	}

	p.logger.Infof("Phase 3.5: Completed person enrichment for %s", stockCode)
}

// mergeYahooOfficers cross-references Yahoo Finance officers with existing key people.
// Updates roles/titles from Yahoo when they match by name, and appends any new officers
// not already in the list (up to 10 total).
func (p *enrichmentProcessor) mergeYahooOfficers(enriched *shortsv1alpha1.EnrichmentData, yahooOfficers []enrichment.YahooOfficer) {
	existingNames := make(map[string]int) // lowercase name → index in KeyPeople
	for i, person := range enriched.KeyPeople {
		if person != nil {
			existingNames[strings.ToLower(strings.TrimSpace(person.Name))] = i
		}
	}

	for _, officer := range yahooOfficers {
		normalizedName := strings.ToLower(strings.TrimSpace(officer.Name))

		if idx, found := existingNames[normalizedName]; found {
			// Cross-reference: update role if Yahoo has a better title
			existing := enriched.KeyPeople[idx]
			if existing.Role == "" && officer.Title != "" {
				existing.Role = officer.Title
			}
			if existing.SourceType == "" {
				existing.SourceType = "yahoo_finance"
			}
		} else if len(enriched.KeyPeople) < 10 {
			// New officer not in LLM-generated list — append
			enriched.KeyPeople = append(enriched.KeyPeople, &stocksv1alpha1.CompanyPerson{
				Name:       officer.Name,
				Role:       officer.Title,
				SourceType: "yahoo_finance",
			})
			existingNames[normalizedName] = len(enriched.KeyPeople) - 1
		}
	}
}

// performFallbackPeopleDiscovery handles Phase 3a: Fallback People Discovery.
// Called only when the main LLM enrichment returned 0 key_people.
// Tries Yahoo Finance officers and extended website crawl + LLM extraction.
func (p *enrichmentProcessor) performFallbackPeopleDiscovery(ctx context.Context, stockCode string, details *stocksv1alpha1.StockDetails, enriched *shortsv1alpha1.EnrichmentData) {
	p.logger.Infof("Phase 3a: Fallback people discovery for %s (LLM returned 0 people)", stockCode)

	var allPeople []*stocksv1alpha1.CompanyPerson

	// Source 1: Yahoo Finance officers (fast, free, no API key)
	if p.yahooPeopleClient != nil {
		officers, err := p.yahooPeopleClient.GetCompanyOfficers(ctx, stockCode)
		if err != nil {
			p.logger.Warnf("Phase 3a: Yahoo Finance failed for %s: %v", stockCode, err)
		} else if len(officers) > 0 {
			p.logger.Infof("Phase 3a: Got %d officers from Yahoo Finance for %s", len(officers), stockCode)
			for _, o := range officers {
				allPeople = append(allPeople, &stocksv1alpha1.CompanyPerson{
					Name:       o.Name,
					Role:       o.Title,
					SourceType: "yahoo_finance",
				})
			}
		}
	}

	// Source 2: Extended website crawl + LLM extraction
	if details.Website != "" && p.gptClient != nil {
		scraper, ok := p.metadataScraper.(*enrichment.MetadataScraper)
		if ok {
			rawText, err := scraper.ScrapePeoplePages(ctx, details.Website)
			if err != nil {
				p.logger.Warnf("Phase 3a: Extended website crawl failed for %s: %v", stockCode, err)
			} else if rawText != "" {
				extracted, err := p.gptClient.ExtractPeopleFromText(ctx, stockCode, details.CompanyName, rawText)
				if err != nil {
					p.logger.Warnf("Phase 3a: LLM people extraction failed for %s: %v", stockCode, err)
				} else if len(extracted) > 0 {
					p.logger.Infof("Phase 3a: Extracted %d people from website for %s", len(extracted), stockCode)
					allPeople = append(allPeople, extracted...)
				}
			}
		}
	}

	// Deduplicate by normalized name
	enriched.KeyPeople = deduplicatePeople(allPeople)

	if len(enriched.KeyPeople) > 0 {
		p.logger.Infof("Phase 3a: Found %d people via fallback for %s", len(enriched.KeyPeople), stockCode)
	} else {
		p.logger.Infof("Phase 3a: No people found via fallback for %s", stockCode)
	}
}

// deduplicatePeople merges people entries by normalized name, preferring entries with more data.
func deduplicatePeople(people []*stocksv1alpha1.CompanyPerson) []*stocksv1alpha1.CompanyPerson {
	if len(people) == 0 {
		return nil
	}

	type entry struct {
		person *stocksv1alpha1.CompanyPerson
		index  int // preserves insertion order
	}
	seen := make(map[string]*entry, len(people))

	for i, p := range people {
		if p == nil || strings.TrimSpace(p.Name) == "" {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(p.Name))
		if existing, ok := seen[key]; ok {
			// Merge: prefer entries with more complete data
			if existing.person.Role == "" && p.Role != "" {
				existing.person.Role = p.Role
			}
			if existing.person.Bio == "" && p.Bio != "" {
				existing.person.Bio = p.Bio
			}
			if existing.person.SourceType == "" && p.SourceType != "" {
				existing.person.SourceType = p.SourceType
			}
		} else {
			seen[key] = &entry{person: p, index: i}
		}
	}

	// Collect in original order
	result := make([]*stocksv1alpha1.CompanyPerson, 0, len(seen))
	ordered := make([]*entry, 0, len(seen))
	for _, e := range seen {
		ordered = append(ordered, e)
	}
	// Sort by insertion order
	for i := 0; i < len(ordered); i++ {
		for j := i + 1; j < len(ordered); j++ {
			if ordered[i].index > ordered[j].index {
				ordered[i], ordered[j] = ordered[j], ordered[i]
			}
		}
	}
	for _, e := range ordered {
		result = append(result, e.person)
	}
	return result
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
	// Register specific routes BEFORE the catch-all route
	// This ensures they match correctly in Go 1.24+
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.HandleFunc("/process-queued", p.handleProcessQueued)
	mux.HandleFunc("/reset-stuck-jobs", p.handleResetStuckJobs)
	mux.HandleFunc("/backfill-people", p.handleBackfillPeople)
	mux.HandleFunc("/enrich-batch", p.handleEnrichBatch)
	mux.HandleFunc("/enrichment/stats", p.handleEnrichmentStats)
	mux.HandleFunc("/", p.handlePubSubPush) // Catch-all for Pub/Sub push messages

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

	// Process job synchronously so Cloud Run keeps the instance alive for the
	// duration of the request. This allows scale-to-zero between messages.
	// Pub/Sub push ack deadline should be configured to match Cloud Run timeout.
	force := job.Force

	if err := p.processJob(r.Context(), jobMsg.JobID, jobMsg.StockCode, force); err != nil {
		if strings.Contains(err.Error(), "stock already enriched") && !force {
			// Permanent failure — ack the message so Pub/Sub doesn't retry
			p.logger.Warnf("Job %s failed permanently (already enriched without force): %v", jobMsg.JobID, err)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("Job already enriched"))
			return
		}
		p.logger.Errorf("Failed to process job %s: %v", jobMsg.JobID, err)
		// Return 500 so Pub/Sub retries the message
		http.Error(w, "Job processing failed", http.StatusInternalServerError)
		return
	}

	p.logger.Infof("Successfully processed job %s", jobMsg.JobID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
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

// handleResetStuckJobs manually resets jobs stuck in processing status
func (p *enrichmentProcessor) handleResetStuckJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	p.logger.Infof("Manual trigger: Resetting stuck jobs...")

	// Reset jobs stuck for more than 5 minutes
	count, err := p.store.ResetStuckJobs(5)
	if err != nil {
		p.logger.Errorf("Failed to reset stuck jobs: %v", err)
		http.Error(w, fmt.Sprintf("Failed to reset stuck jobs: %v", err), http.StatusInternalServerError)
		return
	}

	p.logger.Infof("Reset %d stuck job(s) back to queued", count)
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "Reset %d stuck job(s) back to queued", count)
}

// handleBackfillPeople runs people enrichment backfill via HTTP endpoint
func (p *enrichmentProcessor) handleBackfillPeople(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse limit from query param, default 50
	limit := 50
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}

	p.logger.Infof("HTTP trigger: People backfill (limit: %d)", limit)

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	writeProgress := func(msg string) {
		_, _ = w.Write([]byte(msg + "\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	writeProgress(fmt.Sprintf("Starting people backfill (limit: %d)...", limit))

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Hour)
	defer cancel()

	if err := p.runPeopleBackfill(ctx, limit); err != nil {
		writeProgress(fmt.Sprintf("Error: %v", err))
		return
	}

	writeProgress("People backfill complete")
}

// handleEnrichBatch creates and processes enrichment jobs for stocks needing enrichment
func (p *enrichmentProcessor) handleEnrichBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse parameters
	limit := 50
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}
	force := r.URL.Query().Get("force") == "true"
	autoApprove := r.URL.Query().Get("auto_approve") != "false" && r.URL.Query().Get("autoApprove") != "false" // default true

	// Parse priority (default: unenriched to skip already-completed stocks)
	priority := shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_UNENRICHED
	switch strings.ToLower(r.URL.Query().Get("priority")) {
	case "short_position":
		priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_SHORT_POSITION
	case "stale":
		priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_STALE
	case "all", "unspecified":
		priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_UNSPECIFIED
	}

	p.logger.Infof("HTTP trigger: Batch enrichment (limit: %d, force: %v, autoApprove: %v, priority: %s)", limit, force, autoApprove, priority.String())

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	writeProgress := func(msg string) {
		_, _ = w.Write([]byte(msg + "\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	// Get stocks needing enrichment
	candidates, err := p.store.GetTopStocksForEnrichment(int32(limit), priority)
	if err != nil {
		writeProgress(fmt.Sprintf("Error getting stocks: %v", err))
		return
	}

	if len(candidates) == 0 {
		writeProgress("No stocks need enrichment")
		return
	}

	writeProgress(fmt.Sprintf("Found %d stocks needing enrichment, processing...", len(candidates)))

	// Use a background context so the batch continues even if the HTTP client disconnects.
	// Cloud Run keeps the instance alive as long as a goroutine is running.
	// Budget 55 minutes to leave headroom for Cloud Run's 1-hour max request timeout.
	const batchSafetyMargin = 5 * time.Minute
	batchDeadline := time.Now().Add(55 * time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), batchDeadline)
	defer cancel()

	successCount := 0
	failCount := 0
	skippedCount := 0

	// With per-phase timeouts, most stocks complete in 1-3 minutes.
	// Use a smaller buffer than the full job timeout for the batch cutoff check.
	const minTimePerStock = 3 * time.Minute

	for i, candidate := range candidates {
		stockCode := candidate.StockCode
		// Check if we have enough time remaining for another stock
		remaining := time.Until(batchDeadline) - batchSafetyMargin
		if remaining < minTimePerStock {
			skippedCount = len(candidates) - i
			writeProgress(fmt.Sprintf("  Stopping batch: only %v remaining (need %v per stock), skipping %d stocks",
				remaining.Round(time.Second), minTimePerStock, skippedCount))
			break
		}

		// Throttle between stocks to avoid OpenAI rate limits (429s)
		if i > 0 {
			time.Sleep(3 * time.Second)
		}

		writeProgress(fmt.Sprintf("[%d/%d] Enriching %s... (%v remaining)", i+1, len(candidates), stockCode, remaining.Round(time.Second)))

		// Create enrichment job
		jobID, err := p.store.CreateEnrichmentJob(stockCode, force)
		if err != nil {
			if strings.Contains(err.Error(), "already enriched") {
				writeProgress(fmt.Sprintf("  SKIPPED: %s already enriched", stockCode))
			} else {
				writeProgress(fmt.Sprintf("  FAILED to create job: %v", err))
				failCount++
			}
			continue
		}

		// Process the job
		if err := p.processJob(ctx, jobID, stockCode, force); err != nil {
			writeProgress(fmt.Sprintf("  FAILED: %v", err))
			failCount++
			continue
		}

		// Auto-approve and apply if enabled
		if autoApprove {
			// Get the completed job to find the enrichment ID
			job, err := p.store.GetEnrichmentJob(jobID)
			if err != nil || job.EnrichmentId == "" {
				writeProgress(fmt.Sprintf("  ENRICHED but could not auto-approve (no enrichment ID): %v", err))
				successCount++
				continue
			}

			// Get the pending enrichment data
			pending, err := p.store.GetPendingEnrichment(job.EnrichmentId)
			if err != nil {
				writeProgress(fmt.Sprintf("  ENRICHED but could not fetch pending enrichment: %v", err))
				successCount++
				continue
			}

			// Approve the enrichment
			if err := p.store.ReviewEnrichment(job.EnrichmentId, true, "batch-auto-approve", "Auto-approved by batch enrichment"); err != nil {
				writeProgress(fmt.Sprintf("  ENRICHED but review failed: %v", err))
				successCount++
				continue
			}

			// Apply the enrichment to company-metadata
			if err := p.store.ApplyEnrichment(stockCode, pending.Data); err != nil {
				writeProgress(fmt.Sprintf("  ENRICHED+APPROVED but apply failed: %v", err))
				successCount++
				continue
			}
			go p.notifyAlgoliaSync(stockCode)

			// Sync to Algolia (fire-and-forget)
			go p.notifyAlgoliaSync(stockCode)
			writeProgress(fmt.Sprintf("  SUCCESS: %s enriched + auto-approved + applied", stockCode))
		} else {
			writeProgress(fmt.Sprintf("  SUCCESS: %s enriched (pending review)", stockCode))
		}
		successCount++
	}

	summary := fmt.Sprintf("Batch enrichment complete: %d succeeded, %d failed, %d skipped (time), %d total (autoApprove: %v)", successCount, failCount, skippedCount, len(candidates), autoApprove)
	p.logger.Infof(summary)
	writeProgress(summary)
}

// handleEnrichmentStats returns enrichment coverage statistics as JSON
func (p *enrichmentProcessor) handleEnrichmentStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	stats, err := p.store.GetEnrichmentStats()
	if err != nil {
		p.logger.Errorf("Failed to get enrichment stats: %v", err)
		http.Error(w, fmt.Sprintf("Failed to get enrichment stats: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		p.logger.Errorf("Failed to encode enrichment stats: %v", err)
	}
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

