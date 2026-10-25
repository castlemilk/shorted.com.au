package main

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"fmt"
	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
)

// TestUsageLedgerAgainstPostgres runs the ledger SQL against a real database,
// which the unit tests cannot do. It is skipped unless
// CHAT_LIMITS_TEST_DATABASE_URL is set. The database needs migration 000145
// and the chat tables from 000026. The test writes rows only for fresh user
// ids, and removes them afterwards.
func TestUsageLedgerAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	user := "ledger-test-" + uuid.NewString()
	other := "ledger-test-other-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = ANY($1)`, []string{user, other})
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})

	// Sends made by the caller so far: the first admission is its own row.
	id1, c1, err := store.AdmitSend(ctx, user)
	if err != nil {
		t.Fatalf("AdmitSend(1) error = %v", err)
	}
	if id1 == 0 || c1.UserMinute != 1 || c1.UserDay != 1 || c1.UserMonth != 1 {
		t.Fatalf("AdmitSend(1) = id %d, counts %+v, want id > 0 and every user window at 1", id1, c1)
	}

	// Historical rows, written directly so their ages are exact.
	insertUsage := func(userID, outcome string, age time.Duration) {
		t.Helper()
		if _, err := pool.Exec(ctx,
			`INSERT INTO chat_usage_events (user_id, outcome, created_at) VALUES ($1, $2, now() - make_interval(secs => $3))`,
			userID, outcome, age.Seconds(),
		); err != nil {
			t.Fatalf("insert %s row (%s old): %v", outcome, age, err)
		}
	}
	insertUsage(user, usageOutcomeOK, 2*time.Minute)   // in the day and month windows, not the minute
	insertUsage(user, usageOutcomeOK, 48*time.Hour)    // in the month window only
	insertUsage(user, usageOutcomeOK, 40*24*time.Hour) // outside every window
	insertUsage(user, usageOutcomeLimited, 0)          // refused sends never count
	insertUsage(other, usageOutcomePending, 0)         // another user, counted globally only

	id2, c2, err := store.AdmitSend(ctx, user)
	if err != nil {
		t.Fatalf("AdmitSend(2) error = %v", err)
	}
	// Minute: the first admission and this one. Day: those plus the two-minute-old
	// send. Month: those plus the two-day-old send. The forty-day and limited rows
	// are excluded from every window.
	if c2.UserMinute != 2 || c2.UserDay != 3 || c2.UserMonth != 4 {
		t.Fatalf("AdmitSend(2) user counts = %d/%d/%d, want 2/3/4", c2.UserMinute, c2.UserDay, c2.UserMonth)
	}
	if c2.GlobalMinute < 3 {
		t.Fatalf("GlobalMinute = %d, want at least the caller's two sends and the other user's pending send", c2.GlobalMinute)
	}

	// The oldest counted send in each window fixes its reset time.
	if age := time.Since(c2.OldestUserDay); age < 90*time.Second || age > 150*time.Second {
		t.Fatalf("OldestUserDay is %s old, want about two minutes", age)
	}
	if age := time.Since(c2.OldestUserMonth); age < 47*time.Hour || age > 49*time.Hour {
		t.Fatalf("OldestUserMonth is %s old, want about two days", age)
	}

	// A refused send stops counting for everyone after it.
	if err := store.RejectSend(ctx, id2); err != nil {
		t.Fatalf("RejectSend() error = %v", err)
	}
	_, c3, err := store.AdmitSend(ctx, user)
	if err != nil {
		t.Fatalf("AdmitSend(3) error = %v", err)
	}
	if c3.UserMinute != 2 {
		t.Fatalf("after rejecting send 2, UserMinute = %d, want 2 (the first send and this one)", c3.UserMinute)
	}

	// A completed send records its outcome, tokens and conversation.
	conversationID := uuid.NewString()
	tokensIn, tokensOut := int64(300), int64(45)
	if err := store.CompleteSend(ctx, id1, sendCompletion{
		Outcome:        usageOutcomeOK,
		ConversationID: conversationID,
		Model:          "gemini-2.5-flash",
		InputTokens:    &tokensIn,
		OutputTokens:   &tokensOut,
		ToolCalls:      3,
	}); err != nil {
		t.Fatalf("CompleteSend() error = %v", err)
	}
	var outcome, model string
	var gotConversation string
	var gotIn, gotOut int64
	var toolCalls int
	if err := pool.QueryRow(ctx,
		`SELECT outcome, conversation_id::text, input_tokens, output_tokens, tool_calls, model
		 FROM chat_usage_events WHERE id = $1`, id1,
	).Scan(&outcome, &gotConversation, &gotIn, &gotOut, &toolCalls, &model); err != nil {
		t.Fatalf("read completed row: %v", err)
	}
	if outcome != usageOutcomeOK || gotConversation != conversationID ||
		gotIn != 300 || gotOut != 45 || toolCalls != 3 || model != "gemini-2.5-flash" {
		t.Fatalf("completed row = %s/%s/%d/%d/%d/%s, want ok, the conversation, 300/45, 3 calls, model",
			outcome, gotConversation, gotIn, gotOut, toolCalls, model)
	}

	// A send with no reported usage leaves the token columns NULL, not zero.
	if err := store.CompleteSend(ctx, id1, sendCompletion{Outcome: usageOutcomeCanceled}); err != nil {
		t.Fatalf("CompleteSend(canceled) error = %v", err)
	}
	var nullIn *int64
	if err := pool.QueryRow(ctx, `SELECT input_tokens FROM chat_usage_events WHERE id = $1`, id1).Scan(&nullIn); err != nil {
		t.Fatalf("read input_tokens: %v", err)
	}
	if nullIn != nil {
		t.Fatalf("input_tokens = %d, want NULL when the provider reported none", *nullIn)
	}
}

