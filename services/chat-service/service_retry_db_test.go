package main

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRetryReplacesThePartialReplyAgainstPostgres runs the retry path against a
// real database, which the unit tests cannot do. It is skipped unless
// CHAT_LIMITS_TEST_DATABASE_URL is set, and needs the chat tables from 000026.
// It writes rows only for a fresh user id, and removes them afterwards.
func TestRetryReplacesThePartialReplyAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("CHAT_LIMITS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CHAT_LIMITS_TEST_DATABASE_URL to run the retry path against Postgres")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)
	store := NewConversationStore(pool)
	handler := &ChatServiceHandler{store: store}

	user := "retry-test-" + uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM chat_conversations WHERE user_id = $1`, user)
	})

	conv, err := store.CreateConversation(ctx, user, "retry", "")
	if err != nil {
		t.Fatalf("CreateConversation() error = %v", err)
	}
	question, err := store.AddMessage(ctx, conv.ID, "user", "What is shorted?", nil, nil)
	if err != nil {
		t.Fatalf("AddMessage(user) error = %v", err)
	}
	if _, err := store.AddMessage(ctx, conv.ID, "assistant", "A partial answer", nil, nil); err != nil {
		t.Fatalf("AddMessage(partial) error = %v", err)
	}

	stored, err := handler.replaceFailedReply(ctx, conv.ID, "What is shorted?")
	if err != nil {
		t.Fatalf("replaceFailedReply() error = %v", err)
	}
	if !stored {
		t.Fatal("replaceFailedReply() reports the question is not stored, want stored")
	}

	msgs, err := store.GetMessages(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("GetMessages() error = %v", err)
	}
	if len(msgs) != 1 || msgs[0].ID != question.ID || msgs[0].Role != "user" {
		t.Fatalf("after retry the conversation holds %d messages, want only the question", len(msgs))
	}

	// A question that was never stored is not reused, and nothing is deleted.
	stored, err = handler.replaceFailedReply(ctx, conv.ID, "A different question")
	if err != nil {
		t.Fatalf("replaceFailedReply(other) error = %v", err)
	}
	if stored {
		t.Fatal("replaceFailedReply(other) reports a question that is not stored")
	}
	if msgs, _ := store.GetMessages(ctx, conv.ID, 10); len(msgs) != 1 {
		t.Fatalf("a non-matching retry changed the conversation: %d messages", len(msgs))
	}
}
