package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// openAICompatUserAgent identifies chat to the provider. The Go default is
// refused by some providers' edges.
const openAICompatUserAgent = "shorted-chat/1.0"

// openAICompatMaxErrorBody bounds what is read from an error response. Only
// error.message is kept from it.
const openAICompatMaxErrorBody = 4096

// openAICompatProvider talks to any OpenAI-compatible chat-completions endpoint
// over raw net/http and server-sent events. The SDKs for this API cannot send
// DeepSeek's thinking switch, and the surface needed is one POST and a parser.
type openAICompatProvider struct {
	spec     ProviderSpec
	baseURL  string
	apiKey   string
	client   *http.Client
	timeouts streamTimeouts
}

// newOpenAICompatProvider builds the adapter for one catalog provider. The key
// is registered first, so every error the adapter returns is scrubbed of it.
func newOpenAICompatProvider(spec ProviderSpec, baseURL, apiKey string, client *http.Client) (*openAICompatProvider, error) {
	registerSecrets(apiKey)
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("%s: no API key is configured (%s)", spec.Name, spec.KeyEnv)
	}
	if client == nil {
		client = &http.Client{}
	}
	return &openAICompatProvider{
		spec:     spec,
		baseURL:  strings.TrimRight(baseURL, "/"),
		apiKey:   apiKey,
		client:   client,
		timeouts: defaultStreamTimeouts(),
	}, nil
}

func (p *openAICompatProvider) Name() string { return p.spec.Name }

// Close is a no-op: the HTTP client holds no state that needs releasing.
func (p *openAICompatProvider) Close() error { return nil }

// NewSession starts a turn: the system prompt, then the stored history as text.
// It makes no network call.
func (p *openAICompatProvider) NewSession(cfg SessionConfig) (ModelSession, error) {
	messages := []oaMessage{{Role: "system", Content: cfg.System}}
	for _, m := range cfg.History {
		// An empty message is refused by the API, so it is skipped, as the Gemini
		// adapter skips it.
		if m.Content == "" {
			continue
		}
		switch m.Role {
		case "user", "assistant":
			messages = append(messages, oaMessage{Role: m.Role, Content: m.Content})
		}
	}
	return &oaSession{p: p, cfg: cfg, messages: messages}, nil
}

// oaSession is one turn. Its message list is the transcript the API reads, kept
// here exactly as it was sent, so the next call replays it verbatim.
type oaSession struct {
	p        *openAICompatProvider
	cfg      SessionConfig
	messages []oaMessage
	started  bool
	seq      int
}

// Send makes one streamed call. The first call sends the user's text. Each later
// call sends one tool message per result, in the order the calls came.
func (s *oaSession) Send(ctx context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error) {
	if !s.started {
		s.started = true
		s.messages = append(s.messages, oaMessage{Role: "user", Content: in.UserText})
	} else {
		for _, r := range in.ToolResults {
			content := r.JSON
			if content == "" {
				// A tool message needs content. A result is never empty, so this
				// is a guard, not a path the model sees in practice.
				content = "{}"
			}
			s.messages = append(s.messages, oaMessage{Role: "tool", ToolCallID: r.CallID, Content: content})
		}
	}

	body, err := s.requestBody(choice)
	if err != nil {
		return ModelReply{}, &ProviderError{Provider: s.p.spec.Name, Err: providerError("encode request", err)}
	}
	res, err := s.p.stream(ctx, s.cfg.Model, body, emit)
	if err != nil {
		return res.reply, err
	}

	// Give every call an id the transcript can name, then replay the reply as
	// the model sent it: its text, its reasoning and its calls with raw arguments.
	asst := oaMessage{Role: "assistant", Content: res.text, ReasoningContent: res.reasoning}
	for i := range res.calls {
		if res.calls[i].ID == "" {
			s.seq++
			res.calls[i].ID = fmt.Sprintf("call_%d", s.seq)
			res.reply.ToolCalls[i].ID = res.calls[i].ID
		}
		args := res.calls[i].RawArgs
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		asst.ToolCalls = append(asst.ToolCalls, oaToolCall{
			ID:       res.calls[i].ID,
			Type:     "function",
			Function: oaCallFunction{Name: res.calls[i].Name, Arguments: args},
		})
	}
	if asst.Content != "" || asst.ReasoningContent != "" || len(asst.ToolCalls) > 0 {
		s.messages = append(s.messages, asst)
	}
	return res.reply, nil
}

