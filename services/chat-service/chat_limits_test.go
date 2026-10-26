package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"
)

var (
	testLimits = chatSendLimits{PerMinute: 4, PerDay: 40, PerMonth: 600, GlobalPerMinute: 60}
	testNow    = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
)

func TestEvaluateSendLimitsAdmitsCountsAtTheLimit(t *testing.T) {
	// Counts include the send being decided, so a count equal to the limit is
	// the last send allowed, not the first one refused.
	c := sendCounts{UserMinute: 4, UserDay: 40, UserMonth: 600, GlobalMinute: 60}
	if _, over := evaluateSendLimits(c, testLimits, testNow); over {
		t.Fatal("counts equal to every limit must be admitted")
	}
}

func TestEvaluateSendLimitsWindowBoundaries(t *testing.T) {
	cases := []struct {
		name       string
		counts     sendCounts
		wantKind   string
		wantRetry  int
		wantResetA time.Time
	}{
		{
			name:       "per minute, fifth send inside the minute",
			counts:     sendCounts{UserMinute: 5, UserDay: 5, UserMonth: 5, OldestUserMinute: testNow.Add(-10 * time.Second)},
			wantKind:   limitKindPerMinute,
			wantRetry:  50,
			wantResetA: testNow.Add(50 * time.Second),
		},
		{
			name:       "daily, the oldest send of the day sets the reset",
			counts:     sendCounts{UserMinute: 1, UserDay: 41, UserMonth: 41, OldestUserDay: testNow.Add(-2 * time.Hour)},
			wantKind:   limitKindDaily,
			wantRetry:  22 * 3600,
			wantResetA: testNow.Add(22 * time.Hour),
		},
		{
			name:       "monthly, rolling thirty days",
			counts:     sendCounts{UserMinute: 1, UserDay: 1, UserMonth: 601, OldestUserMonth: testNow.Add(-29 * 24 * time.Hour)},
			wantKind:   limitKindMonthly,
			wantRetry:  24 * 3600,
			wantResetA: testNow.Add(24 * time.Hour),
		},
		{
			name:       "global ceiling, caller under their own limits",
			counts:     sendCounts{UserMinute: 1, UserDay: 1, UserMonth: 1, GlobalMinute: 61, OldestGlobalMinute: testNow.Add(-30 * time.Second)},
			wantKind:   limitKindGlobal,
			wantRetry:  30,
			wantResetA: testNow.Add(30 * time.Second),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, over := evaluateSendLimits(tc.counts, testLimits, testNow)
			if !over {
				t.Fatal("evaluateSendLimits() over = false, want true")
			}
			if got.Kind != tc.wantKind {
				t.Fatalf("Kind = %q, want %q", got.Kind, tc.wantKind)
			}
			if got.RetryAfterSeconds != tc.wantRetry {
				t.Fatalf("RetryAfterSeconds = %d, want %d", got.RetryAfterSeconds, tc.wantRetry)
			}
			if !got.ResetAt.Equal(tc.wantResetA) {
				t.Fatalf("ResetAt = %v, want %v", got.ResetAt, tc.wantResetA)
			}
		})
	}
}

func TestEvaluateSendLimitsReportsTheCallersOwnWindowBeforeGlobal(t *testing.T) {
	c := sendCounts{UserMinute: 5, GlobalMinute: 61, OldestUserMinute: testNow.Add(-5 * time.Second), OldestGlobalMinute: testNow.Add(-5 * time.Second)}
	got, over := evaluateSendLimits(c, testLimits, testNow)
	if !over || got.Kind != limitKindPerMinute {
		t.Fatalf("kind = %q (over=%v), want per_minute: a caller at their own cap is told about it", got.Kind, over)
	}

	c = sendCounts{UserMinute: 1, UserDay: 41, GlobalMinute: 61, OldestUserDay: testNow.Add(-time.Hour), OldestGlobalMinute: testNow.Add(-time.Second)}
	got, over = evaluateSendLimits(c, testLimits, testNow)
	if !over || got.Kind != limitKindDaily {
		t.Fatalf("kind = %q (over=%v), want daily before global", got.Kind, over)
	}
}

