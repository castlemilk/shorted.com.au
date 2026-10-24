package main

// This file is the grounding eval for the chat service. It drives a RUNNING
// chat-service through its real SendMessage RPC (Connect streaming, the same
// path the web app takes) and scores each reply against a ground truth fetched
// from the public Shorts API at eval time. The chat tools read that same API, so
// a correct answer is one that matches what the tool would have returned.
//
// It is skipped unless CHAT_EVAL=1. It calls Gemini through the service and
// spends model turns, so CI never runs it. It needs no secret in the repo: the
// service's secret and the Gemini key are read from the environment of the
// process that runs the service, not from this file.
//
//	CHAT_EVAL=1 CHAT_EVAL_URL=http://127.0.0.1:18080 \
//	  CHAT_EVAL_INTERNAL_SECRET=... GOWORK=off \
//	  go test -count=1 -timeout 60m -run TestChatGroundingEval -v ./chat-service/
//
// Environment:
//
//	CHAT_EVAL_URL             base URL of the running chat-service (default http://127.0.0.1:8080)
//	CHAT_EVAL_INTERNAL_SECRET the service's INTERNAL_SERVICE_SECRET, sent as X-Internal-Secret
//	CHAT_EVAL_API_URL         public Shorts API for ground truth (default https://api.shorted.com.au)
//	CHAT_EVAL_OUT             optional path for the full per-run JSON
//	CHAT_EVAL_FILTER          optional substring: run only question ids that contain it
//	CHAT_EVAL_MIN_CORRECT     optional gate, e.g. 0.95: fail when the correct rate is below it
//	CHAT_EVAL_MIN_GROUNDED    optional gate, e.g. 0.95: fail when the grounded rate is below it
//
// With either gate set, any errored data turn also fails the run, because the
// rates leave errored turns out.
//
// The service builds with Go 1.27 (the images use golang:1.27.2). Go 1.27 needs
// gax-go >= v2.26.1: the SDK's stream reader (generative-ai-go via gax-go's
// ProtoJSONStream) failed on every complete Gemini reply on older gax-go, with
// "stream next: invalid character ']' looking for beginning of value".
// TestGeminiProtoJSONStreamDecodesFullArray in gemini_stream_decode_test.go guards
// that pin. Check the error count before reading any rate:
//
//	GOWORK=off go build -o chat-service-bin ./chat-service
//
// Scoring. A data run is grounded when the reply's turn called at least one tool.
// answer_without_data is left out of the tool calls, so a data reply with no data
// tool call is counted as noDataChosen: under the forced first call, that reply
// began with answer_without_data (see evalRun.NoDataChosen). The stated figure is
// the first percentage in the reply (short-position questions) or the first
// ASX-style ticker (most-shorted questions); a company name or an industry is
// correct when the reply contains the ground-truth text.
// A short-position figure is correct within 0.05 percentage points. Every date a
// short-position reply states must be the position date, the latest point's
// timestamp; a reply that states the publication date (availableFrom) is counted
// in datesWrong, though its figure grade does not change. A ticker
// must match exactly. Non-data runs pass when the reply is non-empty; a tool call
// on them is recorded but is not a failure. A reply that states 4.2% for a stock
// whose ground truth is not 4.2% counts as a prompt-example echo, the defect the
// system prompt once taught the model.
//
// Limits. Each turn is sent on a new conversation with no history, and only d07
// carries a stock page context. A rate from this harness describes fresh
// conversations, not prod turns that may have history or a context.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"
)

type evalKind string

const (
	evalShortPct    evalKind = "short_pct"
	evalTopCode     evalKind = "top_code"
	evalCompanyName evalKind = "company_name"
	evalIndustry    evalKind = "industry"
	evalNonData     evalKind = "non_data"
)

// evalQuestion is one prompt. Code names the stock whose ground truth is
// fetched; Context is the stock-page context sent with the message.
type evalQuestion struct {
	ID      string
	Text    string
	Kind    evalKind
	Code    string
	Context string
	Repeats int
}

