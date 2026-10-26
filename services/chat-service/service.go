package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1/chatv1connect"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// ChatServiceHandler implements the ChatService Connect-RPC interface.
type ChatServiceHandler struct {
	store              *ConversationStore
	runner             turnRunner
	maxInputChars      int
	historyLimit       int
	maxMessagesPerConv int
	maxConversations   int
	internalSecret     string
	environment        string

	// ledger counts sends against limits. It is nil when there is no database,
	// and then SendMessage refuses before reaching it.
	ledger usageLedger
	limits chatSendLimits
	// admitTimeout bounds admission. Zero means chatAdmitTimeout.
	admitTimeout time.Duration
	// models picks each turn's model from the chat-model flag. Nil means the flag
	// is off, and every turn runs on the default runner.
	models *chatModelSelector
}

var _ chatv1connect.ChatServiceHandler = (*ChatServiceHandler)(nil)

// SetModelSelector turns on the per-user chat model flag. Without it, every turn
// runs on the env default, as it always has.
func (h *ChatServiceHandler) SetModelSelector(s *chatModelSelector) {
	h.models = s
}

// NewChatServiceHandler creates a new handler.
func NewChatServiceHandler(store *ConversationStore, runner turnRunner, cfg *Config) *ChatServiceHandler {
	if cfg == nil {
		cfg = &Config{
			ChatMaxInputChars:        2000,
			ChatHistoryLimit:         20,
			MaxMessagesPerConv:       100,
			MaxConversations:         100,
			Environment:              "development",
			ChatSendsPerMinute:       4,
			ChatSendsPerDay:          40,
			ChatSendsPerMonth:        600,
			ChatGlobalSendsPerMinute: 60,
		}
	}
	handler := &ChatServiceHandler{
		store:              store,
		runner:             runner,
		maxInputChars:      cfg.ChatMaxInputChars,
		historyLimit:       cfg.ChatHistoryLimit,
		maxMessagesPerConv: cfg.MaxMessagesPerConv,
		maxConversations:   cfg.MaxConversations,
		internalSecret:     cfg.InternalServiceSecret,
		environment:        cfg.Environment,
		limits: chatSendLimits{
			PerMinute:       cfg.ChatSendsPerMinute,
			PerDay:          cfg.ChatSendsPerDay,
			PerMonth:        cfg.ChatSendsPerMonth,
			GlobalPerMinute: cfg.ChatGlobalSendsPerMinute,
		},
		admitTimeout: chatAdmitTimeout,
	}
	// Assigned only when there is a store: a nil *ConversationStore inside a
	// non-nil interface would look configured to the limiter.
	if store != nil {
		handler.ledger = store
	}
	return handler
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
//
// Order matters. The message is validated first, so an oversized message costs
// nothing. The send is admitted against the limits before anything is written,
// so a refused send leaves no conversation or message behind. The model is
// called only after both.
func (h *ChatServiceHandler) SendMessage(
	ctx context.Context,
	req *connect.Request[chatv1.SendMessageRequest],
	stream *connect.ServerStream[chatv1.SendMessageResponse],
) (retErr error) {
	msg := req.Msg
	if err := validateChatMessage(msg.Message, h.maxInputChars); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
	if h.store == nil {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("chat persistence is not configured"))
	}
	if h.runner == nil || !h.runner.Ready() {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("chat model is not configured"))
	}
	recordChatExperienceEvent("send_message", "attempt", "")

	userID, err := h.authorizeChatRequest(req.Header())
	if err != nil {
		return err
	}

	// An existing conversation is resolved before admission, so a send that
	// names a conversation the caller cannot use spends no send.
	var conv *Conversation
	if msg.ConversationId != "" {
		conv, err = h.store.GetConversation(ctx, msg.ConversationId)
		if err != nil {
			return internalFailure("get conversation", err)
		}
		if conv == nil {
			return connect.NewError(connect.CodeNotFound, fmt.Errorf("conversation not found"))
		}
		if err := ensureConversationOwner(conv, userID); err != nil {
			return connect.NewError(connect.CodePermissionDenied, err)
		}
	}

	turn, err := h.admitSend(ctx, userID)
	if err != nil {
		return err
	}
	completion := sendCompletion{Model: h.runner.Model()}
	// reachedModel is set once the provider has answered. Until then a failure
	// is a failure before the model, and does not count against the limits.
	reachedModel := false
	defer func() {
		completion.Outcome = sendOutcome(ctx, retErr, reachedModel)
		turn.finish(ctx, completion)
	}()

	if conv == nil {
		// Create a new conversation, named after its first message.
		conv, err = h.store.CreateConversation(ctx, userID, conversationTitle(msg.Message), msg.ContextStockCode)
		if err != nil {
			return internalFailure("create conversation", err)
		}
	}
	completion.ConversationID = conv.ID

	// Store user message. A retry reuses its question when the failed attempt
	// stored it, and replaces only the partial reply that attempt kept. A
	// question the failed attempt never stored is stored now, as new.
	questionStored := false
	if msg.Retry && msg.ConversationId != "" {
		questionStored, err = h.replaceFailedReply(ctx, conv.ID, msg.Message)
		if err != nil {
			return internalFailure("replace failed reply", err)
		}
	}
	if !questionStored {
		_, err = h.store.AddMessage(ctx, conv.ID, "user", msg.Message, nil, nil)
		if err != nil {
			return internalFailure("store user message", err)
		}
		recordChatStorageWrite(ctx, "user")
	}

	// Name the conversation before the model runs. A turn can fail before any
	// text (the model errors, or a tool round does), and until this frame the
	// client had no id, so Try again created a second conversation.
	if err := announceConversation(stream, conv.ID); err != nil {
		return internalFailure("announce conversation", err)
	}

	// Get conversation history
	history, err := h.store.GetRecentMessages(ctx, conv.ID, h.historyLimit)
	if err != nil {
		return internalFailure("get history", err)
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

	llmResp, pick, err := h.runTurn(ctx, userID, TurnInput{System: systemPrompt, History: history, UserText: msg.Message}, onChunk, &completion)
	reachedModel = err == nil || modelAnswered(err)
	if err != nil {
		recordChatExperienceEvent("send_message", "error", "llm_error")
		h.keepPartialReply(ctx, conv.ID, fullContent)
		return modelFailure(err)
	}
	log.Printf("chat turn: provider=%s model=%s route=%s route_source=%s route_label=%s first_call_violation=%t est_cost_micro_usd=%d",
		llmResp.Provider, llmResp.Model, pick.routeForLog(), pick.Source, llmResp.Route, llmResp.FirstCallViolation, llmResp.EstCostMicroUSD)

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
		return internalFailure("store assistant message", err)
	}
	recordChatStorageWrite(ctx, "assistant")
	if pruned, pruneErr := h.store.PruneMessages(ctx, conv.ID, h.maxMessagesPerConv); pruneErr != nil {
		logRedacted("chat prune failed for conversation %s: %v", conv.ID, pruneErr)
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
		return internalFailure("send response", err)
	}

	return nil
}