func TestEvaluateSendLimitsRoundsRetryUpSoWaitingTheTimeIsEnough(t *testing.T) {
	// 0.5s of the window is left. The client must be told 1 second, never 0,
	// because a retry at exactly the reset instant is still refused.
	c := sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-59500 * time.Millisecond)}
	got, over := evaluateSendLimits(c, testLimits, testNow)
	if !over || got.RetryAfterSeconds != 1 {
		t.Fatalf("RetryAfterSeconds = %d (over=%v), want 1", got.RetryAfterSeconds, over)
	}
}

func TestEvaluateSendLimitsNeverReturnsZeroRetry(t *testing.T) {
	// The oldest send expires exactly now. Retry is still at least one second.
	c := sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-time.Minute)}
	got, over := evaluateSendLimits(c, testLimits, testNow)
	if !over || got.RetryAfterSeconds != 1 {
		t.Fatalf("RetryAfterSeconds = %d (over=%v), want 1", got.RetryAfterSeconds, over)
	}
}

func TestEvaluateSendLimitsFallsBackToAFullWindowWithNoOldestSend(t *testing.T) {
	c := sendCounts{UserMinute: 5}
	got, over := evaluateSendLimits(c, testLimits, testNow)
	if !over || got.RetryAfterSeconds != 60 {
		t.Fatalf("RetryAfterSeconds = %d (over=%v), want a full minute", got.RetryAfterSeconds, over)
	}
}

func TestHumanizeWait(t *testing.T) {
	cases := map[int]string{
		45:    "45 seconds",
		600:   "10 minutes",
		79200: "22 hours",
	}
	for seconds, want := range cases {
		if got := humanizeWait(seconds); got != want {
			t.Fatalf("humanizeWait(%d) = %q, want %q", seconds, got, want)
		}
	}
}

func TestLimitExceededErrorCarriesMachineReadableDetail(t *testing.T) {
	e := limitExceeded{
		Kind:              limitKindDaily,
		Limit:             40,
		RetryAfterSeconds: 3600,
		ResetAt:           testNow.Add(time.Hour),
	}
	err := limitExceededError(e)

	if code := connect.CodeOf(err); code != connect.CodeResourceExhausted {
		t.Fatalf("code = %v, want resource_exhausted", code)
	}
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		t.Fatalf("error is %T, want *connect.Error", err)
	}

	var detail map[string]any
	if jsonErr := json.Unmarshal([]byte(connectErr.Meta().Get(chatLimitHeader)), &detail); jsonErr != nil {
		t.Fatalf("x-chat-limit is not JSON: %v", jsonErr)
	}
	if detail["kind"] != "daily" || detail["limit"] != float64(40) ||
		detail["retry_after_seconds"] != float64(3600) ||
		detail["reset_at"] != float64(testNow.Add(time.Hour).Unix()) {
		t.Fatalf("x-chat-limit = %v, want the kind/limit/retry_after_seconds/reset_at contract", detail)
	}
	if !strings.Contains(connectErr.Message(), "40 messages in 24 hours") {
		t.Fatalf("message = %q, want the human-readable sentence", connectErr.Message())
	}
}

func TestCountedOutcomesMatchConstants(t *testing.T) {
	// The count must read exactly the outcomes that reached the model or are
	// running. A 'limited' row must never be among them.
	want := []string{usageOutcomePending, usageOutcomeOK, usageOutcomeError, usageOutcomeCanceled}
	for _, outcome := range want {
		if !strings.Contains(countedOutcomesSQL, "'"+outcome+"'") {
			t.Fatalf("countedOutcomesSQL = %s, missing %q", countedOutcomesSQL, outcome)
		}
	}
	if strings.Contains(countedOutcomesSQL, usageOutcomeLimited) {
		t.Fatalf("countedOutcomesSQL = %s, must not count %q", countedOutcomesSQL, usageOutcomeLimited)
	}
}

