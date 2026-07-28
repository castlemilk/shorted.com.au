package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Server provides HTTP API for market data sync
type Server struct {
	syncManager    *msync.SyncManager
	checkpoint     *checkpoint.Store
	gapDetector    *msync.GapDetector
	db             *pgxpool.Pool
	port           int
	ready          atomic.Bool
	syncAllRunning atomic.Bool
	httpServer     *http.Server
	// serveErr carries a fatal ListenAndServe failure to AwaitShutdown. The
	// standalone service called log.Fatalf from the listener goroutine, which
	// skipped every deferred close in main; inside the shared binary a bind
	// failure must surface as a returned error instead.
	serveErr chan error
}

// NewServer creates a new API server. Call Start() to begin serving health
// checks immediately, then SetDependencies() once initialization is complete.
func NewServer(port int) *Server {
	return &Server{port: port, serveErr: make(chan error, 1)}
}

// SetDependencies wires in service dependencies and marks the server as ready.
func (s *Server) SetDependencies(syncManager *msync.SyncManager, checkpointStore *checkpoint.Store, db *pgxpool.Pool, dataProviders []providers.DataProvider) {
	s.syncManager = syncManager
	s.checkpoint = checkpointStore
	s.db = db
	s.gapDetector = msync.NewGapDetector(db, dataProviders)
	s.ready.Store(true)
	log.Printf("✅ Server dependencies initialized, service is ready")
}

// Start begins serving HTTP requests. Health endpoints are available
// immediately; API endpoints return 503 until SetDependencies is called.
func (s *Server) Start() error {
	mux := http.NewServeMux()

	// Health check endpoints — always available (for startup/liveness probes)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleReady)
	mux.HandleFunc("/health", s.handleHealth)

	// API endpoints — guarded by readiness check
	mux.HandleFunc("/api/sync/stock/", s.requireReady(s.handleSyncStock))
	mux.HandleFunc("/api/sync/status/", s.requireReady(s.handleGetStatus))
	mux.HandleFunc("/api/sync/status", s.requireReady(s.handleGetLatestStatus))
	mux.HandleFunc("/api/sync/all", s.requireReady(s.handleSyncAll))
	mux.HandleFunc("/api/gaps/detect/", s.requireReady(s.handleDetectGaps))
	mux.HandleFunc("/api/gaps/repair/", s.requireReady(s.handleRepairGaps))
	mux.HandleFunc("/api/gaps/report/", s.requireReady(s.handleGapReport))
	mux.HandleFunc("/api/gaps/detect-all", s.requireReady(s.handleDetectAllGaps))

	handler := s.corsMiddleware(mux)

	addr := fmt.Sprintf(":%d", s.port)
	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: handler,
		// The standalone service left this unset, so a slow-loris client could
		// hold a connection open indefinitely during the header read.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("🌐 Starting HTTP server on %s", addr)
		if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.serveErr <- fmt.Errorf("market-data http server: %w", err)
		}
	}()

	return nil
}

// Err returns a listener failure if one has already happened, else nil. It
// never blocks — the dependency-init retry loop uses it to abandon early
// instead of retrying against a server that will never accept traffic.
func (s *Server) Err() error {
	select {
	case err := <-s.serveErr:
		return err
	default:
		return nil
	}
}

// AwaitShutdown blocks until the context is cancelled (then gracefully shuts
// the HTTP server down) or the listener fails.
func (s *Server) AwaitShutdown(ctx context.Context) error {
	select {
	case err := <-s.serveErr:
		return err
	case <-ctx.Done():
		// A bind failure can race the cancellation: prefer reporting it over
		// a clean shutdown of a server that never listened.
		select {
		case err := <-s.serveErr:
			return err
		default:
		}
	}
	log.Printf("⏹️ Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return s.httpServer.Shutdown(shutdownCtx)
}

// writeJSON writes status + a JSON body. Every handler used to inline
// `json.NewEncoder(w).Encode(...)` and drop the error; encoding failures now
// land in the log instead of vanishing (the status line is already written by
// then, so there is nothing else to say to the client).
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("⚠️ Failed to encode response: %v", err)
	}
}

// requireReady wraps a handler to return 503 if dependencies aren't initialized.
func (s *Server) requireReady(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.ready.Load() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "initializing", "error": "service is starting up"})
			return
		}
		next(w, r)
	}
}

func (s *Server) beginSyncAll() bool {
	return s.syncAllRunning.CompareAndSwap(false, true)
}

func (s *Server) finishSyncAll() {
	s.syncAllRunning.Store(false)
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
}