// requestBody encodes one call. Thinking, the end-user field and the routing
// preferences depend on the provider's dialect, and nothing else varies.
func (s *oaSession) requestBody(choice ToolChoice) ([]byte, error) {
	d := s.p.spec.Dialect
	req := oaRequest{
		Model:         s.cfg.Model,
		Messages:      s.messages,
		Stream:        true,
		StreamOptions: oaStreamOptions{IncludeUsage: true},
		MaxTokens:     s.cfg.MaxOutputTokens,
		Temperature:   s.cfg.Params.Temperature,
	}
	caps := s.caps()
	// A model without a none choice gets no tools at all on the final round, not a
	// "none" it would refuse. Parallel calls are asked for only where the catalog says so.
	if len(s.cfg.Tools) > 0 && (choice != ToolChoiceNone || caps.NoneToolChoice) {
		req.Tools = openAITools(s.cfg.Tools)
		req.ToolChoice = s.p.toolChoiceValue(choice)
		if caps.ParallelToolCalls {
			parallel := true
			req.ParallelToolCalls = &parallel
		}
	}
	if d.DisableThinking {
		// DeepSeek thinks by default, and a thinking turn refuses a required
		// tool choice and needs reasoning sent back. Every call turns it off.
		req.Thinking = &oaThinking{Type: "disabled"}
	}
	if s.cfg.EndUser != "" {
		switch d.EndUserField {
		case "user_id":
			req.UserID = s.cfg.EndUser
		case "user":
			req.User = s.cfg.EndUser
		}
	}
	if d.OpenRouterPrefs {
		// Without require_parameters a provider silently ignores tool_choice it
		// does not support. Data collection is denied so prompts are not kept.
		req.Provider = &oaRoutingPrefs{
			RequireParameters: true,
			Only:              s.cfg.Params.OpenRouterOnly,
			DataCollection:    "deny",
		}
	}
	return json.Marshal(req)
}

// caps returns the catalog capabilities of this session's model. A model the
// catalog does not list has none, so it gets the conservative behaviour.
func (s *oaSession) caps() ModelCapabilities {
	m, _ := modelOrUnverified(s.p.spec.Name, s.cfg.Model)
	return m.Caps
}

// toolChoiceValue maps a choice to the provider's wire value.
func (p *openAICompatProvider) toolChoiceValue(c ToolChoice) string {
	switch c {
	case ToolChoiceRequired:
		if p.spec.Dialect.RequiredChoice != "" {
			return p.spec.Dialect.RequiredChoice
		}
		return "required"
	case ToolChoiceNone:
		return "none"
	default:
		return "auto"
	}
}

// streamResult is one parsed reply. calls keeps each call's raw argument text,
// which the transcript replays exactly.
type streamResult struct {
	reply     ModelReply
	text      string
	reasoning string
	calls     []oaRawCall
}

type oaRawCall struct {
	ID      string
	Name    string
	RawArgs string
}