func TestSendCountsSQLFiltersOutcomesAndCoversEveryWindow(t *testing.T) {
	if !strings.Contains(sendCountsSQL, "outcome IN "+countedOutcomesSQL) {
		t.Fatalf("send count SQL does not filter on counted outcomes:\n%s", sendCountsSQL)
	}
	if strings.Contains(sendCountsSQL, "limited") {
		t.Fatalf("send count SQL must not mention limited sends:\n%s", sendCountsSQL)
	}
	// The SQL intervals are generated from the Go windows. A drift between them
	// would make the counts and the reset times disagree.
	for _, interval := range []string{"60 seconds", "86400 seconds", "2592000 seconds"} {
		if !strings.Contains(sendCountsSQL, "interval '"+interval+"'") {
			t.Fatalf("send count SQL missing window %q:\n%s", interval, sendCountsSQL)
		}
	}
	if !regexp.MustCompile(`user_id = \$1 AND created_at > now\(\) - interval '2592000 seconds'\)\s+OR`).MatchString(sendCountsSQL) {
		t.Fatalf("send count SQL must bound the per-user scan to 30 days:\n%s", sendCountsSQL)
	}
}

// fakeLedger is an in-memory usageLedger. It records what the limiter asked of
// it, and returns the counts a test sets.
type fakeLedger struct {
	id          int64
	counts      sendCounts
	admitErr    error
	countErr    error
	admitCalls  int
	rejected    []int64
	rejectErrs  []error // consumed one per RejectSend call; nil once empty
	rejectCalls int
	completions []fakeCompletion
}

type fakeCompletion struct {
	id         int64
	completion sendCompletion
}

func (f *fakeLedger) AdmitSend(_ context.Context, _ string) (int64, sendCounts, error) {
	f.admitCalls++
	if f.admitErr != nil {
		return 0, sendCounts{}, f.admitErr
	}
	if f.countErr != nil {
		return f.id, sendCounts{}, f.countErr
	}
	return f.id, f.counts, nil
}

func (f *fakeLedger) RejectSend(_ context.Context, id int64) error {
	f.rejectCalls++
	f.rejected = append(f.rejected, id)
	if len(f.rejectErrs) == 0 {
		return nil
	}
	err := f.rejectErrs[0]
	f.rejectErrs = f.rejectErrs[1:]
	return err
}

// hangingLedger never answers AdmitSend until its context is done, the way a
// stalled database behaves.
type hangingLedger struct {
	fakeLedger
}

func (h *hangingLedger) AdmitSend(ctx context.Context, _ string) (int64, sendCounts, error) {
	h.admitCalls++
	<-ctx.Done()
	return 0, sendCounts{}, ctx.Err()
}

func (f *fakeLedger) CompleteSend(_ context.Context, id int64, c sendCompletion) error {
	f.completions = append(f.completions, fakeCompletion{id: id, completion: c})
	return nil
}

func TestAdmitSendAdmitsWithinLimits(t *testing.T) {
	ledger := &fakeLedger{id: 7, counts: sendCounts{UserMinute: 1, UserDay: 1, UserMonth: 1, GlobalMinute: 1}}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	turn, err := h.admitSend(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("admitSend() error = %v, want nil", err)
	}
	if turn == nil || turn.id != 7 {
		t.Fatalf("turn = %+v, want the admitted row 7", turn)
	}
	if len(ledger.rejected) != 0 {
		t.Fatalf("rejected = %v, want none for an admitted send", ledger.rejected)
	}
}

func TestAdmitSendRefusesOverLimitAndMarksTheRowLimited(t *testing.T) {
	ledger := &fakeLedger{id: 9, counts: sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-time.Second)}}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	turn, err := h.admitSend(context.Background(), "user-1")
	if turn != nil {
		t.Fatalf("turn = %+v, want nil for a refused send", turn)
	}
	if code := connect.CodeOf(err); code != connect.CodeResourceExhausted {
		t.Fatalf("code = %v, want resource_exhausted", code)
	}
	if len(ledger.rejected) != 1 || ledger.rejected[0] != 9 {
		t.Fatalf("rejected = %v, want the refused send's row 9 marked limited", ledger.rejected)
	}
}

