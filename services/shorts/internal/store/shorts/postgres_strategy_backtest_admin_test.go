package shorts

import (
	"errors"
	"strings"
	"testing"
)

// A variant is refused whatever its status: only canonical versions are backtested
// from the admin tool, and a variant's hash is the one a caller would try first.
func TestCheckBacktestVersionRefusesAVariantHash(t *testing.T) {
	variant := versionRow{StrategyID: "zanger-breakout", Label: "variant:abc", Kind: "variant", RulesHash: strings.Repeat("a", 64)}
	err := checkBacktestVersion(variant)
	if !errors.Is(err, ErrBacktestRefused) || !strings.Contains(err.Error(), "variant") {
		t.Fatalf("a variant must be refused as a variant: %v", err)
	}
	if strings.Contains(err.Error(), "variant:abc") || strings.Contains(err.Error(), variant.Label) {
		t.Fatalf("the refusal must not echo a variant's name: %v", err)
	}
}

// The store refuses a recorded version the job would not run, the pre-recipe v0; a
// canonical version it can queue. Liveness is the registry's, not the database's.
func TestCheckBacktestVersionRefusesWhatTheJobWouldNotRun(t *testing.T) {
	if err := checkBacktestVersion(versionRow{StrategyID: "canonical-s", Label: "v0", Kind: "canonical"}); !errors.Is(err, ErrBacktestRefused) {
		t.Fatalf("v0: want a refusal, got %v", err)
	}
	if err := checkBacktestVersion(versionRow{StrategyID: "canonical-s", Label: "v1", Kind: "canonical"}); err != nil {
		t.Fatalf("a canonical version is queued: %v", err)
	}
}

func TestRulesHashPatternIsSixtyFourLowerHex(t *testing.T) {
	if !rulesHashPattern.MatchString(strings.Repeat("0f", 32)) {
		t.Error("64 lowercase hex characters must match")
	}
	for _, bad := range []string{"v1", strings.Repeat("F", 64), strings.Repeat("0", 63), strings.Repeat("g", 64)} {
		if rulesHashPattern.MatchString(bad) {
			t.Errorf("%q must not match", bad)
		}
	}
}
