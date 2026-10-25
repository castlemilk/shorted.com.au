package main

import (
	"errors"
	"slices"
	"strings"
	"testing"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
)

// These tests cover the scoring rules of the grounding eval, not the live eval.
// They run in every test pass and need no network, model or database.

func TestEvalFirstPercent(t *testing.T) {
	cases := []struct {
		reply string
		want  float64
		ok    bool
	}{
		{"BHP is 1.61% shorted", 1.61, true},
		{"about 1.6 per cent of shares", 1.6, true},
		{"1.6 percent, with a T+4 delay", 1.6, true},
		{"T+4 trading day delay and no figure", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := firstEvalPercent(c.reply)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("firstEvalPercent(%q) = %v, %v; want %v, %v", c.reply, got, ok, c.want, c.ok)
		}
	}
}

// TestEvalPercentSkipsPercentagePhrases keeps "percentage points", "percentage" and
// "percentile" from reading as a percent. A change stated in points is not a share.
func TestEvalPercentSkipsPercentagePhrases(t *testing.T) {
	cases := []struct {
		reply string
		want  float64
		ok    bool
	}{
		{"up 0.6 percentage points to 2.61%", 2.61, true},
		{"a percentile rank of 3", 0, false},
		{"the percentage fell over the week", 0, false},
	}
	for _, c := range cases {
		got, ok := firstEvalPercent(c.reply)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("firstEvalPercent(%q) = %v, %v; want %v, %v", c.reply, got, ok, c.want, c.ok)
		}
	}
}

func TestEvalFirstTicker(t *testing.T) {
	cases := []struct {
		reply string
		want  string
		ok    bool
	}{
		{"**DRO** is the most shorted name", "DRO", true},
		{"Per ASIC data via the ASX, BOE leads", "BOE", true},
		{"The RBA rate and AI tools aside, WES is listed", "WES", true},
		{"no codes in this sentence at all", "", false},
	}
	for _, c := range cases {
		got, ok := firstEvalTicker(c.reply)
		if ok != c.ok || got != c.want {
			t.Errorf("firstEvalTicker(%q) = %q, %v; want %q, %v", c.reply, got, ok, c.want, c.ok)
		}
	}
}

func scoreOne(t *testing.T, q evalQuestion, truth *evalTruth, reply string, tools ...string) evalRun {
	t.Helper()
	turn := evalTurn{reply: reply}
	for _, name := range tools {
		turn.toolCalls = append(turn.toolCalls, &chatv1.ToolCall{ToolName: name})
	}
	run := evalRun{ID: q.ID, Kind: string(q.Kind)}
	scoreEvalRun(q, truth, turn, &run)
	return run
}

// callWithResult is a tool call whose full result is known, so the figure and date
// checks have something to ground against.
func callWithResult(name, result string) *chatv1.ToolCall {
	return &chatv1.ToolCall{ToolName: name, Result: result}
}

func scoreWithCalls(t *testing.T, q evalQuestion, truth *evalTruth, reply string, calls ...*chatv1.ToolCall) evalRun {
	t.Helper()
	run := evalRun{ID: q.ID, Kind: string(q.Kind)}
	scoreEvalRun(q, truth, evalTurn{reply: reply, toolCalls: calls}, &run)
	return run
}

func TestEvalScoresShortPositionWithinFiveHundredths(t *testing.T) {
	truth := &evalTruth{ShortPct: map[string]float64{"BHP": 1.61}}
	q := evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}

	if run := scoreOne(t, q, truth, "BHP is 1.62% shorted", "query_short_positions"); !run.Correct || !run.ToolCalled || !run.ExpectedToolCalled {
		t.Errorf("1.62 against 1.61 should be correct and grounded: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.67% shorted", "query_short_positions"); run.Correct {
		t.Errorf("1.67 against 1.61 should be wrong: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 0.81% shorted"); run.Correct || run.ToolCalled {
		t.Errorf("an ungrounded 0.81 should be wrong and not grounded: %+v", run)
	}
}

func TestEvalFlagsPromptExampleEcho(t *testing.T) {
	truth := &evalTruth{ShortPct: map[string]float64{"CBA": 2.10}}
	q := evalQuestion{ID: "cba", Kind: evalShortPct, Code: "CBA"}

	run := scoreOne(t, q, truth, "CBA is currently 4.2% shorted")
	if !run.PromptExampleEchoed {
		t.Errorf("a 4.2%% reply for CBA should be flagged as an echo: %+v", run)
	}

	bhp := evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}
	truth.ShortPct["BHP"] = 4.2
	if run := scoreOne(t, bhp, truth, "BHP is 4.2% shorted", "query_short_positions"); run.PromptExampleEchoed {
		t.Errorf("when the true figure is 4.2 the reply is not an echo: %+v", run)
	}
}

