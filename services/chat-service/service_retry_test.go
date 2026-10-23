package main

import "testing"

func TestRetryTailFindsTheQuestionAlreadyStored(t *testing.T) {
	user := func(id, content string) Message { return Message{ID: id, Role: "user", Content: content} }
	reply := func(id, content string) Message { return Message{ID: id, Role: "assistant", Content: content} }

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
			recent:      []Message{user("u1", "Q"), reply("a1", "partial")},
			question:    "Q",
			wantStored:  true,
			wantPartial: "a1",
		},
		{
			name:       "a different question is stored as new",
			recent:     []Message{user("u1", "Q1")},
			question:   "Q2",
			wantStored: false,
		},
		{
			name:       "a different question after a partial reply does not replace it",
			recent:     []Message{user("u1", "Q1"), reply("a1", "partial")},
			question:   "Q2",
			wantStored: false,
		},
		{
			name:       "a reply with no question before it is not a retry",
			recent:     []Message{reply("a1", "orphan")},
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
