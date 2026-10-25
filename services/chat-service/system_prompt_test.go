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

// promptLine returns the first line of the prompt that contains the phrase, so a test
// can check the rule and its wording together.
func promptLine(t *testing.T, prompt, phrase string) string {
	t.Helper()
	for line := range strings.SplitSeq(prompt, "\n") {
		if strings.Contains(line, phrase) {
			return line
		}
	}
	t.Fatalf("prompt has no line containing %q", phrase)
	return ""
}

// TestSystemPromptMentionsTheT4DelayOnlyWhenAsked keeps the reporting delay out of
// every answer. The eval found a T+4 note on 44 of 48 data replies, often a bullet.
func TestSystemPromptMentionsTheT4DelayOnlyWhenAsked(t *testing.T) {
	line := promptLine(t, BuildSystemPrompt(""), "T+4 reporting delay")
	if !strings.HasPrefix(line, "-") || !strings.Contains(line, "only when") {
		t.Errorf("T+4 guidance = %q, want a bullet that says the delay is mentioned only when asked", line)
	}
	if !strings.Contains(line, "never as a separate note or bullet") {
		t.Errorf("T+4 guidance = %q, want it kept out of separate notes and bullets", line)
	}
}

// TestSystemPromptHasAGeneralAdviceRule keeps the model from telling a person what
// to do with their money, which an eval run did in some replies.
func TestSystemPromptHasAGeneralAdviceRule(t *testing.T) {
	line := promptLine(t, BuildSystemPrompt(""), "personal financial advice")
	if !strings.HasPrefix(line, "-") || !strings.Contains(line, "buy, sell or short") {
		t.Errorf("general advice rule = %q, want a bullet naming buy, sell or short", line)
	}
}

// TestSystemPromptAllowsBulletsOnlyForThreeOrMoreItems pins the bullet rule. Lookups
// got bullets in the last run, and the rule now names the case that earns one.
func TestSystemPromptAllowsBulletsOnlyForThreeOrMoreItems(t *testing.T) {
	line := promptLine(t, BuildSystemPrompt(""), "three or more separate items")
	if !strings.HasPrefix(line, "-") || !strings.Contains(line, "bulleted list") {
		t.Errorf("bullet rule = %q, want a bullet that limits bulleted lists to three or more items", line)
	}
}

// TestSystemPromptDropsProactiveOffers keeps "Proactively offer" out of both
// branches. That phrase drove the unrequested company history and valuation.
func TestSystemPromptDropsProactiveOffers(t *testing.T) {
	for _, code := range []string{"", "PLS"} {
		if prompt := BuildSystemPrompt(code); strings.Contains(prompt, "Proactively offer") {
			t.Errorf("BuildSystemPrompt(%q) still says %q", code, "Proactively offer")
		}
	}
	if prompt := BuildSystemPrompt("PLS"); !strings.Contains(prompt, "You may end with one short suggestion about this stock.") {
		t.Error("the stock-page branch should offer at most one short suggestion")
	}
}

// TestSystemPromptSizesEveryReply pins the length rules that the eval checks: a
// lookup is short, and a greeting gets a short answer.
func TestSystemPromptSizesEveryReply(t *testing.T) {
	prompt := BuildSystemPrompt("")
	for _, phrase := range []string{
		"one to three sentences",
		"one sentence or one paragraph, give exactly that",
		"at most four examples",
	} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("prompt is missing the length rule %q", phrase)
		}
	}
}

// TestSystemPromptLooksUpEachNamedStock keeps comparisons on the per-stock figures.
// The model compared two stocks from the top-shorts list, where one was missing, so
// the rule sends it to each stock's own figure and keeps top shorts for rankings.
func TestSystemPromptLooksUpEachNamedStock(t *testing.T) {
	line := promptLine(t, BuildSystemPrompt(""), "comparing named stocks")
	for _, phrase := range []string{"look up each one", "cite each figure", "top shorts only for rankings"} {
		if !strings.Contains(line, phrase) {
			t.Errorf("comparison guidance missing %q: %s", phrase, line)
		}
	}
}

// TestSystemPromptOneParagraphHasNoLineBreaks pins the single-paragraph rule the
// eval checks. A reply to "one paragraph" broke into two paragraphs without it.
func TestSystemPromptOneParagraphHasNoLineBreaks(t *testing.T) {
	prompt := BuildSystemPrompt("")
	if !strings.Contains(prompt, "give exactly that: one sentence, or a single paragraph with no line breaks.") {
		t.Fatal("prompt does not limit a one-paragraph answer to a single paragraph with no line breaks")
	}
}
