package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// crawl_telemetry.go is the LIVE crawl telemetry stream. Off by default (zero
// footprint). When enabled, the collector appends one NDJSON event per line to a
// local file AS IT CRAWLS — suburb start/done, each listing's extracted fields,
// and failures with debug — so a co-located UI (the BrandBrain macOS agent's
// Real-estate tab) can TAIL it and show extraction in-flight + why a sweep
// failed. LOCAL only: unlike the counts-only summary that goes to brandbrain, the
// per-listing data here never leaves the machine.
//
// Distinct from CRAWL_TRACE (crawl_trace.go), which writes per-page screenshots
// + HTML for offline debugging AFTER a sweep: telemetry is a lightweight,
// append-as-you-go event stream meant to be tailed DURING a run.

type telemetryConfig struct {
	enabled bool
	path    string // CRAWL_TELEMETRY_PATH (default ~/.shorted-housing-crawl/telemetry.ndjson)
	runID   string
}

// loadTelemetryConfig enables telemetry when CRAWL_TELEMETRY is truthy
// ("1"/"true"/"yes") or CRAWL_TELEMETRY_PATH is set. Off otherwise.
func loadTelemetryConfig() telemetryConfig {
	path := strings.TrimSpace(os.Getenv("CRAWL_TELEMETRY_PATH"))
	enabled := truthyEnv("CRAWL_TELEMETRY") || path != ""
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".shorted-housing-crawl", "telemetry.ndjson")
	}
	return telemetryConfig{enabled: enabled, path: path, runID: time.Now().UTC().Format("20060102T150405Z")}
}

// telemetryWriter appends NDJSON crawl events to a local file. A disabled writer
// (or a nil *telemetryWriter) is a no-op — call sites never branch on "is
// telemetry on". Same-machine tailers see appended lines immediately (page
// cache), so no per-line fsync is needed — which keeps thousands of per-listing
// events cheap.
type telemetryWriter struct {
	mu sync.Mutex
	f  *os.File
	id string
}

// newTelemetryWriter opens the telemetry file (append) when enabled. On any
// setup error it logs once and returns a disabled (no-op) writer rather than
// failing the crawl.
func newTelemetryWriter(cfg telemetryConfig) *telemetryWriter {
	if !cfg.enabled {
		return &telemetryWriter{}
	}
	if err := os.MkdirAll(filepath.Dir(cfg.path), 0o755); err != nil {
		log.Printf("[telemetry] mkdir failed (%v) — telemetry disabled", err)
		return &telemetryWriter{}
	}
	// Bound growth: telemetry is append-only, so a long-lived rig with it enabled
	// would grow this file without limit. Rotate before opening if it's over the
	// cap (default 64 MB, CRAWL_TELEMETRY_MAX_MB) — keeps one prior generation for
	// a tailer that reconnects; total bounded to ~2x cap.
	rotateIfOversize(cfg.path, int64(envInt("CRAWL_TELEMETRY_MAX_MB", 64))*1024*1024)
	f, err := os.OpenFile(cfg.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("[telemetry] open %s failed (%v) — telemetry disabled", cfg.path, err)
		return &telemetryWriter{}
	}
	tw := &telemetryWriter{f: f, id: cfg.runID}
	log.Printf("[telemetry] live stream → %s", cfg.path)
	tw.emit("run_start", map[string]any{})
	return tw
}

// emit writes one NDJSON event, stamped with ts/type/run_id. No-op when disabled.
func (tw *telemetryWriter) emit(typ string, fields map[string]any) {
	if tw == nil || tw.f == nil {
		return
	}
	ev := map[string]any{
		"ts":     time.Now().UTC().Format(time.RFC3339Nano),
		"type":   typ,
		"run_id": tw.id,
	}
	for k, v := range fields {
		ev[k] = v
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	tw.mu.Lock()
	defer tw.mu.Unlock()
	_, _ = tw.f.Write(append(b, '\n'))
}

func (tw *telemetryWriter) Close() {
	if tw == nil || tw.f == nil {
		return
	}
	tw.emit("run_done", map[string]any{})
	_ = tw.f.Close()
}

// --- typed event helpers (each a no-op on a disabled writer) ---

func (tw *telemetryWriter) suburbStart(suburb, source string) {
	tw.emit("suburb_start", map[string]any{"suburb": suburb, "source": source})
}

// listing streams one extracted listing's key fields — the "intelligent
// extraction info" surfaced in-flight (address, price, status, beds/baths,
// agency + agents, and the detail URL for a scheduled deep fetch).
func (tw *telemetryWriter) listing(suburb, source string, l RawListing) {
	tw.emit("listing", map[string]any{
		"suburb":        suburb,
		"source":        source,
		"listing_id":    l.ListingID,
		"url":           l.ListingURL,
		"address":       l.DisplayAddr,
		"price":         l.PriceDisplay,
		"price_kind":    l.PriceKind,
		"status":        l.Status,
		"beds":          int16OrZero(l.Bedrooms),
		"baths":         int16OrZero(l.Bathrooms),
		"property_type": l.PropertyType,
		"agency":        l.AgencyName,
		"agents":        l.AgentNames,
	})
}

func (tw *telemetryWriter) suburbDone(suburb, source string, listings, events int, status string) {
	tw.emit("suburb_done", map[string]any{
		"suburb": suburb, "source": source, "listings": listings, "events": events, "status": status,
	})
}

// failure streams a sweep failure (block/poison/empty) with whatever debug the
// caller has, so the UI can show WHY a suburb came back empty.
func (tw *telemetryWriter) failure(suburb, source, reason string, debug map[string]any) {
	m := map[string]any{"suburb": suburb, "source": source, "reason": reason}
	for k, v := range debug {
		m[k] = v
	}
	tw.emit("error", m)
}

func int16OrZero(p *int16) int16 {
	if p == nil {
		return 0
	}
	return *p
}

// rotateIfOversize renames path to path+".1" (replacing any prior rotation) when
// the file is at or over maxBytes, so an append-only log can't grow without
// bound. A missing file or maxBytes<=0 is a no-op.
func rotateIfOversize(path string, maxBytes int64) {
	if maxBytes <= 0 {
		return
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Size() < maxBytes {
		return
	}
	if err := os.Rename(path, path+".1"); err != nil {
		log.Printf("[telemetry] rotate %s failed (%v) — appending to the existing file", path, err)
	}
}