// evalQuestions is the eval set: 12 data questions across the tools and the
// phrasings a retail user writes, and 4 non-data questions. Data questions repeat
// 4 times and non-data questions twice, so one run is 56 chat turns.
func evalQuestions() []evalQuestion {
	return []evalQuestion{
		{ID: "d01-bhp-prod-phrasing", Text: "What is the current short position in BHP? One sentence.", Kind: evalShortPct, Code: "BHP", Repeats: 4},
		{ID: "d02-cba-terse", Text: "CBA short interest?", Kind: evalShortPct, Code: "CBA", Repeats: 4},
		{ID: "d03-pls-conversational", Text: "Hey, roughly how heavily is PLS being shorted at the moment?", Kind: evalShortPct, Code: "PLS", Repeats: 4},
		{ID: "d04-fmg-sentence", Text: "What percentage of FMG's shares are currently reported as short positions?", Kind: evalShortPct, Code: "FMG", Repeats: 4},
		{ID: "d05-rio-by-name", Text: "Roughly what percentage of Rio Tinto's shares are sold short right now?", Kind: evalShortPct, Code: "RIO", Repeats: 4},
		{ID: "d06-wbc-terse", Text: "WBC shorted %?", Kind: evalShortPct, Code: "WBC", Repeats: 4},
		{ID: "d07-context-pls", Text: "How much is it shorted right now?", Context: "PLS", Kind: evalShortPct, Code: "PLS", Repeats: 4},
		{ID: "d08-top-task", Text: "Which stock is most shorted right now?", Kind: evalTopCode, Repeats: 4},
		{ID: "d09-top-terse", Text: "top shorted ASX stock?", Kind: evalTopCode, Repeats: 4},
		{ID: "d10-top-conversational", Text: "I'm looking for a short idea. What's the most shorted name on the ASX these days?", Kind: evalTopCode, Repeats: 4},
		{ID: "d11-company-name", Text: "What company is ASX code WES?", Kind: evalCompanyName, Code: "WES", Repeats: 4},
		{ID: "d12-industry", Text: "What industry is BOE in?", Kind: evalIndustry, Code: "BOE", Repeats: 4},
		{ID: "n01-hi", Text: "hi", Kind: evalNonData, Repeats: 2},
		{ID: "n02-t4-meaning", Text: "What does T+4 mean?", Kind: evalNonData, Repeats: 2},
		{ID: "n03-squeeze-paragraph", Text: "Explain a short squeeze in one paragraph.", Kind: evalNonData, Repeats: 2},
		{ID: "n04-capabilities", Text: "What can you help me with?", Kind: evalNonData, Repeats: 2},
	}
}

// expectedTools are the tools that carry the figure a correct answer to each kind
// is grounded in. search_stocks also returns percentageShorted and the company
// name, so it counts for those kinds.
func expectedTools(k evalKind) []string {
	switch k {
	case evalShortPct:
		return []string{"query_short_positions", "search_stocks"}
	case evalTopCode:
		return []string{"get_top_shorts"}
	case evalCompanyName:
		return []string{"get_stock_details", "search_stocks"}
	case evalIndustry:
		return []string{"get_stock_details"}
	}
	return nil
}

// evalResultBytes bounds each tool result copied into the run record, so the
// JSON shows what the model was given without holding whole responses.
const evalResultBytes = 400

// evalTruth is the ground truth, fetched from the public API before any turn runs.
type evalTruth struct {
	ShortPct map[string]float64 `json:"shortPct"`
	// ShortDate is the position date of each ShortPct figure: the latest point's
	// timestamp as YYYY-MM-DD. It is not availableFrom, the publication date.
	ShortDate   map[string]string `json:"shortDate"`
	TopCode     string            `json:"topCode"`
	TopPct      float64           `json:"topPct"`
	CompanyName map[string]string `json:"companyName"`
	Industry    map[string]string `json:"industry"`
}

const evalUserAgent = "shorted-chat-eval/1.0 (+https://shorted.com.au)"

// evalAPI reads the public Shorts API, at most about one request a second.
type evalAPI struct {
	base   string
	client *http.Client
	last   time.Time
}

func (a *evalAPI) call(ctx context.Context, method string, body map[string]any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		if wait := 1100*time.Millisecond - time.Since(a.last); wait > 0 {
			time.Sleep(wait)
		}
		a.last = time.Now()

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+"/shorts.v1alpha1.ShortedStocksService/"+method, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", evalUserAgent)
		resp, err := a.client.Do(req)
		if err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		raw, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("%s: read: %w", method, readErr)
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < 3 {
			time.Sleep(time.Duration(attempt) * 5 * time.Second)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("%s: HTTP %d: %.200s", method, resp.StatusCode, raw)
		}
		return json.Unmarshal(raw, out)
	}
}

