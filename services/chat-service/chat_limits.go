package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"connectrpc.com/connect"
)

// chatSendLimits are the ceilings one send is admitted against. The per-user
// windows are rolling: a send counts for its full window from the moment it
// starts, so waiting for a calendar boundary does not reset anything.
type chatSendLimits struct {
	PerMinute       int
	PerDay          int
	PerMonth        int
	GlobalPerMinute int
}

// Limit kinds. These are the vocabulary the x-chat-limit header and the web
// app's product events share, so they are a contract, not labels.
const (
	limitKindPerMinute = "per_minute"
	limitKindDaily     = "daily"
	limitKindMonthly   = "monthly"
	limitKindGlobal    = "global"
)

// Windows. The SQL intervals are built from these, so the counts and the
// reset times cannot disagree about how long a window is.
const (
	minuteWindow = time.Minute
	dayWindow    = 24 * time.Hour
	monthWindow  = 30 * 24 * time.Hour
)

// Ledger outcomes. A send is pending while its turn runs, then ends ok, error
// or canceled once the model has answered. A send the limiter refused is
// limited, and a turn that failed before the model answered is
// failed_before_model. Neither counts.
const (
	usageOutcomePending  = "pending"
	usageOutcomeOK       = "ok"
	usageOutcomeError    = "error"
	usageOutcomeCanceled = "canceled"
	usageOutcomeLimited  = "limited"
	// usageOutcomeFailedBeforeModel is a turn that failed before the provider
	// answered. Nothing was billed, so it does not count against the limits.
	usageOutcomeFailedBeforeModel = "failed_before_model"
)

// countedOutcomesSQL lists the outcomes that count against every window: the
// sends that are running or reached the model. It must match the four
// outcomes above, which TestCountedOutcomesMatchConstants checks. Refused and
// failed-before-model rows are deliberately absent.
const countedOutcomesSQL = "('pending', 'ok', 'error', 'canceled')"

// chatLimitHeader carries the machine-readable limit on a ResourceExhausted
// error. It travels as the error's metadata, which Connect sends as trailers on
// a server stream, so the web app reads it from the error it receives.
const chatLimitHeader = "x-chat-limit"

// usageWriteTimeout bounds the ledger writes that finish a send. They run after
// the request context may already be canceled, which is when they matter most,
// so they get their own deadline instead of none.
const usageWriteTimeout = 5 * time.Second

// chatAdmitTimeout bounds admission: the pending insert and the count that checks
// a send against the limits. Without it a slow ledger would hold every send for
// as long as the request lasts. Past this the send is admitted, and the timeout
// is logged at error severity, as any other ledger failure is.
const chatAdmitTimeout = 2 * time.Second

// rejectAttempts is how many times a refused send's row is marked limited. A row
// that stays pending keeps counting against its user until its window passes, so
// one transient failure is worth a retry.
const rejectAttempts = 2

// sendCountsSQL counts sends in one statement, FILTERed per window. The WHERE
// clause limits the scan to the caller's last 30 days plus everyone's last
// minute, which are the two indexes on chat_usage_events. Only counted
// outcomes are read, so a 'limited' row never counts.
var sendCountsSQL = fmt.Sprintf(`
SELECT
    COUNT(*) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[1]d seconds'),
    COUNT(*) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[2]d seconds'),
    COUNT(*) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[3]d seconds'),
    COUNT(*) FILTER (WHERE created_at > now() - interval '%[1]d seconds'),
    MIN(created_at) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[1]d seconds'),
    MIN(created_at) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[2]d seconds'),
    MIN(created_at) FILTER (WHERE user_id = $1 AND created_at > now() - interval '%[3]d seconds'),
    MIN(created_at) FILTER (WHERE created_at > now() - interval '%[1]d seconds')
FROM chat_usage_events
WHERE outcome IN %[4]s
  AND ((user_id = $1 AND created_at > now() - interval '%[3]d seconds')
       OR created_at > now() - interval '%[1]d seconds')`,
	int(minuteWindow.Seconds()),
	int(dayWindow.Seconds()),
	int(monthWindow.Seconds()),
	countedOutcomesSQL,
)