// stream sends the request and parses the event stream. Text is emitted as it
// arrives, reasoning is kept but never emitted, and tool calls are assembled by
// index.
func (p *openAICompatProvider) stream(ctx context.Context, model string, body []byte, emit func(ModelEvent)) (streamResult, error) {
	guard := newStreamGuard(ctx, p.timeouts)
	defer guard.stop()

	req, err := http.NewRequestWithContext(guard.ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return streamResult{}, p.failure(ctx, guard, false, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	// The key is trimmed the same way it is for redaction, so a stray newline in the
	// environment does not reach the header.
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(p.apiKey))
	req.Header.Set("User-Agent", openAICompatUserAgent)

	resp, err := p.client.Do(req)
	if err != nil {
		return streamResult{}, p.failure(ctx, guard, false, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return streamResult{}, p.statusFailure(resp)
	}

	var (
		res        streamResult
		text       strings.Builder
		shown      strings.Builder // the text emitted to the person
		reasoning  strings.Builder
		calls      = map[int]*oaPartialCall{}
		finish     string
		usage      *oaUsage
		reached    bool
		sawDone    bool
		scanner    = bufio.NewScanner(resp.Body)
		maxLineLen = 4 * 1024 * 1024
	)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineLen)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		// Blank lines separate events, and a line starting with a colon is a
		// comment. Neither is data, so neither resets a bound.
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		guard.touch()
		if data == "[DONE]" {
			sawDone = true
			break
		}

		var chunk oaChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return res, &ProviderError{Provider: p.spec.Name, Reached: true, Err: providerError("model stream", errors.New("a stream chunk was not valid JSON"))}
		}
		reached = true
		if chunk.Error != nil {
			return res, &ProviderError{Provider: p.spec.Name, Reached: true, Err: providerError("model stream", errors.New(chunk.Error.Message))}
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
			// Record the billed tokens now, not after the loop: every exit below,
			// a filtered or errored reply included, must carry what was billed.
			res.reply.Usage = usage.tokenUsage()
		}
		for _, c := range chunk.Choices {
			// A chunk that carries a tool call streams no text, as the Gemini adapter
			// does: that text is a preamble such as "Let me check". The transcript keeps it.
			text.WriteString(c.Delta.Content)
			if c.Delta.Content != "" && len(c.Delta.ToolCalls) == 0 {
				shown.WriteString(c.Delta.Content)
				emit(ModelEvent{Kind: EventTextDelta, Text: c.Delta.Content})
			}
			reasoning.WriteString(c.Delta.ReasoningContent)
			for _, tc := range c.Delta.ToolCalls {
				call := calls[tc.Index]
				if call == nil {
					call = &oaPartialCall{}
					calls[tc.Index] = call
				}
				if tc.ID != "" {
					call.ID = tc.ID
				}
				if tc.Function.Name != "" {
					call.Name = tc.Function.Name
				}
				call.Args.WriteString(tc.Function.Arguments)
			}
			if c.FinishReason != nil && *c.FinishReason != "" {
				finish = *c.FinishReason
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return res, p.failure(ctx, guard, reached, err)
	}
	if !sawDone && finish == "" {
		// The stream ended mid-answer. Nothing after the last chunk is trustworthy.
		return res, &ProviderError{Provider: p.spec.Name, Reached: reached, Retryable: !reached,
			Err: providerError("model stream", errors.New("the stream ended before the model finished"))}
	}
	if finish == "insufficient_system_resource" && text.Len() == 0 {
		// The provider had no capacity to answer. Nothing reached the user, and a
		// later attempt may succeed.
		return res, &ProviderError{Provider: p.spec.Name, Reached: reached, Retryable: true,
			Err: providerError("model stream", errors.New("the provider had insufficient resources to answer"))}
	}
	if finish == "content_filter" {
		// A refused reply is not an answer, as Gemini treats a SAFETY block. The
		// refusal is not retryable, and a fallback may run because nothing was emitted.
		return res, &ProviderError{Provider: p.spec.Name, Reached: reached,
			Err: providerError("model stream", errors.New("the provider filtered the reply"))}
	}
	if finish == "error" {
		return res, &ProviderError{Provider: p.spec.Name, Reached: reached,
			Err: providerError("model stream", errors.New("the provider ended the reply with an error"))}
	}

	res.text = text.String()
	res.reasoning = reasoning.String()
	res.reply = ModelReply{Text: shown.String(), Finish: mapFinishReason(finish, sawDone)}
	if usage != nil {
		res.reply.Usage = usage.tokenUsage()
	} else {
		// The cost of this reply is unknown, not zero. The flag and the counter keep
		// a zero estimate from being read as a real one.
		res.reply.UsageMissing = true
		recordUsageMissing(ctx, p.spec.Name, model)
	}

	indexes := make([]int, 0, len(calls))
	for i := range calls {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	for _, i := range indexes {
		c := calls[i]
		raw := c.Args.String()
		call := ToolCall{ID: c.ID, Name: c.Name}
		if strings.TrimSpace(raw) == "" {
			call.Args = map[string]any{}
		} else {
			var args map[string]any
			if err := json.Unmarshal([]byte(raw), &args); err != nil || args == nil {
				call.ArgsError = "the arguments were not a JSON object"
			} else {
				call.Args = args
			}
		}
		res.reply.ToolCalls = append(res.reply.ToolCalls, call)
		res.calls = append(res.calls, oaRawCall{ID: c.ID, Name: c.Name, RawArgs: raw})
	}
	return res, nil
}

// failure wraps a transport or read error. A bound the guard enforced is not
// retryable on the same provider: a queued request would cost another full bound
// before the fallback. A caller cancel is never retryable. Anything else, such as
// a refused or reset connection, is retryable only before the first chunk.
func (p *openAICompatProvider) failure(ctx context.Context, guard *streamGuard, reached bool, err error) error {
	pe := &ProviderError{Provider: p.spec.Name, Reached: reached}
	switch {
	case guard.expired() && ctx.Err() == nil:
		pe.Err = providerError("model request", errTimedOut)
	case ctx.Err() != nil:
		pe.Err = providerError("model request", ctx.Err())
	default:
		pe.Err = providerError("model request", err)
		pe.Retryable = !reached
	}
	return pe
}

// statusFailure turns a non-200 response into a ProviderError. Only error.message
// is read from the body, and at most a few KB of it.
func (p *openAICompatProvider) statusFailure(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, openAICompatMaxErrorBody))
	msg := providerErrorMessage(raw)
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	return &ProviderError{
		Provider:  p.spec.Name,
		Reached:   false,
		Retryable: resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500,
		Status:    resp.StatusCode,
		Err:       providerError("model request", fmt.Errorf("HTTP %d: %s", resp.StatusCode, msg)),
	}
}

