package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// ChatServiceHandler implements the ChatService Connect-RPC interface.
type ChatServiceHandler struct {
	store              *ConversationStore
	llmClient          *LLMClient
	maxInputChars      int
	historyLimit       int
	maxMessagesPerConv int
	maxConversations   int
	internalSecret     string
	environment        string
}

var _ chatv1connect.ChatServiceHandler = (*ChatServiceHandler)(nil)

// NewChatServiceHandler creates a new handler.
func NewChatServiceHandler(store *ConversationStore, llmClient *LLMClient, cfg *Config) *ChatServiceHandler {
	if cfg == nil {
		cfg = &Config{
			ChatMaxInputChars:  2000,
			ChatHistoryLimit:   20,
			MaxMessagesPerConv: 100,
			MaxConversations:   100,
			Environment:        "development",
		}
	}
	return &ChatServiceHandler{
		store:              store,
		llmClient:          llmClient,
		maxInputChars:      cfg.ChatMaxInputChars,
		historyLimit:       cfg.ChatHistoryLimit,
		maxMessagesPerConv: cfg.MaxMessagesPerConv,
		maxConversations:   cfg.MaxConversations,
		internalSecret:     cfg.InternalServiceSecret,
		environment:        cfg.Environment,
	}
}

func validateChatMessage(message string, maxChars int) error {
	if message == "" {
		return fmt.Errorf("message is required")
	}
	if maxChars > 0 && utf8.RuneCountInString(message) > maxChars {
		return fmt.Errorf("message exceeds %d characters", maxChars)
	}
	return nil
}

func validateInternalServiceSecret(headers http.Header, expectedSecret string, environment string) error {
	expected := strings.TrimSpace(expectedSecret)
	if expected == "" {
		if strings.EqualFold(environment, "production") {
			return fmt.Errorf("internal service secret is not configured")
		}
		return nil
	}

	provided := strings.TrimSpace(headers.Get("X-Internal-Secret"))
	if provided == "" {
		return fmt.Errorf("internal service secret is required")
	}
	if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		return fmt.Errorf("internal service secret is invalid")
	}
	return nil
}

func trustedChatUserID(headers http.Header) (string, error) {
	userID := strings.TrimSpace(headers.Get("X-User-Id"))
	if userID == "" {
		return "", fmt.Errorf("X-User-Id header is required")
	}
	return userID, nil
}

func ensureConversationOwner(conv *Conversation, userID string) error {
	if conv == nil {
		return nil
	}
	if conv.UserID != userID {
		return fmt.Errorf("conversation not found")
	}
	return nil
}

func (h *ChatServiceHandler) authorizeChatRequest(headers http.Header) (string, error) {
	if err := validateInternalServiceSecret(headers, h.internalSecret, h.environment); err != nil {
		return "", connect.NewError(connect.CodeUnauthenticated, err)
	}
	userID, err := trustedChatUserID(headers)
	if err != nil {
		return "", connect.NewError(connect.CodeUnauthenticated, err)
	}
	return userID, nil
}

