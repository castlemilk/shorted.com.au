package discovery

import (
	"context"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/stretchr/testify/require"
)

// TestLoadConfigDefaults pins the env contract carried over verbatim from
// services/asx-discovery: the deployed Cloud Run Job sets neither variable in
// dev, so the defaults are load-bearing.
func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("GCS_BUCKET_NAME", "")
	t.Setenv("DOWNLOAD_DIR", "")

	cfg := loadConfig()

	require.Equal(t, "shorted-data", cfg.bucketName)
	require.Equal(t, "/tmp/asx-downloads", cfg.downloadDir)
}

func TestLoadConfigFromEnv(t *testing.T) {
	t.Setenv("GCS_BUCKET_NAME", "other-bucket")
	t.Setenv("DOWNLOAD_DIR", "/var/tmp/asx")

	cfg := loadConfig()

	require.Equal(t, "other-bucket", cfg.bucketName)
	require.Equal(t, "/var/tmp/asx", cfg.downloadDir)
}

// TestRejectsUnknownArgs proves the job fails fast on a stray argument instead
// of silently ignoring it — the standalone binary parsed no flags at all, so a
// typo'd invocation ran a full scrape+upload regardless.
func TestRejectsUnknownArgs(t *testing.T) {
	t.Parallel()

	err := Run(context.Background(), []string{"-mode", "all"})

	require.Error(t, err)
}

// TestRefusesGlobalDryRun documents that discovery declares NO dry-run support
// (it always downloads and always uploads), so the runner refuses a global
// -dry-run before the job opens a browser.
func TestRefusesGlobalDryRun(t *testing.T) {
	t.Parallel()

	job := Job()
	aware, ok := job.(runner.DryRunAware)
	require.True(t, ok)
	require.False(t, aware.SupportsDryRun())
}
