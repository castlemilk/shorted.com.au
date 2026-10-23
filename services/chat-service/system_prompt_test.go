package main

import (
	"regexp"
	"strings"
	"testing"
)

// percentLiteralRE matches a number written as a percentage, such as "4.2%".
var percentLiteralRE = regexp.MustCompile(`\d\s*%`)

// threeCapitalWordRE matches a three-capital word, the shape of an ASX code.
var threeCapitalWordRE = regexp.MustCompile(`\b[A-Z]{3}\b`)

// TestSystemPromptCarriesNoFigureOrCodeTheModelCouldEcho fails when the prompt
// holds an example figure or a real stock code. The model copied the old example
// ("BHP is currently 4.2% shorted") into its answers.
func TestSystemPromptCarriesNoFigureOrCodeTheModelCouldEcho(t *testing.T) {
	prompt := BuildSystemPrompt("")

	if loc := percentLiteralRE.FindStringIndex(prompt); loc != nil {
		t.Fatalf("prompt has the percentage literal %q, which the model can echo", prompt[loc[0]:loc[1]])
	}
	// ASX and AUD name the exchange and the currency, not a stock.
	allowed := map[string]bool{"ASX": true, "AUD": true}
	for _, word := range threeCapitalWordRE.FindAllString(prompt, -1) {
		if !allowed[word] {
			t.Fatalf("prompt names %q, which reads as a stock code the model can echo", word)
		}
	}
	if !strings.Contains(prompt, "must come from a tool result in this conversation") {
		t.Fatal("prompt is missing the rule that figures come from a tool result")
	}
}

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
