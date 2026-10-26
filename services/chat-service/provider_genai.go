package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"google.golang.org/genai"
)

// geminiProviderName is the catalog key and the event label for Gemini calls.
const geminiProviderName = "gemini"

// geminiProvider is the Gemini backend, over google.golang.org/genai. The
// generative-ai-go SDK it replaced is archived, and it could not send back the
// thought signatures Gemini 3.x needs on a stateless tool loop.
type geminiProvider struct {
	client   *genai.Client
	timeouts streamTimeouts
}

// newGeminiProviderAt creates the Gemini client. The key is registered before any
// request can fail, so every error the client produces is scrubbed of it. The base
// URL is overridden by tests to point the client at a fake endpoint; an empty
// baseURL is production.
func newGeminiProviderAt(ctx context.Context, apiKey, baseURL string) (*geminiProvider, error) {
	registerSecrets(apiKey)
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:      apiKey,
		Backend:     genai.BackendGeminiAPI,
		HTTPOptions: genai.HTTPOptions{BaseURL: baseURL},
	})
	if err != nil {
		return nil, providerError("create genai client", err)
	}
	return &geminiProvider{client: client, timeouts: defaultStreamTimeouts()}, nil
}

func (p *geminiProvider) Name() string { return geminiProviderName }

// Close is a no-op: genai.Client holds no connections that need releasing.
func (p *geminiProvider) Close() error { return nil }

// NewSession starts a turn with the system prompt, the tool declarations and the
// stored history. It makes no network call.
func (p *geminiProvider) NewSession(cfg SessionConfig) (ModelSession, error) {
	transcript := make([]*genai.Content, 0, len(cfg.History)+1)
	transcript = append(transcript, buildGeminiHistory(cfg.History)...)
	return &geminiSession{
		client:      p.client,
		model:       cfg.Model,
		config:      cfg,
		transcript:  transcript,
		timeouts:    p.timeouts,
		providerIDs: map[string]bool{},
	}, nil
}

// geminiSession is one turn. The transcript is the model's full history, kept
// here rather than in the SDK: each reply is appended exactly as the model sent
// it, so a thought signature or function-call part goes back on the next call.
type geminiSession struct {
	client     *genai.Client
	model      string
	config     SessionConfig
	transcript []*genai.Content
	timeouts   streamTimeouts
	started    bool
	seq        int
	// providerIDs marks the call ids Gemini itself sent. Only those are echoed
	// back on a function response; a synthesised id is ours, not the model's.
	providerIDs map[string]bool
}

// Send makes one streamed call. The first call sends the user's text. Each later
// call sends one function response per tool result, in the order the calls came.
func (s *geminiSession) Send(ctx context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error) {
	op := "stream function response"
	if !s.started {
		s.started = true
		op = "stream next"
		s.transcript = append(s.transcript, genai.NewContentFromText(in.UserText, genai.RoleUser))
	} else {
		parts := make([]*genai.Part, 0, len(in.ToolResults))
		for _, r := range in.ToolResults {
			fr := &genai.FunctionResponse{Name: r.Name, Response: functionResponseMap(r.JSON)}
			if s.providerIDs[r.CallID] {
				fr.ID = r.CallID
			}
			parts = append(parts, &genai.Part{FunctionResponse: fr})
		}
		s.transcript = append(s.transcript, &genai.Content{Role: genai.RoleUser, Parts: parts})
	}

	var reply ModelReply
	var modelParts []*genai.Part
	reached := false
	guard := newStreamGuard(ctx, s.timeouts)
	defer guard.stop()
	for resp, err := range s.client.Models.GenerateContentStream(guard.ctx, s.model, s.transcript, s.requestConfig(choice)) {
		if err != nil {
			return reply, providerFailure(ctx, guard, op, reached, err)
		}
		guard.touch()
		// A refused prompt or reply is an error, as it was on the legacy SDK. The
		// refused chunk is not counted as reached, so a block on the first chunk is a
		// failure before the model, and text already streamed stays partial.
		if reason := blockingReason(resp); reason != "" {
			return reply, &ProviderError{Provider: geminiProviderName, Reached: reached, Err: providerError(op, fmt.Errorf("the model refused the reply: %s", reason))}
		}
		reached = true
		if usage := genaiUsage(resp); usage.hasTokens() {
			reply.Usage = usage
		}
		if len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
			continue
		}
		for _, part := range resp.Candidates[0].Content.Parts {
			if part == nil {
				continue
			}
			modelParts = appendStreamedPart(modelParts, part)
		}
		// A chunk that carries a function call streams no text, as the P1 adapter
		// does, so text such as "Let me check." never joins the answer.
		hasCall := false
		for _, part := range resp.Candidates[0].Content.Parts {
			if part != nil && part.FunctionCall != nil {
				hasCall = true
			}
		}
		for _, part := range resp.Candidates[0].Content.Parts {
			if part == nil || part.Thought || hasCall {
				continue
			}
			if part.Text != "" {
				reply.Text += part.Text
				emit(ModelEvent{Kind: EventTextDelta, Text: part.Text})
			}
		}
	}

	// The reply is replayed as one Content, so the next call sees the same turn
	// the model produced.
	if len(modelParts) > 0 {
		s.transcript = append(s.transcript, &genai.Content{Role: genai.RoleModel, Parts: modelParts})
	}
	for _, part := range modelParts {
		if part.FunctionCall == nil {
			continue
		}
		fc := part.FunctionCall
		id := fc.ID
		if id != "" {
			s.providerIDs[id] = true
		} else {
			s.seq++
			id = fmt.Sprintf("call_%d", s.seq)
		}
		args := fc.Args
		if args == nil {
			args = map[string]any{}
		}
		reply.ToolCalls = append(reply.ToolCalls, ToolCall{ID: id, Name: fc.Name, Args: args})
	}
	return reply, nil
}