func TestAdmitSendFailsOpenWhenTheLedgerCannotInsert(t *testing.T) {
	ledger := &fakeLedger{admitErr: errors.New("connection refused")}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	var turn *sendTurn
	var err error
	logged := captureLogEvent(t, func() {
		turn, err = h.admitSend(context.Background(), "user-1")
	})

	if err != nil {
		t.Fatalf("admitSend() error = %v, want the send admitted (fail open)", err)
	}
	if turn == nil || turn.id != 0 {
		t.Fatalf("turn = %+v, want a no-op turn with id 0", turn)
	}
	if logged["severity"] != "ERROR" || logged["stage"] != "admit" {
		t.Fatalf("log = %v, want an ERROR-severity admit failure", logged)
	}
}

func TestAdmitSendFailsOpenButKeepsTheRowWhenCountingFails(t *testing.T) {
	// The insert committed, so the send is pending and counts. It must still be
	// finished later, or it would stay pending forever.
	ledger := &fakeLedger{id: 11, countErr: errors.New("count timed out")}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	turn, err := captureLogEventResult(t, func() (*sendTurn, error) {
		return h.admitSend(context.Background(), "user-1")
	})
	if err != nil {
		t.Fatalf("admitSend() error = %v, want the send admitted (fail open)", err)
	}
	if turn == nil || turn.id != 11 {
		t.Fatalf("turn = %+v, want the pending row 11 kept so it can be finished", turn)
	}
	if len(ledger.rejected) != 0 {
		t.Fatalf("rejected = %v, want none when counting failed", ledger.rejected)
	}
}

func TestAdmitSendWithoutLedgerAdmitsAndFinishIsANoOp(t *testing.T) {
	h := &ChatServiceHandler{limits: testLimits}

	turn, err := h.admitSend(context.Background(), "user-1")
	if err != nil || turn != nil {
		t.Fatalf("admitSend() = (%v, %v), want (nil, nil) without a ledger", turn, err)
	}
	turn.finish(context.Background(), sendCompletion{Outcome: usageOutcomeOK})
}

func TestSendTurnFinishRecordsTheOutcome(t *testing.T) {
	ledger := &fakeLedger{}
	turn := &sendTurn{ledger: ledger, id: 5}
	tokensIn, tokensOut := int64(120), int64(40)

	turn.finish(context.Background(), sendCompletion{
		Outcome:        usageOutcomeOK,
		ConversationID: "conv-1",
		Model:          "gemini-2.5-flash",
		InputTokens:    &tokensIn,
		OutputTokens:   &tokensOut,
		ToolCalls:      2,
	})

	if len(ledger.completions) != 1 {
		t.Fatalf("completions = %d, want 1", len(ledger.completions))
	}
	got := ledger.completions[0]
	if got.id != 5 || got.completion.Outcome != usageOutcomeOK || got.completion.ToolCalls != 2 {
		t.Fatalf("completion = %+v, want row 5 ok with 2 tool calls", got)
	}
}