// flagPick is how a turn's model was chosen: the route id the flag named ("" for
// the default) and the outcome, which says why.
type flagPick struct {
	Route  string
	Source string
}

// routeForLog is the route id for a log line, with "default" for the env default.
func (p flagPick) routeForLog() string {
	if p.Route == "" {
		return "default"
	}
	return p.Route
}

// runTurn plays one turn on the model the flag picks for this user, and records
// the answering model on the ledger's completion. The flag can only pick a route
// the registry built, and it never fails the turn: a choice that is not usable
// is the default runner.
func (h *ChatServiceHandler) runTurn(ctx context.Context, userID string, in TurnInput, onChunk func(string), completion *sendCompletion) (*LLMResponse, flagPick, error) {
	runner, pick := h.pickRunner(ctx, userID)
	completion.Model = runner.Model()
	resp, err := runner.RunTurn(ctx, userID, in, onChunk)
	if err != nil {
		recordTurnOnLedger(completion, nil, err)
		log.Printf("chat turn failed: model=%s route=%s route_source=%s", runner.Model(), pick.routeForLog(), pick.Source)
		return nil, pick, err
	}
	recordTurnOnLedger(completion, resp, nil)
	return resp, pick, nil
}

// pickRunner returns the runner for a turn, and how it was chosen.
func (h *ChatServiceHandler) pickRunner(ctx context.Context, userID string) (turnRunner, flagPick) {
	if h.models == nil {
		return h.runner, flagPick{Source: flagOutcomeUnconfigured}
	}
	route, source := h.models.choose(ctx, userID)
	if r := h.models.routeFor(route); r != nil {
		return r, flagPick{Route: route, Source: source}
	}
	return h.runner, flagPick{Source: source}
}

