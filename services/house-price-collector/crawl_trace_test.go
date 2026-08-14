package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests cover the trace WRITER with fixtures/a temp dir — no browser
// needed. The screenshot CAPTURE path (cdpFetcher.screenshot in crawl_cdp.go)
// is operationally verified live by the operator (plan Task 10), not here;
// WriteScreenshot itself is still covered (a fake PNG payload round-trips).

func TestTraceWriter_WritesPageAndSummary(t *testing.T) {
	dir := t.TempDir()
	cfg := traceConfig{enabled: true, dir: dir, runID: "run1"}
	tw := newTraceWriter(cfg, "Bondi", "domain")

	tw.WritePage(tracePageRecord{Page: 1, URL: "https://example.com/1", Matched: 5, Extracted: 5, TotalResults: 969, WantPages: 5, Outcome: "ok", Status: "continuing", Decision: "continue"})
	tw.WritePage(tracePageRecord{Page: 2, URL: "https://example.com/2", Matched: 0, Outcome: "ok", Status: "complete", Decision: "stop-empty-page"})
	tw.WriteSummary(traceSummary{Suburb: "Bondi", Source: "domain", Pages: 2, Listings: 5, Status: "complete"})

	traceDir := filepath.Join(dir, "run1", "bondi-domain")

	b, err := os.ReadFile(filepath.Join(traceDir, "trace.jsonl"))
	if err != nil {
		t.Fatalf("read trace.jsonl: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 trace.jsonl lines (one per WritePage), got %d: %q", len(lines), string(b))
	}

	var rec1 tracePageRecord
	if err := json.Unmarshal([]byte(lines[0]), &rec1); err != nil {
		t.Fatalf("unmarshal line 1: %v", err)
	}
	if rec1.Page != 1 || rec1.Matched != 5 || rec1.TotalResults != 969 || rec1.WantPages != 5 || rec1.Decision != "continue" {
		t.Errorf("line 1 = %+v", rec1)
	}

	var rec2 tracePageRecord
	if err := json.Unmarshal([]byte(lines[1]), &rec2); err != nil {
		t.Fatalf("unmarshal line 2: %v", err)
	}
	if rec2.Page != 2 || rec2.Decision != "stop-empty-page" {
		t.Errorf("line 2 = %+v", rec2)
	}

	sb, err := os.ReadFile(filepath.Join(traceDir, "summary.json"))
	if err != nil {
		t.Fatalf("read summary.json: %v", err)
	}
	var summary traceSummary
	if err := json.Unmarshal(sb, &summary); err != nil {
		t.Fatalf("unmarshal summary.json: %v", err)
	}
	if summary.Pages != 2 || summary.Listings != 5 || summary.Status != "complete" || summary.Suburb != "Bondi" || summary.Source != "domain" {
		t.Errorf("summary = %+v", summary)
	}
}

func TestTraceWriter_WriteHTMLAndScreenshot(t *testing.T) {
	dir := t.TempDir()
	cfg := traceConfig{enabled: true, dir: dir, runID: "run1"}
	tw := newTraceWriter(cfg, "St Kilda", "rea")

	tw.WriteHTML(1, []byte("<html>page one</html>"))
	tw.WriteScreenshot(1, []byte{0x89, 'P', 'N', 'G'}) // fake PNG payload

	traceDir := filepath.Join(dir, "run1", "st-kilda-rea")
	html, err := os.ReadFile(filepath.Join(traceDir, "p1.html"))
	if err != nil || string(html) != "<html>page one</html>" {
		t.Fatalf("p1.html = %q, err=%v", html, err)
	}
	png, err := os.ReadFile(filepath.Join(traceDir, "p1.png"))
	if err != nil || len(png) != 4 {
		t.Fatalf("p1.png = %v, err=%v", png, err)
	}

	// An empty screenshot payload (the fetcher didn't support it / capture
	// failed) must NOT create a p2.png at all.
	tw.WriteScreenshot(2, nil)
	if _, err := os.Stat(filepath.Join(traceDir, "p2.png")); !os.IsNotExist(err) {
		t.Errorf("an empty screenshot payload must not create a file, stat err=%v", err)
	}
}