func TestSendOutcomeMapsHowTheTurnEnded(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	cases := []struct {
		name         string
		ctx          context.Context
		err          error
		reachedModel bool
		want         string
	}{
		{"completed", context.Background(), nil, true, usageOutcomeOK},
		{"model error after it answered", context.Background(), errors.New("gemini 500"), true, usageOutcomeError},
		{"client left after the model answered", canceled, errors.New("stream closed"), true, usageOutcomeCanceled},
		// A turn that never reached the model is not counted, whatever the cause.
		{"conversation write failed before the model", context.Background(), errors.New("insert failed"), false, usageOutcomeFailedBeforeModel},
		{"provider refused before answering", context.Background(), errors.New("quota"), false, usageOutcomeFailedBeforeModel},
		{"client left before the model answered", canceled, errors.New("stream closed"), false, usageOutcomeFailedBeforeModel},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sendOutcome(tc.ctx, tc.err, tc.reachedModel); got != tc.want {
				t.Fatalf("sendOutcome() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFailedBeforeModelIsNotACountedOutcome(t *testing.T) {
	if strings.Contains(countedOutcomesSQL, usageOutcomeFailedBeforeModel) {
		t.Fatalf("countedOutcomesSQL = %s, must not count %q", countedOutcomesSQL, usageOutcomeFailedBeforeModel)
	}
}

func TestModelAnsweredOnlyForTurnsThatReachedTheProvider(t *testing.T) {
	cause := errors.New("connection refused")
	if modelAnswered(&turnError{ModelReached: false, err: cause}) {
		t.Fatal("a refusal before any response must not read as the model answering")
	}
	if !modelAnswered(&turnError{ModelReached: true, err: cause}) {
		t.Fatal("a failure after a response must read as the model answering")
	}
	if !modelAnswered(fmt.Errorf("wrapped: %w", &turnError{ModelReached: true, err: cause})) {
		t.Fatal("a wrapped turn error must still be recognised")
	}
	if modelAnswered(cause) || modelAnswered(nil) {
		t.Fatal("an error that is not a turn error must not read as the model answering")
	}
}

func TestCompletionTokensAreNullWhenUnreported(t *testing.T) {
	if in, out := completionTokens(TokenUsage{}); in != nil || out != nil {
		t.Fatalf("completionTokens(zero) = (%v, %v), want NULL for both", in, out)
	}
	in, out := completionTokens(TokenUsage{PromptTokens: 300, CandidateTokens: 90})
	if in == nil || *in != 300 || out == nil || *out != 90 {
		t.Fatalf("completionTokens() = (%v, %v), want 300 and 90", in, out)
	}
}

// newWireTestServer serves a ChatServiceHandler over real HTTP, so the refusal
// is checked the way a client sees it: the error and its metadata come back
// through Connect's streaming framing, not through a direct function call.
func newWireTestServer(t *testing.T, handler *ChatServiceHandler) chatv1connect.ChatServiceClient {
	t.Helper()
	mux := http.NewServeMux()
	path, h := chatv1connect.NewChatServiceHandler(handler)
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return chatv1connect.NewChatServiceClient(srv.Client(), srv.URL)
}

func sendOverWire(t *testing.T, client chatv1connect.ChatServiceClient, message string) error {
	t.Helper()
	req := connect.NewRequest(&chatv1.SendMessageRequest{Message: message})
	req.Header().Set("X-User-Id", "user-1")
	stream, err := client.SendMessage(context.Background(), req)
	if err != nil {
		return err
	}
	for stream.Receive() {
	}
	return stream.Err()
}

func TestSendMessageRejectsOversizedMessageBeforeAdmission(t *testing.T) {
	ledger := &fakeLedger{id: 1}
	handler := NewChatServiceHandler(&ConversationStore{}, &LLMClient{model: "m"}, nil)
	handler.ledger = ledger
	client := newWireTestServer(t, handler)

	err := sendOverWire(t, client, strings.Repeat("a", 2001))

	if code := connect.CodeOf(err); code != connect.CodeInvalidArgument {
		t.Fatalf("code = %v, want invalid_argument", code)
	}
	if ledger.admitCalls != 0 {
		t.Fatalf("AdmitSend called %d times for an oversized message, want 0", ledger.admitCalls)
	}
}

func TestSendMessageRefusedOverTheWireCarriesTheLimit(t *testing.T) {
	ledger := &fakeLedger{id: 3, counts: sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-time.Second)}}
	handler := NewChatServiceHandler(&ConversationStore{}, &LLMClient{model: "m"}, nil)
	handler.ledger = ledger
	client := newWireTestServer(t, handler)

	err := sendOverWire(t, client, "hello")

	if code := connect.CodeOf(err); code != connect.CodeResourceExhausted {
		t.Fatalf("code = %v, want resource_exhausted", code)
	}
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		t.Fatalf("error is %T, want *connect.Error", err)
	}
	raw := connectErr.Meta().Get(chatLimitHeader)
	if !strings.Contains(raw, `"kind":"per_minute"`) {
		t.Fatalf("x-chat-limit = %q, want the per_minute kind on the wire", raw)
	}
	if len(ledger.rejected) != 1 || ledger.rejected[0] != 3 {
		t.Fatalf("rejected = %v, want row 3 marked limited", ledger.rejected)
	}
}

