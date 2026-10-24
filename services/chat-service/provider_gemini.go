package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// geminiProviderName is the catalog key and the event label for Gemini calls.
const geminiProviderName = "gemini"

// geminiProvider is the Gemini backend, over the generative-ai-go SDK.
type geminiProvider struct {
	client *genai.Client
}

// newGeminiProvider creates the Gemini client. The key is registered before any
// request can fail, so every error the client produces is scrubbed of it.
func newGeminiProvider(ctx context.Context, apiKey string) (*geminiProvider, error) {
	registerSecrets(apiKey)
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, providerError("create genai client", err)
	}
	return &geminiProvider{client: client}, nil
}

func (p *geminiProvider) Name() string { return geminiProviderName }

func (p *geminiProvider) Close() error { return p.client.Close() }

// NewSession starts a chat session with the turn's system prompt, tools and
// stored history. It makes no network call.
func (p *geminiProvider) NewSession(cfg SessionConfig) (ModelSession, error) {
	model := p.client.GenerativeModel(cfg.Model)
	model.SystemInstruction = genai.NewUserContent(genai.Text(cfg.System))
	if cfg.MaxOutputTokens > 0 {
		model.SetMaxOutputTokens(cfg.MaxOutputTokens)
	}
	model.Tools = buildGeminiTools(cfg.Tools)

	chat := model.StartChat()
	chat.History = buildGeminiHistory(cfg.History)
	return &geminiSession{model: model, chat: chat}, nil
}

// geminiSession is one turn. The SDK's ChatSession keeps the transcript,
// including the model's function-call parts, so each Send only adds the input.
type geminiSession struct {
	model   *genai.GenerativeModel
	chat    *genai.ChatSession
	started bool
	seq     int
}

// Send makes one streamed call. The first call sends the user's text. Each later
// call sends one FunctionResponse per tool result, in order.
func (s *geminiSession) Send(ctx context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error) {
	// The model is a pointer, so the SDK reads this choice when the call goes out.
	s.model.ToolConfig = geminiToolConfig(choice)

	op := "stream function response"
	var parts []genai.Part
	if !s.started {
		s.started = true
		op = "stream next"
		parts = []genai.Part{genai.Text(in.UserText)}
	} else {
		for _, r := range in.ToolResults {
			parts = append(parts, genai.FunctionResponse{
				Name:     r.Name,
				Response: functionResponseMap(r.JSON),
			})
		}
	}

	iter := s.chat.SendMessageStream(ctx, parts...)
	var reply ModelReply
	reached := false
	for {
		resp, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return reply, &ProviderError{Provider: geminiProviderName, Reached: reached, Err: providerError(op, err)}
		}
		reached = true
		if usage := geminiUsageFromResponse(resp); usage.hasTokens() {
			reply.Usage = usage
		}

		// A chunk that carries function calls contributes no text, as before.
		if calls := extractFunctionCalls(resp); len(calls) > 0 {
			for _, fc := range calls {
				s.seq++
				reply.ToolCalls = append(reply.ToolCalls, ToolCall{
					ID:   fmt.Sprintf("call_%d", s.seq),
					Name: fc.Name,
					Args: fc.Args,
				})
			}
			continue
		}
		if text := extractTextContent(resp); text != "" {
			reply.Text += text
			emit(ModelEvent{Kind: EventTextDelta, Text: text})
		}
	}
	return reply, nil
}

// geminiToolConfig maps a choice to the SDK's function calling config. Auto is
// nil, not an explicit AUTO, which is the request the model received before.
func geminiToolConfig(choice ToolChoice) *genai.ToolConfig {
	switch choice {
	case ToolChoiceRequired:
		return &genai.ToolConfig{FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingAny}}
	case ToolChoiceNone:
		return &genai.ToolConfig{FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingNone}}
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
		var role string
		switch msg.Role {
		case "user":
			role = "user"
		case "assistant":
			role = "model"
		default:
			continue // skip tool messages in history for now
		}
		history = append(history, &genai.Content{
			Role:  role,
			Parts: []genai.Part{genai.Text(msg.Content)},
		})
	}
	return history
}

// extractFunctionCalls gets function calls from a Gemini response.
func extractFunctionCalls(resp *genai.GenerateContentResponse) []*genai.FunctionCall {
	var calls []*genai.FunctionCall
	for _, cand := range resp.Candidates {
		if cand.Content != nil {
			for _, part := range cand.Content.Parts {
				if fc, ok := part.(genai.FunctionCall); ok {
					calls = append(calls, &fc)
				}
			}
		}
	}
	return calls
}

// extractTextContent gets the text content from a Gemini response.
func extractTextContent(resp *genai.GenerateContentResponse) string {
	for _, cand := range resp.Candidates {
		if cand.Content != nil {
			for _, part := range cand.Content.Parts {
				if text, ok := part.(genai.Text); ok {
					return string(text)
				}
			}
		}
	}
	return ""
}

// geminiUsageFromResponse reads the bounded token counts from a response.
func geminiUsageFromResponse(resp *genai.GenerateContentResponse) TokenUsage {
	if resp == nil || resp.UsageMetadata == nil {
		return TokenUsage{}
	}
	return TokenUsage{
		PromptTokens:       int64(resp.UsageMetadata.PromptTokenCount),
		CachedPromptTokens: int64(resp.UsageMetadata.CachedContentTokenCount),
		CandidateTokens:    int64(resp.UsageMetadata.CandidatesTokenCount),
		TotalTokens:        int64(resp.UsageMetadata.TotalTokenCount),
	}
}
