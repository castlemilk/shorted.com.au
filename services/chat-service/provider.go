package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// ChatProvider is one LLM backend. It knows its wire protocol and nothing about
// what tools mean, budgets, fallback or persistence: TurnEngine owns those.
type ChatProvider interface {
	// Name is the catalog key, for example "gemini".
	Name() string
	// NewSession starts one turn. It makes no network call.
	NewSession(cfg SessionConfig) (ModelSession, error)
	Close() error
}

// SessionConfig is fixed for one turn.
type SessionConfig struct {
	Model           string
	System          string
	History         []Message        // stored user/assistant text
	Tools           []ToolDefinition // data tools plus answer_without_data
	MaxOutputTokens int32
	Params          ModelParams
	// EndUser is a pseudonymous id for the caller: "u_" plus a hash of the uid.
	// It goes to providers that take an end-user field, never a raw uid.
	EndUser string
}

// ModelParams is the closed set of knobs an admin may set. Nothing free-form
// reaches a request body.
type ModelParams struct {
	Temperature    *float64 // nil = provider default (today: unset)
	OpenRouterOnly []string // openrouter only; slugs matching ^[a-z0-9-]{1,40}$
}

// ModelSession is one turn's conversation. Each Send is exactly one model call.
// The session appends the input and the model's reply to its own transcript,
// including anything that must be replayed verbatim, so the engine never sees
// provider types.
type ModelSession interface {
	// Send makes one model call. emit receives each text delta as it arrives.
	// On error the reply still carries whatever usage the call reported before
	// it failed, and the error is a *ProviderError.
	Send(ctx context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error)
}

// SendInput is what the model reads next: the user's message on the first call,
// then a result for every call of the previous reply, in the same order.
type SendInput struct {
	UserText    string
	ToolResults []ToolResult
}

// ToolChoice says whether the model must, may or must not call a tool.
type ToolChoice int

const (
	ToolChoiceAuto     ToolChoice = iota // the model decides; Gemini: no ToolConfig at all
	ToolChoiceRequired                   // the model must call a tool; Gemini: mode ANY
	ToolChoiceNone                       // the model must answer in text; Gemini: mode NONE
)

// ToolCall is one function call the model asked for.
type ToolCall struct {
	ID        string // provider id, or "call_<seq>" when the provider has none
	Name      string
	Args      map[string]any // nil when ArgsError is set
	ArgsError string         // the model's argument JSON did not parse
}

// ToolResult answers one ToolCall. JSON is the exact text the model reads.
type ToolResult struct {
	CallID string
	Name   string
	JSON   string
}

// ModelEventKind labels a ModelEvent.
type ModelEventKind int

const (
	EventTextDelta ModelEventKind = iota
)

// ModelEvent is something a session tells the engine while a call streams.
type ModelEvent struct {
	Kind ModelEventKind
	Text string
}

// FinishReason says why a model call stopped, in provider-neutral terms.
type FinishReason string

const (
	FinishStop      FinishReason = "stop"
	FinishToolCalls FinishReason = "tool_calls"
	FinishLength    FinishReason = "length"
	FinishFiltered  FinishReason = "content_filter"
	FinishOther     FinishReason = "other"
)

// ModelReply is everything one model call produced.
type ModelReply struct {
	Text      string     // all text this call produced (already emitted as deltas)
	ToolCalls []ToolCall // complete, in model order
	Usage     TokenUsage
	Finish    FinishReason
	// UsageMissing says the reply ended without a usage report, so its Usage and
	// cost are unknown, not zero.
	UsageMissing bool
}

// TokenUsage is the bounded token accounting of one or more model calls.
// CandidateTokens is the visible output; ReasoningTokens is billed as output too.
type TokenUsage struct {
	PromptTokens       int64
	CachedPromptTokens int64
	CandidateTokens    int64
	ReasoningTokens    int64
	TotalTokens        int64
	// ReportedCostUSD is the cost the provider billed for the call (OpenRouter
	// usage.cost). Nil when the provider reports none.
	ReportedCostUSD *float64
}

// ProviderError is the only error type a Send returns. Err is already redacted.
type ProviderError struct {
	Provider  string
	Reached   bool // at least one response chunk arrived, so the call was billed
	Retryable bool // the provider reported a transient failure
	Status    int  // HTTP status when the provider reported one
	Err       error
}

func (e *ProviderError) Error() string { return e.Err.Error() }

func (e *ProviderError) Unwrap() error { return e.Err }

// providerReached reports whether a failed model call got a response. Any error
// that is not a ProviderError is treated as not reached.
func providerReached(err error) bool {
	var pe *ProviderError
	return errors.As(err, &pe) && pe.Reached
}

// endUserID is the pseudonymous caller id a provider may see: "u_" and the first
// 24 hex digits of sha256("shorted-chat:"+uid). It is stable for a user and says
// nothing about the uid, which never leaves the service.
func endUserID(uid string) string {
	sum := sha256.Sum256([]byte("shorted-chat:" + uid))
	return "u_" + hex.EncodeToString(sum[:])[:24]
}
