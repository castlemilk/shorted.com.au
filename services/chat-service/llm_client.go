package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// LLMClient wraps the Gemini API for chat completions with function calling.
type LLMClient struct {
	client          *genai.Client
	model           string
	maxOutputTokens int32
	toolExecutor    *ToolExecutor
}

// turnError is what ChatStream returns when a turn fails. ModelReached says
// whether Gemini answered at all. A request it refuses before any response is
// not billed, so the send must not count against the caller's limits. A failure
// after the first response did reach the model, and counts.
type turnError struct {
	ModelReached bool
	err          error
}

func (e *turnError) Error() string { return e.err.Error() }

func (e *turnError) Unwrap() error { return e.err }

// modelAnswered reports whether a failed turn got as far as the model.
func modelAnswered(err error) bool {
	var te *turnError
	return errors.As(err, &te) && te.ModelReached
}

// LLMResponse represents a response from the LLM.
type LLMResponse struct {
	Content   string
	ToolCalls []ToolCallRecord
	Citations []Citation
	Usage     GeminiUsage
}

// ToolCallRecord records a tool call made during the conversation.
type ToolCallRecord struct {
	Name   string         `json:"name"`
	Args   map[string]any `json:"args"`
	Result string         `json:"result"`
}

// Citation references data used in the response.
type Citation struct {
	Source string `json:"source"`
	Text   string `json:"text"`
}

// NewLLMClient creates a new LLM client.
func NewLLMClient(ctx context.Context, apiKey, model string, maxOutputTokens int32, toolExecutor *ToolExecutor) (*LLMClient, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}

	return &LLMClient{
		client:          client,
		model:           model,
		maxOutputTokens: maxOutputTokens,
		toolExecutor:    toolExecutor,
	}, nil
}

// Close closes the underlying client.
func (lc *LLMClient) Close() {
	_ = lc.client.Close()
}

func (lc *LLMClient) newModel(systemPrompt string) *genai.GenerativeModel {
	model := lc.client.GenerativeModel(lc.model)
	model.SystemInstruction = genai.NewUserContent(genai.Text(systemPrompt))
	if lc.maxOutputTokens > 0 {
		model.SetMaxOutputTokens(lc.maxOutputTokens)
	}
	model.Tools = buildGeminiTools()
	return model
}

// Chat sends a message and processes tool calls, returning the final response.
func (lc *LLMClient) Chat(ctx context.Context, systemPrompt string, history []Message, userMessage string) (*LLMResponse, error) {
	model := lc.newModel(systemPrompt)

	// Build chat session with history
	cs := model.StartChat()
	cs.History = buildGeminiHistory(history)

	// Send user message
	resp, err := cs.SendMessage(ctx, genai.Text(userMessage))
	if err != nil {
		recordGeminiRequest(ctx, lc.model, "initial", "error", GeminiUsage{})
		return nil, fmt.Errorf("send message: %w", err)
	}
	initialUsage := geminiUsageFromResponse(resp)
	recordGeminiRequest(ctx, lc.model, "initial", "success", initialUsage)

	var allToolCalls []ToolCallRecord
	var totalUsage GeminiUsage
	totalUsage.Add(initialUsage)

	// Process tool calls in a loop (max 5 rounds to prevent infinite loops)
	for round := 0; round < 5; round++ {
		funcCalls := extractFunctionCalls(resp)
		if len(funcCalls) == 0 {
			break
		}

		// Execute all function calls
		var funcResponses []genai.Part
		for _, fc := range funcCalls {
			args := make(map[string]any)
			for k, v := range fc.Args {
				args[k] = v
			}

			log.Printf("Executing tool: %s with args: %v", fc.Name, args)
			result, execErr := lc.toolExecutor.Execute(ctx, fc.Name, args)
			status := "success"
			if execErr != nil {
				status = "error"
				result = fmt.Sprintf("Error: %s", execErr.Error())
			}
			recordToolCall(ctx, fc.Name, len([]byte(result)), status)

			allToolCalls = append(allToolCalls, ToolCallRecord{
				Name:   fc.Name,
				Args:   args,
				Result: result,
			})

			// Parse result as JSON for the function response
			var resultMap map[string]any
			if json.Unmarshal([]byte(result), &resultMap) != nil {
				resultMap = map[string]any{"result": result}
			}

			funcResponses = append(funcResponses, genai.FunctionResponse{
				Name:     fc.Name,
				Response: resultMap,
			})
		}

		// Send function responses back to the model
		resp, err = cs.SendMessage(ctx, funcResponses...)
		if err != nil {
			recordGeminiRequest(ctx, lc.model, "tool_response", "error", GeminiUsage{})
			return nil, fmt.Errorf("send function response: %w", err)
		}
		toolUsage := geminiUsageFromResponse(resp)
		recordGeminiRequest(ctx, lc.model, "tool_response", "success", toolUsage)
		totalUsage.Add(toolUsage)
	}

	// Extract final text response
	content := extractTextContent(resp)

	return &LLMResponse{
		Content:   content,
		ToolCalls: allToolCalls,
		Usage:     totalUsage,
	}, nil
}