// sendCounts is one admission's view of the ledger. Every count includes the
// send being decided: its pending row was inserted before the count ran. That
// is what makes parallel sends safe. Each admitted send's count runs after its
// own insert, so the last admitted send sees every other admitted send, and no
// window can admit more than its limit.
type sendCounts struct {
	UserMinute, UserDay, UserMonth, GlobalMinute int64

	// The oldest counted send in each window. Its expiry is when that window
	// first has room again.
	OldestUserMinute, OldestUserDay, OldestUserMonth, OldestGlobalMinute time.Time
}

// limitExceeded names the window that refused a send.
type limitExceeded struct {
	Kind              string
	Limit             int
	RetryAfterSeconds int
	ResetAt           time.Time
}

// evaluateSendLimits reports the first window the send is over, or false when
// it is within every limit. The per-user windows are checked before the global
// one, so a caller at their own cap is told about their own limit, and the
// global ceiling only ever explains a refusal of a caller who is under theirs.
func evaluateSendLimits(c sendCounts, l chatSendLimits, now time.Time) (limitExceeded, bool) {
	windows := []struct {
		kind   string
		count  int64
		limit  int
		window time.Duration
		oldest time.Time
	}{
		{limitKindPerMinute, c.UserMinute, l.PerMinute, minuteWindow, c.OldestUserMinute},
		{limitKindDaily, c.UserDay, l.PerDay, dayWindow, c.OldestUserDay},
		{limitKindMonthly, c.UserMonth, l.PerMonth, monthWindow, c.OldestUserMonth},
		{limitKindGlobal, c.GlobalMinute, l.GlobalPerMinute, minuteWindow, c.OldestGlobalMinute},
	}
	for _, w := range windows {
		// Counts include the send being decided, so it is over when the count
		// is above its limit.
		if w.count <= int64(w.limit) {
			continue
		}
		reset := now.Add(w.window)
		if !w.oldest.IsZero() {
			reset = w.oldest.Add(w.window)
		}
		// Round up, so a client that waits exactly this long is never told to
		// retry while the window is still full. Reset and retry are derived
		// from the same number so they cannot disagree.
		retry := max(int(math.Ceil(reset.Sub(now).Seconds())), 1)
		return limitExceeded{
			Kind:              w.kind,
			Limit:             w.limit,
			RetryAfterSeconds: retry,
			ResetAt:           now.Add(time.Duration(retry) * time.Second),
		}, true
	}
	return limitExceeded{}, false
}

// message is the sentence a direct caller of the service sees. The web app
// composes its own copy from the same fields, so this is for logs and for
// clients that do not read the header.
func (e limitExceeded) message() string {
	wait := humanizeWait(e.RetryAfterSeconds)
	switch e.Kind {
	case limitKindPerMinute:
		return fmt.Sprintf("You can send %d messages per minute. Try again in %s.", e.Limit, wait)
	case limitKindDaily:
		return fmt.Sprintf("You have reached the limit of %d messages in 24 hours. Try again in %s.", e.Limit, wait)
	case limitKindMonthly:
		return fmt.Sprintf("You have reached the limit of %d messages in 30 days. Try again in %s.", e.Limit, wait)
	default:
		return fmt.Sprintf("Shorted AI is busy right now. Try again in %s.", wait)
	}
}

func humanizeWait(seconds int) string {
	switch {
	case seconds < 90:
		return fmt.Sprintf("%d seconds", seconds)
	case seconds < 90*60:
		return fmt.Sprintf("%d minutes", (seconds+59)/60)
	default:
		return fmt.Sprintf("%d hours", (seconds+3599)/3600)
	}
}

// limitDetail is the x-chat-limit payload. Its field names are a contract with
// web/src/@/lib/chat-server-guards.ts: renaming one stops the web app from
// recognising the limit it was refused by.
type limitDetail struct {
	Kind              string `json:"kind"`
	Limit             int    `json:"limit"`
	RetryAfterSeconds int    `json:"retry_after_seconds"`
	ResetAt           int64  `json:"reset_at"`
}

