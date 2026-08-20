package shortdatasync

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

// TestRevalidateRequestContract pins the exact cache-bust the Python sends.
// Dropping a path or the flush silently strands an ISR surface on stale data
// for up to 24h.
func TestRevalidateRequestContract(t *testing.T) {
	req := revalidateRequest()
	if req.Tag != "shorts-data,scan-results" {
		t.Fatalf("tag = %q", req.Tag)
	}
	if req.Flush != "shorts" {
		t.Fatalf("flush = %q", req.Flush)
	}
	want := []string{"/", "/top", "/news", "/screener", "/industry", "/shorts/[stockCode]", "/statistics", "/scans"}
	if len(req.Paths) != len(want) {
		t.Fatalf("paths = %v", req.Paths)
	}
	for i, p := range want {
		if req.Paths[i] != p {
			t.Fatalf("paths[%d] = %q, want %q", i, req.Paths[i], p)
		}
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
	platform.PingRevalidate(revalidateRequest())

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
