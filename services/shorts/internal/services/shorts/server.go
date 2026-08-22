package shorts

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/register"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ShortsServer ...
type ShortsServer struct {
	config Config
	store  ShortsStore
	cache  Cache
	logger Logger
	shortsv1alpha1connect.UnimplementedShortedStocksServiceHandler
	registerServer *register.RegisterServer
	tokenService   *TokenService
	pubSubClient   PubSubClient
	rateLimiter    ratelimit.RateLimiter
	httpClient     *http.Client
	jobsCollector  *jobmonitor.Collector
}

// New creates instance of the Server
func New(ctx context.Context, cfg Config) (*ShortsServer, error) {
	// Create cache with 5 minute TTL for most data
	cache := NewMemoryCache(5 * time.Minute)

	// Create store adapter
	storeImpl, err := shorts.NewStore(cfg.ShortsStoreConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create store: %w", err)
	}
	store := NewStoreAdapter(storeImpl)

	// Create logger adapter
	logger := NewLoggerAdapter()

	// Token secret - required in production, optional in development
	tokenSecret := os.Getenv("TOKEN_SECRET")
	if tokenSecret == "" {
		// Check if we're in production
		// Support both ENV and ENVIRONMENT (Terraform/Cloud Run uses ENVIRONMENT)
		env := os.Getenv("ENV")
		if env == "" {
			env = os.Getenv("ENVIRONMENT")
		}
		if env == "production" || env == "prod" {
			return nil, fmt.Errorf("TOKEN_SECRET environment variable is required in production")
		}
		// Allow fallback only in development
		tokenSecret = "dev-secret-unsafe-do-not-use-in-production"
	}
	tokenService := NewTokenService(tokenSecret)

	// Initialize Pub/Sub client (optional, service can run without it)
	var pubSubClient PubSubClient
	pubSubClient, err = NewPubSubClientFromEnv(ctx)
	if err != nil {
		logger.Warnf("Failed to initialize Pub/Sub client: %v (enrichment jobs will not be queued)", err)
		pubSubClient = nil
	}

	registerServer, err := register.NewRegisterServer(cfg.ShortsStoreConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create register server: %w", err)
	}

	// Initialize the monthly quota limiter (optional, service can run without it).
	//
	// Per-minute limiting is NOT done here — it is enforced at the Cloudflare
	// edge worker (services/edge-worker/worker.js). The app layer only accounts
	// monthly quotas, with batched writes and a circuit breaker, so a sick
	// Upstash database can never 500 users or take the API down with it.
	var rateLimiter ratelimit.RateLimiter
	if cfg.RateLimitConfig.Enabled {
		if cfg.RateLimitConfig.UpstashURL != "" && cfg.RateLimitConfig.UpstashToken != "" {
			rateLimiter, err = ratelimit.NewMonthlyLimiter(cfg.RateLimitConfig)
			if err != nil {
				logger.Warnf("Failed to initialize monthly quota limiter: %v (quota accounting disabled)", err)
				rateLimiter = nil
			} else {
				logger.Infof("Monthly quota accounting enabled (Upstash, batched); per-minute limiting is enforced at the Cloudflare edge")
			}
		} else {
			logger.Warnf("Rate limiting enabled but Upstash credentials not configured — monthly quotas will not be enforced")
		}
	} else {
		logger.Infof("App-layer monthly quota accounting disabled (per-minute limiting is unaffected — it runs at the Cloudflare edge)")
	}

	return &ShortsServer{
		config:         cfg,
		store:          store,
		cache:          cache,
		logger:         logger,
		registerServer: registerServer,
		tokenService:   tokenService,
		pubSubClient:   pubSubClient,
		rateLimiter:    rateLimiter,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
		jobsCollector:  jobmonitor.NewCollector(jobmonitor.ConfigFromEnv()),
	}, nil
}
