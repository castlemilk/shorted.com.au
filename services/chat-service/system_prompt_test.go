package main

import (
	"strings"
	"testing"
)

func TestSystemPromptMentionsEconomicSeriesToolOnce(t *testing.T) {
	prompt := BuildSystemPrompt("")
	if got := strings.Count(prompt, "get_economic_series"); got != 1 {
		t.Fatalf("get_economic_series mention count = %d, want exactly 1", got)
	}

	var macroLine string
	for _, line := range strings.Split(prompt, "\n") {
		if strings.Contains(line, "get_economic_series") {
			macroLine = line
			break
		}
	}
	if !strings.HasPrefix(macroLine, "-") {
		t.Fatalf("macro tool guidance = %q, want a prompt bullet", macroLine)
	}
	for _, topic := range []string{"rates", "inflation", "wages", "jobs", "credit", "commodities", "trade", "state", "industry short-interest"} {
		if !strings.Contains(macroLine, topic) {
			t.Errorf("macro tool guidance missing %q: %s", topic, macroLine)
		}
	}
}
