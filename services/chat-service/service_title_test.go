package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The title is cut on characters. A byte cut at 100 split CJK and emoji
// characters, Postgres rejected the invalid UTF-8, and the first send failed.
func TestConversationTitleCutsOnCharacterBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		message string
		want    string
	}{
		{
			name:    "a short message is the title",
			message: "What is BHP short interest?",
			want:    "What is BHP short interest?",
		},
		{
			name:    "exactly 100 characters is not cut",
			message: strings.Repeat("a", 100),
			want:    strings.Repeat("a", 100),
		},
		{
			name:    "101 characters is cut to 100 and marked",
			message: strings.Repeat("a", 101),
			want:    strings.Repeat("a", 100) + "...",
		},
		{
			// 39 characters is 117 bytes: a byte cut at 100 landed inside one.
			name:    "a CJK question past 100 bytes is kept whole",
			message: strings.Repeat("中", 39),
			want:    strings.Repeat("中", 39),
		},
		{
			name:    "CJK past 100 characters is cut between characters",
			message: strings.Repeat("中", 120),
			want:    strings.Repeat("中", 100) + "...",
		},
		{
			// 30 emoji and one letter is 121 bytes. Four-byte emoji split on a byte cut.
			name:    "emoji past byte 100 is kept whole",
			message: "a" + strings.Repeat("😀", 30),
			want:    "a" + strings.Repeat("😀", 30),
		},
		{
			name:    "emoji past 100 characters is cut between characters",
			message: strings.Repeat("😀", 101),
			want:    strings.Repeat("😀", 100) + "...",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := conversationTitle(tt.message)
			if got != tt.want {
				t.Fatalf("conversationTitle() = %q, want %q", got, tt.want)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("conversationTitle() produced invalid UTF-8: %q", got)
			}
		})
	}
}
