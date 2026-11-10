package shortdatasync

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func TestJobDeclaresDryRunSupport(t *testing.T) {
	j := Job()
	if j.Name() != "short-data-sync" {
		t.Fatalf("job name = %q", j.Name())
	}
	d, ok := j.(runner.DryRunAware)
	if !ok || !d.SupportsDryRun() {
		t.Fatal("the job must declare dry-run support, or a global -dry-run is refused")
	}
}

func TestParseConfigDefaultsFromEnv(t *testing.T) {
	t.Setenv("SYNC_DAYS_SHORTS", "14")
	t.Setenv("SYNC_BATCH_SIZE", "250")
	t.Setenv("SYNC_ALGOLIA", "true")

	cfg, err := parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.days != 14 || cfg.batchSize != 250 || !cfg.syncAlgolia {
		t.Fatalf("env contract not honoured: %+v", cfg)
	}
}

func TestParseConfigFlagsBeatEnv(t *testing.T) {
	t.Setenv("SYNC_DAYS_SHORTS", "14")
	t.Setenv("SYNC_ALGOLIA", "true")

	cfg, err := parseConfig(context.Background(), []string{"-days", "3", "-sync-algolia=false"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.days != 3 || cfg.syncAlgolia {
		t.Fatalf("flags must win over env: %+v", cfg)
	}
}

func TestParseConfigDefaultsMatchDeployedImage(t *testing.T) {
	cfg, err := parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	// The deployed Dockerfile sets SYNC_DAYS_SHORTS=7 and the script defaulted
	// SYNC_BATCH_SIZE to 500; an unset env must land on the same values.
	if cfg.days != defaultSyncDays || cfg.batchSize != defaultBatchSize {
		t.Fatalf("defaults drifted: %+v", cfg)
	}
	if cfg.dryRun || cfg.shadow || cfg.syncAlgolia {
		t.Fatalf("no side-effect flag may default on: %+v", cfg)
	}
}

func TestParseConfigShadowImpliesDryRun(t *testing.T) {
	cfg, err := parseConfig(context.Background(), []string{"-shadow"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if !cfg.dryRun {
		t.Fatal("-shadow must never write")
	}
}

func TestParseConfigInheritsGlobalDryRun(t *testing.T) {
	ctx := runner.WithGlobals(context.Background(), runner.Globals{DryRun: true})
	cfg, err := parseConfig(ctx, nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if !cfg.dryRun {
		t.Fatal("the global -dry-run must be the per-job default")
	}
}

func TestParseConfigRejectsBadInput(t *testing.T) {
	if _, err := parseConfig(context.Background(), []string{"-days", "0"}); err == nil {
		t.Fatal("expected an error for -days 0")
	}
	if _, err := parseConfig(context.Background(), []string{"stray"}); err == nil {
		t.Fatal("expected an error for a positional argument")
	}
	if _, err := parseConfig(context.Background(), []string{"-h"}); !errors.Is(err, runner.ErrUsage) {
		t.Fatalf("-h should return ErrUsage, got %v", err)
	}
}

// TestRevalidateRequestContract pins the BROAD cache-bust, the Python's exact
// request, which a run sends when it cannot name what it wrote. Dropping a path
// or the flush silently strands an ISR surface on stale data for up to 24h.
func TestRevalidateRequestContract(t *testing.T) {
	broad := &changeSet{}
	broad.add(utcDay(2026, time.November, 3), rowsFor("BHP"))
	broad.markBroad()
	for name, changes := range map[string]*changeSet{"no change set": nil, "an initial load": broad} {
		req := revalidateRequest(changes)
		if req.Tag != "shorts-data,scan-results" {
			t.Fatalf("%s: tag = %q", name, req.Tag)
		}
		if req.Flush != "shorts" {
			t.Fatalf("%s: flush = %q", name, req.Flush)
		}
		if req.Body != nil {
			t.Fatalf("%s: the broad request carries no body, got %+v", name, req.Body)
		}
		want := []string{"/", "/top", "/news", "/screener", "/industry", "/shorts/[stockCode]", "/statistics", "/scans"}
		if !slices.Equal(req.Paths, want) {
			t.Fatalf("%s: paths = %v", name, req.Paths)
		}
	}
}

// TestNarrowRevalidateRequestContract pins the NARROW cache-bust: never the
// broad tag, never the whole stock segment, the same newest-snapshot paths and
// flush, and the change set as the body.
func TestNarrowRevalidateRequestContract(t *testing.T) {
	changes := &changeSet{}
	changes.add(utcDay(2026, time.November, 3), rowsFor("CBA", "BHP"))
	req := revalidateRequest(changes)
	if req.Tag != "scan-results" {
		t.Fatalf("tag = %q: a narrow request must not send shorts-data", req.Tag)
	}
	if req.Flush != "shorts" {
		t.Fatalf("flush = %q", req.Flush)
	}
	if !slices.Equal(req.Paths, []string{"/", "/top", "/news", "/screener", "/industry", "/statistics", "/scans"}) {
		t.Fatalf("paths = %v", req.Paths)
	}
	body, ok := req.Body.(shortsChangeBody)
	if !ok {
		t.Fatalf("body = %#v", req.Body)
	}
	if !slices.Equal(body.Shorts.Codes, []string{"BHP", "CBA"}) || !slices.Equal(body.Shorts.Dates, []string{"2026-11-03"}) {
		t.Fatalf("change set = %+v", body.Shorts)
	}
}

// TestRevalidatePingWireFormat proves the request that actually leaves the
// process: the secret rides in the X-Revalidate-Secret HEADER (never a query
// parameter) and the three query values are comma-joined as the endpoint
// expects.
func TestRevalidatePingWireFormat(t *testing.T) {
	var gotPath, gotSecret, gotTag, gotFlush, gotQueryPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotSecret = r.Header.Get("X-Revalidate-Secret")
		gotTag = r.URL.Query().Get("tag")
		gotFlush = r.URL.Query().Get("flush")
		gotQueryPath = r.URL.Query().Get("path")
		if r.URL.Query().Get("secret") != "" {
			t.Error("the secret must not travel as a query parameter")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("REVALIDATION_URL", srv.URL+"/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")
	platform.PingRevalidate(revalidateRequest(nil))

	if gotMethod != http.MethodPost || gotPath != "/api/revalidate" {
		t.Fatalf("%s %s", gotMethod, gotPath)
	}
	if gotSecret != "s3cr3t" {
		t.Fatalf("secret header = %q", gotSecret)
	}
	if gotTag != "shorts-data,scan-results" || gotFlush != "shorts" {
		t.Fatalf("tag=%q flush=%q", gotTag, gotFlush)
	}
	if !strings.HasPrefix(gotQueryPath, "/,/top,") || !strings.HasSuffix(gotQueryPath, "/scans") {
		t.Fatalf("path list = %q", gotQueryPath)
	}
}

func TestUnsupportedEnvIsEnumerated(t *testing.T) {
	// These are the deployed script's price/metric knobs. If one is ever
	// implemented here, drop it from the warn list in the SAME change.
	for _, want := range []string{"SYNC_DAYS_STOCK_PRICES", "SYNC_KEY_METRICS", "ALPHA_VANTAGE_API_KEY"} {
		found := false
		for _, k := range unsupportedEnv {
			if k == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s must be warned about, not silently ignored", want)
		}
	}
}

// TestNarrowRevalidatePingWireFormat proves the narrow request on the wire: the
// change set travels as the JSON body the web route reads
// (web/src/app/api/revalidate/shorts-change.ts), the secret as a header.
func TestNarrowRevalidatePingWireFormat(t *testing.T) {
	var gotTag, gotType, gotSecret string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTag = r.URL.Query().Get("tag")
		gotType = r.Header.Get("Content-Type")
		gotSecret = r.Header.Get("X-Revalidate-Secret")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("REVALIDATION_URL", srv.URL+"/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")
	changes := &changeSet{}
	changes.add(utcDay(2026, time.November, 3), rowsFor("BHP", "CBA"))
	platform.PingRevalidate(revalidateRequest(changes))

	if gotTag != "scan-results" || gotSecret != "s3cr3t" || gotType != "application/json" {
		t.Fatalf("tag=%q secret=%q content-type=%q", gotTag, gotSecret, gotType)
	}
	if want := `{"shorts":{"codes":["BHP","CBA"],"dates":["2026-11-03"]}}`; string(gotBody) != want {
		t.Fatalf("body = %s, want %s", gotBody, want)
	}
}