// replaceFailedReply makes a retry of question idempotent. It reads the stored
// tail, deletes the partial reply a failed attempt left after the question, and
// reports whether the question itself is already stored.
func (h *ChatServiceHandler) replaceFailedReply(ctx context.Context, conversationID, question string) (bool, error) {
	recent, err := h.store.GetRecentMessages(ctx, conversationID, 2)
	if err != nil {
		return false, fmt.Errorf("get recent messages: %w", err)
	}
	stored, partialID := retryTail(recent, question)
	if partialID != "" {
		if err := h.store.DeletePartialReply(ctx, conversationID, partialID); err != nil {
			return false, err
		}
	}
	return stored, nil
}

// conversationTitleRunes is how many characters of its first message name a
// new conversation.
const conversationTitleRunes = 100

// conversationTitle names a conversation after its first message. It cuts on
// characters, not bytes. A byte cut can split a multi-byte character, Postgres
// rejects the invalid UTF-8 that leaves, and the send failed with no reply.
func conversationTitle(message string) string {
	runes := []rune(message)
	if len(runes) <= conversationTitleRunes {
		return message
	}
	return string(runes[:conversationTitleRunes]) + "..."
}

// retryTail reads the last stored messages, in chronological order, against the
// question a retry asks again. The question is already stored when it is the
// latest message, or when the latest is a partial reply its failed attempt kept
// (Partial) with the question just before it. In that second case partialID
// names the reply to replace. A complete reply is never named, so a repeated
// question whose earlier answer is complete is stored as a new question, and
// the answer the person already received stays. Anything else is not a retry
// of this question, and the question is stored as a new one.
func retryTail(recent []Message, question string) (questionStored bool, partialID string) {
	n := len(recent)
	if n == 0 {
		return false, ""
	}
	last := recent[n-1]
	if last.Role == "user" && last.Content == question {
		return true, ""
	}
	if last.Role == "assistant" && last.Partial && n >= 2 {
		if prev := recent[n-2]; prev.Role == "user" && prev.Content == question {
			return true, last.ID
		}
	}
	return false, ""
}

// frameSender is the part of the response stream the frames above need.
type frameSender interface {
	Send(*chatv1.SendMessageResponse) error
}

// announceConversation sends the conversation id as a frame of its own, with no
// text, so the client learns the id before any text or failure can arrive.
func announceConversation(stream frameSender, conversationID string) error {
	return stream.Send(&chatv1.SendMessageResponse{ConversationId: conversationID})
}

// keepPartialReply stores what the model streamed before its turn failed or was
// canceled, so a reload shows what the user saw. It writes with a context that
// outlives the request, because a canceled stream is exactly when this matters,
// and the write is bounded by usageWriteTimeout.
func (h *ChatServiceHandler) keepPartialReply(ctx context.Context, conversationID, content string) {
	if content == "" {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), usageWriteTimeout)
	defer cancel()
	if _, err := h.store.AddPartialReply(writeCtx, conversationID, content); err != nil {
		logRedacted("chat: keep partial reply for conversation %s: %v", conversationID, err)
		return
	}
	recordChatStorageWrite(writeCtx, "assistant")
	if _, err := h.store.PruneMessages(writeCtx, conversationID, h.maxMessagesPerConv); err != nil {
		logRedacted("chat prune failed for conversation %s: %v", conversationID, err)
	}
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
		return nil, internalFailure("get conversation history", err)
	}
	if conv == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("conversation not found"))
	}
	if err := ensureConversationOwner(conv, userID); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	messages, err := h.store.GetMessages(ctx, req.Msg.ConversationId, h.maxMessagesPerConv)
	if err != nil {
		return nil, internalFailure("get messages", err)
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
		return nil, internalFailure("list conversations", err)
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
		return nil, internalFailure("delete conversation", err)
	}

	return connect.NewResponse(&chatv1.DeleteConversationResponse{
		Success: true,
	}), nil
}
