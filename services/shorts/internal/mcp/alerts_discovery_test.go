package mcp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The discovery tool, driven over a real socket: the challenge is an HTTP status and a
// WWW-Authenticate header, so these tests read those, not a tool result.

var manageCall = toolCallBody(7, ManageMyAlertsTool, `{}`)

func challengeURL() string { return ProtectedResourceMetadataURL(conformanceOrigin) }

// The discovery tool is listed for anonymous and unscoped callers, with the wording and the
// empty input schema the brief specifies, and it stays short.
func TestManageMyAlertsIsListedWithTheRightShape(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), op, true)
	_, body := rpcCall(t, srv, "", listToolsBody)
	raw := toolJSONByName(t, body)[ManageMyAlertsTool]
	require.NotNil(t, raw, "the discovery tool must be listed to anonymous callers")

	var tool struct {
		Description string `json:"description"`
		InputSchema struct {
			Type       string         `json:"type"`
			Properties map[string]any `json:"properties"`
		} `json:"inputSchema"`
		Annotations map[string]any `json:"annotations"`
	}
	require.NoError(t, json.Unmarshal(raw, &tool))
	assert.Contains(t, tool.Description, "Premium subscribers")
	assert.Contains(t, tool.Description, "Call this to sign in")
	assert.Contains(t, tool.Description, "create_alert, list_my_alerts, pause_alert, resume_alert, delete_alert and list_my_alert_history")
	assert.NotContains(t, strings.ToLower(tool.Description), "pro ", "the plan is Premium, not Pro")
	assert.Equal(t, "object", tool.InputSchema.Type)
	assert.Empty(t, tool.InputSchema.Properties, "the input schema is an empty object")
	assert.Equal(t, true, tool.Annotations["readOnlyHint"], "signing in changes nothing")
	assert.LessOrEqual(t, len(raw), 1024, "the discovery tool is about half a kilobyte, not more")
	t.Logf("manage_my_alerts: %d bytes in tools/list", len(raw))
}

// A scoped caller does not see the discovery tool.
func TestManageMyAlertsIsNotListedToAScopedCaller(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), &recordingAlerts{}, true)
	_, body := rpcCall(t, srv, "t", listToolsBody)
	assert.NotContains(t, toolJSONByName(t, body), ManageMyAlertsTool)
}

// An anonymous call gets a 401 whose WWW-Authenticate names the resource metadata and the
// write scope, and a JSON-RPC body that echoes the id. The tool itself does not run.
func TestAnonymousManageCallIsA401Challenge(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), op, true)
	resp, body := rpcCall(t, srv, "", manageCall)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode, body)
	assert.Equal(t, `Bearer resource_metadata="`+challengeURL()+`", scope="alerts:write"`, resp.Header.Get("WWW-Authenticate"))
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))

	var rpc struct {
		ID    any `json:"id"`
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &rpc), body)
	assert.EqualValues(t, 7, rpc.ID, "the challenge echoes the request id")
	assert.Equal(t, -32000, rpc.Error.Code)
	assert.NotContains(t, body, "Premium subscription", "the challenge body is not the tool's text")
	assert.Empty(t, op.calls)
}

// A signed-in caller whose token lacks alerts:write gets the RFC 6750 step-up: 403 with
// insufficient_scope and the scope it needs.
func TestUnscopedTokenGetsInsufficientScope(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	resp, body := rpcCall(t, srv, "t", manageCall)
	require.Equal(t, http.StatusForbidden, resp.StatusCode, body)
	challenge := resp.Header.Get("WWW-Authenticate")
	assert.True(t, strings.HasPrefix(challenge, `Bearer error="insufficient_scope"`), challenge)
	assert.Contains(t, challenge, `scope="alerts:write"`)
	assert.Contains(t, challenge, `resource_metadata="`+challengeURL()+`"`)
}

// A scoped caller is never challenged. The scoped server has no such tool, so the call is an
// unknown tool, a tool error, and nothing about it goes out as a challenge.
func TestScopedCallerIsNeverChallengedForTheDiscoveryTool(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), op, true)
	resp, body := rpcCall(t, srv, "t", manageCall)
	assert.NotEqual(t, http.StatusUnauthorized, resp.StatusCode)
	assert.NotEqual(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, resp.Header.Get("WWW-Authenticate"))
	assert.True(t, strings.Contains(body, "unknown tool") || strings.Contains(body, `"isError":true`), body)
	assert.Empty(t, op.calls)
}

