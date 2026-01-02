package shorts

import (
	"context"
	"os"
	"strings"
	"time"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
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
}

// New creates instance of the Server
func New(ctx context.Context, cfg Config) (*ShortsServer, error) {
	// Create cache with 5 minute TTL for most data
	cache := NewMemoryCache(5 * time.Minute)

	// Create store adapter
	storeImpl := shorts.NewStore(cfg.ShortsStoreConfig)
	store := NewStoreAdapter(storeImpl)

	// Create logger adapter
	logger := NewLoggerAdapter()

	// Token secret - should be in config in production
	tokenSecret := "dev-secret" // TODO: get from config
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
	pubSubClient, err := NewPubSubClientFromEnv(ctx)
	if err != nil {
		logger.Warnf("Failed to initialize Pub/Sub client: %v (enrichment jobs will not be queued)", err)
		pubSubClient = nil
	}

	return &ShortsServer{
		config:         cfg,
		store:          store,
		cache:          cache,
		logger:         logger,
		registerServer: register.NewRegisterServer(cfg.ShortsStoreConfig),
		tokenService:   tokenService,
		gptClient:      gptClient,
		reportCrawler:  reportCrawler,
		pubSubClient:   pubSubClient,
	}, nil
}