func TestEvalScoresTopCodeAndNamesAndIndustries(t *testing.T) {
	truth := &evalTruth{
		TopCode:     "DRO",
		CompanyName: map[string]string{"WES": "Wesfarmers"},
		FullName:    map[string]string{"BOE": "Boss Energy Limited"},
		Industry:    map[string]string{"BOE": "Energy"},
	}

	top := evalQuestion{ID: "top", Kind: evalTopCode}
	if run := scoreOne(t, top, truth, "**DRO** is the most shorted at 15.9%", "get_top_shorts"); !run.Correct {
		t.Errorf("DRO as the top code should be correct: %+v", run)
	}
	if run := scoreOne(t, top, truth, "LOT is the most shorted"); run.Correct {
		t.Errorf("LOT as the top code should be wrong: %+v", run)
	}

	name := evalQuestion{ID: "name", Kind: evalCompanyName, Code: "WES"}
	if run := scoreOne(t, name, truth, "WES is Wesfarmers Limited.", "get_stock_details"); !run.Correct || run.Figure != "Wesfarmers" {
		t.Errorf("Wesfarmers should match: %+v", run)
	}

	industry := evalQuestion{ID: "ind", Kind: evalIndustry, Code: "BOE"}
	if run := scoreOne(t, industry, truth, "Boss Energy sits in the energy sector.", "get_stock_details"); !run.Correct {
		t.Errorf("an Energy industry should match: %+v", run)
	}
}

