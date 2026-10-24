package mcp

import (
	"net/http"
	"strings"
)

// WithChallengeScope adds scope= to the SDK's invalid-token challenge.
//
// The SDK writes scope= from RequireBearerTokenOptions.Scopes, but that field is also a set
// every token must hold, so it cannot carry the read scopes without refusing tokens that
// lack one. This wrapper changes only the header: a 401 or 403 whose WWW-Authenticate names
// a resource_metadata and no scope gets the read scopes (DefaultScopes) appended. Nothing
// about verification changes, and a challenge that already names a scope is left alone.
// Successful responses are never touched.
func WithChallengeScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&challengeScopeWriter{ResponseWriter: w}, r)
	})
}

type challengeScopeWriter struct {
	http.ResponseWriter
	wrote bool
}

func (c *challengeScopeWriter) WriteHeader(status int) {
	if !c.wrote && (status == http.StatusUnauthorized || status == http.StatusForbidden) {
		h := c.Header()
		if ch := h.Get("WWW-Authenticate"); ch != "" && strings.Contains(ch, "resource_metadata=") && !strings.Contains(ch, "scope=") {
			h.Set("WWW-Authenticate", ch+`, scope="`+strings.Join(DefaultScopes, " ")+`"`)
		}
	}
	c.wrote = true
	c.ResponseWriter.WriteHeader(status)
}

func (c *challengeScopeWriter) Write(p []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(p)
}

// Flush keeps streaming responses working through the wrapper.
func (c *challengeScopeWriter) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
