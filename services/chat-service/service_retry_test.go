package main

import "testing"

func TestRetryTailFindsTheQuestionAlreadyStored(t *testing.T) {
	user := func(id, content string) Message { return Message{ID: id, Role: "user", Content: content} }
	reply := func(id, content string) Message { return Message{ID: id, Role: "assistant", Content: content} }
	partial := func(id, content string) Message {
		return Message{ID: id, Role: "assistant", Content: content, Partial: true}
	}

	tests := []struct {
		name        string
		recent      []Message
		question    string
		wantStored  bool
		wantPartial string
	}{
		{
			name:       "no history: the question is new",
			recent:     nil,
			question:   "Q",
			wantStored: false,
		},
		{
			name:       "failed before any text: the question is the latest message",
			recent:     []Message{reply("a0", "earlier"), user("u1", "Q")},
			question:   "Q",
			wantStored: true,
		},
		{
			name:        "failed after a partial reply: replace it, keep the question",
			recent:      []Message{user("u1", "Q"), partial("a1", "partial")},
			question:    "Q",
			wantStored:  true,
			wantPartial: "a1",
		},
		{
			// The regression: a repeated question whose earlier answer is complete.
			// A failure before storage must not remove that answer.
			name:       "a complete reply to a repeated question is never replaced",
			recent:     []Message{user("u1", "Tell me more"), reply("a1", "complete answer")},
			question:   "Tell me more",
			wantStored: false,
		},
		{
			name:       "a complete reply is not replaced even when the question matches an earlier one",
			recent:     []Message{user("u0", "Q"), reply("a0", "first answer"), user("u1", "Q2"), reply("a1", "second answer")},
			question:   "Q",
			wantStored: false,
		},
		{
			name:       "a different question is stored as new",
			recent:     []Message{user("u1", "Q1")},
			question:   "Q2",
			wantStored: false,
		},
		{
			name:       "a different question after a partial reply does not replace it",
			recent:     []Message{user("u1", "Q1"), partial("a1", "partial")},
			question:   "Q2",
			wantStored: false,
		},
		{
			name:       "a reply with no question before it is not a retry",
			recent:     []Message{reply("a1", "orphan")},
			question:   "Q",
			wantStored: false,
		},
		{
			name:       "a partial reply with no question before it is not a retry",
			recent:     []Message{partial("a1", "orphan")},
			question:   "Q",
			wantStored: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stored, partial := retryTail(tt.recent, tt.question)
			if stored != tt.wantStored || partial != tt.wantPartial {
				t.Fatalf("retryTail() = (%v, %q), want (%v, %q)", stored, partial, tt.wantStored, tt.wantPartial)
			}
		})
	}
}