// Other tools and methods are unaffected for an anonymous caller: a normal read tool is a
// normal 200 with a result, and resources/list works.
func TestOtherCallsAreUnaffectedForAnonymousCallers(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	resp, body := rpcCall(t, srv, "", toolCallBody(8, "list_top_shorts", `{"limit":1}`))
	assert.Equal(t, http.StatusOK, resp.StatusCode, body)
	assert.Empty(t, resp.Header.Get("WWW-Authenticate"))
	assert.NotContains(t, body, "insufficient_scope")

	resp, body = rpcCall(t, srv, "", `{"jsonrpc":"2.0","id":9,"method":"resources/list"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode, body)
	assert.Empty(t, resp.Header.Get("WWW-Authenticate"))
}

// A batch that contains the discovery call is challenged as a whole.
func TestBatchWithTheDiscoveryCallIsChallenged(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	batch := "[" + listToolsBody + "," + manageCall + "]"
	resp, body := rpcCall(t, srv, "", batch)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, body)
	assert.Contains(t, resp.Header.Get("WWW-Authenticate"), `scope="alerts:write"`)
}

// A batch without it is not challenged, even with other tool calls in it.
func TestBatchWithoutTheDiscoveryCallPasses(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	batch := "[" + listToolsBody + "," + toolCallBody(10, "list_top_shorts", `{"limit":1}`) + "]"
	resp, _ := rpcCall(t, srv, "", batch)
	assert.NotEqual(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, resp.Header.Get("WWW-Authenticate"))
}

// A malformed body is not a discovery call. It is not challenged; the SDK answers it.
func TestMalformedBodyIsNotChallenged(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	for _, body := range []string{`{"jsonrpc":`, `not json`, `{"method":"tools/call","params":{"name":"manage_my_alerts"}`} {
		resp, _ := rpcCall(t, srv, "", body)
		assert.NotEqual(t, http.StatusUnauthorized, resp.StatusCode, "%q", body)
		assert.Empty(t, resp.Header.Get("WWW-Authenticate"), "%q", body)
	}
}

// A body over MaxRequestBytes is not parsed. The guard passes it through, the limiter charges
// it the ceiling (MaxBatchCost units, see TestAnOversizedBodyIsChargedTheCeiling), and the
// SDK receives the WHOLE body. The discovery tool then answers with its fallback text, which
// takes no action, so the answer is text rather than a challenge. The test checks the body
// arrives complete: a truncated body would parse as a malformed request.
func TestOversizedBodyReachesTheFallbackNotAChallenge(t *testing.T) {
	srv := publicStack(t, publicClaims("uid-a", "shorts:read"), &recordingAlerts{}, true)
	pad := strings.Repeat("x", MaxRequestBytes)
	body := `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"manage_my_alerts","arguments":{},"pad":"` + pad + `"}}`
	resp, text := rpcCall(t, srv, "", body)
	assert.NotEqual(t, http.StatusUnauthorized, resp.StatusCode)
	assert.NotContains(t, text, "malformed payload", "the whole body must reach the SDK, not a truncated prefix")
	assert.Contains(t, text, "Sign in to a Shorted account")
}

// The detection rule, case by case.
func TestCallsManageMyAlertsDetection(t *testing.T) {
	yes := []string{
		manageCall,
		`[` + manageCall + `]`,
		`[` + listToolsBody + `,` + manageCall + `]`,
		`  ` + manageCall,
	}
	no := []string{
		``,
		`   `,
		`[]`,
		listToolsBody,
		toolCallBody(1, "list_top_shorts", `{}`),
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"name":"manage_my_alerts"}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Manage_My_Alerts"}}`,
		`{"jsonrpc":`,
		`"manage_my_alerts"`,
	}
	for _, b := range yes {
		assert.True(t, callsManageMyAlerts([]byte(b)), "should detect: %s", b)
	}
	for _, b := range no {
		assert.False(t, callsManageMyAlerts([]byte(b)), "should not detect: %s", b)
	}
}