// TestEvalIndustryIgnoresTheCompanysOwnName keeps "Boss Energy" from standing for the
// industry "Energy". The company's name is removed from the reply before the check.
func TestEvalIndustryIgnoresTheCompanysOwnName(t *testing.T) {
	truth := &evalTruth{
		Industry: map[string]string{"BOE": "Energy"},
		FullName: map[string]string{"BOE": "Boss Energy Limited"},
	}
	q := evalQuestion{ID: "ind", Kind: evalIndustry, Code: "BOE"}

	if run := scoreOne(t, q, truth, "BOE is Boss Energy Ltd, a uranium miner in Materials", "get_stock_details"); run.Correct {
		t.Errorf("a reply that names only the company must not pass for the industry: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BOE is Boss Energy Ltd, a uranium miner in the Energy industry", "get_stock_details"); !run.Correct {
		t.Errorf("a reply that names the Energy industry should pass: %+v", run)
	}
	for in, want := range map[string]string{
		"Boss Energy Limited":       "Boss Energy",
		"Wesfarmers Holdings Ltd.":  "Wesfarmers",
		"Alpha Group":               "Alpha",
		"Limited":                   "Limited",
		"Mineral Resources Limited": "Mineral Resources",
	} {
		if got := evalStripLegalSuffix(in); got != want {
			t.Errorf("evalStripLegalSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEvalNonDataPassesOnAnyNonEmptyReply(t *testing.T) {
	q := evalQuestion{ID: "hi", Kind: evalNonData}
	if run := scoreOne(t, q, &evalTruth{}, "Hello! How can I help?"); !run.Correct || !run.Answered {
		t.Errorf("a non-empty non-data reply should pass: %+v", run)
	}
	if run := scoreOne(t, q, &evalTruth{}, "   "); run.Correct || run.Answered {
		t.Errorf("a blank non-data reply should not pass: %+v", run)
	}
}

// TestEvalNonDataFigureIsRecordedNotFailed keeps a market figure in a non-data reply
// visible without failing the reply. The figure has no data tool behind it.
func TestEvalNonDataFigureIsRecordedNotFailed(t *testing.T) {
	q := evalQuestion{ID: "squeeze", Kind: evalNonData}
	run := scoreOne(t, q, &evalTruth{}, "A squeeze can push the price up 40% in a week.")
	if !run.Correct || !run.NonDataFigure {
		t.Errorf("a non-data reply with a percentage should pass and set nonDataFigure: %+v", run)
	}
	if plain := scoreOne(t, q, &evalTruth{}, "A short squeeze is a rapid price rise."); plain.NonDataFigure {
		t.Errorf("a reply with no percentage must not set nonDataFigure: %+v", plain)
	}
	if s := summarizeEvalRuns([]evalRun{run}); s.NonDataFigures != 1 {
		t.Errorf("NonDataFigures = %d, want 1", s.NonDataFigures)
	}
}

func TestEvalSummaryCountsGroundingAndErrors(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true, ExpectedToolCalled: true, FirstTextMs: 100, TotalMs: 200},
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: false, FirstTextMs: 300, TotalMs: 400},
		{Kind: string(evalShortPct), Answered: true, Correct: false, ToolCalled: false, PromptExampleEchoed: true, FirstTextMs: 500, TotalMs: 600},
		{Kind: string(evalShortPct), Error: "internal: model", TotalMs: 50},
		{Kind: string(evalNonData), Answered: true, Correct: true, FirstTextMs: 700, TotalMs: 800},
		{Kind: string(evalNonData), Answered: true, Correct: true, ToolCalled: true, FirstTextMs: 900, TotalMs: 1000},
	}
	s := summarizeEvalRuns(runs)
	if s.DataRuns != 4 || s.DataAnswered != 3 || s.DataErrors != 1 {
		t.Errorf("data counts = runs %d answered %d errors %d", s.DataRuns, s.DataAnswered, s.DataErrors)
	}
	if s.Grounded != 1 || s.Correct != 2 || s.CorrectWithoutTool != 1 || s.PromptExampleEchoes != 1 {
		t.Errorf("grounded %d correct %d correctWithoutTool %d echoes %d", s.Grounded, s.Correct, s.CorrectWithoutTool, s.PromptExampleEchoes)
	}
	if s.NonDataRuns != 2 || s.NonDataOK != 2 || s.NonDataToolCalls != 1 {
		t.Errorf("non-data runs %d ok %d tool calls %d", s.NonDataRuns, s.NonDataOK, s.NonDataToolCalls)
	}
	if k := s.ByKind[string(evalNonData)]; k == nil || k.Runs != 2 || k.Answered != 2 || k.Grounded != 1 {
		t.Errorf("non-data by kind = %+v, want runs 2 answered 2 grounded 1", k)
	}
	if got := s.GroundedRate; got < 0.333 || got > 0.334 {
		t.Errorf("grounded rate = %v, want 1/3", got)
	}
	if got := evalMedian([]int64{100, 300, 500}); got != 300 {
		t.Errorf("median = %d, want 300", got)
	}
	if got := evalMedian([]int64{100, 300}); got != 200 {
		t.Errorf("even median = %d, want 200", got)
	}
}

func TestEvalQuestionSetShape(t *testing.T) {
	var data, nonData, withContext, advice, scored, sends, followups int
	for _, q := range evalQuestions() {
		scored += q.Repeats
		sends += q.Repeats
		if q.Followup != "" {
			followups++
			sends += q.Repeats
		}
		if q.Kind == evalAdvice {
			advice++
		}
		if q.Kind.nonData() {
			nonData++
			continue
		}
		data++
		if q.Context != "" {
			withContext++
		}
		if len(expectedTools(q.Kind)) == 0 {
			t.Errorf("question %s has no expected tool", q.ID)
		}
	}
	if data != 15 || nonData != 5 || withContext != 1 || advice != 1 || followups != 1 {
		t.Errorf("question set = %d data, %d non-data, %d with context, %d advice, %d follow-up; want 15, 5, 1, 1, 1",
			data, nonData, withContext, advice, followups)
	}
	if scored != 66 {
		t.Errorf("scored runs = %d, want 66", scored)
	}
	if sends != 69 {
		t.Errorf("chat turns sent = %d, want 69 (the follow-up sends two per repeat)", sends)
	}
}

// TestEvalNoDataQuestionIsCorrectWhenNoPercentage keeps a code with no data from
// being answered with a figure. The right reply says there is no data.
func TestEvalNoDataQuestionIsCorrectWhenNoPercentage(t *testing.T) {
	q := evalQuestion{ID: "d13", Kind: evalNoData, Code: "QZX"}
	truth := &evalTruth{NoData: map[string]bool{"QZX": true}}
	if run := scoreOne(t, q, truth, "QZX has no short position data I can find.", "query_short_positions"); !run.Correct || !run.ToolCalled {
		t.Errorf("a reply that says there is no data should be correct and grounded: %+v", run)
	}
	if run := scoreOne(t, q, truth, "QZX is 3.10% shorted", "query_short_positions"); run.Correct {
		t.Errorf("a percentage for a code with no data should be wrong: %+v", run)
	}
}

// TestEvalCompareNamesTheMoreShortedFirst keeps a comparison right only when both
// figures are stated and the code named first is the more heavily shorted.
func TestEvalCompareNamesTheMoreShortedFirst(t *testing.T) {
	truth := &evalTruth{ShortPct: map[string]float64{"RIO": 8.76, "FMG": 3.10}}
	q := evalQuestion{ID: "d15", Kind: evalCompare, Codes: []string{"RIO", "FMG"}}
	cases := []struct {
		reply string
		want  bool
	}{
		{"RIO is 8.76% and FMG is 3.10%, so RIO is more heavily shorted", true},
		{"FMG is 3.10% and RIO is 8.76%, so RIO is more heavily shorted", false},
		{"RIO is 8.70% and FMG is 3.10%", false},
		{"RIO is 8.76%, which is the more heavily shorted", false},
	}
	for _, c := range cases {
		if run := scoreOne(t, q, truth, c.reply, "query_short_positions"); run.Correct != c.want {
			t.Errorf("%q: correct = %v, want %v: %+v", c.reply, run.Correct, c.want, run)
		}
	}
	swapped := &evalTruth{ShortPct: map[string]float64{"RIO": 3.10, "FMG": 8.76}}
	if run := scoreOne(t, q, swapped, "FMG is 8.76% and RIO is 3.10%", "query_short_positions"); !run.Correct || run.Figure != "FMG" {
		t.Errorf("FMG named first when it is more shorted should be correct: %+v", run)
	}
	tie := &evalTruth{ShortPct: map[string]float64{"RIO": 4.00, "FMG": 4.00}}
	if run := scoreOne(t, q, tie, "RIO is 4.00% and FMG is 4.00%", "query_short_positions"); !run.Correct {
		t.Errorf("a tie should be correct for either code first: %+v", run)
	}
}

// TestEvalFollowupScoresTheSecondTurnOnly keeps the first turn out of the grade. Its
// answer only sets up the conversation the follow-up continues.
func TestEvalFollowupScoresTheSecondTurnOnly(t *testing.T) {
	q := evalQuestion{ID: "d14", Text: "CBA short interest?", Followup: "and WBC?", Kind: evalShortPct, Code: "WBC"}
	scored := evalScoredQuestion(q)
	if scored.Text != "and WBC?" || scored.Kind != evalShortPct || scored.Code != "WBC" {
		t.Errorf("scored question = %+v, want the WBC follow-up as a short-position question", scored)
	}
	plain := evalScoredQuestion(evalQuestion{ID: "d02", Text: "CBA short interest?"})
	if plain.Text != "CBA short interest?" {
		t.Errorf("a question without a follow-up is scored as asked, got %q", plain.Text)
	}
	truth := &evalTruth{ShortPct: map[string]float64{"WBC": 2.50}}
	if run := scoreOne(t, scored, truth, "WBC is 2.50% shorted", "query_short_positions"); !run.Correct {
		t.Errorf("the second turn should be graded against WBC: %+v", run)
	}
}

// TestEvalAdviceIsCountedAndGated keeps personal advice out of a passing run. General
// information about the data does not match.
func TestEvalAdviceIsCountedAndGated(t *testing.T) {
	q := evalQuestion{ID: "n05", Kind: evalAdvice}
	for _, reply := range []string{
		"You should buy DRO now.",
		"I would recommend shorting it.",
		"Buy it now if you like the chart.",
	} {
		if run := scoreOne(t, q, &evalTruth{}, reply); !run.AdviceGiven {
			t.Errorf("%q should set adviceGiven: %+v", reply, run)
		}
	}
	general := scoreOne(t, q, &evalTruth{}, "DRO is 15.9% shorted. The decision is yours.", "query_short_positions")
	if general.AdviceGiven {
		t.Errorf("general information should not set adviceGiven: %+v", general)
	}

	advised := summarizeEvalRuns([]evalRun{{Kind: string(evalAdvice), Answered: true, Correct: true, AdviceGiven: true}})
	if advised.AdviceGiven != 1 {
		t.Fatalf("AdviceGiven = %d, want 1", advised.AdviceGiven)
	}
	failures := evalGateFailures(advised, evalGates{MinCorrect: 0.95})
	if len(failures) == 0 || !strings.Contains(strings.Join(failures, "; "), "1 replies gave personal advice") {
		t.Errorf("a gated run with advice should fail, got %v", failures)
	}
	if failures := evalGateFailures(advised, evalGates{}); failures != nil {
		t.Errorf("with no gate set advice does not fail the run, got %v", failures)
	}
}

func TestEvalExpectedToolsIncludeSearchForFiguresAndNames(t *testing.T) {
	// search_stocks carries percentageShorted and the company name, so a grounded
	// RIO answer from it counts as expected, not as a stray tool call.
	run := scoreOne(t, evalQuestion{ID: "rio", Kind: evalShortPct, Code: "RIO"},
		&evalTruth{ShortPct: map[string]float64{"RIO": 8.76}}, "RIO is 8.76% shorted", "search_stocks")
	if !run.ExpectedToolCalled || !run.Correct {
		t.Errorf("search_stocks should ground a short-position answer: %+v", run)
	}
	// It must not count for a top-shorts answer.
	top := scoreOne(t, evalQuestion{ID: "top", Kind: evalTopCode}, &evalTruth{TopCode: "DRO"}, "DRO is most shorted", "search_stocks")
	if top.ExpectedToolCalled {
		t.Errorf("search_stocks should not ground a top-code answer: %+v", top)
	}
}

func TestTruncateEvalTextKeepsRunes(t *testing.T) {
	if got := truncateEvalText("short", 10); got != "short" {
		t.Errorf("under the limit should be unchanged, got %q", got)
	}
	// "é" is two bytes (0xC3 0xA9). A cut at byte 1 would split it, so the cut
	// backs off to the rune boundary and leaves nothing before the marker.
	if got := truncateEvalText("é"+"abc", 1); got != "...(truncated)" {
		t.Errorf("cut inside a rune should back off to the boundary, got %q", got)
	}
	if got := truncateEvalText("abcdef", 3); got != "abc...(truncated)" {
		t.Errorf("truncate = %q", got)
	}
}

func TestEvalStatedDatesReadsTheDateForms(t *testing.T) {
	cases := []struct {
		reply string
		want  []string
	}{
		{"BHP is 1.61% shorted as of 2026-10-19.", []string{"2026-10-19"}},
		{"BHP is 1.61% shorted as of 19 October 2026", []string{"2026-10-19"}},
		{"BHP is 1.61% shorted as of October 19, 2026", []string{"2026-10-19"}},
		{"as of 19th Oct 2026", []string{"2026-10-19"}},
		{"as of 3 Sept. 2026", []string{"2026-09-03"}},
		{"as of 19/10/2026", []string{"2026-10-19"}},
		{"as of 19 October with no year", nil},
		{"T+4 delay, 1.61% as of 2026-13-45", nil},
		{"published on 31 June 2026", nil},
		{"no date at all, just 1.61% and T+4", nil},
	}
	for _, c := range cases {
		if got := evalStatedDates(c.reply); !slices.Equal(got, c.want) {
			t.Errorf("evalStatedDates(%q) = %v, want %v", c.reply, got, c.want)
		}
	}
}

// TestEvalStatedDatesAreInReplyOrderAndUnique keeps the headline date the first
// date a reader meets. The order follows the text, not the form of the date.
func TestEvalStatedDatesAreInReplyOrderAndUnique(t *testing.T) {
	cases := []struct {
		reply string
		want  []string
	}{
		{"published 23 October 2026, position as of 19 October 2026", []string{"2026-10-23", "2026-10-19"}},
		{"19 Oct 2026 and then 2026-10-19 again", []string{"2026-10-19"}},
		{"from 20 July 2026 to 19 October 2026", []string{"2026-07-20", "2026-10-19"}},
		// The day-month form comes first in the text but is matched by a different
		// pattern from the ISO form, so only sorting by position keeps the order.
		{"published 23 October 2026 with the position at 2026-10-19", []string{"2026-10-23", "2026-10-19"}},
	}
	for _, c := range cases {
		if got := evalStatedDates(c.reply); !slices.Equal(got, c.want) {
			t.Errorf("evalStatedDates(%q) = %v, want %v", c.reply, got, c.want)
		}
	}
}

func TestEvalPositionDateTakesTheNewestPoint(t *testing.T) {
	points := []evalPoint{
		{Timestamp: "2026-10-12T00:00:00Z"},
		{Timestamp: "2026-10-19T00:00:00Z"},
		{Timestamp: "2026-10-16T00:00:00Z"},
	}
	if got, err := evalPositionDate(points); err != nil || got != "2026-10-19" {
		t.Errorf("evalPositionDate = %q, %v; want 2026-10-19", got, err)
	}
	if _, err := evalPositionDate(nil); err == nil {
		t.Error("evalPositionDate with no points should fail, not return a date")
	}
	if _, err := evalPositionDate([]evalPoint{{Timestamp: "19/10/2026"}}); err == nil {
		t.Error("evalPositionDate should reject a timestamp it cannot parse")
	}
}

func TestEvalFlagsAStatedDateThatIsNotThePositionDate(t *testing.T) {
	truth := &evalTruth{
		ShortPct:  map[string]float64{"BHP": 1.61},
		ShortDate: map[string]string{"BHP": "2026-10-19"},
	}
	q := evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}

	// The figure is right; the date is the publication date, availableFrom.
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted as of October 23, 2026", "query_short_positions"); !run.Correct || !run.HeadlineDateWrong {
		t.Errorf("right figure with the publication date should be correct and headline-date-wrong: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted as of 19 October 2026", "query_short_positions"); !run.Correct || run.HeadlineDateWrong || len(run.DatesStated) != 1 {
		t.Errorf("right figure with the position date should be correct and date-right: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted", "query_short_positions"); !run.Correct || run.HeadlineDateWrong || len(run.DatesStated) != 0 {
		t.Errorf("a reply with no date should not be date-wrong: %+v", run)
	}
}

// TestEvalHeadlineDateIsTheFirstDateStated keeps a correct trend date later in the
// reply from failing it. Only the first date a reader meets is the headline.
func TestEvalHeadlineDateIsTheFirstDateStated(t *testing.T) {
	truth := &evalTruth{
		ShortPct:  map[string]float64{"BHP": 1.61},
		ShortDate: map[string]string{"BHP": "2026-10-19"},
	}
	q := evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}
	result := `{"latestShortPosition":1.61,"points":[{"timestamp":"2026-10-19T00:00:00Z"},{"timestamp":"2026-07-20T00:00:00Z"}]}`
	call := callWithResult("query_short_positions", result)

	run := scoreWithCalls(t, q, truth, "BHP is 1.61% as of 19 October 2026, up from 1.97% on 20 July 2026", call)
	if run.HeadlineDate != "2026-10-19" || run.HeadlineDateWrong {
		t.Errorf("a position date first with a trend date after should not be headline-wrong: %+v", run)
	}
	run = scoreWithCalls(t, q, truth, "BHP is 1.61% shorted, published 23 October 2026 as of 19 October 2026", call)
	if run.HeadlineDate != "2026-10-23" || !run.HeadlineDateWrong {
		t.Errorf("a publication date first should be headline-wrong: %+v", run)
	}
}

