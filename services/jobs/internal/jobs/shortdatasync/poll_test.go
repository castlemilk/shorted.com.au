package shortdatasync

// poll_test.go covers `-poll`: the intraday probe that ingests only what ASIC
// published after MAX("DATE") and never reconciles.

import (
	"context"
	"strings"
	"testing"
)

func TestParseConfigPollRefusesWorkItSkips(t *testing.T) {
	for _, args := range [][]string{
		{"-poll", "-shadow"},
		{"-poll", "-shadow", "-stocks", "BHP"},
		{"-poll", "-validate-days", "3"},
		{"-poll", "-reconcile-days", "5"},
		{"-poll", "-reconcile-rotation", "0"},
		{"-poll", "-reconcile-from", "2026-01-01"},
		{"-poll", "-reconcile-from", "2026-01-01", "-reconcile-to", "2026-02-01"},
	} {
		_, err := parseConfig(context.Background(), args)
		if err == nil || !strings.Contains(err.Error(), "-poll") {
			t.Errorf("%v: want a -poll refusal, got %v", args, err)
		}
	}
}

func TestParseConfigPollAllowsDryRun(t *testing.T) {
	cfg, err := parseConfig(context.Background(), []string{"-poll", "-dry-run"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if !cfg.poll || !cfg.dryRun || cfg.shadow {
		t.Fatalf("-poll -dry-run must be a dry poll: %+v", cfg)
	}
}

// The reconcile env vars are the deployed job's defaults, inherited by every
// execution including the poll's; only the FLAGS are refused.
func TestParseConfigPollToleratesReconcileEnv(t *testing.T) {
	t.Setenv("SYNC_RECONCILE_DAYS", "20")
	t.Setenv("SYNC_RECONCILE_ROTATION", "28")
	if _, err := parseConfig(context.Background(), []string{"-poll"}); err != nil {
		t.Fatalf("reconcile env must not break a poll: %v", err)
	}
}

func TestPollIsNeverEnvDefaulted(t *testing.T) {
	t.Setenv("SYNC_POLL", "true")
	cfg, err := parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.poll {
		t.Fatal("the daily run shares the job env; an env var must never turn it into a poll")
	}
}

func TestPollPlan(t *testing.T) {
	today := day(20)
	idx := index() // newest first: 19, 18, 15(-002), 15(-001), ...

	// Ingested to the 18th, ASIC has the 19th → exactly that file.
	files, cutoff := pollPlan(idx, 7, today, day(18))
	if len(files) != 1 || files[0].Date != 20260819 {
		t.Fatalf("files = %+v, want only the 19th", files)
	}
	if cutoff.Format("2006-01-02") != "2026-08-19" {
		t.Fatalf("cutoff = %s", cutoff)
	}

	// Ingested to the 19th, ASIC has nothing newer → nothing to do.
	if files, _ := pollPlan(idx, 7, today, day(19)); files != nil {
		t.Fatalf("nothing new must plan nothing, got %+v", files)
	}

	// Already holding today → nothing, whatever the index says.
	if files, _ := pollPlan(idx, 7, today, today); files != nil {
		t.Fatalf("an up-to-date table must plan nothing, got %+v", files)
	}

	// Two days behind → both, in index order (the sync's own selection).
	files, _ = pollPlan(idx, 7, today, day(17))
	if len(files) != 2 || files[0].Date != 20260819 || files[1].Date != 20260818 {
		t.Fatalf("files = %+v, want 19th then 18th", files)
	}

	// An empty index (fetch returned nothing) → nothing.
	if files, _ := pollPlan(nil, 7, today, day(17)); files != nil {
		t.Fatalf("an empty index must plan nothing, got %+v", files)
	}
}

func TestPollEmptyTableErrorNamesTheFix(t *testing.T) {
	if !strings.Contains(errPollEmptyTable.Error(), "plain sync") {
		t.Fatalf("unexpected error: %v", errPollEmptyTable)
	}
}
