package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConversationStore manages chat conversations and messages in PostgreSQL.
type ConversationStore struct {
	pool *pgxpool.Pool
}

// Conversation represents a chat conversation.
type Conversation struct {
	ID               string    `json:"id"`
	UserID           string    `json:"userId"`
	Title            string    `json:"title"`
	ContextStockCode string    `json:"contextStockCode,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// Message represents a single chat message.
type Message struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Role           string          `json:"role"` // "user", "assistant", "tool"
	Content        string          `json:"content"`
	ToolCalls      json.RawMessage `json:"toolCalls,omitempty"`
	Citations      json.RawMessage `json:"citations,omitempty"`
	// Partial marks an assistant reply that a failed turn kept. Only a retry of
	// that turn may remove it. A complete reply is never Partial.
	Partial   bool      `json:"partial,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// NewConversationStore creates a new store with the given connection pool.
func NewConversationStore(pool *pgxpool.Pool) *ConversationStore {
	return &ConversationStore{pool: pool}
}

// CreateConversation creates a new conversation.
func (s *ConversationStore) CreateConversation(ctx context.Context, userID, title, contextStockCode string) (*Conversation, error) {
	id := uuid.New().String()
	now := time.Now()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO chat_conversations (id, user_id, title, context_stock_code, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		id, userID, title, nullIfEmpty(contextStockCode), now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create conversation: %w", err)
	}

	return &Conversation{
		ID:               id,
		UserID:           userID,
		Title:            title,
		ContextStockCode: contextStockCode,
		CreatedAt:        now,
		UpdatedAt:        now,
	}, nil
}

// GetConversation returns a conversation by ID.
func (s *ConversationStore) GetConversation(ctx context.Context, conversationID string) (*Conversation, error) {
	var conv Conversation
	var contextStock *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, user_id, title, context_stock_code, created_at, updated_at
		 FROM chat_conversations WHERE id = $1`, conversationID,
	).Scan(&conv.ID, &conv.UserID, &conv.Title, &contextStock, &conv.CreatedAt, &conv.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get conversation: %w", err)
	}
	if contextStock != nil {
		conv.ContextStockCode = *contextStock
	}
	return &conv, nil
}

// ListConversations returns conversations for a user.
func (s *ConversationStore) ListConversations(ctx context.Context, userID string, limit int) ([]Conversation, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, title, context_stock_code, created_at, updated_at
		 FROM chat_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
		userID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()

	var convs []Conversation
	for rows.Next() {
		var conv Conversation
		var contextStock *string
		if err := rows.Scan(&conv.ID, &conv.UserID, &conv.Title, &contextStock, &conv.CreatedAt, &conv.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan conversation: %w", err)
		}
		if contextStock != nil {
			conv.ContextStockCode = *contextStock
		}
		convs = append(convs, conv)
	}
	return convs, nil
}

// DeleteConversation deletes a conversation and its messages (CASCADE).
func (s *ConversationStore) DeleteConversation(ctx context.Context, conversationID, userID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2`,
		conversationID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("conversation not found or not owned by user")
	}
	return nil
}

// AddMessage adds a complete message to a conversation.
func (s *ConversationStore) AddMessage(ctx context.Context, conversationID, role, content string, toolCalls, citations json.RawMessage) (*Message, error) {
	return s.addMessage(ctx, conversationID, role, content, toolCalls, citations, false)
}

// AddPartialReply stores the assistant reply a failed turn kept, marked Partial.
// Only a retry of that turn may replace it, and only while it is the latest
// reply after the question.
func (s *ConversationStore) AddPartialReply(ctx context.Context, conversationID, content string) (*Message, error) {
	return s.addMessage(ctx, conversationID, "assistant", content, nil, nil, true)
}

func (s *ConversationStore) addMessage(ctx context.Context, conversationID, role, content string, toolCalls, citations json.RawMessage, partial bool) (*Message, error) {
	id := uuid.New().String()
	now := time.Now()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO chat_messages (id, conversation_id, role, content, tool_calls, citations, partial, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, conversationID, role, content, nullJSONIfEmpty(toolCalls), nullJSONIfEmpty(citations), partial, now,
	)
	if err != nil {
		return nil, fmt.Errorf("add message: %w", err)
	}

	return &Message{
		ID:             id,
		ConversationID: conversationID,
		Role:           role,
		Content:        content,
		ToolCalls:      toolCalls,
		Citations:      citations,
		Partial:        partial,
		CreatedAt:      now,
	}, nil
}

// GetMessages returns messages for a conversation.
func (s *ConversationStore) GetMessages(ctx context.Context, conversationID string, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, tool_calls, citations, partial, created_at
		 FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`,
		conversationID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	defer rows.Close()

	var msgs []Message
	for rows.Next() {
		var msg Message
		var tc, cit *json.RawMessage
		if err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.Role, &msg.Content, &tc, &cit, &msg.Partial, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		if tc != nil {
			msg.ToolCalls = *tc
		}
		if cit != nil {
			msg.Citations = *cit
		}
		msgs = append(msgs, msg)
	}
	return msgs, nil
}

// GetRecentMessages returns the most recent messages for a conversation in
// chronological order, suitable for feeding bounded context back to the model.
func (s *ConversationStore) GetRecentMessages(ctx context.Context, conversationID string, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, tool_calls, citations, partial, created_at
		 FROM (
		     SELECT id, conversation_id, role, content, tool_calls, citations, partial, created_at
		     FROM chat_messages
		     WHERE conversation_id = $1
		     ORDER BY created_at DESC
		     LIMIT $2
		 ) recent
		 ORDER BY created_at ASC`,
		conversationID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get recent messages: %w", err)
	}
	defer rows.Close()

	var msgs []Message
	for rows.Next() {
		var msg Message
		var tc, cit *json.RawMessage
		if err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.Role, &msg.Content, &tc, &cit, &msg.Partial, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan recent message: %w", err)
		}
		if tc != nil {
			msg.ToolCalls = *tc
		}
		if cit != nil {
			msg.Citations = *cit
		}
		msgs = append(msgs, msg)
	}
	return msgs, nil
}

// DeletePartialReply removes a partial assistant reply from a conversation. A
// retry uses it to replace the reply its failed attempt kept. The statement
// itself requires a Partial assistant row in this conversation, so no caller
// can remove a complete reply or a user message through it.
func (s *ConversationStore) DeletePartialReply(ctx context.Context, conversationID, messageID string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM chat_messages
		 WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' AND partial`,
		messageID, conversationID,
	)
	if err != nil {
		return fmt.Errorf("delete partial reply: %w", err)
	}
	return nil
}

// PruneMessages deletes old messages beyond maxMessages for a conversation.
func (s *ConversationStore) PruneMessages(ctx context.Context, conversationID string, maxMessages int) (int64, error) {
	if maxMessages <= 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx,
		`WITH keep AS (
		     SELECT id
		     FROM chat_messages
		     WHERE conversation_id = $1
		     ORDER BY created_at DESC
		     LIMIT $2
		 )
		 DELETE FROM chat_messages
		 WHERE conversation_id = $1
		   AND id NOT IN (SELECT id FROM keep)`,
		conversationID, maxMessages,
	)
	if err != nil {
		return 0, fmt.Errorf("prune messages: %w", err)
	}
	return tag.RowsAffected(), nil
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullJSONIfEmpty(data json.RawMessage) *json.RawMessage {
	if len(data) == 0 || string(data) == "null" {
		return nil
	}
	return &data
}
