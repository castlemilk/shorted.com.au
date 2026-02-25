package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// LLMClient wraps the Gemini API for chat completions with function calling.
type LLMClient struct {
	client       *genai.Client
	model        string
	toolExecutor *ToolExecutor
}

// LLMResponse represents a response from the LLM.
type LLMResponse struct {
	Content   string
	ToolCalls []ToolCallRecord
	Citations []Citation
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
func NewLLMClient(ctx context.Context, apiKey, model string, toolExecutor *ToolExecutor) (*LLMClient, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}

	return &LLMClient{
		client:       client,
		model:        model,
		toolExecutor: toolExecutor,
	}, nil
}

// Close closes the underlying client.
func (lc *LLMClient) Close() {
	_ = lc.client.Close()
}

// Chat sends a message and processes tool calls, returning the final response.
func (lc *LLMClient) Chat(ctx context.Context, systemPrompt string, history []Message, userMessage string) (*LLMResponse, error) {
	model := lc.client.GenerativeModel(lc.model)
	model.SystemInstruction = genai.NewUserContent(genai.Text(systemPrompt))

	// Configure tools
	tools := buildGeminiTools()
	model.Tools = tools

	// Build chat session with history
	cs := model.StartChat()
	cs.History = buildGeminiHistory(history)

	// Send user message
	resp, err := cs.SendMessage(ctx, genai.Text(userMessage))
	if err != nil {
		return nil, fmt.Errorf("send message: %w", err)
	}

	var allToolCalls []ToolCallRecord

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
			if execErr != nil {
				result = fmt.Sprintf("Error: %s", execErr.Error())
			}

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
			return nil, fmt.Errorf("send function response: %w", err)
		}
	}

	// Extract final text response
	content := extractTextContent(resp)

	return &LLMResponse{
		Content:   content,
		ToolCalls: allToolCalls,
	}, nil
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
