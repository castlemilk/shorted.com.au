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
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/oauth"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/register"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The MCP tools call this server's Connect handlers in-process, so the set of
// methods they can reach is exactly mcp.DataSource. Asserting it here means a
// signature change on a wrapped handler breaks the build in this package —
// next to the handler — rather than at the mount in serve.go.
var _ mcp.DataSource = (*ShortsServer)(nil)

// Close releases resources held by the server.
//
// This is not optional bookkeeping: the rate limiter buffers monthly quota
// increments in memory and flushes them in batches, so a shutdown that skips
// Close silently discards up to one batch per identifier.
func (s *ShortsServer) Close() error {
	if s.rateLimiter != nil {
		return s.rateLimiter.Close()
	}
	return nil
}

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
	// oauthStore backs the OAuth authorization server (clients, codes,
	// refresh tokens — migration 000116). Nil when no Postgres pool is
	// reachable, in which case the grant endpoint reports
	// temporarily_unavailable rather than panicking.
	oauthStore oauth.Store
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
	// Tokens are audience-bound (RFC 8707) to this deployment's origin and its
	// MCP resource identifier. An unset APIBaseURL would mint audience-less
	// tokens that the MCP resource server refuses, so normalise once here —
	// every later reader (the metadata document, the bearer challenge) then
	// sees the same origin the tokens were minted against.
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = mcp.DefaultAPIBaseURL
	}
	tokenService := NewTokenService(tokenSecret, TokenAudience(cfg.APIBaseURL)...)

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

	// Initialize the app-layer rate limiter (optional, service can run without it).
	//
	// It owns two things: the documented PER-TIER per-minute limits (in memory,
	// per instance) and monthly quotas (Postgres, batched). The tier-blind
	// abuse ceiling is separate and runs at the Cloudflare edge worker
	// (services/edge-worker/worker.js).
	//
	// The quota store REUSES the store's pgx pool rather than opening its own —
	// Supabase max_connections is shared across services. If the pool is not
	// reachable through the store (non-Postgres backend), per-minute limiting
	// still runs; only monthly accounting is skipped.
	//
	// The OAuth authorization server shares that same pool, for the same
	// reason — see the oauthStore wiring below.
	var pool *pgxpool.Pool
	if pooled, ok := storeImpl.(interface{ Pool() *pgxpool.Pool }); ok {
		pool = pooled.Pool()
	}

	var rateLimiter ratelimit.RateLimiter
	if cfg.RateLimitConfig.Enabled {
		var usageStore ratelimit.UsageStore
		if pool != nil {
			usageStore = ratelimit.NewPostgresUsageStore(pool, cfg.RateLimitConfig.Timeout)
			logger.Infof("Monthly quota accounting enabled (Postgres api_usage_monthly, batched writes, fail-open)")
		} else {
			logger.Warnf("Rate limiting enabled but no Postgres pool available — per-minute tier limits still apply, monthly quotas will not be enforced")
		}
		rateLimiter = ratelimit.NewAppLimiter(cfg.RateLimitConfig, usageStore)
	} else {
		logger.Infof("App-layer rate limiting disabled (the Cloudflare edge abuse ceiling is unaffected)")
	}

	// OAuth authorization-server storage. A typed-nil in the interface would
	// read as "configured" and panic on first use, so the assignment is
	// conditional on a real pool.
	var oauthStore oauth.Store
	if pool != nil {
		oauthStore = oauth.NewPostgresStore(pool)
	} else {
		logger.Warnf("No Postgres pool available — the OAuth authorization endpoints will report temporarily_unavailable")
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
		oauthStore:     oauthStore,
	}, nil
}