// handleReady handles readiness check requests
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if !s.ready.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "initializing"})
		return
	}

	// Check database connection
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.db.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not ready", "error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// SyncStockRequest represents a request to sync a specific stock
type SyncStockRequest struct {
	Symbol string `json:"symbol"`
}

// SyncStockResponse represents the response from syncing a stock
type SyncStockResponse struct {
	RunID        string    `json:"run_id"`
	Symbol       string    `json:"symbol"`
	Status       string    `json:"status"`
	RecordsAdded int       `json:"records_added,omitempty"`
	Error        string    `json:"error,omitempty"`
	StartedAt    time.Time `json:"started_at"`
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
		RunID:     runID,
		Symbol:    symbol,
		StartedAt: time.Now(),
	}

	if err != nil {
		log.Printf("❌ Failed to sync %s: %v", symbol, err)
		response.Status = "failed"
		response.Error = err.Error()

		// Update checkpoint
		if updateErr := s.checkpoint.UpdateProgress(r.Context(), runID, 1, 0, 1, 0, 0); updateErr != nil {
			log.Printf("⚠️ Failed to update checkpoint: %v", updateErr)
		}
		if failErr := s.checkpoint.FailRun(r.Context(), runID, err.Error()); failErr != nil {
			log.Printf("⚠️ Failed to mark run as failed: %v", failErr)
		}

		writeJSON(w, http.StatusOK, response)
		return
	}

	// Success
	response.Status = "success"
	response.RecordsAdded = recordsAdded

	// Update checkpoint
	if err := s.checkpoint.UpdateProgress(r.Context(), runID, 1, 1, 0, 0, 0); err != nil {
		log.Printf("⚠️ Failed to update checkpoint: %v", err)
	}
	if err := s.checkpoint.UpdatePricesCount(r.Context(), runID, recordsAdded); err != nil {
		log.Printf("⚠️ Failed to update prices count: %v", err)
	}
	if err := s.checkpoint.CompleteRun(r.Context(), runID); err != nil {
		log.Printf("⚠️ Failed to mark run as complete: %v", err)
	}

	log.Printf("✅ Successfully synced %s: %d records added", symbol, recordsAdded)

	writeJSON(w, http.StatusOK, response)
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
		writeJSON(w, http.StatusOK, cp)
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

	writeJSON(w, http.StatusOK, cp)
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
		writeJSON(w, http.StatusOK, map[string]string{"status": "no_active_run"})
		return
	}

	writeJSON(w, http.StatusOK, cp)
}

// handleSyncAll handles POST /api/sync/all - triggers full sync
func (s *Server) handleSyncAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	log.Printf("📥 Received full sync request")

	if !s.beginSyncAll() {
		writeJSON(w, http.StatusConflict, map[string]string{
			"status":  "already_running",
			"message": "Full sync is already running",
		})
		return
	}

	// Run sync in background goroutine.
	//
	// context.Background() (not r.Context()) is deliberate and preserved from
	// the standalone service: a full sweep takes far longer than the request
	// that triggered it, so binding it to the request would cancel it the
	// moment the 202 is written. It is also deliberately NOT bound to the
	// server lifecycle — a SIGTERM drains HTTP but leaves the in-flight sweep
	// to finish or die with the process, exactly as before. Selection is
	// resumable (checkpointed), so an abrupt end is recoverable.
	go func() {
		defer s.finishSyncAll()
		ctx := context.Background()
		if err := s.syncManager.Run(ctx); err != nil {
			log.Printf("❌ Full sync failed: %v", err)
		}
	}()

	response := map[string]string{
		"status":  "started",
		"message": "Full sync started in background",
	}

	writeJSON(w, http.StatusAccepted, response)
}