// ChatStream sends a message and streams text chunks via the onChunk callback.
// Tool call rounds execute synchronously between streaming segments.
func (lc *LLMClient) ChatStream(ctx context.Context, systemPrompt string, history []Message, userMessage string, onChunk func(text string)) (*LLMResponse, error) {
	model := lc.newModel(systemPrompt)

	cs := model.StartChat()
	cs.History = buildGeminiHistory(history)

	// First call: use streaming
	iter := cs.SendMessageStream(ctx, genai.Text(userMessage))

	var allToolCalls []ToolCallRecord
	var pendingFuncCalls []*genai.FunctionCall
	var totalUsage GeminiUsage
	var initialUsage GeminiUsage

	// Consume the streaming response
	modelReached := false
	for {
		resp, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			recordGeminiRequest(ctx, lc.model, "initial", "error", initialUsage)
			return nil, &turnError{ModelReached: modelReached, err: fmt.Errorf("stream next: %w", err)}
		}
		modelReached = true
		if usage := geminiUsageFromResponse(resp); usage.hasTokens() {
			initialUsage = usage
		}

		// Check for function calls
		funcCalls := extractFunctionCalls(resp)
		if len(funcCalls) > 0 {
			pendingFuncCalls = append(pendingFuncCalls, funcCalls...)
			continue
		}

		// Stream text chunks
		text := extractTextContent(resp)
		if text != "" {
			onChunk(text)
		}
	}
	recordGeminiRequest(ctx, lc.model, "initial", "success", initialUsage)
	totalUsage.Add(initialUsage)

	// Rounds 0 to maxToolRounds-1 run tools. The round after them runs none:
	// every call still pending is answered with a notice, and the model is asked
	// for text with function calling off. A turn therefore never ends on a
	// request the model made and never got an answer to, and never ends without
	// text while the model still had calls to make.
	for round := 0; len(pendingFuncCalls) > 0; round++ {
		hasBudget := roundHasBudget(round)
		model.ToolConfig = toolConfigFor(hasBudget)

		calls := pendingFuncCalls
		pendingFuncCalls = nil
		decisions := planToolCalls(len(calls), hasBudget)

		var funcResponses []genai.Part
		for i, fc := range calls {
			if decisions[i] != toolCallExecute {
				funcResponses = append(funcResponses, genai.FunctionResponse{
					Name:     fc.Name,
					Response: toolCallNotice(decisions[i]),
				})
				continue
			}

			args := make(map[string]any)
			for k, v := range fc.Args {
				args[k] = v
			}

			log.Printf("Executing tool: %s with args: %v", fc.Name, args)
			result, execErr := lc.toolExecutor.Execute(ctx, fc.Name, args)
			status := "success"
			if execErr != nil {
				status = "error"
				result = fmt.Sprintf("Error: %s", execErr.Error())
			}
			recordToolCall(ctx, fc.Name, len([]byte(result)), status)

			allToolCalls = append(allToolCalls, ToolCallRecord{
				Name:   fc.Name,
				Args:   args,
				Result: result,
			})

			var resultMap map[string]any
			if json.Unmarshal([]byte(result), &resultMap) != nil {
				resultMap = map[string]any{"result": result}
			}
			funcResponses = append(funcResponses, genai.FunctionResponse{
				Name:     fc.Name,
				Response: resultMap,
			})
		}

		// Send function responses back to the model, stream the result
		nextIter := cs.SendMessageStream(ctx, funcResponses...)
		var toolUsage GeminiUsage
		for {
			resp, err := nextIter.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				recordGeminiRequest(ctx, lc.model, "tool_response", "error", toolUsage)
				// Tool rounds run only after the model has answered the first call.
				return nil, &turnError{ModelReached: true, err: fmt.Errorf("stream function response: %w", err)}
			}
			if usage := geminiUsageFromResponse(resp); usage.hasTokens() {
				toolUsage = usage
			}

			funcCalls := extractFunctionCalls(resp)
			if len(funcCalls) > 0 {
				pendingFuncCalls = append(pendingFuncCalls, funcCalls...)
				continue
			}

			text := extractTextContent(resp)
			if text != "" {
				onChunk(text)
			}
		}
		recordGeminiRequest(ctx, lc.model, "tool_response", "success", toolUsage)
		totalUsage.Add(toolUsage)

		// Without budget there is no round left to run calls in, so anything
		// the model requested in this response is dropped rather than looped on.
		if !hasBudget {
			break
		}
	}

	return &LLMResponse{
		ToolCalls: allToolCalls,
		Usage:     totalUsage,
	}, nil
}