// requestConfig is the generation config for one call of the turn.
func (s *geminiSession) requestConfig(choice ToolChoice) *genai.GenerateContentConfig {
	// genai resumes a stream on a continuation token. The legacy path never did,
	// and resuming would send a request the turn did not plan for.
	autoContinue := false
	cfg := &genai.GenerateContentConfig{
		SystemInstruction:     genai.NewContentFromText(s.config.System, genai.RoleUser),
		Tools:                 buildGeminiTools(s.config.Tools),
		ToolConfig:            geminiToolConfig(choice),
		CandidateCount:        1,
		AutomaticContinuation: &autoContinue,
	}
	if s.config.MaxOutputTokens > 0 {
		cfg.MaxOutputTokens = s.config.MaxOutputTokens
	}
	if t := s.config.Params.Temperature; t != nil {
		temperature := float32(*t)
		cfg.Temperature = &temperature
	}
	return cfg
}

// appendStreamedPart adds one streamed part to the model's reply. Adjacent text
// is joined, as the SDK joined it, and empty text is dropped. A thought part, a
// function call, or a text part that carries a thought signature is kept as its
// own part, because the signature belongs to that part.
func appendStreamedPart(parts []*genai.Part, part *genai.Part) []*genai.Part {
	isPlainText := part.Text != "" && part.FunctionCall == nil && !part.Thought && part.ThoughtSignature == nil
	if part.Text == "" && part.FunctionCall == nil && part.ThoughtSignature == nil && !part.Thought && part.FunctionResponse == nil && part.InlineData == nil && part.FileData == nil {
		return parts // empty text: nothing to replay
	}
	if isPlainText && len(parts) > 0 {
		last := parts[len(parts)-1]
		if last.Text != "" && last.FunctionCall == nil && !last.Thought && last.ThoughtSignature == nil {
			merged := *last
			merged.Text += part.Text
			parts[len(parts)-1] = &merged
			return parts
		}
	}
	return append(parts, part)
}

// blockingFinishReasons refuse a reply. The legacy SDK returned an error for each;
// genai returns the chunk, so the adapter has to refuse it.
var blockingFinishReasons = map[genai.FinishReason]bool{
	genai.FinishReasonSafety:            true,
	genai.FinishReasonRecitation:        true,
	genai.FinishReasonBlocklist:         true,
	genai.FinishReasonProhibitedContent: true,
	genai.FinishReasonSPII:              true,
}

// blockingReason names why a chunk refuses the reply, or returns "" when it does not.
func blockingReason(resp *genai.GenerateContentResponse) string {
	if resp.PromptFeedback != nil && resp.PromptFeedback.BlockReason != "" {
		return "prompt " + string(resp.PromptFeedback.BlockReason)
	}
	if len(resp.Candidates) > 0 && blockingFinishReasons[resp.Candidates[0].FinishReason] {
		return string(resp.Candidates[0].FinishReason)
	}
	return ""
}

