package main

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

const internalSecretHeader = "X-Internal-Secret"

func requireInternalSecret(secret string, next http.Handler) http.Handler {
	expected := strings.TrimSpace(secret)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if expected == "" {
			http.Error(w, "chat unavailable", http.StatusServiceUnavailable)
			return
		}

		provided := strings.TrimSpace(r.Header.Get(internalSecretHeader))
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}