// providerErrorMessage returns error.message from a provider's JSON error body,
// or "" when the body has another shape.
func providerErrorMessage(raw []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return ""
	}
	return env.Error.Message
}

// mapFinishReason converts a provider's finish reason. A stream that ended with
// [DONE] and no reason stopped normally.
func mapFinishReason(reason string, sawDone bool) FinishReason {
	switch reason {
	case "stop":
		return FinishStop
	case "tool_calls", "function_call":
		return FinishToolCalls
	case "length":
		return FinishLength
	case "content_filter":
		return FinishFiltered
	case "":
		if sawDone {
			return FinishStop
		}
		return FinishOther
	default:
		return FinishOther
	}
}

// oaPartialCall accumulates one tool call across its chunks.
type oaPartialCall struct {
	ID   string
	Name string
	Args strings.Builder
}

// --- wire types -------------------------------------------------------------

type oaRequest struct {
	Model         string          `json:"model"`
	Messages      []oaMessage     `json:"messages"`
	Tools         []oaTool        `json:"tools,omitempty"`
	ToolChoice    string          `json:"tool_choice,omitempty"`
	Stream        bool            `json:"stream"`
	StreamOptions oaStreamOptions `json:"stream_options"`
	MaxTokens     int32           `json:"max_tokens,omitempty"`
	Temperature   *float64        `json:"temperature,omitempty"`
	Thinking      *oaThinking     `json:"thinking,omitempty"`
	UserID        string          `json:"user_id,omitempty"`
	User          string          `json:"user,omitempty"`
	Provider      *oaRoutingPrefs `json:"provider,omitempty"`
	// ParallelToolCalls is set only for a model the catalog says supports it.
	ParallelToolCalls *bool `json:"parallel_tool_calls,omitempty"`
}

type oaStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type oaThinking struct {
	Type string `json:"type"`
}

