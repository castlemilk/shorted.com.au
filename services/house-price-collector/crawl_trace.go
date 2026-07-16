package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// crawl_trace.go: an OPT-IN, off-by-default debug-trace mode for the listings
// sweep (crawl_listings.go's sweepSuburbSource). When enabled it writes, per
// (suburb,source) swept this run, under CRAWL_TRACE_DIR/<runId>/<suburb>-<source>/:
//
//   - trace.jsonl  — one tracePageRecord per page fetched (JSON Lines — one
//     record per line, so a killed/interrupted run still leaves readable
//     output), capturing the exact smart-pagination signals (Tasks 2-7) that
//     drove each page's decision.
//   - p<N>.html    — the raw page HTML.
//   - p<N>.png     — a screenshot, ONLY when the active fetcher implements
//     pageScreenshotter (cdpFetcher — see crawl_cdp.go); a silent no-op for
//     fileFetcher (fixtures/tests) and playwrightFetcher.
//   - summary.json — the final sweep outcome.
//
// Trace artifacts are LOCAL-only debugging aids: they never cross to
// brandbrain (the agent submit path stays counts-only — see crawlJobSummary
// in crawl_agent.go) and are gitignored (traces/, *.png). Off (the default),
// every method on traceWriter is a zero-cost no-op — sweepSuburbSource
// doesn't need to branch on "is tracing enabled" at each call site.

// pageScreenshotter is an OPTIONAL capability a crawlFetcher may implement:
// capture a screenshot of a URL on the fetcher's live browser. Only cdpFetcher
// implements it (a real, warm host-Chrome context — see crawl_cdp.go);
// fileFetcher/playwrightFetcher do not, so the type-assertion in
// sweepSuburbSource simply misses for them — the expected no-op for anything
// but a live CDP-driven -mode listings/-mode agent trace run. Operationally
// verified against the real host Chrome by the operator (plan Task 10), not
// exercised by the fixture-based unit tests here.
type pageScreenshotter interface {
	screenshot(ctx context.Context, url string) ([]byte, error)
}

// traceConfig controls whether/where the debug-trace mode writes.
type traceConfig struct {
	enabled bool
	dir     string // CRAWL_TRACE_DIR (default "traces")
	suburb  string // CRAWL_TRACE_SUBURB (optional filter, case-insensitive on Display; empty traces every swept suburb)
	runID   string // one directory per process run
}

// loadTraceConfig reads CRAWL_TRACE (truthy "1"/"true"/"yes") or a non-empty
// CRAWL_TRACE_DIR to enable tracing; CRAWL_TRACE_SUBURB optionally restricts
// tracing to one suburb's Display name so a targeted debug run doesn't dump
// every suburb in the catalog. Off by default — zero footprint unless opted in.
func loadTraceConfig() traceConfig {
	dir := strings.TrimSpace(os.Getenv("CRAWL_TRACE_DIR"))
	enabled := truthyEnv("CRAWL_TRACE") || dir != ""
	if dir == "" {
		dir = "traces"
	}
	return traceConfig{
		enabled: enabled,
		dir:     dir,
		suburb:  strings.TrimSpace(os.Getenv("CRAWL_TRACE_SUBURB")),
		runID:   time.Now().UTC().Format("20060102T150405Z"),
	}
}