// maxToolRounds is how many rounds of tool calls one turn may run.
const maxToolRounds = 5

// maxToolCallsPerRound caps the calls one model response may make. The model
// can ask for many at once, and each one is a database-backed tool call.
const maxToolCallsPerRound = 4

// roundHasBudget reports whether a zero-based round may still run tools.
func roundHasBudget(round int) bool {
	return round < maxToolRounds
}

// toolCallDecision says what happens to one call a model response requested.
type toolCallDecision int

const (
	toolCallExecute toolCallDecision = iota
	// toolCallOverCap: the response asked for more calls than one round runs.
	toolCallOverCap
	// toolCallNoBudget: the turn has no tool rounds left.
	toolCallNoBudget
)

// planToolCalls decides, for each of the n calls one response requested,
// whether it runs. Calls past the cap, or in a round without budget, are not
// run, but each still gets a response, because Gemini rejects a history with an
// unanswered call.
func planToolCalls(n int, roundHasBudget bool) []toolCallDecision {
	decisions := make([]toolCallDecision, n)
	for i := range decisions {
		switch {
		case !roundHasBudget:
			decisions[i] = toolCallNoBudget
		case i >= maxToolCallsPerRound:
			decisions[i] = toolCallOverCap
		default:
			decisions[i] = toolCallExecute
		}
	}
	return decisions
}

// toolCallNotice is the function response for a call that did not run. The
// wording is for the model, which reads it and answers the user.
func toolCallNotice(d toolCallDecision) map[string]any {
	if d == toolCallOverCap {
		return map[string]any{"error": fmt.Sprintf(
			"Only %d tool calls run per reply, so this call did not run. If it is still needed, ask for it in a later message.",
			maxToolCallsPerRound,
		)}
	}
	return map[string]any{"error": "The tool budget for this reply is spent, so this call did not run. Answer from the data already retrieved, and say plainly what is missing."}
}

// toolConfigFor returns the function calling config for a round. A round with
// no budget carries NONE, so the model must answer in text. The model is a
// pointer, so the next request reads whatever is set here.
func toolConfigFor(roundHasBudget bool) *genai.ToolConfig {
	if roundHasBudget {
		return nil
	}
	return &genai.ToolConfig{
		FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingNone},
	}
}

// buildGeminiTools converts our tool definitions to Gemini format.
func buildGeminiTools() []*genai.Tool {
	defs := GetToolDefinitions()
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

		funcDecls = append(funcDecls, &genai.FunctionDeclaration{
			Name:        def.Name,
			Description: def.Description,
			Parameters: &genai.Schema{
				Type:       genai.TypeObject,
				Properties: props,
				Required:   def.Required,
			},
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