// TestKeepPartialReplyStoresWhatWasStreamed checks the reload path: a turn that
// ended early leaves its streamed text in the conversation.
func TestKeepPartialReplyStoresWhatWasStreamed(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	user := "partial-test-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})

	conv, err := store.CreateConversation(ctx, user, "partial", "")
	if err != nil {
		t.Fatalf("CreateConversation() error = %v", err)
	}

	handler := &ChatServiceHandler{store: store, maxMessagesPerConv: 100}
	handler.keepPartialReply(ctx, conv.ID, "Here is the first part of the answer")

	messages, err := store.GetMessages(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("GetMessages() error = %v", err)
	}
	if len(messages) != 1 || messages[0].Role != "assistant" || messages[0].Content != "Here is the first part of the answer" {
		t.Fatalf("messages = %+v, want the one streamed assistant part", messages)
	}
}

// TestParallelSendsCannotExceedTheMinuteLimit is the reason pending rows exist.
// Twenty sends admitted at once must not all see an empty window: each one's
// count runs after its own insert, so the last admitted send sees every other.
// Refusing some of the burst is fine; admitting more than the limit is not.
func TestParallelSendsCannotExceedTheMinuteLimit(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	user := "parallel-test-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = $1`, user)
	})

	const limit = 4
	limits := chatSendLimits{PerMinute: limit, PerDay: 1000, PerMonth: 1000, GlobalPerMinute: 1000}

	var admitted atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 20 {
		wg.Go(func() {
			<-start
			id, counts, err := store.AdmitSend(ctx, user)
			if err != nil {
				t.Errorf("AdmitSend() error = %v", err)
				return
			}
			if _, over := evaluateSendLimits(counts, limits, time.Now()); over {
				if err := store.RejectSend(ctx, id); err != nil {
					t.Errorf("RejectSend() error = %v", err)
				}
				return
			}
			admitted.Add(1)
		})
	}
	close(start)
	wg.Wait()

	if n := admitted.Load(); n > limit {
		t.Fatalf("admitted %d parallel sends, want at most %d", n, limit)
	}
}

// TestPreModelFailureIsNotCounted runs a real send that fails in the conversation
// write, before the model. The context stock code is longer than its column, so
// CreateConversation fails in the database. The send must be recorded as failed
// before the model, and must not count against the caller's limits afterwards.
func TestPreModelFailureIsNotCounted(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	user := "pre-model-test-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = $1`, user)
	})

	// The model is never reached, so the client's SDK handle is never used.
	handler := NewChatServiceHandler(store, &LLMClient{model: "gemini-test"}, nil)
	client := newWireTestServer(t, handler)

	req := connect.NewRequest(&chatv1.SendMessageRequest{
		Message:          "what is short interest in ZIP?",
		ContextStockCode: "THIS-CODE-IS-TOO-LONG", // > VARCHAR(10): the conversation insert fails
	})
	req.Header().Set("X-User-Id", user)
	stream, err := client.SendMessage(ctx, req)
	if err != nil {
		t.Fatalf("SendMessage() error = %v", err)
	}
	for stream.Receive() {
	}
	if stream.Err() == nil {
		t.Fatal("SendMessage() succeeded, want the conversation write to fail")
	}

	var outcome string
	if err := pool.QueryRow(ctx,
		`SELECT outcome FROM chat_usage_events WHERE user_id = $1`, user,
	).Scan(&outcome); err != nil {
		t.Fatalf("read the send's row: %v", err)
	}
	if outcome != usageOutcomeFailedBeforeModel {
		t.Fatalf("outcome = %q, want %q", outcome, usageOutcomeFailedBeforeModel)
	}

	// The failed send must not count: the next admission sees only itself.
	_, counts, err := store.AdmitSend(ctx, user)
	if err != nil {
		t.Fatalf("AdmitSend() error = %v", err)
	}
	if counts.UserMinute != 1 {
		t.Fatalf("UserMinute = %d after a failed-before-model send, want 1 (the new send only)", counts.UserMinute)
	}
}