// handleDetectGaps handles GET /api/gaps/detect/{symbol}
// Detects gaps in price data for a specific stock
func (s *Server) handleDetectGaps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract symbol from path
	path := r.URL.Path
	prefix := "/api/gaps/detect/"
	if !strings.HasPrefix(path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	symbol := strings.TrimPrefix(path, prefix)
	if symbol == "" {
		http.Error(w, "symbol is required", http.StatusBadRequest)
		return
	}

	// Get optional minGapDays parameter (default: 4 to account for weekends)
	minGapDays := 4
	if minGapStr := r.URL.Query().Get("minGapDays"); minGapStr != "" {
		if parsed, err := strconv.Atoi(minGapStr); err == nil && parsed > 0 {
			minGapDays = parsed
		}
	}

	log.Printf("🔍 Detecting gaps for %s (minGapDays=%d)", symbol, minGapDays)

	gaps, err := s.gapDetector.DetectGaps(r.Context(), symbol, minGapDays)
	if err != nil {
		log.Printf("❌ Failed to detect gaps for %s: %v", symbol, err)
		http.Error(w, fmt.Sprintf("failed to detect gaps: %v", err), http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"stock_code":   symbol,
		"min_gap_days": minGapDays,
		"gaps_found":   len(gaps),
		"gaps":         gaps,
	}

	writeJSON(w, http.StatusOK, response)
}

// handleRepairGaps handles POST /api/gaps/repair/{symbol}
// Detects and repairs all gaps for a specific stock
func (s *Server) handleRepairGaps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract symbol from path
	path := r.URL.Path
	prefix := "/api/gaps/repair/"
	if !strings.HasPrefix(path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	symbol := strings.TrimPrefix(path, prefix)
	if symbol == "" {
		http.Error(w, "symbol is required", http.StatusBadRequest)
		return
	}

	// Get optional minGapDays parameter
	minGapDays := 4
	if minGapStr := r.URL.Query().Get("minGapDays"); minGapStr != "" {
		if parsed, err := strconv.Atoi(minGapStr); err == nil && parsed > 0 {
			minGapDays = parsed
		}
	}

	log.Printf("🔧 Repairing gaps for %s (minGapDays=%d)", symbol, minGapDays)

	// First detect gaps
	gaps, err := s.gapDetector.DetectGaps(r.Context(), symbol, minGapDays)
	if err != nil {
		log.Printf("❌ Failed to detect gaps for %s: %v", symbol, err)
		http.Error(w, fmt.Sprintf("failed to detect gaps: %v", err), http.StatusInternalServerError)
		return
	}

	if len(gaps) == 0 {
		response := map[string]interface{}{
			"stock_code":       symbol,
			"status":           "no_gaps",
			"message":          "No gaps found to repair",
			"records_repaired": 0,
		}
		writeJSON(w, http.StatusOK, response)
		return
	}

	// Repair gaps
	totalRepaired, err := s.gapDetector.RepairAllGaps(r.Context(), symbol, minGapDays)
	if err != nil {
		log.Printf("❌ Failed to repair gaps for %s: %v", symbol, err)
		http.Error(w, fmt.Sprintf("failed to repair gaps: %v", err), http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"stock_code":       symbol,
		"status":           "repaired",
		"gaps_found":       len(gaps),
		"records_repaired": totalRepaired,
	}

	writeJSON(w, http.StatusOK, response)
}

// handleGapReport handles GET /api/gaps/report/{symbol}
// Generates a detailed gap report for a specific stock
func (s *Server) handleGapReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract symbol from path
	path := r.URL.Path
	prefix := "/api/gaps/report/"
	if !strings.HasPrefix(path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	symbol := strings.TrimPrefix(path, prefix)
	if symbol == "" {
		http.Error(w, "symbol is required", http.StatusBadRequest)
		return
	}

	// Get optional minGapDays parameter
	minGapDays := 4
	if minGapStr := r.URL.Query().Get("minGapDays"); minGapStr != "" {
		if parsed, err := strconv.Atoi(minGapStr); err == nil && parsed > 0 {
			minGapDays = parsed
		}
	}

	log.Printf("📊 Generating gap report for %s", symbol)

	report, err := s.gapDetector.GenerateReport(r.Context(), symbol, minGapDays)
	if err != nil {
		log.Printf("❌ Failed to generate gap report for %s: %v", symbol, err)
		http.Error(w, fmt.Sprintf("failed to generate report: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, report)
}

// handleDetectAllGaps handles GET /api/gaps/detect-all
// Detects gaps across all stocks with price data
func (s *Server) handleDetectAllGaps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get optional minGapDays parameter
	minGapDays := 4
	if minGapStr := r.URL.Query().Get("minGapDays"); minGapStr != "" {
		if parsed, err := strconv.Atoi(minGapStr); err == nil && parsed > 0 {
			minGapDays = parsed
		}
	}

	log.Printf("🔍 Detecting gaps across all stocks (minGapDays=%d)", minGapDays)

	allGaps, err := s.gapDetector.DetectAllGaps(r.Context(), minGapDays)
	if err != nil {
		log.Printf("❌ Failed to detect gaps: %v", err)
		http.Error(w, fmt.Sprintf("failed to detect gaps: %v", err), http.StatusInternalServerError)
		return
	}

	// Count total gaps and stocks with gaps
	totalGaps := 0
	for _, gaps := range allGaps {
		totalGaps += len(gaps)
	}

	response := map[string]interface{}{
		"min_gap_days":     minGapDays,
		"stocks_with_gaps": len(allGaps),
		"total_gaps":       totalGaps,
		"gaps_by_stock":    allGaps,
	}

	writeJSON(w, http.StatusOK, response)
}