func TestTraceWriter_DisabledIsNoOp(t *testing.T) {
	dir := t.TempDir()
	cfg := traceConfig{enabled: false, dir: dir, runID: "run1"} // disabled
	tw := newTraceWriter(cfg, "Bondi", "domain")

	tw.WritePage(tracePageRecord{Page: 1})
	tw.WriteHTML(1, []byte("<html></html>"))
	tw.WriteScreenshot(1, []byte{1, 2, 3})
	tw.WriteSummary(traceSummary{Pages: 1})

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("disabled tracing must not touch the filesystem, found %v", entries)
	}
}

func TestTraceWriter_SuburbFilterIsNoOpForNonMatching(t *testing.T) {
	dir := t.TempDir()
	cfg := traceConfig{enabled: true, dir: dir, runID: "run1", suburb: "St Kilda"}
	tw := newTraceWriter(cfg, "Bondi", "domain") // Bondi != the CRAWL_TRACE_SUBURB filter

	tw.WritePage(tracePageRecord{Page: 1})

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("a suburb outside the CRAWL_TRACE_SUBURB filter must not be traced, found %v", entries)
	}
}

func TestTraceConfig_Wants(t *testing.T) {
	off := traceConfig{enabled: false}
	if off.wants("Bondi") {
		t.Error("disabled config should never want tracing")
	}
	all := traceConfig{enabled: true}
	if !all.wants("Bondi") || !all.wants("Anything") {
		t.Error("an enabled config with no suburb filter should want every suburb")
	}
	filtered := traceConfig{enabled: true, suburb: "bondi"}
	if !filtered.wants("Bondi") {
		t.Error("the suburb filter should match case-insensitively")
	}
	if filtered.wants("St Kilda") {
		t.Error("the suburb filter should exclude non-matching suburbs")
	}
}

func TestLoadTraceConfig(t *testing.T) {
	base := t.TempDir()
	t.Setenv("TMPDIR", base)
	t.Setenv("CRAWL_TRACE", "")
	t.Setenv("CRAWL_TRACE_DIR", "")
	t.Setenv("CRAWL_TRACE_SUBURB", "")
	if got := loadTraceConfig(); got.enabled || got.dir != "" {
		t.Errorf("tracing must be OFF by default, got %+v", got)
	}
	if entries, err := os.ReadDir(base); err != nil || len(entries) != 0 {
		t.Fatalf("disabled tracing must not allocate a temp directory: entries=%v err=%v", entries, err)
	}

	t.Setenv("CRAWL_TRACE", "1")
	first := loadTraceConfig()
	second := loadTraceConfig()
	for _, got := range []traceConfig{first, second} {
		if !got.enabled || !filepath.IsAbs(got.dir) || filepath.Dir(got.dir) != base || !strings.HasPrefix(filepath.Base(got.dir), "shorted-crawl-traces-") {
			t.Errorf("default trace directory must be unique and absolute inside %q, got %+v", base, got)
			continue
		}
		info, err := os.Stat(got.dir)
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Errorf("default trace directory must exist with mode 0700: info=%v err=%v", info, err)
		}
	}
	if first.dir == second.dir {
		t.Errorf("default trace directories must be unique, both were %q", first.dir)
	}

	relativeBase := filepath.Join("relative-trace-temp", filepath.Base(t.TempDir()))
	if _, err := os.Stat(relativeBase); !os.IsNotExist(err) {
		t.Fatalf("relative TMPDIR test path must not exist before loadTraceConfig: %v", err)
	}
	t.Setenv("TMPDIR", relativeBase)
	if got := loadTraceConfig(); got.enabled || got.dir != "" {
		t.Errorf("relative TMPDIR must fail closed, got %+v", got)
	}
	if _, err := os.Stat(relativeBase); !os.IsNotExist(err) {
		t.Fatalf("relative TMPDIR must not be created: %v", err)
	}

	t.Setenv("CRAWL_TRACE", "")
	explicitDir := filepath.Join(base, "explicit-trace-dir")
	t.Setenv("CRAWL_TRACE_DIR", explicitDir)
	if got := loadTraceConfig(); !got.enabled || got.dir != explicitDir {
		t.Errorf("a non-empty CRAWL_TRACE_DIR should enable tracing with that dir, got %+v", got)
	}

	t.Setenv("CRAWL_TRACE_DIR", "")
	t.Setenv("CRAWL_TRACE_SUBURB", "New Farm")
	got := loadTraceConfig()
	if got.enabled {
		t.Errorf("CRAWL_TRACE_SUBURB alone (without CRAWL_TRACE/CRAWL_TRACE_DIR) must NOT enable tracing, got %+v", got)
	}
	if got.suburb != "New Farm" {
		t.Errorf("suburb filter not read, got %+v", got)
	}
}