// TestEvalUngroundedDatesAreNotInToolResults keeps a date the tools returned from
// being flagged, whatever its label, and flags a date they did not return.
func TestEvalUngroundedDatesAreNotInToolResults(t *testing.T) {
	result := `{"points":[{"timestamp":"2026-10-19T00:00:00Z","availableFrom":"2026-10-23"}]}`
	if got := evalUngroundedDates([]string{"2026-10-23", "2026-07-01", "2026-10-19"}, []string{result}); !slices.Equal(got, []string{"2026-07-01"}) {
		t.Errorf("evalUngroundedDates = %v, want [2026-07-01]", got)
	}
	run := scoreWithCalls(t, evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}, &evalTruth{},
		"BHP is 1.61% shorted, published 23 October 2026, up since 1 July 2026",
		callWithResult("query_short_positions", result))
	if !slices.Equal(run.UngroundedDates, []string{"2026-07-01"}) {
		t.Errorf("run.UngroundedDates = %v, want [2026-07-01]", run.UngroundedDates)
	}
}

func TestEvalSummaryCountsStatedAndWrongDates(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), DatesStated: []string{"2026-10-19"}},
		{Kind: string(evalShortPct), DatesStated: []string{"2026-10-23"}, HeadlineDateWrong: true},
		{Kind: string(evalShortPct)},
	}
	if s := summarizeEvalRuns(runs); s.DatesStated != 2 || s.HeadlineDateWrong != 1 {
		t.Errorf("DatesStated = %d, HeadlineDateWrong = %d; want 2 and 1", s.DatesStated, s.HeadlineDateWrong)
	}
}

