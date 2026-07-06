package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireInternalSecretRejectsMissingSecret(t *testing.T) {
	handler := requireInternalSecret("server-secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodPost, "/chat.v1.ChatService/SendMessage", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireInternalSecretRejectsWrongSecret(t *testing.T) {
	handler := requireInternalSecret("server-secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodPost, "/chat.v1.ChatService/SendMessage", nil)
	req.Header.Set("X-Internal-Secret", "attacker")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireInternalSecretAllowsMatchingSecret(t *testing.T) {
	called := false
	handler := requireInternalSecret("server-secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/chat.v1.ChatService/SendMessage", nil)
	req.Header.Set("X-Internal-Secret", "server-secret")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if !called {
		t.Fatal("next handler was not called")
	}
}

func TestRequireInternalSecretFailsClosedWhenSecretNotConfigured(t *testing.T) {
	handler := requireInternalSecret("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodPost, "/chat.v1.ChatService/SendMessage", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