// SendMessage handles a chat message, executing tools and returning the assistant response.
func (h *ChatServiceHandler) SendMessage(
	ctx context.Context,
	req *connect.Request[chatv1.SendMessageRequest],
	stream *connect.ServerStream[chatv1.SendMessageResponse],
) error {
	msg := req.Msg
	if err := validateChatMessage(msg.Message, h.maxInputChars); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
	if h.store == nil {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("chat persistence is not configured"))
	}
	if h.llmClient == nil {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("chat model is not configured"))
	}
	recordChatExperienceEvent("send_message", "attempt", "")

	userID, err := h.authorizeChatRequest(req.Header())
	if err != nil {
		return err
	}

	// Get or create conversation
	var conv *Conversation
	if msg.ConversationId != "" {
		conv, err = h.store.GetConversation(ctx, msg.ConversationId)
		if err != nil {
			return connect.NewError(connect.CodeInternal, fmt.Errorf("get conversation: %w", err))
		}
		if conv == nil {
			return connect.NewError(connect.CodeNotFound, fmt.Errorf("conversation not found"))
		}
		if err := ensureConversationOwner(conv, userID); err != nil {
			return connect.NewError(connect.CodePermissionDenied, err)
		}
	} else {
		// Create new conversation with first message as title
		title := msg.Message
		if len(title) > 100 {
			title = title[:100] + "..."
		}
		conv, err = h.store.CreateConversation(ctx, userID, title, msg.ContextStockCode)
		if err != nil {
			return connect.NewError(connect.CodeInternal, fmt.Errorf("create conversation: %w", err))
		}
	}

	// Store user message
	_, err = h.store.AddMessage(ctx, conv.ID, "user", msg.Message, nil, nil)
	if err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("store user message: %w", err))
	}
	recordChatStorageWrite(ctx, "user")

	// Get conversation history
	history, err := h.store.GetRecentMessages(ctx, conv.ID, h.historyLimit)
	if err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("get history: %w", err))
	}

	// Remove the just-added user message from history (it will be sent as the current message)
	if len(history) > 0 {
		history = history[:len(history)-1]
	}

	// Build system prompt
	systemPrompt := BuildSystemPrompt(conv.ContextStockCode)

	// Stream LLM response token-by-token
	var fullContent string
	onChunk := func(text string) {
		fullContent += text
		// Send each text chunk as it arrives
		_ = stream.Send(&chatv1.SendMessageResponse{
			ConversationId: conv.ID,
			Chunk:          text,
			IsComplete:     false,
		})
	}

	llmResp, err := h.llmClient.ChatStream(ctx, systemPrompt, history, msg.Message, onChunk)
	if err != nil {
		log.Printf("LLM error: %v", err)
		recordChatExperienceEvent("send_message", "error", "llm_error")
		return connect.NewError(connect.CodeInternal, fmt.Errorf("chat error: %w", err))
	}

	// Marshal tool calls and citations for storage
	var toolCallsJSON, citationsJSON json.RawMessage
	if len(llmResp.ToolCalls) > 0 {
		toolCallsJSON, _ = json.Marshal(llmResp.ToolCalls)
	}
	if len(llmResp.Citations) > 0 {
		citationsJSON, _ = json.Marshal(llmResp.Citations)
	}

	// Store assistant message
	_, err = h.store.AddMessage(ctx, conv.ID, "assistant", fullContent, toolCallsJSON, citationsJSON)
	if err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("store assistant message: %w", err))
	}
	recordChatStorageWrite(ctx, "assistant")
	if pruned, pruneErr := h.store.PruneMessages(ctx, conv.ID, h.maxMessagesPerConv); pruneErr != nil {
		log.Printf("chat prune failed for conversation %s: %v", conv.ID, pruneErr)
	} else {
		recordChatMessagesPruned(ctx, pruned)
	}
	recordChatExperienceEvent("send_message", "success", "")

	// Build proto tool calls for final chunk
	var protoToolCalls []*chatv1.ToolCall
	for _, tc := range llmResp.ToolCalls {
		argsJSON, _ := json.Marshal(tc.Args)
		protoToolCalls = append(protoToolCalls, &chatv1.ToolCall{
			ToolName:  tc.Name,
			Arguments: string(argsJSON),
			Result:    tc.Result,
		})
	}

	// Build proto citations for final chunk
	var protoCitations []*chatv1.Citation
	for _, c := range llmResp.Citations {
		protoCitations = append(protoCitations, &chatv1.Citation{
			SourceType: c.Source,
			Reference:  c.Text,
		})
	}

	// Send final completion chunk with tool calls and citations
	if err := stream.Send(&chatv1.SendMessageResponse{
		ConversationId: conv.ID,
		Chunk:          "",
		IsComplete:     true,
		ToolCalls:      protoToolCalls,
		Citations:      protoCitations,
	}); err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("send response: %w", err))
	}

	return nil
}