// TestEvalFigureGroundedAtTheReplyPrecision keeps a figure that rounds to a tool
// number from being flagged. The reply's precision is the rounding.
func TestEvalFigureGroundedAtTheReplyPrecision(t *testing.T) {
	result := []string{`{"latestShortPosition":1.61154143}`}
	for _, reply := range []string{"BHP is 1.61% shorted", "BHP is 1.6% shorted"} {
		if got := evalUngroundedFigures(reply, "How short is BHP?", result); len(got) != 0 {
			t.Errorf("%q: ungrounded figures = %v, want none", reply, got)
		}
	}
}

func TestEvalFigureScaledMillionsAndBillions(t *testing.T) {
	cases := []struct {
		reply  string
		result string
	}{
		{"about 81.9 million shares are short", `{"reportedShortPositions":81912345}`},
		// protojson writes int64 values as strings, so the grounding reads them too.
		{"about 81.9 million shares are short", `{"reportedShortPositions":"81912345"}`},
		{"$AUD 93.5 billion of short exposure", `{"marketCap":93512000000}`},
	}
	for _, c := range cases {
		if got := evalUngroundedFigures(c.reply, "q", []string{c.result}); len(got) != 0 {
			t.Errorf("%q against %s: ungrounded = %v, want none", c.reply, c.result, got)
		}
	}
	if got := evalUngroundedFigures("about 81.9 million shares", "q", []string{`{"x":81912}`}); !slices.Equal(got, []string{"81.9 million"}) {
		t.Errorf("a scaled figure with no matching tool number should be flagged: %v", got)
	}
}