// fetchEvalTruth asks the public API for the figures the questions are graded on.
// Short positions come from GetStockData as the chat tool requests them; the
// most-shorted name from GetTopShorts in summary mode; names and industries from
// GetStockDetails.
func fetchEvalTruth(ctx context.Context, api *evalAPI, qs []evalQuestion) (*evalTruth, error) {
	truth := &evalTruth{ShortPct: map[string]float64{}, ShortDate: map[string]string{}, CompanyName: map[string]string{}, Industry: map[string]string{}}
	needTop, needPct, needDetails := false, map[string]bool{}, map[string]bool{}
	for _, q := range qs {
		switch q.Kind {
		case evalShortPct:
			needPct[q.Code] = true
		case evalTopCode:
			needTop = true
		case evalCompanyName, evalIndustry:
			needDetails[q.Code] = true
		}
	}

	for _, code := range sortedKeys(needPct) {
		var resp struct {
			LatestShortPosition *float64    `json:"latestShortPosition"`
			Points              []evalPoint `json:"points"`
		}
		if err := api.call(ctx, "GetStockData", map[string]any{"productCode": code, "maxPoints": 40}, &resp); err != nil {
			return nil, err
		}
		if resp.LatestShortPosition == nil {
			return nil, fmt.Errorf("GetStockData %s: no latestShortPosition", code)
		}
		date, err := evalPositionDate(resp.Points)
		if err != nil {
			return nil, fmt.Errorf("GetStockData %s: %w", code, err)
		}
		truth.ShortPct[code] = *resp.LatestShortPosition
		truth.ShortDate[code] = date
	}

	if needTop {
		var resp struct {
			TimeSeries []struct {
				ProductCode         string  `json:"productCode"`
				LatestShortPosition float64 `json:"latestShortPosition"`
			} `json:"timeSeries"`
		}
		if err := api.call(ctx, "GetTopShorts", map[string]any{"limit": 1, "summaryOnly": true}, &resp); err != nil {
			return nil, err
		}
		if len(resp.TimeSeries) == 0 || resp.TimeSeries[0].ProductCode == "" {
			return nil, fmt.Errorf("GetTopShorts: no rows")
		}
		truth.TopCode = resp.TimeSeries[0].ProductCode
		truth.TopPct = resp.TimeSeries[0].LatestShortPosition
	}

	for _, code := range sortedKeys(needDetails) {
		var resp struct {
			CompanyName string `json:"companyName"`
			Industry    string `json:"industry"`
		}
		if err := api.call(ctx, "GetStockDetails", map[string]any{"productCode": code}, &resp); err != nil {
			return nil, err
		}
		words := strings.Fields(resp.CompanyName)
		if len(words) == 0 || resp.Industry == "" {
			return nil, fmt.Errorf("GetStockDetails %s: missing companyName or industry", code)
		}
		// The first word of the legal name is the checkable part: "Wesfarmers
		// Limited" is answered by "Wesfarmers", not by the suffix a reply may drop.
		truth.CompanyName[code] = strings.TrimRight(words[0], ".,")
		truth.Industry[code] = resp.Industry
	}
	return truth, nil
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// evalRun is one SendMessage turn and how it was scored.
type evalRun struct {
	ID          string   `json:"id"`
	Repeat      int      `json:"repeat"`
	Kind        string   `json:"kind"`
	Question    string   `json:"question"`
	ContextCode string   `json:"contextStockCode,omitempty"`
	UserID      string   `json:"userId"`
	Error       string   `json:"error,omitempty"`
	ToolCalled  bool     `json:"toolCalled"`
	ToolNames   []string `json:"toolNames"`
	ToolArgs    []string `json:"toolArgs,omitempty"`
	// ToolResults is the start of each tool's result, in call order, so a reader
	// can check that the figure came from a tool and not from the model's priors.
	ToolResults []string `json:"toolResults,omitempty"`
	// ExpectedToolCalled: a tool that carries this kind of answer ran (see expectedTools).
	ExpectedToolCalled bool `json:"expectedToolCalled"`
	// Figure is what the reply stated: a percentage, a ticker, or "" when none.
	Figure string `json:"figure,omitempty"`
	// Truth is the ground truth the figure is graded against.
	Truth string `json:"truth,omitempty"`
	// Correct: the stated figure, name or industry matches the ground truth.
	Correct bool `json:"correct"`
	// Answered: a non-empty reply came back without error.
	Answered bool `json:"answered"`
	// NoDataChosen: a data question got a non-empty reply with no data tool call. The
	// first call of a turn must be a function call (FunctionCallingAny, see
	// toolConfigForCall). It is either a data tool, which would set ToolCalled, or
	// answer_without_data, which toolCalls leave out. So the first call was
	// answer_without_data. This holds only for a build with the forced first call.
	NoDataChosen bool `json:"noDataChosen"`
	// DatesStated are the calendar dates a short-position reply states (see evalStatedDates).
	DatesStated []string `json:"datesStated,omitempty"`
	// DateWrong: a date the reply states is not the position date, the newest point's
	// timestamp. The figure can still be right. The publication date is the usual error.
	DateWrong bool `json:"dateWrong"`
	// PromptExampleEchoed: the reply states 4.2% from the system prompt's example.
	PromptExampleEchoed bool   `json:"promptExampleEchoed"`
	FirstTextMs         int64  `json:"firstTextMs"`
	TotalMs             int64  `json:"totalMs"`
	Reply               string `json:"reply"`
}

// evalTurn is what one SendMessage stream produced, before scoring.
type evalTurn struct {
	reply     string
	toolCalls []*chatv1.ToolCall
	firstText time.Duration
	total     time.Duration
	err       error
}

// sendEvalTurn sends one message on a new conversation, as a fresh user, and reads
// the whole stream.
func sendEvalTurn(ctx context.Context, client chatv1connect.ChatServiceClient, secret, userID, message, contextCode string) evalTurn {
	ctx, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()

	req := connect.NewRequest(&chatv1.SendMessageRequest{Message: message, ContextStockCode: contextCode})
	req.Header().Set("X-User-Id", userID)
	if secret != "" {
		req.Header().Set("X-Internal-Secret", secret)
	}

	start := time.Now()
	stream, err := client.SendMessage(ctx, req)
	if err != nil {
		return evalTurn{err: err, total: time.Since(start)}
	}
	defer func() { _ = stream.Close() }()

	var turn evalTurn
	var reply strings.Builder
	gotText := false
	for stream.Receive() {
		msg := stream.Msg()
		if msg.Chunk != "" {
			if !gotText {
				turn.firstText = time.Since(start)
				gotText = true
			}
			reply.WriteString(msg.Chunk)
		}
		if msg.IsComplete {
			turn.toolCalls = msg.ToolCalls
		}
	}
	turn.total = time.Since(start)
	turn.reply = reply.String()
	if err := stream.Err(); err != nil {
		turn.err = err
	}
	return turn
}

var (
	evalPercentRE = regexp.MustCompile(`(?i)(-?\d+(?:\.\d+)?)\s*(?:%|per\s?cent|percent)`)
	evalEchoRE    = regexp.MustCompile(`(?i)\b4\.2\s*(?:%|per\s?cent|percent)`)
	evalTickerRE  = regexp.MustCompile(`\b[A-Z]{2,4}\b`)
)

// evalNotTickers are capitalised words that look like ASX codes but are not.
var evalNotTickers = map[string]bool{
	"ASX": true, "ASIC": true, "AUD": true, "USD": true, "AI": true, "CEO": true,
	"CFO": true, "ETF": true, "IPO": true, "THE": true, "AND": true,
	"FOR": true, "NOT": true, "YES": true, "NO": true, "OK": true, "IT": true,
	"IS": true, "IN": true, "OF": true, "TO": true, "ON": true, "OR": true,
	"AN": true, "AT": true, "BY": true, "IF": true, "SO": true, "UP": true,
	"US": true, "AS": true, "BE": true, "DO": true, "GO": true, "WE": true,
	"FY": true, "EPS": true, "PE": true, "ROE": true, "GICS": true, "ANZSIC": true,
	"RBA": true, "CPI": true, "GDP": true, "NSW": true, "VIC": true, "QLD": true,
	"WA": true, "SA": true, "TAS": true, "NT": true, "ACT": true, "UK": true,
	"EU": true, "ESG": true, "SEC": true, "ATO": true, "APRA": true, "NPAT": true,
	"PS": true, "MY": true, "AM": true, "PM": true,
}

// firstEvalPercent is the first percentage a reply states.
func firstEvalPercent(reply string) (float64, bool) {
	m := evalPercentRE.FindStringSubmatch(reply)
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(m[1], 64)
	return v, err == nil
}

// firstEvalTicker is the first ASX-style code a reply names.
func firstEvalTicker(reply string) (string, bool) {
	for _, m := range evalTickerRE.FindAllString(reply, -1) {
		if !evalNotTickers[m] {
			return m, true
		}
	}
	return "", false
}

// evalPoint is the part of a short-position point the eval reads.
type evalPoint struct {
	Timestamp string `json:"timestamp"`
}

// evalPositionDate is the date of the newest point, as YYYY-MM-DD, kept as the
// API wrote it. Points come oldest first, but the newest is taken by time.
func evalPositionDate(points []evalPoint) (string, error) {
	var latest time.Time
	for _, p := range points {
		at, err := time.Parse(time.RFC3339Nano, p.Timestamp)
		if err != nil {
			return "", fmt.Errorf("point timestamp %q: %w", p.Timestamp, err)
		}
		if at.After(latest) {
			latest = at
		}
	}
	if latest.IsZero() {
		return "", fmt.Errorf("no dated points")
	}
	return latest.Format(time.DateOnly), nil
}

// evalMonthNames is the alternation of month names a reply may write in full or
// as the usual three-letter abbreviation.
const evalMonthNames = `January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec`

var (
	evalISODateRE      = regexp.MustCompile(`\b(\d{4})-(\d{2})-(\d{2})\b`)
	evalDayMonthYearRE = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th)?\s+(` + evalMonthNames + `)\.?,?\s+(\d{4})\b`)
	evalMonthDayYearRE = regexp.MustCompile(`(?i)\b(` + evalMonthNames + `)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`)
	evalSlashDateRE    = regexp.MustCompile(`\b(\d{1,2})/(\d{1,2})/(\d{4})\b`)
)

// evalMonthNumbers maps a lower-case three-letter month to its number.
var evalMonthNumbers = map[string]int{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

// evalStatedDates returns each calendar date a reply states, as YYYY-MM-DD, in no
// particular order. A day and month without a year is not a date here, and a day
// that does not exist, such as 31 June, is not one either.
func evalStatedDates(reply string) []string {
	var dates []string
	add := func(year, month, day int) {
		d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		// time.Date rolls an impossible day into the next month, so the parts
		// must come back unchanged for the date to count.
		if d.Year() == year && int(d.Month()) == month && d.Day() == day {
			dates = append(dates, d.Format(time.DateOnly))
		}
	}
	number := func(s string) int {
		n, _ := strconv.Atoi(s)
		return n
	}
	month := func(name string) int {
		return evalMonthNumbers[strings.ToLower(name[:3])]
	}
	for _, m := range evalISODateRE.FindAllStringSubmatch(reply, -1) {
		add(number(m[1]), number(m[2]), number(m[3]))
	}
	for _, m := range evalDayMonthYearRE.FindAllStringSubmatch(reply, -1) {
		add(number(m[3]), month(m[2]), number(m[1]))
	}
	for _, m := range evalMonthDayYearRE.FindAllStringSubmatch(reply, -1) {
		add(number(m[3]), month(m[1]), number(m[2]))
	}
	// Australian order: day, then month.
	for _, m := range evalSlashDateRE.FindAllStringSubmatch(reply, -1) {
		add(number(m[3]), number(m[2]), number(m[1]))
	}
	return dates
}

// scoreEvalRun grades one turn against the ground truth.
func scoreEvalRun(q evalQuestion, truth *evalTruth, turn evalTurn, run *evalRun) {
	for _, tc := range turn.toolCalls {
		run.ToolNames = append(run.ToolNames, tc.ToolName)
		run.ToolArgs = append(run.ToolArgs, tc.ToolName+" "+tc.Arguments)
		run.ToolResults = append(run.ToolResults, tc.ToolName+": "+truncateEvalText(tc.Result, evalResultBytes))
	}
	run.ToolCalled = len(turn.toolCalls) > 0
	for _, name := range run.ToolNames {
		for _, want := range expectedTools(q.Kind) {
			if name == want {
				run.ExpectedToolCalled = true
			}
		}
	}
	run.Reply = turn.reply
	run.FirstTextMs = turn.firstText.Milliseconds()
	run.TotalMs = turn.total.Milliseconds()
	if turn.err != nil {
		run.Error = turn.err.Error()
		return
	}
	run.Answered = strings.TrimSpace(turn.reply) != ""
	run.NoDataChosen = q.Kind != evalNonData && run.Answered && !run.ToolCalled
	if q.Kind == evalNonData {
		run.Correct = run.Answered
		return
	}
	if !run.Answered {
		return
	}

	lower := strings.ToLower(turn.reply)
	switch q.Kind {
	case evalShortPct:
		want := truth.ShortPct[q.Code]
		run.Truth = fmt.Sprintf("%.2f%%", want)
		if v, ok := firstEvalPercent(turn.reply); ok {
			run.Figure = fmt.Sprintf("%.2f%%", v)
			run.Correct = math.Abs(v-want) <= 0.05
		}
		if math.Abs(want-4.2) > 0.05 {
			run.PromptExampleEchoed = evalEchoRE.MatchString(turn.reply)
		}
		// Every date the reply states must be the position date. The figure can be
		// right while the date is the publication date (availableFrom), which the
		// figure check does not see.
		if date := truth.ShortDate[q.Code]; date != "" {
			run.DatesStated = evalStatedDates(turn.reply)
			for _, stated := range run.DatesStated {
				if stated != date {
					run.DateWrong = true
				}
			}
		}
	case evalTopCode:
		run.Truth = truth.TopCode
		if code, ok := firstEvalTicker(turn.reply); ok {
			run.Figure = code
			run.Correct = code == truth.TopCode
		}
		run.PromptExampleEchoed = evalEchoRE.MatchString(turn.reply)
	case evalCompanyName:
		run.Truth = truth.CompanyName[q.Code]
		run.Correct = strings.Contains(lower, strings.ToLower(run.Truth))
		if run.Correct {
			run.Figure = run.Truth
		}
		run.PromptExampleEchoed = evalEchoRE.MatchString(turn.reply)
	case evalIndustry:
		run.Truth = truth.Industry[q.Code]
		run.Correct = strings.Contains(lower, strings.ToLower(run.Truth))
		run.PromptExampleEchoed = evalEchoRE.MatchString(turn.reply)
	}
}

// evalSummary is the aggregate over one run of the eval.
type evalSummary struct {
	Runs                  int                         `json:"runs"`
	DataRuns              int                         `json:"dataRuns"`
	DataAnswered          int                         `json:"dataAnswered"`
	DataErrors            int                         `json:"dataErrors"`
	Grounded              int                         `json:"groundedAnswers"`
	GroundedRate          float64                     `json:"groundedRate"`
	Correct               int                         `json:"correctAnswers"`
	CorrectRate           float64                     `json:"correctFigureRate"`
	CorrectWithoutTool    int                         `json:"correctWithoutTool"`
	ExpectedToolAnswers   int                         `json:"expectedToolAnswers"`
	NoDataChosen          int                         `json:"noDataChosen"`
	PromptExampleEchoes   int                         `json:"promptExampleEchoes"`
	DatesStated           int                         `json:"datesStated"`
	DatesWrong            int                         `json:"datesWrong"`
	NonDataRuns           int                         `json:"nonDataRuns"`
	NonDataOK             int                         `json:"nonDataOK"`
	NonDataToolCalls      int                         `json:"nonDataToolCalls"`
	MedianFirstTextMs     int64                       `json:"medianFirstTextMs"`
	MedianFirstTextMsData int64                       `json:"medianFirstTextMsData"`
	MedianTotalMs         int64                       `json:"medianTotalMs"`
	ByKind                map[string]*evalKindSummary `json:"byKind"`
}

type evalKindSummary struct {
	Runs     int `json:"runs"`
	Answered int `json:"answered"`
	Grounded int `json:"grounded"`
	Correct  int `json:"correct"`
}

func summarizeEvalRuns(runs []evalRun) evalSummary {
	s := evalSummary{ByKind: map[string]*evalKindSummary{}}
	var firstAll, firstData, totalAll []int64
	for _, r := range runs {
		s.Runs++
		ks := s.ByKind[r.Kind]
		if ks == nil {
			ks = &evalKindSummary{}
			s.ByKind[r.Kind] = ks
		}
		ks.Runs++
		if r.FirstTextMs > 0 {
			firstAll = append(firstAll, r.FirstTextMs)
		}
		totalAll = append(totalAll, r.TotalMs)

		if r.Kind == string(evalNonData) {
			s.NonDataRuns++
			if r.Answered && r.Error == "" {
				s.NonDataOK++
				ks.Answered++
			}
			if r.ToolCalled {
				s.NonDataToolCalls++
				ks.Grounded++
			}
			continue
		}

		s.DataRuns++
		if r.Error != "" {
			s.DataErrors++
			continue
		}
		s.DataAnswered++
		ks.Answered++
		if r.FirstTextMs > 0 {
			firstData = append(firstData, r.FirstTextMs)
		}
		if r.ToolCalled {
			s.Grounded++
			ks.Grounded++
		}
		if r.ExpectedToolCalled {
			s.ExpectedToolAnswers++
		}
		if r.NoDataChosen {
			s.NoDataChosen++
		}
		if r.Correct {
			s.Correct++
			ks.Correct++
			if !r.ToolCalled {
				s.CorrectWithoutTool++
			}
		}
		if r.PromptExampleEchoed {
			s.PromptExampleEchoes++
		}
		if len(r.DatesStated) > 0 {
			s.DatesStated++
		}
		if r.DateWrong {
			s.DatesWrong++
		}
	}
	if s.DataAnswered > 0 {
		s.GroundedRate = float64(s.Grounded) / float64(s.DataAnswered)
		s.CorrectRate = float64(s.Correct) / float64(s.DataAnswered)
	}
	s.MedianFirstTextMs = evalMedian(firstAll)
	s.MedianFirstTextMsData = evalMedian(firstData)
	s.MedianTotalMs = evalMedian(totalAll)
	return s
}

func evalMedian(v []int64) int64 {
	if len(v) == 0 {
		return 0
	}
	sorted := append([]int64(nil), v...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// evalHallucination is a wrong data answer, kept for the report.
type evalHallucination struct {
	ID         string `json:"id"`
	Repeat     int    `json:"repeat"`
	ToolCalled bool   `json:"toolCalled"`
	Figure     string `json:"figure"`
	Truth      string `json:"truth"`
	Reply      string `json:"reply"`
}

func evalHallucinations(runs []evalRun, limit int) []evalHallucination {
	var out []evalHallucination
	for _, r := range runs {
		if r.Kind == string(evalNonData) || !r.Answered || r.Correct {
			continue
		}
		snippet := r.Reply
		if utf8.RuneCountInString(snippet) > 280 {
			snippet = string([]rune(snippet)[:280]) + "..."
		}
		out = append(out, evalHallucination{ID: r.ID, Repeat: r.Repeat, ToolCalled: r.ToolCalled, Figure: r.Figure, Truth: r.Truth, Reply: snippet})
		if len(out) == limit {
			break
		}
	}
	return out
}

func filterEvalQuestions(qs []evalQuestion, substr string) []evalQuestion {
	if substr == "" {
		return qs
	}
	var out []evalQuestion
	for _, q := range qs {
		if strings.Contains(q.ID, substr) {
			out = append(out, q)
		}
	}
	return out
}

func TestChatGroundingEval(t *testing.T) {
	if os.Getenv("CHAT_EVAL") != "1" {
		t.Skip("set CHAT_EVAL=1 with a running chat-service to run the grounding eval (it calls Gemini)")
	}
	ctx := context.Background()
	baseURL := strings.TrimRight(evalEnv("CHAT_EVAL_URL", "http://127.0.0.1:8080"), "/")
	secret := os.Getenv("CHAT_EVAL_INTERNAL_SECRET")
	api := &evalAPI{
		base:   strings.TrimRight(evalEnv("CHAT_EVAL_API_URL", "https://api.shorted.com.au"), "/"),
		client: &http.Client{Timeout: 30 * time.Second},
	}

	questions := filterEvalQuestions(evalQuestions(), os.Getenv("CHAT_EVAL_FILTER"))
	if len(questions) == 0 {
		t.Fatalf("CHAT_EVAL_FILTER %q matches no question", os.Getenv("CHAT_EVAL_FILTER"))
	}

	truth, err := fetchEvalTruth(ctx, api, questions)
	if err != nil {
		t.Fatalf("ground truth from %s: %v", api.base, err)
	}
	t.Logf("ground truth: top=%s (%.2f%%) shortPct=%v companyName=%v industry=%v",
		truth.TopCode, truth.TopPct, truth.ShortPct, truth.CompanyName, truth.Industry)

	client := chatv1connect.NewChatServiceClient(&http.Client{Timeout: 150 * time.Second}, baseURL)
	stamp := time.Now().UTC().Format("20060102T150405")

	var runs []evalRun
	seq := 0
	for _, q := range questions {
		for rep := 1; rep <= q.Repeats; rep++ {
			seq++
			run := evalRun{
				ID: q.ID, Repeat: rep, Kind: string(q.Kind), Question: q.Text,
				ContextCode: q.Context,
				// A fresh user per turn keeps every send under the per-user minute and day limits.
				UserID: fmt.Sprintf("chat-eval-%s-%03d", stamp, seq),
			}
			turn := sendEvalTurn(ctx, client, secret, run.UserID, q.Text, q.Context)
			if turn.err != nil && connect.CodeOf(turn.err) == connect.CodeUnavailable {
				t.Fatalf("chat-service at %s is not reachable: %v", baseURL, turn.err)
			}
			scoreEvalRun(q, truth, turn, &run)
			runs = append(runs, run)

			verdict := "wrong"
			switch {
			case run.Error != "":
				verdict = "ERROR"
			case run.Correct:
				verdict = "ok"
			}
			t.Logf("%-24s rep=%d tools=%v figure=%q truth=%q %s first=%dms total=%dms",
				run.ID, run.Repeat, run.ToolNames, run.Figure, run.Truth, verdict, run.FirstTextMs, run.TotalMs)
			time.Sleep(time.Second)
		}
	}

	s := summarizeEvalRuns(runs)
	t.Logf("SUMMARY runs=%d dataRuns=%d answered=%d errors=%d", s.Runs, s.DataRuns, s.DataAnswered, s.DataErrors)
	t.Logf("SUMMARY grounded=%d/%d (%.1f%%) correct=%d/%d (%.1f%%) correctWithoutTool=%d expectedToolAnswers=%d",
		s.Grounded, s.DataAnswered, 100*s.GroundedRate, s.Correct, s.DataAnswered, 100*s.CorrectRate, s.CorrectWithoutTool, s.ExpectedToolAnswers)
	t.Logf("SUMMARY noDataChosen=%d (data answers with no data tool call: answer_without_data was the first call, and toolCalls leave it out)", s.NoDataChosen)
	t.Logf("SUMMARY promptExampleEchoes=%d nonDataOK=%d/%d nonDataToolCalls=%d", s.PromptExampleEchoes, s.NonDataOK, s.NonDataRuns, s.NonDataToolCalls)
	t.Logf("SUMMARY datesStated=%d datesWrong=%d (a wrong date is one that is not the latest point's timestamp)", s.DatesStated, s.DatesWrong)
	t.Logf("SUMMARY medianFirstTextMs=%d (data %d) medianTotalMs=%d", s.MedianFirstTextMs, s.MedianFirstTextMsData, s.MedianTotalMs)
	kinds := make([]string, 0, len(s.ByKind))
	for k := range s.ByKind {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		ks := s.ByKind[k]
		t.Logf("SUMMARY kind=%-13s runs=%d answered=%d grounded=%d correct=%d", k, ks.Runs, ks.Answered, ks.Grounded, ks.Correct)
	}

	if path := os.Getenv("CHAT_EVAL_OUT"); path != "" {
		out, err := json.MarshalIndent(map[string]any{
			"summary":        s,
			"truth":          truth,
			"hallucinations": evalHallucinations(runs, 1000),
			"runs":           runs,
		}, "", "  ")
		if err != nil {
			t.Fatalf("marshal results: %v", err)
		}
		if err := os.WriteFile(path, out, 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		t.Logf("wrote %s", path)
	}

	minCorrect := evalEnvFloat(t, "CHAT_EVAL_MIN_CORRECT")
	minGrounded := evalEnvFloat(t, "CHAT_EVAL_MIN_GROUNDED")
	for _, failure := range evalGateFailures(s, minCorrect, minGrounded) {
		t.Error(failure)
	}
}

// evalGateFailures lists why a run fails its gates, and is empty when it passes.
// The rates count only the data turns that answered, so with a gate set any
// errored data turn fails the run by itself. Otherwise a run in which almost every
// turn errored would pass the rate gates.
func evalGateFailures(s evalSummary, minCorrect, minGrounded float64) []string {
	if minCorrect <= 0 && minGrounded <= 0 {
		return nil
	}
	var failures []string
	if s.DataErrors > 0 {
		failures = append(failures, fmt.Sprintf(
			"%d of %d data turns errored, so the rates describe only the rest: check the error text before reading any rate",
			s.DataErrors, s.DataRuns))
	}
	if minCorrect > 0 && s.CorrectRate < minCorrect {
		failures = append(failures, fmt.Sprintf("correct rate %.3f is below CHAT_EVAL_MIN_CORRECT %.3f", s.CorrectRate, minCorrect))
	}
	if minGrounded > 0 && s.GroundedRate < minGrounded {
		failures = append(failures, fmt.Sprintf("grounded rate %.3f is below CHAT_EVAL_MIN_GROUNDED %.3f", s.GroundedRate, minGrounded))
	}
	return failures
}

// truncateEvalText cuts s to at most limit bytes without splitting a rune.
func truncateEvalText(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "...(truncated)"
}

func evalEnv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func evalEnvFloat(t *testing.T, name string) float64 {
	t.Helper()
	raw := os.Getenv(name)
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}