// TestRefusedBeforeAnswerIsNotCounted runs a real send through a real Gemini
// client whose endpoint refuses connections, so the provider never answers. The
// send must be recorded as failed before the model, and must not count.
func TestRefusedBeforeAnswerIsNotCounted(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	// Port 1 refuses connections, so the first request fails before any response.
	provider, err := newGeminiProviderAt(ctx, "test-key", "http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}

	user := "refused-test-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = $1`, user)
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})

	handler := NewChatServiceHandler(store, newLLMClient(provider, "gemini-test", 0, nil), nil)
	client := newWireTestServer(t, handler)

	req := connect.NewRequest(&chatv1.SendMessageRequest{Message: "hello"})
	req.Header().Set("X-User-Id", user)
	stream, err := client.SendMessage(ctx, req)
	if err != nil {
		t.Fatalf("SendMessage() error = %v", err)
	}
	for stream.Receive() {
	}
	if stream.Err() == nil {
		t.Fatal("SendMessage() succeeded, want the provider to refuse")
	}

	var outcome string
	if err := pool.QueryRow(ctx,
		`SELECT outcome FROM chat_usage_events WHERE user_id = $1`, user,
	).Scan(&outcome); err != nil {
		t.Fatalf("read the send's row: %v", err)
	}
	if outcome != usageOutcomeFailedBeforeModel {
		t.Fatalf("outcome = %q, want %q", outcome, usageOutcomeFailedBeforeModel)
	}
	_, counts, err := store.AdmitSend(ctx, user)
	if err != nil {
		t.Fatalf("AdmitSend() error = %v", err)
	}
	if counts.UserMinute != 1 {
		t.Fatalf("UserMinute = %d after a refused send, want 1 (the new send only)", counts.UserMinute)
	}
}

// A send whose primary attempt was billed before the fallback answered is ledgered
// against the route that answered: the model is the fallback's, and the tokens are
// the billed call plus the answer. The test is skipped unless
// CHAT_LIMITS_TEST_DATABASE_URL is set, and it removes its own rows.
func TestFallbackSendIsLedgeredAgainstTheModelThatAnswered(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	// The primary's first call is billed, then its tool round is refused before any text.
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3}},
		{err: failedCall(false, true, 429)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}},
		{texts: []string{"ok"}, usage: TokenUsage{PromptTokens: 10, CandidateTokens: 2, TotalTokens: 12}},
	})}
	r, _ := routerFor(primary, fallback, 0)

	user := fmt.Sprintf("ledger-fallback-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = $1`, user)
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})
	client := newWireTestServer(t, NewChatServiceHandler(store, r, nil))

	req := connect.NewRequest(&chatv1.SendMessageRequest{Message: "hello"})
	req.Header().Set("X-User-Id", user)
	stream, err := client.SendMessage(ctx, req)
	if err != nil {
		t.Fatalf("SendMessage() error = %v", err)
	}
	for stream.Receive() {
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("SendMessage() stream error = %v, want the fallback's answer", err)
	}

	var model string
	var in, out *int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(model,''), input_tokens, output_tokens FROM chat_usage_events WHERE user_id = $1`, user).Scan(&model, &in, &out); err != nil {
		t.Fatalf("read the send's row: %v", err)
	}
	if model != "m-fallback" {
		t.Fatalf("chat_usage_events.model = %q, want %q (the route that answered)", model, "m-fallback")
	}
	if in == nil || *in != 17 || out == nil || *out != 5 {
		t.Fatalf("chat_usage_events tokens = %v/%v, want 17/5: the billed primary call plus the fallback's answer", in, out)
	}
}

// A send whose calls were billed and whose turn then failed keeps those tokens in
// the ledger, and its outcome counts against the limits. The primary's first call
// was answered, its tool round was refused, and the fallback was refused too.
func TestFailedSendKeepsItsBilledTokensInTheLedger(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the ledger against Postgres")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)

	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3}},
		{err: failedCall(false, true, 429)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always([]fakeReply{{err: failedCall(false, false, 402)}})}
	r, _ := routerFor(primary, fallback, 0)

	user := fmt.Sprintf("ledger-billed-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_usage_events WHERE user_id = $1`, user)
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})
	client := newWireTestServer(t, NewChatServiceHandler(store, r, nil))

	req := connect.NewRequest(&chatv1.SendMessageRequest{Message: "hello"})
	req.Header().Set("X-User-Id", user)
	stream, err := client.SendMessage(ctx, req)
	if err != nil {
		t.Fatalf("SendMessage() error = %v", err)
	}
	for stream.Receive() {
	}
	if stream.Err() == nil {
		t.Fatal("SendMessage() succeeded, want the turn to fail")
	}

	var outcome string
	var in, out *int64
	if err := pool.QueryRow(ctx, `SELECT outcome, input_tokens, output_tokens FROM chat_usage_events WHERE user_id = $1`, user).Scan(&outcome, &in, &out); err != nil {
		t.Fatalf("read the send's row: %v", err)
	}
	if outcome != usageOutcomeError {
		t.Fatalf("outcome = %q, want %q: the model answered the first call, so the send counts", outcome, usageOutcomeError)
	}
	if in == nil || *in != 7 || out == nil || *out != 3 {
		t.Fatalf("tokens = %v/%v, want the billed first call's 7/3", in, out)
	}
}
