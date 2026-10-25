package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"connectrpc.com/connect"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"
)

func main() {
	// Every line this process writes passes through the redacting writer, so a
	// secret that reaches a log call unscrubbed still does not leave the process.
	log.SetOutput(redactingWriter{dst: os.Stderr})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	registerSecrets(cfg.GeminiAPIKey, cfg.InternalServiceSecret, cfg.DatabaseURL, cfg.FlaggrAPIKey)
	// Every provider key is registered, so no error or log line can carry one.
	for _, key := range cfg.ProviderKeys {
		registerSecrets(key)
	}
	if dsn, err := url.Parse(cfg.DatabaseURL); err == nil && dsn.User != nil {
		if password, ok := dsn.User.Password(); ok {
			registerSecrets(password)
		}
	}

	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "chat-service")
	if otelErr != nil {
		log.Printf("WARNING: Failed to initialize OpenTelemetry: %v", otelErr)
	}
	if otelShutdown != nil {
		defer func() {
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer shutdownCancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("Error shutting down OpenTelemetry: %v", err)
			}
		}()
	}

	// Connect to database
	var store *ConversationStore
	if cfg.DatabaseURL != "" {
		poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("Failed to parse database URL: %v", err)
		}
		poolCfg.MaxConns = 5                                            // Budget: shorts(25) + chat(5) + news(3) + enrichment(3) = 36 < 60
		poolCfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec // extended protocol with unnamed statements; no named statement cache

		pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
		if err != nil {
			log.Fatalf("Failed to connect to database: %v", err)
		}
		defer pool.Close()

		if err := pool.Ping(ctx); err != nil {
			log.Fatalf("Failed to ping database: %v", err)
		}
		log.Println("Connected to database")

		store = NewConversationStore(pool)
		shortedotel.RegisterDBPoolMetrics(pool)
	} else {
		log.Println("WARNING: No database configured, chat history will not be persisted")
	}

	// Create tool executor
	toolExecutor := NewToolExecutor(cfg.ShortsAPIURL)

	// Create the model router. Without a primary model chat is not configured,
	// which is what an unset GEMINI_API_KEY has always meant.
	var runner turnRunner
	router, err := NewModelRouter(ctx, cfg, toolExecutor)
	if err != nil {
		log.Fatalf("Failed to configure the chat model: %v", err)
	}
	if router != nil {
		defer router.Close()
		runner = router
		fallback := "none"
		if cfg.ChatFallbackProvider != "" {
			fallback = cfg.ChatFallbackProvider + "/" + cfg.ChatFallbackModel
		}
		b := router.Bounds()
		log.Printf("chat model initialized (primary: %s/%s, fallback: %s, max_output_tokens: %d, first_byte_timeout: %s, idle_timeout: %s, turn_timeout: %s, fallback_set: %t)",
			cfg.ChatProvider, cfg.ChatModel, fallback, cfg.ChatMaxOutputTokens, b.FirstByte, b.Idle, b.Turn, b.HasFallback)
	} else {
		log.Println("WARNING: No GEMINI_API_KEY configured, chat will not work")
	}

	// Create handler
	handler := NewChatServiceHandler(store, runner, cfg)

	// The chat-model flag picks a route per user. Without a Flaggr key and service
	// id it is off: no client, no flagged route, and every turn is the default.
	// A client that cannot be made also leaves it off, and never stops startup.
	defaultRouteID := routeID(cfg.ChatProvider, cfg.ChatModel)
	flagClient, flagErr := newChatModelFlagClient(cfg)
	switch {
	case flagErr != nil:
		log.Printf("WARNING: chat model flag is off: %v", flagErr)
	case flagClient == nil:
		log.Println("chat model flag is off (FLAGGR_API_KEY or FLAGGR_SERVICE_ID is not set)")
	default:
		flagRoutes := buildChatModelRoutes(ctx, cfg, toolExecutor, defaultRouteID)
		defer closeChatModelRoutes(flagRoutes)
		timing := flagTiming{Turn: cfg.ChatModelFlagTimeout, Lookup: cfg.ChatModelFlagLookupTimeout, TTL: cfg.ChatModelFlagTTL, MaxStale: cfg.ChatModelFlagMaxStale}
		handler.SetModelSelector(newChatModelSelector(flagClient, defaultRouteID, cfg.Environment, flagRoutes, timing))
		log.Printf("chat model flag on: default=%s flagged_routes=%v turn_timeout=%s lookup_timeout=%s ttl=%s max_stale=%s",
			defaultRouteID, sortedRouteIDs(flagRoutes), timing.Turn, timing.Lookup, timing.TTL, timing.MaxStale)
	}

	// Create mux with Connect-RPC handler. Health remains public for Cloud Run
	// probes; all chat RPCs require the service-to-service secret.
	mux := http.NewServeMux()
	chatMux := http.NewServeMux()

	// Register the chat service
	path, h := chatv1connect.NewChatServiceHandler(handler, connect.WithInterceptors(shortedotel.OTelInterceptor()))
	chatMux.Handle(path, h)
	mux.Handle("/", requireInternalSecret(cfg.InternalServiceSecret, chatMux))

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"status":"ok","service":"chat-service"}`)
	})

	// CORS
	corsHandler := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders: []string{
			"Content-Type",
			"Connect-Protocol-Version",
			"Connect-Timeout-Ms",
			"Grpc-Timeout",
			"X-Grpc-Web",
			"X-User-Agent",
			"X-User-Id",
			"X-User-Email",
			"X-Internal-Secret",
			"Authorization",
		},
		ExposedHeaders: []string{
			"Grpc-Status",
			"Grpc-Message",
			"Grpc-Status-Details-Bin",
		},
	}).Handler(mux)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      corsHandler,
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("Shutdown error: %v", err)
		}
	}()

	log.Printf("Chat service starting on :%d", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
