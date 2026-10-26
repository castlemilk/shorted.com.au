package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// batchOf builds a batch of n tools/call entries.
func batchOf(n int) string {
	entries := make([]string, n)
	for i := range entries {
		entries[i] = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_top_shorts","arguments":{"limit":1}}}`
	}
	return "[" + strings.Join(entries, ",") + "]"
}

// The guard refuses a batch over the limit with the SDK's error shape: 400, a JSON-RPC
// envelope, and -32600, with a message that names the limit.
func TestBatchGuardRefusesAnOversizedBatch(t *testing.T) {
	reached := false
	h := BatchGuard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, jsonRPCRequest(batchOf(MaxBatchCost+1)))

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.False(t, reached, "an oversized batch must not reach the server")

	var env struct {
		JSONRPC string `json:"jsonrpc"`
		ID      any    `json:"id"`
		Error   struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	assert.Equal(t, "2.0", env.JSONRPC)
	assert.Nil(t, env.ID)
	assert.Equal(t, -32600, env.Error.Code)
	assert.Contains(t, env.Error.Message, "21 tool calls")
	assert.Contains(t, env.Error.Message, "at most 20")
}

// A batch at the limit is served, and its body reaches the handler whole.
func TestBatchGuardPassesABatchAtTheLimit(t *testing.T) {
	body := batchOf(MaxBatchCost)
	var got []byte
	h := BatchGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
	}))
	h.ServeHTTP(httptest.NewRecorder(), jsonRPCRequest(body))
	assert.Equal(t, body, string(got), "the handler must receive the whole batch")
}

// Requests that are not an oversized batch pass through untouched: a single call, a batch
// of other methods, a malformed body, and a GET.
func TestBatchGuardLeavesEverythingElseAlone(t *testing.T) {
	for name, req := range map[string]*http.Request{
		"single call":       jsonRPCRequest(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}`),
		"batch of others":   jsonRPCRequest(`[{"method":"tools/list"},{"method":"resources/list"}]`),
		"malformed":         jsonRPCRequest(`{not json`),
		"get":               httptest.NewRequest(http.MethodGet, "/mcp", nil),
		"not a batch array": jsonRPCRequest(`"tools/call"`),
	} {
		reached := false
		h := BatchGuard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
		h.ServeHTTP(httptest.NewRecorder(), req)
		assert.True(t, reached, "%s must reach the server", name)
	}
}

// A batch of 21 tools/call entries mixed with other methods is refused on its tool calls
// alone: the others do not count against the limit.
func TestBatchGuardCountsOnlyToolCalls(t *testing.T) {
	entries := []string{}
	for i := 0; i < MaxBatchCost; i++ {
		entries = append(entries, `{"method":"tools/call"}`)
	}
	entries = append(entries, `{"method":"tools/list"}`, `{"method":"resources/list"}`)
	reached := false
	h := BatchGuard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	h.ServeHTTP(httptest.NewRecorder(), jsonRPCRequest("["+strings.Join(entries, ",")+"]"))
	assert.True(t, reached, "20 tool calls and two other methods is within the limit")
}
