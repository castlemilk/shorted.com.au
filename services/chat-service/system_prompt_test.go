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
	for line := range strings.SplitSeq(prompt, "\n") {
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

// TestSystemPromptNamesThePositionDate keeps the citation date on the position
// date. The model wrote the publication date (availableFrom) when the prompt
// left the date field open.
func TestSystemPromptNamesThePositionDate(t *testing.T) {
	prompt := BuildSystemPrompt("")
	if !strings.Contains(prompt, "the latest point's timestamp") || !strings.Contains(prompt, "never availableFrom") {
		t.Fatal("prompt does not say the citation date is the latest point's timestamp, never availableFrom")
	}
}

// TestSystemPromptSaysTableAndChartResultsAreShown keeps the reply short where the
// person already has the rows. Tool results for short positions, top shorts, peers,
// director trades and economic series are drawn as a table or chart under the reply,
// so the model names the takeaways and cites figures instead of listing every row.
// The bullet names no tool: the economic-series tool is named once, in its own bullet.
func TestSystemPromptSaysTableAndChartResultsAreShown(t *testing.T) {
	prompt := BuildSystemPrompt("")

	var shownLine string
	for line := range strings.SplitSeq(prompt, "\n") {
		if strings.Contains(line, "shown to the person as an interactive table or chart") {
			shownLine = line
			break
		}
	}
	if !strings.HasPrefix(shownLine, "-") {
		t.Fatalf("table and chart guidance = %q, want a prompt bullet", shownLine)
	}
	for _, phrase := range []string{"one to three sentences", "still cite the figures"} {
		if !strings.Contains(shownLine, phrase) {
			t.Errorf("table and chart guidance missing %q: %s", phrase, shownLine)
		}
	}
	// The grounding rule and the citation form stay as they were.
	if !strings.Contains(prompt, "must come from a tool result in this conversation") {
		t.Fatal("grounding rule was weakened")
	}
	if !strings.Contains(prompt, "Always cite specific data points when answering") {
		t.Fatal("citation rule was weakened")
	}
}