func TestSendMessageChecksPersistenceBeforeAdmission(t *testing.T) {
	// Without persistence no send can complete, so the refusal happens before
	// a row is written for it.
	ledger := &fakeLedger{id: 1}
	handler := NewChatServiceHandler(nil, &LLMClient{model: "m"}, nil)
	handler.ledger = ledger
	client := newWireTestServer(t, handler)

	err := sendOverWire(t, client, "hello")

	if code := connect.CodeOf(err); code != connect.CodeFailedPrecondition {
		t.Fatalf("code = %v, want failed_precondition", code)
	}
	if ledger.admitCalls != 0 {
		t.Fatalf("AdmitSend called %d times, want 0", ledger.admitCalls)
	}
}

// captureLogEventResult runs fn while capturing the single structured log line
// it writes, and returns fn's results.
func captureLogEventResult(t *testing.T, fn func() (*sendTurn, error)) (*sendTurn, error) {
	t.Helper()
	var turn *sendTurn
	var err error
	captureLogEvent(t, func() {
		turn, err = fn()
	})
	return turn, err
}

func TestAdmitSendFailsOpenWhenTheLedgerStallsPastTheDeadline(t *testing.T) {
	// A stalled ledger must not hold the send. The deadline is what bounds it, so
	// the test shortens it rather than waiting for the production two seconds.
	ledger := &hangingLedger{}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits, admitTimeout: 20 * time.Millisecond}

	var turn *sendTurn
	var err error
	started := time.Now()
	logged := captureLogEvent(t, func() {
		turn, err = h.admitSend(context.Background(), "user-1")
	})

	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("admitSend() took %s, want it bounded by its deadline", elapsed)
	}
	if err != nil {
		t.Fatalf("admitSend() error = %v, want the send admitted (fail open)", err)
	}
	if turn == nil || turn.id != 0 {
		t.Fatalf("turn = %+v, want a no-op turn with id 0", turn)
	}
	if logged["severity"] != "ERROR" || logged["stage"] != "admit" || logged["timed_out"] != true {
		t.Fatalf("log = %v, want an ERROR-severity admit timeout", logged)
	}
}

func TestAdmissionUsesTheProductionDeadlineByDefault(t *testing.T) {
	h := &ChatServiceHandler{}
	if got := h.admitBudget(); got != 2*time.Second {
		t.Fatalf("admitBudget() = %s, want 2s", got)
	}
	configured := NewChatServiceHandler(nil, nil, nil)
	if configured.admitTimeout != 2*time.Second {
		t.Fatalf("NewChatServiceHandler admitTimeout = %s, want 2s", configured.admitTimeout)
	}
}

func TestRejectSendIsRetriedOnceAndThenSucceeds(t *testing.T) {
	// A transient failure on the first attempt must not leave the refused send
	// pending, which would count it against the user.
	ledger := &fakeLedger{id: 9, counts: sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-time.Second)}}
	ledger.rejectErrs = []error{errors.New("connection reset")}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	_, err := h.admitSend(context.Background(), "user-1")

	if code := connect.CodeOf(err); code != connect.CodeResourceExhausted {
		t.Fatalf("code = %v, want resource_exhausted", code)
	}
	if ledger.rejectCalls != 2 {
		t.Fatalf("RejectSend called %d times, want 2 (one retry)", ledger.rejectCalls)
	}
}

func TestRejectSendFailingTwiceIsLoggedOnce(t *testing.T) {
	ledger := &fakeLedger{id: 9, counts: sendCounts{UserMinute: 5, OldestUserMinute: testNow.Add(-time.Second)}}
	ledger.rejectErrs = []error{errors.New("first"), errors.New("second")}
	h := &ChatServiceHandler{ledger: ledger, limits: testLimits}

	lines := captureLogLines(t, func() {
		_, _ = h.admitSend(context.Background(), "user-1")
	})

	if ledger.rejectCalls != 2 {
		t.Fatalf("RejectSend called %d times, want exactly 2 attempts", ledger.rejectCalls)
	}
	var failures []map[string]any
	for _, line := range lines {
		if line["type"] == "chat_limit_error" {
			failures = append(failures, line)
		}
	}
	if len(failures) != 1 || failures[0]["stage"] != "reject" || failures[0]["severity"] != "ERROR" {
		t.Fatalf("limit failures = %v, want one ERROR-severity reject failure", failures)
	}
}

