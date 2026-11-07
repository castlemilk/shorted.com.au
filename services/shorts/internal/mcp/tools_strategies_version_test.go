package mcp

import (
	"context"
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func TestRulesVersionTextQuotesTheLabelHashAndEngine(t *testing.T) {
	ref := &shortsv1alpha1.StrategyVersionRef{Label: "v1", RulesHash: "3f9a1c2e0000000000000000000000000000000000000000000000000000ffff", EngineVersion: "1.0.0"}
	if got, want := rulesVersionText(ref), "v1 3f9a1c2e · engine 1.0.0"; got != want {
		t.Errorf("rulesVersionText() = %q, want %q", got, want)
	}
	if got := rulesVersionText(nil); got != "" {
		t.Errorf("rulesVersionText(nil) = %q, want absent", got)
	}
}

func TestStrategyToolsNameTheRulesVersion(t *testing.T) {
	ver := &shortsv1alpha1.StrategyVersionRef{
		StrategyId:    "canslim",
		Label:         "v0",
		RulesHash:     "3f9a1c2e" + "0000000000000000000000000000000000000000000000000000000000000000",
		EngineVersion: "1.0.0",
	}
	src := &fakeDataSource{strategies: &shortsv1alpha1.ListStrategiesResponse{
		Strategies: []*shortsv1alpha1.Strategy{{Id: "canslim", Name: "CAN SLIM", Version: ver}},
	}}
	_, out, err := listStrategiesHandler(src)(context.Background(), nil, ListStrategiesInput{})
	if err != nil {
		t.Fatalf("list_strategies: %v", err)
	}
	if len(out.Strategies) != 1 {
		t.Fatalf("got %d strategies, want 1", len(out.Strategies))
	}
	if got, want := out.Strategies[0].RulesVersion, "v0 3f9a1c2e · engine 1.0.0"; got != want {
		t.Errorf("list_strategies rules_version = %q, want %q", got, want)
	}

	src.strategyPicks = &shortsv1alpha1.GetStrategyPicksResponse{Version: ver, Strategy: &shortsv1alpha1.Strategy{Id: "canslim", Name: "CAN SLIM"}}
	_, picks, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "canslim"})
	if err != nil {
		t.Fatalf("get_strategy_picks: %v", err)
	}
	if got, want := picks.RulesVersion, "v0 3f9a1c2e · engine 1.0.0"; got != want {
		t.Errorf("get_strategy_picks rules_version = %q, want %q", got, want)
	}
}