func TestTruthyEnv(t *testing.T) {
	cases := map[string]bool{"1": true, "true": true, "TRUE": true, "yes": true, "0": false, "false": false, "": false, "nah": false}
	for v, want := range cases {
		t.Setenv("CRAWL_TRACE_TRUTHY_TEST", v)
		if got := truthyEnv("CRAWL_TRACE_TRUTHY_TEST"); got != want {
			t.Errorf("truthyEnv(%q) = %v want %v", v, got, want)
		}
	}
}

// --- sweepSuburbSource trace wiring (fixture-based, no browser) ---

// TestSweep_TraceModeWritesArtifactsWithFakeFetcher proves the trace mode is
// actually wired into the sweep loop (not just unit-tested in isolation): a
// 2-page sweep with tracing enabled must produce trace.jsonl (2 records) +
// summary.json + p1.html/p2.html, all via the SAME pagedFetcher fake the rest
// of the suite uses (no browser, and no screenshots — pagedFetcher doesn't
// implement pageScreenshotter).
func TestSweep_TraceModeWritesArtifactsWithFakeFetcher(t *testing.T) {
	dir := t.TempDir()
	lc := testLC()
	lc.cfg.traceCfg = traceConfig{enabled: true, dir: dir, runID: "run1"}
	lc.fetcher = &pagedFetcher{pages: map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026"),
		// page 2 is the default empty page -> natural end -> complete
	}}
	blocks := 0
	sw := lc.sweepSuburbSource(context.Background(), bondi, "domain", bondi.domainSearchURL, &blocks)
	if sw.status != sweepComplete {
		t.Fatalf("sweep status = %s, want complete", sw.status)
	}

	traceDir := filepath.Join(dir, "run1", "bondi-domain")
	b, err := os.ReadFile(filepath.Join(traceDir, "trace.jsonl"))
	if err != nil {
		t.Fatalf("read trace.jsonl: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 trace.jsonl records (page 1 + the empty page 2 stop), got %d: %q", len(lines), string(b))
	}
	var rec2 tracePageRecord
	if err := json.Unmarshal([]byte(lines[1]), &rec2); err != nil {
		t.Fatalf("unmarshal line 2: %v", err)
	}
	if rec2.Decision != "stop-empty-page" {
		t.Errorf("expected the page-2 record to record stop-empty-page, got %+v", rec2)
	}

	if _, err := os.Stat(filepath.Join(traceDir, "p1.html")); err != nil {
		t.Errorf("p1.html missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(traceDir, "p1.png")); !os.IsNotExist(err) {
		t.Errorf("pagedFetcher does not implement pageScreenshotter -- p1.png must NOT exist, stat err=%v", err)
	}

	sb, err := os.ReadFile(filepath.Join(traceDir, "summary.json"))
	if err != nil {
		t.Fatalf("read summary.json: %v", err)
	}
	var summary traceSummary
	if err := json.Unmarshal(sb, &summary); err != nil {
		t.Fatalf("unmarshal summary.json: %v", err)
	}
	if summary.Status != "complete" || summary.Listings != 5 || summary.Suburb != "Bondi" || summary.Source != "domain" {
		t.Errorf("summary = %+v", summary)
	}
}

