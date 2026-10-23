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

func TestEvalNonDataPassesOnAnyNonEmptyReply(t *testing.T) {
	q := evalQuestion{ID: "hi", Kind: evalNonData}
	if run := scoreOne(t, q, &evalTruth{}, "Hello! How can I help?"); !run.Correct || !run.Answered {
		t.Errorf("a non-empty non-data reply should pass: %+v", run)
	}
	if run := scoreOne(t, q, &evalTruth{}, "   "); run.Correct || run.Answered {
		t.Errorf("a blank non-data reply should not pass: %+v", run)
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
	var data, nonData, withContext, runs int
	for _, q := range evalQuestions() {
		runs += q.Repeats
		if q.Kind == evalNonData {
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
	if data != 12 || nonData != 4 || withContext != 1 {
		t.Errorf("question set = %d data, %d non-data, %d with context; want 12, 4, 1", data, nonData, withContext)
	}
	if runs != 56 {
		t.Errorf("total turns = %d, want 56", runs)
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
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted as of October 23, 2026", "query_short_positions"); !run.Correct || !run.DateWrong {
		t.Errorf("right figure with the publication date should be correct and date-wrong: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted as of 19 October 2026", "query_short_positions"); !run.Correct || run.DateWrong || len(run.DatesStated) != 1 {
		t.Errorf("right figure with the position date should be correct and date-right: %+v", run)
	}
	if run := scoreOne(t, q, truth, "BHP is 1.61% shorted", "query_short_positions"); !run.Correct || run.DateWrong || len(run.DatesStated) != 0 {
		t.Errorf("a reply with no date should not be date-wrong: %+v", run)
	}
}

func TestEvalSummaryCountsStatedAndWrongDates(t *testing.T) {
	runs := []evalRun{
		{Kind: string(evalShortPct), DatesStated: []string{"2026-10-19"}},
		{Kind: string(evalShortPct), DatesStated: []string{"2026-10-23"}, DateWrong: true},
		{Kind: string(evalShortPct)},
	}
	if s := summarizeEvalRuns(runs); s.DatesStated != 2 || s.DatesWrong != 1 {
		t.Errorf("DatesStated = %d, DatesWrong = %d; want 2 and 1", s.DatesStated, s.DatesWrong)
	}
}

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

func TestEvalGateFailsARunWhoseTurnsErrored(t *testing.T) {
	// One answered turn that is correct and grounded, and 59 provider errors. The
	// rates over the answered turns are 1.000, so only the error count can fail the run.
	runs := []evalRun{{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true}}
	for i := 0; i < 59; i++ {
		runs = append(runs, evalRun{Kind: string(evalShortPct), Error: "stream next: invalid character ']' looking for beginning of value"})
	}
	s := summarizeEvalRuns(runs)
	if s.CorrectRate != 1 || s.GroundedRate != 1 {
		t.Fatalf("rates over the answered turns = %.3f and %.3f, want 1 and 1", s.CorrectRate, s.GroundedRate)
	}

	failures := evalGateFailures(s, 0.95, 0.95)
	if len(failures) != 1 || !strings.Contains(failures[0], "59 of 60 data turns errored") {
		t.Errorf("gate failures = %v, want one failure naming the 59 errored turns", failures)
	}
	if failures := evalGateFailures(s, 0, 0); failures != nil {
		t.Errorf("with no gate set there should be no failures, got %v", failures)
	}
}

func TestEvalGatePassesACleanRunAndFailsALowRate(t *testing.T) {
	clean := summarizeEvalRuns([]evalRun{
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
	})
	if failures := evalGateFailures(clean, 0.95, 0.95); failures != nil {
		t.Errorf("a clean run at 1.000 should pass both gates, got %v", failures)
	}

	low := summarizeEvalRuns([]evalRun{
		{Kind: string(evalShortPct), Answered: true, Correct: true, ToolCalled: true},
		{Kind: string(evalShortPct), Answered: true, Correct: false},
	})
	failures := evalGateFailures(low, 0.95, 0)
	if len(failures) != 1 || !strings.Contains(failures[0], "correct rate 0.500 is below CHAT_EVAL_MIN_CORRECT 0.950") {
		t.Errorf("gate failures = %v, want one correct-rate failure", failures)
	}
}