type oaRoutingPrefs struct {
	RequireParameters bool     `json:"require_parameters"`
	Only              []string `json:"only,omitempty"`
	DataCollection    string   `json:"data_collection"`
}

type oaMessage struct {
	Role             string       `json:"role"`
	Content          string       `json:"content,omitempty"`
	ReasoningContent string       `json:"reasoning_content,omitempty"`
	ToolCalls        []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string       `json:"tool_call_id,omitempty"`
}

type oaToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function oaCallFunction `json:"function"`
}

type oaCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type oaTool struct {
	Type     string     `json:"type"`
	Function oaFunction `json:"function"`
}

type oaFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

// openAITools converts the tool definitions to function tools. No tool is sent
// as strict: strict mode is a beta on the providers that have it, and the
// schemas here do not need it.
func openAITools(defs []ToolDefinition) []oaTool {
	tools := make([]oaTool, 0, len(defs))
	for _, def := range defs {
		tools = append(tools, oaTool{
			Type: "function",
			Function: oaFunction{
				Name:        def.Name,
				Description: def.Description,
				Parameters:  openAISchema(def),
			},
		})
	}
	return tools
}

// openAISchema is the JSON Schema for a tool's arguments. A tool with no
// parameters gets an object with no properties.
func openAISchema(def ToolDefinition) map[string]any {
	props := make(map[string]any, len(def.Parameters))
	for name, param := range def.Parameters {
		jsonType := "string"
		switch param.Type {
		case "integer", "boolean", "array":
			jsonType = param.Type
		}
		prop := map[string]any{"type": jsonType, "description": param.Description}
		if len(param.Enum) > 0 {
			prop["enum"] = param.Enum
		}
		if jsonType == "array" {
			prop["items"] = map[string]any{"type": "string"}
		}
		props[name] = prop
	}
	schema := map[string]any{"type": "object", "properties": props}
	if len(def.Required) > 0 {
		schema["required"] = def.Required
	}
	return schema
}

type oaChunk struct {
	Choices []struct {
		Delta struct {
			Content          string            `json:"content"`
			ReasoningContent string            `json:"reasoning_content"`
			ToolCalls        []oaDeltaToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *oaUsage `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type oaDeltaToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// oaUsage is the usage object of the final chunk. Cache hits are read from both
// fields providers use, and the larger count wins.
type oaUsage struct {
	PromptTokens            int64        `json:"prompt_tokens"`
	CompletionTokens        int64        `json:"completion_tokens"`
	TotalTokens             int64        `json:"total_tokens"`
	PromptCacheHitTokens    int64        `json:"prompt_cache_hit_tokens"`
	PromptTokensDetails     *oaCache     `json:"prompt_tokens_details"`
	CompletionTokensDetails *oaReasoning `json:"completion_tokens_details"`
	Cost                    *float64     `json:"cost"`
}

type oaCache struct {
	CachedTokens int64 `json:"cached_tokens"`
}

type oaReasoning struct {
	ReasoningTokens int64 `json:"reasoning_tokens"`
}

// tokenUsage maps the wire usage to ours. Completion tokens include reasoning,
// so the visible output is the difference.
func (u oaUsage) tokenUsage() TokenUsage {
	cached := u.PromptCacheHitTokens
	if u.PromptTokensDetails != nil && u.PromptTokensDetails.CachedTokens > cached {
		cached = u.PromptTokensDetails.CachedTokens
	}
	var reasoning int64
	if u.CompletionTokensDetails != nil {
		reasoning = u.CompletionTokensDetails.ReasoningTokens
	}
	candidate := u.CompletionTokens - reasoning
	if candidate < 0 {
		candidate = 0
	}
	total := u.TotalTokens
	if total == 0 {
		total = u.PromptTokens + u.CompletionTokens
	}
	return TokenUsage{
		PromptTokens:       u.PromptTokens,
		CachedPromptTokens: cached,
		CandidateTokens:    candidate,
		ReasoningTokens:    reasoning,
		TotalTokens:        total,
		ReportedCostUSD:    u.Cost,
	}
}