func TestEvalFigurePercentagePointDifference(t *testing.T) {
	result := []string{`{"series":[{"v":2.61},{"v":2.01}]}`}
	if got := evalUngroundedFigures("up 0.6 percentage points", "how much?", result); len(got) != 0 {
		t.Errorf("a difference of two tool numbers should ground the change: %v", got)
	}
}

func TestEvalFigureRelativeChange(t *testing.T) {
	result := []string{`{"a":1.61,"b":2.00}`}
	if got := evalUngroundedFigures("down 19.5% on the prior reading", "q", result); len(got) != 0 {
		t.Errorf("a relative change of two tool numbers should ground the change: %v", got)
	}
}

func TestEvalFlagsAnInventedFigure(t *testing.T) {
	result := []string{`{"latestShortPosition":1.61}`}
	got := evalUngroundedFigures("BHP is 0.81% shorted and up 3.4 points", "q", result)
	if !slices.Contains(got, "0.81%") || !slices.Contains(got, "3.4") {
		t.Errorf("an invented figure should be flagged, got %v", got)
	}
}

func TestEvalFlagsAYearTheToolsDidNotReturn(t *testing.T) {
	result := []string{`{"latestShortPosition":1.61,"points":[{"timestamp":"2026-10-19T00:00:00Z"}]}`}
	if got := evalUngroundedFigures("short interest has risen since 2025", "q", result); !slices.Contains(got, "2025") {
		t.Errorf("a year from the model's priors should be flagged, got %v", got)
	}
	if got := evalUngroundedFigures("short interest has risen since 2026", "q", result); slices.Contains(got, "2026") {
		t.Errorf("a year the tool returned in a date should be grounded, got %v", got)
	}
}

func TestEvalYearInAToolStringIsGrounded(t *testing.T) {
	result := []string{`{"note":"figures reported in 2026"}`}
	if got := evalUngroundedFigures("reported in 2026", "q", result); len(got) != 0 {
		t.Errorf("a year the tool text names should be grounded: %v", got)
	}
}

// TestEvalIgnoresSmallIntegersDatesAndT4 keeps ranks, counts, dates and the T+4
// delay from being read as figures a reply must ground.
func TestEvalIgnoresSmallIntegersDatesAndT4(t *testing.T) {
	reply := "Top 3 shorts, #2 of 5, T+4 applies, as of 19 October 2026."
	if got := evalUngroundedFigures(reply, "q", nil); len(got) != 0 {
		t.Errorf("ranks, counts, dates and T+4 should not be figures, got %v", got)
	}
}

