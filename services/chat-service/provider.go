package main

import (
	"context"
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
	ID   string // provider id, or "call_<seq>" when the provider has none
	Name string
	Args map[string]any
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

// ModelReply is everything one model call produced.
type ModelReply struct {
	Text      string     // all text this call produced (already emitted as deltas)
	ToolCalls []ToolCall // complete, in model order
	Usage     TokenUsage
}

// TokenUsage is the bounded token accounting of one or more model calls.
type TokenUsage struct {
	PromptTokens       int64
	CachedPromptTokens int64
	CandidateTokens    int64
	ReasoningTokens    int64
	TotalTokens        int64
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