// providerFailure wraps a stream error as a ProviderError. Reached says a chunk
// arrived, so the call was billed. A 429 or a 5xx is retryable, and so is a
// network failure before any chunk. A cancelled context is never retryable, and
// neither is a bound the guard enforced: a timeout goes to the fallback, not back
// to the same provider.
func providerFailure(ctx context.Context, guard *streamGuard, op string, reached bool, err error) error {
	pe := &ProviderError{
		Provider: geminiProviderName,
		Reached:  reached,
		Err:      providerError(op, err),
	}
	var apiErr genai.APIError
	switch {
	case guard.expired() && ctx.Err() == nil:
		pe.Err = providerError(op, errTimedOut)
	case errors.As(err, &apiErr):
		pe.Status = apiErr.Code
		pe.Retryable = apiErr.Code == 429 || apiErr.Code >= 500
	case ctx.Err() != nil:
		pe.Retryable = false
	default:
		pe.Retryable = !reached
	}
	return pe
}

// geminiToolConfig maps a choice to the function calling config. Auto is nil,
// so the request carries no tool config, which is what the model received
// before the engine existed.
func geminiToolConfig(choice ToolChoice) *genai.ToolConfig {
	switch choice {
	case ToolChoiceRequired:
		return &genai.ToolConfig{FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeAny}}
	case ToolChoiceNone:
		return &genai.ToolConfig{FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeNone}}
	default:
		return nil
	}
}

// functionResponseMap turns a tool result into the object Gemini reads. A result
// that is not a JSON object is wrapped as {"result": text}.
func functionResponseMap(result string) map[string]any {
	var resultMap map[string]any
	if json.Unmarshal([]byte(result), &resultMap) != nil {
		return map[string]any{"result": result}
	}
	return resultMap
}

// buildGeminiTools converts tool definitions to Gemini function declarations.
func buildGeminiTools(defs []ToolDefinition) []*genai.Tool {
	var funcDecls []*genai.FunctionDeclaration

	for _, def := range defs {
		props := make(map[string]*genai.Schema)
		for name, param := range def.Parameters {
			schema := &genai.Schema{
				Description: param.Description,
			}
			switch param.Type {
			case "string":
				schema.Type = genai.TypeString
				if len(param.Enum) > 0 {
					schema.Enum = param.Enum
				}
			case "integer":
				schema.Type = genai.TypeInteger
			case "boolean":
				schema.Type = genai.TypeBoolean
			case "array":
				schema.Type = genai.TypeArray
				schema.Items = &genai.Schema{Type: genai.TypeString}
			default:
				schema.Type = genai.TypeString
			}
			props[name] = schema
		}

		// A tool with no parameters declares none. An object schema with no
		// properties is not a valid declaration.
		var parameters *genai.Schema
		if len(def.Parameters) > 0 {
			parameters = &genai.Schema{
				Type:       genai.TypeObject,
				Properties: props,
				Required:   def.Required,
			}
		}

		funcDecls = append(funcDecls, &genai.FunctionDeclaration{
			Name:        def.Name,
			Description: def.Description,
			Parameters:  parameters,
		})
	}

	return []*genai.Tool{{FunctionDeclarations: funcDecls}}
}

// buildGeminiHistory converts stored messages to Gemini chat history.
func buildGeminiHistory(messages []Message) []*genai.Content {
	var history []*genai.Content
	for _, msg := range messages {
		// An empty message is a part with no text, which the API rejects, so the
		// turn would fail for the rest of the conversation.
		if msg.Content == "" {
			continue
		}
		var role genai.Role
		switch msg.Role {
		case "user":
			role = genai.RoleUser
		case "assistant":
			role = genai.RoleModel
		default:
			continue // skip tool messages in history for now
		}
		history = append(history, genai.NewContentFromText(msg.Content, role))
	}
	return history
}

// genaiUsage reads the bounded token counts from one response.
func genaiUsage(resp *genai.GenerateContentResponse) TokenUsage {
	if resp == nil || resp.UsageMetadata == nil {
		return TokenUsage{}
	}
	m := resp.UsageMetadata
	return TokenUsage{
		PromptTokens:       int64(m.PromptTokenCount),
		CachedPromptTokens: int64(m.CachedContentTokenCount),
		CandidateTokens:    int64(m.CandidatesTokenCount),
		ReasoningTokens:    int64(m.ThoughtsTokenCount),
		TotalTokens:        int64(m.TotalTokenCount),
	}
}
