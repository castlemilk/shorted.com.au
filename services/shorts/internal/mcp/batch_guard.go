package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// BatchGuard refuses a JSON-RPC batch that carries more than MaxBatchCost tool calls
// before the request reaches the SDK. The refusal is the SDK's own shape for a request
// error: HTTP 400, a JSON-RPC error envelope (the SDK's writeJSONRPCError, go-sdk
// mcp/streamable.go), and CodeInvalidRequest (-32600). The message names the limit.
//
// It only reads the body to decide and then restores all of it, so a batch within the
// limit reaches the handler byte for byte. Anything that is not a batch of tools/call is
// not its business: a single call, an unparseable body and a batch of other methods pass
// through, and the SDK answers them as it always has.
func BatchGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Body == nil {
			next.ServeHTTP(w, r)
			return
		}
		orig := r.Body
		body, err := io.ReadAll(io.LimitReader(orig, MaxRequestBytes+1))
		r.Body = readCloser{io.MultiReader(bytes.NewReader(body), orig), orig}
		if err != nil || len(body) > MaxRequestBytes {
			// Oversized bodies are charged the ceiling by RateLimitCost; they are not parsed here.
			next.ServeHTTP(w, r)
			return
		}
		calls := batchToolCalls(body)
		if calls <= MaxBatchCost {
			next.ServeHTTP(w, r)
			return
		}
		writeBatchRefused(w, calls)
	})
}

// batchToolCalls counts the tools/call entries of a batch. A single message, or a body that
// is not a JSON array, is 0 here: it is not a batch this guard refuses.
func batchToolCalls(body []byte) int {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return 0
	}
	var batch []struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(trimmed, &batch) != nil {
		return 0
	}
	n := 0
	for _, entry := range batch {
		if entry.Method == "tools/call" {
			n++
		}
	}
	return n
}

// writeBatchRefused sends the refusal. The id is null: a batch has no single id to echo.
func writeBatchRefused(w http.ResponseWriter, calls int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error": map[string]any{
			"code":    -32600,
			"message": fmt.Sprintf("this batch has %d tool calls; a request may carry at most %d. Split it into smaller batches.", calls, MaxBatchCost),
		},
	})
}