// GetConversationHistory returns messages for a conversation.
func (h *ChatServiceHandler) GetConversationHistory(
	ctx context.Context,
	req *connect.Request[chatv1.GetConversationHistoryRequest],
) (*connect.Response[chatv1.GetConversationHistoryResponse], error) {
	userID, authErr := h.authorizeChatRequest(req.Header())
	if authErr != nil {
		return nil, authErr
	}
	if req.Msg.ConversationId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("conversation_id is required"))
	}

	conv, err := h.store.GetConversation(ctx, req.Msg.ConversationId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if conv == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("conversation not found"))
	}
	if err := ensureConversationOwner(conv, userID); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	messages, err := h.store.GetMessages(ctx, req.Msg.ConversationId, h.maxMessagesPerConv)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	var protoMsgs []*chatv1.ChatMessage
	for _, msg := range messages {
		var role chatv1.MessageRole
		switch msg.Role {
		case "assistant":
			role = chatv1.MessageRole_MESSAGE_ROLE_ASSISTANT
		case "system":
			role = chatv1.MessageRole_MESSAGE_ROLE_SYSTEM
		default:
			role = chatv1.MessageRole_MESSAGE_ROLE_USER
		}

		protoMsg := &chatv1.ChatMessage{
			Id:        msg.ID,
			Role:      role,
			Content:   msg.Content,
			CreatedAt: timestamppb.New(msg.CreatedAt),
		}

		// Parse tool calls
		if len(msg.ToolCalls) > 0 {
			var toolCalls []ToolCallRecord
			if json.Unmarshal(msg.ToolCalls, &toolCalls) == nil {
				for _, tc := range toolCalls {
					argsJSON, _ := json.Marshal(tc.Args)
					protoMsg.ToolCalls = append(protoMsg.ToolCalls, &chatv1.ToolCall{
						ToolName:  tc.Name,
						Arguments: string(argsJSON),
						Result:    tc.Result,
					})
				}
			}
		}

		protoMsgs = append(protoMsgs, protoMsg)
	}

	return connect.NewResponse(&chatv1.GetConversationHistoryResponse{
		ConversationId:   conv.ID,
		Title:            conv.Title,
		ContextStockCode: conv.ContextStockCode,
		Messages:         protoMsgs,
	}), nil
}

// ListConversations returns conversations for a user.
func (h *ChatServiceHandler) ListConversations(
	ctx context.Context,
	req *connect.Request[chatv1.ListConversationsRequest],
) (*connect.Response[chatv1.ListConversationsResponse], error) {
	userID, authErr := h.authorizeChatRequest(req.Header())
	if authErr != nil {
		return nil, authErr
	}

	limit := int(req.Msg.Limit)
	if limit <= 0 {
		limit = 20
	}
	if h.maxConversations > 0 && limit > h.maxConversations {
		limit = h.maxConversations
	}

	convs, err := h.store.ListConversations(ctx, userID, limit)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	var protoConvs []*chatv1.ConversationSummary
	for _, conv := range convs {
		protoConvs = append(protoConvs, &chatv1.ConversationSummary{
			Id:               conv.ID,
			Title:            conv.Title,
			ContextStockCode: conv.ContextStockCode,
			CreatedAt:        timestamppb.New(conv.CreatedAt),
			UpdatedAt:        timestamppb.New(conv.UpdatedAt),
		})
	}

	return connect.NewResponse(&chatv1.ListConversationsResponse{
		Conversations: protoConvs,
		TotalCount:    int32(len(protoConvs)),
	}), nil
}

// DeleteConversation deletes a conversation.
func (h *ChatServiceHandler) DeleteConversation(
	ctx context.Context,
	req *connect.Request[chatv1.DeleteConversationRequest],
) (*connect.Response[chatv1.DeleteConversationResponse], error) {
	userID, authErr := h.authorizeChatRequest(req.Header())
	if authErr != nil {
		return nil, authErr
	}
	if req.Msg.ConversationId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("conversation_id is required"))
	}

	if err := h.store.DeleteConversation(ctx, req.Msg.ConversationId, userID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&chatv1.DeleteConversationResponse{
		Success: true,
	}), nil
}
