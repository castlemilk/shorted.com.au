package shorts

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
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
	gptClient      enrichment.GPTClient
	reportCrawler  enrichment.FinancialReportCrawler
	pubSubClient   PubSubClient
	rateLimiter    ratelimit.RateLimiter
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

	// Optional enrichment dependencies (service can run without them)
	var gptClient enrichment.GPTClient
	openAIKey := strings.TrimSpace(cfg.OpenAIApiKey)
	if openAIKey == "" {
		openAIKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	}
	if openAIKey != "" {
		client, err := enrichment.NewOpenAIGPTClient(openAIKey)
		if err != nil {
			return nil, err
		}
		gptClient = client
	}

	reportCrawler := enrichment.NewReportCrawler()

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

	// Initialize rate limiter (optional, service can run without it)
	var rateLimiter ratelimit.RateLimiter
	if cfg.RateLimitConfig.Enabled {
		if cfg.RateLimitConfig.UpstashURL != "" && cfg.RateLimitConfig.UpstashToken != "" {
			rateLimiter, err = ratelimit.NewSlidingWindowLimiter(cfg.RateLimitConfig)
			if err != nil {
				logger.Warnf("Failed to initialize rate limiter: %v (rate limiting disabled)", err)
				rateLimiter = nil
			} else {
				logger.Infof("Rate limiting enabled with Upstash Redis")
			}
		} else {
			logger.Warnf("Rate limiting enabled but Upstash credentials not configured")
		}
	} else {
		logger.Infof("Rate limiting disabled")
	}

	return &ShortsServer{
		config:         cfg,
		store:          store,
		cache:          cache,
		logger:         logger,
		registerServer: registerServer,
		tokenService:   tokenService,
		gptClient:      gptClient,
		reportCrawler:  reportCrawler,
		pubSubClient:   pubSubClient,
		rateLimiter:    rateLimiter,
	}, nil
}
