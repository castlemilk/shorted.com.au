package news

import (
	"errors"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func TestParseConfigRunModeSources(t *testing.T) {
	tests := []struct {
		name    string
		env     string
		args    []string
		want    string
		wantErr string
	}{
		{name: "default is aggregate", want: modeAggregate},
		// The deployed schedulers set RUN_MODE via container_overrides; the
		// cutover must not require changing them all at once.
		{name: "env is honoured", env: modeCluster, want: modeCluster},
		{name: "flag beats env", env: modeCluster, args: []string{"-run-mode", modeDigest}, want: modeDigest},
		{name: "double dash accepted", args: []string{"--run-mode", modeDigest}, want: modeDigest},
		{name: "unknown mode rejected", args: []string{"-run-mode", "nope"}, wantErr: `unknown -run-mode "nope"`},
		{name: "unknown env mode rejected", env: "nope", wantErr: `unknown -run-mode "nope"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("RUN_MODE", tt.env)
			cfg, err := parseConfig(t.Context(), tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseConfig() error = %v", err)
			}
			if cfg.runMode != tt.want {
				t.Errorf("runMode = %q, want %q", cfg.runMode, tt.want)
			}
		})
	}
}

func TestParseConfigRefusesDryRunAgainstWritingModes(t *testing.T) {
	// These modes ignored -dry-run in the standalone binary and wrote anyway;
	// refusing beats silently writing.
	for _, mode := range []string{modeEmbed, modeEmbedCompany, modeDigest, modeServe} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("RUN_MODE", "")
			_, err := parseConfig(t.Context(), []string{"-run-mode", mode, "-dry-run"})
			if err == nil || !strings.Contains(err.Error(), "does not honour -dry-run") {
				t.Fatalf("err = %v, want a dry-run refusal", err)
			}
		})
	}
	for _, mode := range []string{modeAggregate, modeBackfillImgs, modeResolveGN, modeCluster} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("RUN_MODE", "")
			cfg, err := parseConfig(t.Context(), []string{"-run-mode", mode, "-dry-run"})
			if err != nil {
				t.Fatalf("parseConfig() error = %v", err)
			}
			if !cfg.dryRun {
				t.Error("dryRun not set")
			}
		})
	}
}

func TestParseConfigGlobalDryRunAndVerboseAreDefaults(t *testing.T) {
	t.Setenv("RUN_MODE", "")
	ctx := runner.WithGlobals(t.Context(), runner.Globals{DryRun: true, Verbose: true})
	cfg, err := parseConfig(ctx, nil)
	if err != nil {
		t.Fatalf("parseConfig() error = %v", err)
	}
	if !cfg.dryRun || !cfg.verbose {
		t.Fatalf("globals not applied: %+v", cfg)
	}
	// An explicit per-job flag still wins over the global default.
	cfg, err = parseConfig(ctx, []string{"-dry-run=false", "-verbose=false"})
	if err != nil {
		t.Fatalf("parseConfig() error = %v", err)
	}
	if cfg.dryRun || cfg.verbose {
		t.Fatalf("explicit flags did not override globals: %+v", cfg)
	}
}

func TestParseConfigHelpIsUsage(t *testing.T) {
	t.Setenv("RUN_MODE", "")
	if _, err := parseConfig(t.Context(), []string{"-h"}); !errors.Is(err, runner.ErrUsage) {
		t.Fatalf("err = %v, want runner.ErrUsage", err)
	}
}

func TestEnvIntOrFallsBackAndWarns(t *testing.T) {
	tests := []struct {
		name string
		set  string
		want int
	}{
		{"unset", "", 42},
		{"parsed", "7", 7},
		{"padded", " 7 ", 7},
		{"garbage falls back", "many", 42},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("BACKFILL_LIMIT", tt.set)
			if got := envIntOr("BACKFILL_LIMIT", 42); got != tt.want {
				t.Errorf("envIntOr(%q) = %d, want %d", tt.set, got, tt.want)
			}
		})
	}
}
