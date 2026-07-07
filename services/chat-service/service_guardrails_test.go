package main

import (
	"net/http"
	"testing"
)

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

func TestValidateInternalServiceSecretRequiresSecretInProduction(t *testing.T) {
	headers := http.Header{}

	if err := validateInternalServiceSecret(headers, "", "production"); err == nil {
		t.Fatal("validateInternalServiceSecret() error = nil, want missing config error")
	}
}

func TestValidateInternalServiceSecretRejectsMissingOrWrongSecret(t *testing.T) {
	headers := http.Header{}
	if err := validateInternalServiceSecret(headers, "expected", "production"); err == nil {
		t.Fatal("validateInternalServiceSecret() error = nil, want missing header error")
	}

	headers.Set("X-Internal-Secret", "wrong")
	if err := validateInternalServiceSecret(headers, "expected", "production"); err == nil {
		t.Fatal("validateInternalServiceSecret() error = nil, want invalid header error")
	}
}

func TestValidateInternalServiceSecretAllowsMatchingSecret(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-Internal-Secret", "expected")

	if err := validateInternalServiceSecret(headers, "expected", "production"); err != nil {
		t.Fatalf("validateInternalServiceSecret() error = %v, want nil", err)
	}
}

func TestTrustedChatUserIDRejectsMissingHeader(t *testing.T) {
	if _, err := trustedChatUserID(http.Header{}); err == nil {
		t.Fatal("trustedChatUserID() error = nil, want missing user error")
	}
}

func TestEnsureConversationOwnerRejectsCrossUserAccess(t *testing.T) {
	conv := &Conversation{ID: "conv-1", UserID: "owner"}

	if err := ensureConversationOwner(conv, "attacker"); err == nil {
		t.Fatal("ensureConversationOwner() error = nil, want ownership error")
	}

	if err := ensureConversationOwner(conv, "owner"); err != nil {
		t.Fatalf("ensureConversationOwner() error = %v, want nil", err)
	}
}
