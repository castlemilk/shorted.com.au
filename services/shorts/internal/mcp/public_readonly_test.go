package mcp

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The fixed public plugin catalog must remain read-only even when a caller
// presents a valid token that can manage alerts on the separate /mcp surface.
func TestPublicReadOnlyCatalogDoesNotEscalateWithAlertScope(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("reviewer", ScopeAlertsWrite), op, false)
	_, anonymous := rpcCall(t, srv, "", listToolsBody)
	_, scoped := rpcCall(t, srv, "valid-token", listToolsBody)
	anonymousTools := toolJSONByName(t, anonymous)
	scopedTools := toolJSONByName(t, scoped)
	require.Equal(t, anonymousTools, scopedTools)
	require.Contains(t, anonymousTools, "list_top_shorts")
	for name, annotations := range listedTools(t, scoped) {
		assert.Equal(t, true, annotations["readOnlyHint"], name)
		assert.Equal(t, false, annotations["destructiveHint"], name)
	}
	for _, name := range append([]string{ManageMyAlertsTool}, alertToolNames...) {
		assert.NotContains(t, scopedTools, name)
		response, body := rpcCall(t, srv, "valid-token", toolCallBody(2, name, `{}`))
		assert.Equal(t, http.StatusOK, response.StatusCode, body)
		assert.Contains(t, body, `"error"`, body)
		assert.Empty(t, response.Header.Get("WWW-Authenticate"), "unknown tools must not start a broader grant")
	}
	assert.Empty(t, op.calls)
}