// TestSweep_TraceModeDisabledTouchesNoFilesystem proves the default (off)
// path never creates a traces/ dir at all -- "Off -> zero overhead." Chdir's
// into a scratch temp dir so a stray "./traces" would be unambiguous.
func TestSweep_TraceModeDisabledTouchesNoFilesystem(t *testing.T) {
	t.Chdir(t.TempDir())
	_ = sweepWith(map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026"),
	})
	if _, err := os.Stat("traces"); !os.IsNotExist(err) {
		t.Errorf("tracing is disabled by default (testLC's zero-value traceConfig) -- must not create ./traces, stat err=%v", err)
	}
}

// TestTraceWriter_LightModeKeepsDecisionsDropsArtefacts covers CRAWL_TRACE_LIGHT:
// the per-page DECISION record is what explains a sweep (why it stopped, what the
// portal claimed existed, how many were on-target) and costs a few hundred bytes,
// so it must survive. The p<N>.html / p<N>.png artefacts are ~1.5MB per page plus
// a CDP round-trip, which is what makes full tracing unusable on a real pass.
func TestTraceWriter_LightModeKeepsDecisionsDropsArtefacts(t *testing.T) {
	dir := t.TempDir()
	cfg := traceConfig{enabled: true, dir: dir, light: true, runID: "run1"}
	tw := newTraceWriter(cfg, "St Kilda", "rea")

	tw.WritePage(tracePageRecord{Page: 1, URL: "u", Matched: 25, Decision: "stop-yield-decay"})
	tw.WriteHTML(1, []byte("<html>page one</html>"))
	tw.WriteScreenshot(1, []byte{0x89, 'P', 'N', 'G'})

	traceDir := filepath.Join(dir, "run1", "st-kilda-rea")
	jsonl, err := os.ReadFile(filepath.Join(traceDir, "trace.jsonl"))
	if err != nil || !strings.Contains(string(jsonl), "stop-yield-decay") {
		t.Fatalf("light mode must still record per-page decisions: %q err=%v", jsonl, err)
	}
	for _, name := range []string{"p1.html", "p1.png"} {
		if _, err := os.Stat(filepath.Join(traceDir, name)); !os.IsNotExist(err) {
			t.Errorf("light mode must not write %s, stat err=%v", name, err)
		}
	}
}

// TestTraceWriter_LightModeSkipsScreenshotCapture is the one that matters for
// cost: a screenshot is a CDP round-trip on the live browser, so light mode has
// to suppress the CAPTURE, not just the write. Gating only the write would still
// pay the latency on every page of every sweep.
func TestTraceWriter_LightModeSkipsScreenshotCapture(t *testing.T) {
	dir := t.TempDir()
	full := newTraceWriter(traceConfig{enabled: true, dir: dir, runID: "r"}, "A", "rea")
	if !full.capturesArtefacts() {
		t.Errorf("full tracing must capture artefacts")
	}
	light := newTraceWriter(traceConfig{enabled: true, dir: dir, light: true, runID: "r"}, "B", "rea")
	if light.capturesArtefacts() {
		t.Errorf("light tracing must NOT trigger a screenshot round-trip")
	}
	off := newTraceWriter(traceConfig{enabled: false, dir: dir, runID: "r"}, "C", "rea")
	if off.capturesArtefacts() {
		t.Errorf("disabled tracing must not capture artefacts")
	}
}

// TestLoadTraceConfig_Light proves the env knob is read, and that light mode is
// opt-in so today's full-trace debugging is unchanged.
func TestLoadTraceConfig_Light(t *testing.T) {
	t.Setenv("CRAWL_TRACE", "1")
	t.Setenv("CRAWL_TRACE_DIR", t.TempDir())
	t.Setenv("CRAWL_TRACE_LIGHT", "")
	if loadTraceConfig().light {
		t.Errorf("light must default off")
	}
	t.Setenv("CRAWL_TRACE_LIGHT", "1")
	if !loadTraceConfig().light {
		t.Errorf("CRAWL_TRACE_LIGHT=1 must enable light mode")
	}
}