// captureLogLines runs fn and returns every structured log line it wrote. The
// refusal path also writes a product event, so a test that needs one specific
// line cannot use captureLogEvent, which insists on exactly one.
func captureLogLines(t *testing.T, fn func()) []map[string]any {
	t.Helper()
	var buf bytes.Buffer
	oldOutput := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	defer func() {
		log.SetOutput(oldOutput)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	}()

	fn()

	var lines []map[string]any
	for raw := range strings.SplitSeq(strings.TrimSpace(buf.String()), "\n") {
		if raw == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			t.Fatalf("log line is not JSON: %q: %v", raw, err)
		}
		lines = append(lines, event)
	}
	return lines
}

// The ledger takes the model that answered. A failed attempt's model is not the
// answering one, so a send that was answered by the fallback names the fallback.
func TestLedgerNamesTheModelThatAnswered(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	recordTurnOnLedger(&c, &LLMResponse{Model: "m-fallback"}, nil)
	if c.Model != "m-fallback" {
		t.Fatalf("ledger model = %q, want the answering model %q", c.Model, "m-fallback")
	}
}

// A turn that answers with no route name keeps the model the send started with.
func TestLedgerKeepsTheStartingModelWhenNoRouteAnswered(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	recordTurnOnLedger(&c, &LLMResponse{}, nil)
	if c.Model != "m-primary" {
		t.Fatalf("ledger model = %q, want the starting model kept", c.Model)
	}
}

// A failed turn keeps the tokens of the calls that reached the model, so the
// ledger counts what was billed rather than a send that looks free.
func TestLedgerKeepsTheBilledTokensOfAFailedTurn(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	err := &turnError{ModelReached: true, err: errors.New("refused"), Billed: turnTally{usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3}, calls: 1}}
	recordTurnOnLedger(&c, nil, err)
	if c.InputTokens == nil || *c.InputTokens != 7 || c.OutputTokens == nil || *c.OutputTokens != 3 {
		t.Fatalf("ledger tokens = %v/%v, want the billed 7/3", c.InputTokens, c.OutputTokens)
	}
	if c.Model != "m-primary" {
		t.Fatalf("ledger model = %q, want the starting model on a failed turn", c.Model)
	}
}

// An unreported count is stored as NULL, never as zero.
func TestLedgerStoresAnUnreportedCountAsNull(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	recordTurnOnLedger(&c, &LLMResponse{}, nil)
	if c.InputTokens != nil || c.OutputTokens != nil {
		t.Fatalf("ledger tokens = %v/%v, want NULL for an unreported turn", c.InputTokens, c.OutputTokens)
	}
}

// A failed turn with nothing billed has no tokens to record either.
func TestLedgerRecordsNoTokensForAFailedTurnThatBilledNothing(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	recordTurnOnLedger(&c, nil, &turnError{ModelReached: false, err: errors.New("refused before the model")})
	if c.InputTokens != nil || c.OutputTokens != nil {
		t.Fatalf("ledger tokens = %v/%v, want NULL", c.InputTokens, c.OutputTokens)
	}
}

// The ledger counts the tool calls of an answered turn.
func TestLedgerCountsTheToolCallsOfAnAnsweredTurn(t *testing.T) {
	c := sendCompletion{Model: "m-primary"}
	recordTurnOnLedger(&c, &LLMResponse{ToolCalls: []ToolCallRecord{{}, {}}, Usage: TokenUsage{PromptTokens: 9, CandidateTokens: 4}}, nil)
	if c.ToolCalls != 2 {
		t.Fatalf("ledger tool calls = %d, want 2", c.ToolCalls)
	}
	if c.InputTokens == nil || *c.InputTokens != 9 || c.OutputTokens == nil || *c.OutputTokens != 4 {
		t.Fatalf("ledger tokens = %v/%v, want 9/4", c.InputTokens, c.OutputTokens)
	}
}