// limitExceededError is the refusal a client receives: ResourceExhausted, with
// the limit in metadata for machines and a sentence for people.
func limitExceededError(e limitExceeded) error {
	err := connect.NewError(connect.CodeResourceExhausted, errors.New(e.message()))
	detail, _ := json.Marshal(limitDetail{
		Kind:              e.Kind,
		Limit:             e.Limit,
		RetryAfterSeconds: e.RetryAfterSeconds,
		ResetAt:           e.ResetAt.Unix(),
	})
	err.Meta().Set(chatLimitHeader, string(detail))
	return err
}

// usageLedger is the persistence the limiter needs. ConversationStore implements
// it on chat_usage_events; the tests use a fake.
type usageLedger interface {
	// AdmitSend inserts a pending row for a send about to reach the model, then
	// counts. The id is non-zero whenever the row was written, even when the
	// count then fails, so the send can still be finished or rejected.
	AdmitSend(ctx context.Context, userID string) (int64, sendCounts, error)
	// RejectSend marks an admitted send limited, so no window counts it.
	RejectSend(ctx context.Context, id int64) error
	// CompleteSend records how an admitted send ended.
	CompleteSend(ctx context.Context, id int64, completion sendCompletion) error
}

// sendCompletion is what a finished send records.
type sendCompletion struct {
	Outcome        string
	ConversationID string // empty when the send never reached a conversation
	Model          string
	InputTokens    *int64 // nil when the provider reported no usage
	OutputTokens   *int64
	ToolCalls      int
}

// completionTokens converts provider usage into the ledger's nullable counts.
// An unreported count is stored as NULL, never as zero.
func completionTokens(usage TokenUsage) (*int64, *int64) {
	if !usage.hasTokens() {
		return nil, nil
	}
	in := usage.PromptTokens
	out := usage.CandidateTokens
	return &in, &out
}

// recordTurnOnLedger fills the ledger's completion from a turn's result. A failed
// turn still bills the calls that reached the model, so their tokens are kept.
// The ledger names the route that answered: a failed attempt is billed, but it
// did not answer, so its model does not replace the answering one.
func recordTurnOnLedger(c *sendCompletion, resp *LLMResponse, err error) {
	if err != nil {
		c.InputTokens, c.OutputTokens = completionTokens(billedBy(err).usage)
		return
	}
	if resp.Model != "" {
		c.Model = resp.Model
	}
	c.InputTokens, c.OutputTokens = completionTokens(resp.Usage)
	c.ToolCalls = len(resp.ToolCalls)
}

// sendOutcome maps how a send's turn ended onto a ledger outcome. A turn that
// never reached the model is not counted: a failure in the conversation writes,
// or a request the provider refused before answering, costs nothing to count
// as free. Once the model has answered, the send is counted whatever happens
// after it.
func sendOutcome(ctx context.Context, err error, reachedModel bool) string {
	switch {
	case err == nil:
		return usageOutcomeOK
	case !reachedModel:
		return usageOutcomeFailedBeforeModel
	case errors.Is(ctx.Err(), context.Canceled):
		return usageOutcomeCanceled
	default:
		return usageOutcomeError
	}
}

// sendTurn is one admitted send. Finishing it goes through here, so a pending
// row never outlives its turn unrecorded.
type sendTurn struct {
	ledger usageLedger
	id     int64
}

// finish records the send's outcome. It is safe on a nil turn, which is what a
// handler without a ledger holds.
func (t *sendTurn) finish(ctx context.Context, completion sendCompletion) {
	if t == nil || t.ledger == nil || t.id == 0 {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), usageWriteTimeout)
	defer cancel()
	if err := t.ledger.CompleteSend(writeCtx, t.id, completion); err != nil {
		logLimitFailure("complete", err)
	}
}

