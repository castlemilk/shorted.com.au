package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Connect to database
	var store *ConversationStore
	if cfg.DatabaseURL != "" {
		poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("Failed to parse database URL: %v", err)
		}
		poolCfg.MaxConns = 5 // Budget: shorts(25) + chat(5) + news(3) + enrichment(3) = 36 < 60
		poolCfg.ConnConfig.DefaultQueryExecMode = 4 // pgx.QueryExecModeSimpleProtocol for Supabase

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
	} else {
		log.Println("WARNING: No database configured, chat history will not be persisted")
	}

	// Create tool executor
	toolExecutor := NewToolExecutor(cfg.ShortsAPIURL)

	// Create LLM client
	var llmClient *LLMClient
	if cfg.GeminiAPIKey != "" {
		llmClient, err = NewLLMClient(ctx, cfg.GeminiAPIKey, cfg.GeminiModel, toolExecutor)
		if err != nil {
			log.Fatalf("Failed to create LLM client: %v", err)
		}
		defer llmClient.Close()
		log.Printf("LLM client initialized (model: %s)", cfg.GeminiModel)
	} else {
		log.Println("WARNING: No GEMINI_API_KEY configured, chat will not work")
	}

	// Create handler
	handler := NewChatServiceHandler(store, llmClient)

	// Create mux with Connect-RPC handler
	mux := http.NewServeMux()

	// Register the chat service
	path, h := chatv1connect.NewChatServiceHandler(handler, connect.WithInterceptors())
	mux.Handle(path, h)

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"chat-service"}`)
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
