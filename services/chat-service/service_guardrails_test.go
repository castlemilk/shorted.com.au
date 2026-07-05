package main

import "testing"

func TestValidateChatMessageRejectsEmptyMessage(t *testing.T) {
	if err := validateChatMessage("", 10); err == nil {
		t.Fatal("validateChatMessage() error = nil, want empty message error")
	}
}

func TestValidateChatMessageRejectsOversizedMessageByRuneCount(t *testing.T) {
	if err := validateChatMessage("abcd", 3); err == nil {
		t.Fatal("validateChatMessage() error = nil, want oversized message error")
	}

	if err := validateChatMessage("日本語", 3); err != nil {
		t.Fatalf("validateChatMessage() error = %v, want nil for 3 runes", err)
	}
}

func TestValidateChatMessageAllowsUnlimitedWhenLimitIsZero(t *testing.T) {
	if err := validateChatMessage("abcd", 0); err != nil {
		t.Fatalf("validateChatMessage() error = %v, want nil", err)
	}
}