// admitSend counts this send against the limits and reserves its place in the
// ledger. It returns the turn to finish once the send is admitted, or a
// ResourceExhausted error naming the window that refused it.
//
// A ledger failure never refuses a send. The limits are a cost control, not a
// gate for paying users: when Postgres cannot count, the send is admitted and
// the failure is logged at error severity, and the web buckets remain the first
// line.
func (h *ChatServiceHandler) admitSend(ctx context.Context, userID string) (*sendTurn, error) {
	if h.ledger == nil {
		return nil, nil
	}
	admitCtx, cancelAdmit := context.WithTimeout(ctx, h.admitBudget())
	id, counts, err := h.ledger.AdmitSend(admitCtx, userID)
	cancelAdmit()
	turn := &sendTurn{ledger: h.ledger, id: id}
	if err != nil {
		logLimitFailure("admit", err)
		return turn, nil
	}

	exceeded, over := evaluateSendLimits(counts, h.limits, time.Now())
	if !over {
		return turn, nil
	}

	rejectCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), usageWriteTimeout)
	defer cancel()
	var rejectErr error
	for range rejectAttempts {
		if rejectErr = h.ledger.RejectSend(rejectCtx, id); rejectErr == nil {
			break
		}
	}
	if rejectErr != nil {
		logLimitFailure("reject", rejectErr)
	}
	recordChatExperienceEvent("send_message", "rate_limited", exceeded.Kind)
	return nil, limitExceededError(exceeded)
}

// admitBudget is the admission deadline, falling back to the production default
// for a handler built without one.
func (h *ChatServiceHandler) admitBudget() time.Duration {
	if h.admitTimeout > 0 {
		return h.admitTimeout
	}
	return chatAdmitTimeout
}

// logLimitFailure records a ledger failure at error severity. The line is
// structured so it can be alerted on, and it still names the failure in text.
func logLimitFailure(stage string, err error) {
	log.Printf("%s", mustMarshalLogEvent(map[string]any{
		"type":      "chat_limit_error",
		"severity":  "ERROR",
		"stage":     stage,
		"error":     err.Error(),
		"timed_out": errors.Is(err, context.DeadlineExceeded),
	}))
}

// AdmitSend implements usageLedger. The insert commits on its own before the
// count runs, so the count sees this send and every send written before it.
func (s *ConversationStore) AdmitSend(ctx context.Context, userID string) (int64, sendCounts, error) {
	var id int64
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO chat_usage_events (user_id, outcome) VALUES ($1, $2) RETURNING id`,
		userID, usageOutcomePending,
	).Scan(&id); err != nil {
		return 0, sendCounts{}, fmt.Errorf("insert pending send: %w", err)
	}

	var counts sendCounts
	var oldestUserMinute, oldestUserDay, oldestUserMonth, oldestGlobalMinute *time.Time
	if err := s.pool.QueryRow(ctx, sendCountsSQL, userID).Scan(
		&counts.UserMinute, &counts.UserDay, &counts.UserMonth, &counts.GlobalMinute,
		&oldestUserMinute, &oldestUserDay, &oldestUserMonth, &oldestGlobalMinute,
	); err != nil {
		return id, sendCounts{}, fmt.Errorf("count sends: %w", err)
	}
	counts.OldestUserMinute = timeOrZero(oldestUserMinute)
	counts.OldestUserDay = timeOrZero(oldestUserDay)
	counts.OldestUserMonth = timeOrZero(oldestUserMonth)
	counts.OldestGlobalMinute = timeOrZero(oldestGlobalMinute)
	return id, counts, nil
}

// RejectSend implements usageLedger.
func (s *ConversationStore) RejectSend(ctx context.Context, id int64) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE chat_usage_events SET outcome = $2 WHERE id = $1`,
		id, usageOutcomeLimited,
	); err != nil {
		return fmt.Errorf("reject send: %w", err)
	}
	return nil
}

// CompleteSend implements usageLedger.
func (s *ConversationStore) CompleteSend(ctx context.Context, id int64, c sendCompletion) error {
	var conversationID *string
	if c.ConversationID != "" {
		conversationID = &c.ConversationID
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE chat_usage_events
		 SET outcome = $2,
		     conversation_id = $3::uuid,
		     input_tokens = $4,
		     output_tokens = $5,
		     tool_calls = $6,
		     model = $7
		 WHERE id = $1`,
		id, c.Outcome, conversationID, c.InputTokens, c.OutputTokens, c.ToolCalls, nullIfEmpty(c.Model),
	); err != nil {
		return fmt.Errorf("complete send: %w", err)
	}
	return nil
}

func timeOrZero(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