func truthyEnv(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// wants reports whether tracing should run for the given suburb Display name
// under this config (honouring the optional CRAWL_TRACE_SUBURB filter).
func (c traceConfig) wants(suburbDisplay string) bool {
	if !c.enabled {
		return false
	}
	if c.suburb == "" {
		return true
	}
	return strings.EqualFold(c.suburb, suburbDisplay)
}

// tracePageRecord is one page's decision trace — the exact smart-pagination
// signals (Tasks 2-7) that drove the sweep's behaviour on this page.
type tracePageRecord struct {
	Page            int     `json:"page"`
	URL             string  `json:"url"`
	Ms              int64   `json:"ms"`
	Bytes           int     `json:"bytes"`
	Extracted       int     `json:"extracted"`         // raw listings found, before target-filtering
	Matched         int     `json:"matched"`           // on-target listings, after partitionByTarget
	Mismatch        float64 `json:"mismatch"`          // off-target ratio this page
	TotalResults    int     `json:"total_results"`     // PageMeta.TotalResults (0 if PageMeta unusable) — the BROADENED count, see PageMeta's doc comment
	OnTargetResults int     `json:"on_target_results"` // PageMeta.OnTargetResults (0 if unavailable — Domain, or REA when the field is missing) — the REA-only exact on-target count that drove sizing, see PageMeta's doc comment
	WantPages       int     `json:"want_pages"`        // the sweep's current loop bound
	NewIDs          int     `json:"new_ids"`           // ids added to `collected` this page
	Outcome         string  `json:"outcome"`           // ok|blocked|error
	Status          string  `json:"status"`            // the sweepStatus this page's decision resolved to (or "continuing")
	Decision        string  `json:"decision"`          // short machine-readable reason: continue|stop-blocked|stop-error|stop-parse-error|stop-poison-blocked|stop-broadening|stop-thin-page1|stop-duplicate-page|stop-empty-page|stop-yield-decay
}

// traceSummary is the final sweep outcome, written once per (suburb,source).
type traceSummary struct {
	Suburb   string `json:"suburb"`
	Source   string `json:"source"`
	Pages    int    `json:"pages"`
	Listings int    `json:"listings"`
	Status   string `json:"status"`
}

// traceWriter writes per-page trace records + HTML/screenshots + a final
// summary for one (suburb,source) sweep. The zero value (dir=="") is a safe
// no-op for every method.
type traceWriter struct {
	dir string // "" = disabled (no-op)
	mu  sync.Mutex
}

// newTraceWriter creates CRAWL_TRACE_DIR/<runId>/<suburb>-<source>/ and
// returns a traceWriter rooted there. When cfg is disabled (or doesn't want
// this suburb — see traceConfig.wants), it returns the zero-value traceWriter
// (a safe no-op) without touching the filesystem at all.
func newTraceWriter(cfg traceConfig, suburb, source string) *traceWriter {
	if !cfg.wants(suburb) {
		return &traceWriter{}
	}
	dir := filepath.Join(cfg.dir, cfg.runID, traceSlug(suburb)+"-"+source)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[trace] mkdir %s failed: %v — tracing disabled for %s/%s this sweep", dir, err, suburb, source)
		return &traceWriter{}
	}
	return &traceWriter{dir: dir}
}

// traceSlug lowercases and hyphenates a display name for a filesystem-safe
// directory component ("St Kilda" -> "st-kilda").
func traceSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func (tw *traceWriter) enabled() bool { return tw != nil && tw.dir != "" }

// WritePage appends one tracePageRecord to trace.jsonl.
func (tw *traceWriter) WritePage(rec tracePageRecord) {
	if !tw.enabled() {
		return
	}
	tw.mu.Lock()
	defer tw.mu.Unlock()

	f, err := os.OpenFile(filepath.Join(tw.dir, "trace.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("[trace] open trace.jsonl failed: %v", err)
		return
	}
	defer func() { _ = f.Close() }()

	b, err := json.Marshal(rec)
	if err != nil {
		log.Printf("[trace] marshal page record failed: %v", err)
		return
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		log.Printf("[trace] write trace.jsonl failed: %v", err)
	}
}

// WriteHTML saves one page's raw HTML as p<N>.html.
func (tw *traceWriter) WriteHTML(page int, html []byte) {
	if !tw.enabled() {
		return
	}
	path := filepath.Join(tw.dir, "p"+strconv.Itoa(page)+".html")
	if err := os.WriteFile(path, html, 0o644); err != nil {
		log.Printf("[trace] write %s failed: %v", path, err)
	}
}

// WriteScreenshot saves one page's screenshot as p<N>.png. A no-op when png
// is empty — either the active fetcher doesn't implement pageScreenshotter
// (fileFetcher/playwrightFetcher — the expected case for every unit test and
// for -mode crawl) or the capture failed upstream (logged at that call site).
func (tw *traceWriter) WriteScreenshot(page int, png []byte) {
	if !tw.enabled() || len(png) == 0 {
		return
	}
	path := filepath.Join(tw.dir, "p"+strconv.Itoa(page)+".png")
	if err := os.WriteFile(path, png, 0o644); err != nil {
		log.Printf("[trace] write %s failed: %v", path, err)
	}
}

// WriteSummary writes the final sweep outcome as summary.json.
func (tw *traceWriter) WriteSummary(s traceSummary) {
	if !tw.enabled() {
		return
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		log.Printf("[trace] marshal summary failed: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(tw.dir, "summary.json"), b, 0o644); err != nil {
		log.Printf("[trace] write summary.json failed: %v", err)
	}
}