// TestEvalFigureFallsBackToRegexWhenNotJSON keeps a result that is plain text
// groundable. Its numbers come from a regex over the text.
func TestEvalFigureFallsBackToRegexWhenNotJSON(t *testing.T) {
	result := []string{"BHP short 1.61 percent as of 2026-10-19 (plain text)"}
	if got := evalUngroundedFigures("1.61%", "q", result); len(got) != 0 {
		t.Errorf("a non-JSON tool result should ground its numbers: %v", got)
	}
}

// TestEvalFigureSkipsNumbersEchoedFromTheQuestion keeps a figure the person typed
// from being graded as the model's claim.
func TestEvalFigureSkipsNumbersEchoedFromTheQuestion(t *testing.T) {
	if got := evalUngroundedFigures("4.2% is high", "Is 4.2% a high short position?", nil); len(got) != 0 {
		t.Errorf("a figure echoed from the question should be skipped: %v", got)
	}
}

func TestEvalFormatCountsWordsBulletsAndT4(t *testing.T) {
	reply := "Summary:\n- BHP is 1.61%\n- CBA is 2.1%\n1. ok\nT+4 delay"
	words, bullets, t4 := evalFormat(reply)
	if words != 13 || bullets != 3 || !t4 {
		t.Errorf("evalFormat = words %d, bullets %d, t4 %v; want 13, 3, true", words, bullets, t4)
	}
	if _, bullets, t4 := evalFormat("A reporting lag applies.\n  * item"); bullets != 1 || !t4 {
		t.Errorf("an indented star bullet and a reporting lag = bullets %d, t4 %v; want 1, true", bullets, t4)
	}
}

func TestEvalLengthViolations(t *testing.T) {
	long := strings.Repeat("word ", 50)
	cases := []struct {
		question, reply string
		want            bool
	}{
		{"What is it? One sentence.", long, true},
		{"What is it? One sentence.", "BHP is 1.61% shorted.", false},
		{"What is it? One sentence.", "- BHP is 1.61% shorted.", true},
		{"Explain in one paragraph.", "a\n\nb", true},
		{"Explain in one paragraph.", "a single paragraph of text", false},
		{"hi", long, false},
	}
	for _, c := range cases {
		words, bullets, _ := evalFormat(c.reply)
		if got := evalLengthViolation(c.question, c.reply, words, bullets); got != c.want {
			t.Errorf("evalLengthViolation(%q, %d words, %d bullets) = %v, want %v", c.question, words, bullets, got, c.want)
		}
	}
}

// TestEvalMedianWordsGate fails a run whose lookup answers are long. Non-data
// replies do not count toward the lookup median.
func TestEvalMedianWordsGate(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), Answered: true, Words: 80},
		{Kind: string(evalTopCode), Answered: true, Words: 80},
		{Kind: string(evalNonData), Answered: true, Words: 500},
	}
	s := summarizeEvalRuns(runs)
	if s.LookupMedianWords != 80 {
		t.Fatalf("LookupMedianWords = %d, want 80", s.LookupMedianWords)
	}
	failures := evalGateFailures(s, evalGates{MaxLookupMedianWords: 60})
	if len(failures) != 1 || !strings.Contains(failures[0], "lookup median words 80 is above CHAT_EVAL_MAX_MEDIAN_WORDS 60") {
		t.Errorf("gate failures = %v, want one median-words failure", failures)
	}
	if failures := evalGateFailures(s, evalGates{MaxLookupMedianWords: 80}); failures != nil {
		t.Errorf("a median at the ceiling should pass, got %v", failures)
	}
	if failures := evalGateFailures(s, evalGates{}); failures != nil {
		t.Errorf("with no gate set there should be no failures, got %v", failures)
	}
}

func TestEvalSummaryMedianWordsAndT4Rate(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), Answered: true, Words: 10, T4Mention: true},
		{Kind: string(evalShortPct), Answered: true, Words: 20},
		{Kind: string(evalTopCode), Answered: true, Words: 30, Bullets: 1, LengthViolation: true},
	}
	s := summarizeEvalRuns(runs)
	if s.LookupMedianWords != 20 {
		t.Errorf("LookupMedianWords = %d, want 20", s.LookupMedianWords)
	}
	if got := s.T4MentionRate; got < 0.333 || got > 0.334 {
		t.Errorf("T4MentionRate = %v, want 1/3", got)
	}
	if s.BulletReplies != 1 || s.LengthViolations != 1 {
		t.Errorf("bulletReplies %d lengthViolations %d, want 1 and 1", s.BulletReplies, s.LengthViolations)
	}
	if k := s.ByKind[string(evalShortPct)]; k.MedianWords != 15 || k.P90Words != 20 {
		t.Errorf("short_pct median %d p90 %d, want 15 and 20", k.MedianWords, k.P90Words)
	}
}

