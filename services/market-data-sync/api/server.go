package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/sync"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Server provides HTTP API for market data sync
type Server struct {
	syncManager *sync.SyncManager
	checkpoint  *checkpoint.Store
	db          *pgxpool.Pool
	port        int
}

// NewServer creates a new API server
func NewServer(syncManager *sync.SyncManager, checkpointStore *checkpoint.Store, db *pgxpool.Pool, port int) *Server {
	return &Server{
		syncManager: syncManager,
		checkpoint:  checkpointStore,
		db:          db,
		port:        port,
	}
}

// Start starts the HTTP server
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// Health check endpoints
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleReady)
	mux.HandleFunc("/health", s.handleHealth)

	// Sync endpoints
	mux.HandleFunc("/api/sync/stock/", s.handleSyncStock)
	mux.HandleFunc("/api/sync/status/", s.handleGetStatus)
	mux.HandleFunc("/api/sync/status", s.handleGetLatestStatus)
	mux.HandleFunc("/api/sync/all", s.handleSyncAll)

	// CORS middleware
	handler := s.corsMiddleware(mux)

	addr := fmt.Sprintf(":%d", s.port)
	log.Printf("🌐 Starting HTTP server on %s", addr)

	server := &http.Server{
		Addr:    addr,
		Handler: handler,
	}

	// Start server in goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("❌ Server failed: %v", err)
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()
	log.Printf("⏹️ Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return server.Shutdown(shutdownCtx)
}

// corsMiddleware adds CORS headers
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// handleHealth handles health check requests
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}

// handleReady handles readiness check requests
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	// Check database connection
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.db.Ping(ctx); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

// SyncStockRequest represents a request to sync a specific stock
type SyncStockRequest struct {
	Symbol string `json:"symbol"`
}

// SyncStockResponse represents the response from syncing a stock
type SyncStockResponse struct {
	RunID      string    `json:"run_id"`
	Symbol     string    `json:"symbol"`
	Status     string    `json:"status"`
	RecordsAdded int     `json:"records_added,omitempty"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"started_at"`
}

// handleSyncStock handles POST /api/sync/stock/{symbol}
func (s *Server) handleSyncStock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract symbol from path: /api/sync/stock/{symbol}
	path := r.URL.Path
	prefix := "/api/sync/stock/"
	if !strings.HasPrefix(path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	symbol := strings.TrimPrefix(path, prefix)
	if symbol == "" {
		http.Error(w, "symbol is required", http.StatusBadRequest)
		return
	}

	log.Printf("📥 Received sync request for stock: %s", symbol)

	// Generate run ID for this single stock sync
	runID := uuid.New().String()

	// Start checkpoint for single stock
	if err := s.checkpoint.StartRun(r.Context(), runID, 1, 0); err != nil {
		log.Printf("⚠️ Failed to start checkpoint: %v", err)
		// Continue anyway
	}

	// Sync the stock
	recordsAdded, err := s.syncManager.SyncStock(r.Context(), symbol)
	
	response := SyncStockResponse{
		RunID:      runID,
		Symbol:     symbol,
		StartedAt:  time.Now(),
	}

	if err != nil {
		log.Printf("❌ Failed to sync %s: %v", symbol, err)
		response.Status = "failed"
		response.Error = err.Error()
		
		// Update checkpoint
		if updateErr := s.checkpoint.UpdateProgress(r.Context(), runID, 1, 0, 1, 0); updateErr != nil {
			log.Printf("⚠️ Failed to update checkpoint: %v", updateErr)
		}
		if failErr := s.checkpoint.FailRun(r.Context(), runID, err.Error()); failErr != nil {
			log.Printf("⚠️ Failed to mark run as failed: %v", failErr)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK) // Return 200 with error in response body
		json.NewEncoder(w).Encode(response)
		return
	}

	// Success
	response.Status = "success"
	response.RecordsAdded = recordsAdded
	
	// Update checkpoint
	if err := s.checkpoint.UpdateProgress(r.Context(), runID, 1, 1, 0, 0); err != nil {
		log.Printf("⚠️ Failed to update checkpoint: %v", err)
	}
	if err := s.checkpoint.UpdatePricesCount(r.Context(), runID, recordsAdded); err != nil {
		log.Printf("⚠️ Failed to update prices count: %v", err)
	}
	if err := s.checkpoint.CompleteRun(r.Context(), runID); err != nil {
		log.Printf("⚠️ Failed to mark run as complete: %v", err)
	}

	log.Printf("✅ Successfully synced %s: %d records added", symbol, recordsAdded)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// handleGetStatus handles GET /api/sync/status/{runId}
func (s *Server) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract runId from path: /api/sync/status/{runId}
	// Note: This handler is registered with "/api/sync/status/" prefix
	// So the path will be "/api/sync/status/{runId}"
	path := r.URL.Path
	prefix := "/api/sync/status/"
	if !strings.HasPrefix(path, prefix) {
		// Try to get from query parameter as fallback
		runID := r.URL.Query().Get("runId")
		if runID == "" {
			http.Error(w, "runId is required", http.StatusBadRequest)
			return
		}
		cp, err := s.checkpoint.GetRun(r.Context(), runID)
		if err != nil {
			http.Error(w, fmt.Sprintf("run not found: %v", err), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(cp)
		return
	}
	runID := strings.TrimPrefix(path, prefix)
	if runID == "" {
		http.Error(w, "runId is required", http.StatusBadRequest)
		return
	}

	cp, err := s.checkpoint.GetRun(r.Context(), runID)
	if err != nil {
		http.Error(w, fmt.Sprintf("run not found: %v", err), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(cp)
}

// handleGetLatestStatus handles GET /api/sync/status
func (s *Server) handleGetLatestStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cp, err := s.checkpoint.GetIncompleteRun(r.Context())
	if err != nil {
		// No incomplete run, return empty response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "no_active_run"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(cp)
}

// handleSyncAll handles POST /api/sync/all - triggers full sync
func (s *Server) handleSyncAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	log.Printf("📥 Received full sync request")

	// Run sync in background goroutine
	go func() {
		ctx := context.Background()
		if err := s.syncManager.Run(ctx); err != nil {
			log.Printf("❌ Full sync failed: %v", err)
		}
	}()

	response := map[string]string{
		"status":  "started",
		"message": "Full sync started in background",
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(response)
}