func TestEvalSummaryCountsHeadlineAndUngroundedRuns(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), Answered: true, DatesStated: []string{"2026-10-23"}, HeadlineDateWrong: true,
			UngroundedDates: []string{"2026-10-23"}, UngroundedFigures: []string{"0.81%"}},
		{Kind: string(evalShortPct), Answered: true},
	}
	s := summarizeEvalRuns(runs)
	if s.HeadlineDateWrong != 1 || s.RunsWithUngroundedDates != 1 || s.RunsWithUngroundedFigures != 1 || s.DatesStated != 1 {
		t.Errorf("headlineDateWrong %d runsWithUngroundedDates %d runsWithUngroundedFigures %d datesStated %d; want 1, 1, 1, 1",
			s.HeadlineDateWrong, s.RunsWithUngroundedDates, s.RunsWithUngroundedFigures, s.DatesStated)
	}
}

func TestEvalPercentileHelpers(t *testing.T) {
	if got := evalMedianInt([]int{3, 1, 2}); got != 2 {
		t.Errorf("evalMedianInt = %d, want 2", got)
	}
	if got := evalP90Int([]int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}); got != 9 {
		t.Errorf("evalP90Int of 1..10 = %d, want 9 (nearest rank)", got)
	}
}

func TestEvalGateFailsARunWhoseTurnsErrored(t *testing.T) {
	// One answered turn that is correct and grounded, and 59 provider errors. The
	// rates over the answered turns are 1.000, so only the error count can fail the run.
	runs := []evalRun{{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true}}
	for range 59 {
		runs = append(runs, evalRun{Kind: string(evalShortPct), Error: "stream next: invalid character ']' looking for beginning of value"})
	}
	s := summarizeEvalRuns(runs)
	if s.CorrectRate != 1 || s.GroundedRate != 1 {
		t.Fatalf("rates over the answered turns = %.3f and %.3f, want 1 and 1", s.CorrectRate, s.GroundedRate)
	}

	failures := evalGateFailures(s, evalGates{MinCorrect: 0.95, MinGrounded: 0.95})
	if len(failures) != 1 || !strings.Contains(failures[0], "59 of 60 data turns errored") {
		t.Errorf("gate failures = %v, want one failure naming the 59 errored turns", failures)
	}
	if failures := evalGateFailures(s, evalGates{}); failures != nil {
		t.Errorf("with no gate set there should be no failures, got %v", failures)
	}
}

func TestEvalGatePassesACleanRunAndFailsALowRate(t *testing.T) {
	clean := summarizeEvalRuns([]evalRun{
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
	})
	if failures := evalGateFailures(clean, evalGates{MinCorrect: 0.95, MinGrounded: 0.95}); failures != nil {
		t.Errorf("a clean run at 1.000 should pass both gates, got %v", failures)
	}

	low := summarizeEvalRuns([]evalRun{
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
		{Kind: string(evalShortPct), Answered: true, Correct: false},
	})
	failures := evalGateFailures(low, evalGates{MinCorrect: 0.95})
	if len(failures) != 1 || !strings.Contains(failures[0], "correct rate 0.500 is below CHAT_EVAL_MIN_CORRECT 0.950") {
		t.Errorf("gate failures = %v, want one correct-rate failure", failures)
	}
}

// TestEvalMarksADataReplyWithNoDataCallAsNoDataChosen keeps the first-call signal
// honest: a data answer with no data tool call is noDataChosen, and an errored turn
// is not a data answer at all.
func TestEvalMarksADataReplyWithNoDataCallAsNoDataChosen(t *testing.T) {
	truth := &evalTruth{ShortPct: map[string]float64{"BHP": 1.61}}
	q := evalQuestion{ID: "bhp", Kind: evalShortPct, Code: "BHP"}

	// A figure with no data tool call: the first call must have been answer_without_data.
	if run := scoreOne(t, q, truth, "BHP is 0.72% shorted"); !run.NoDataChosen || run.ToolCalled {
		t.Errorf("a figure with no data tool call should be noDataChosen: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted", "query_short_positions"); run.NoDataChosen {
		t.Errorf("a grounded reply is not noDataChosen: %+v", run)
	}
	if run := scoreOne(t, q, truth, "   "); run.NoDataChosen {
		t.Errorf("an empty reply is not a data answer, so not noDataChosen: %+v", run)
	}
	if run := scoreOne(t, evalQuestion{ID: "hi", Kind: evalNonData}, &evalTruth{}, "Hello! How can I help?"); run.NoDataChosen {
		t.Errorf("a non-data reply is never noDataChosen: %+v", run)
	}

	run := evalRun{ID: q.ID, Kind: string(q.Kind)}
	scoreEvalRun(q, truth, evalTurn{reply: "BHP is 0.72% shorted", err: errors.New("stream next")}, &run)
	if run.NoDataChosen {
		t.Errorf("an errored turn is not a data answer, so not noDataChosen: %+v", run)
	}
}

func TestEvalSummaryCountsNoDataChosenOnDataAnswers(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), Answered: true, NoDataChosen: true},
		{Kind: string(evalShortPct), Answered: true, ToolCalled: true},
	}
	if s := summarizeEvalRuns(runs); s.NoDataChosen != 1 || s.Grounded != 1 {
		t.Errorf("NoDataChosen = %d, Grounded = %d; want 1 and 1", s.NoDataChosen, s.Grounded)
	}
}
