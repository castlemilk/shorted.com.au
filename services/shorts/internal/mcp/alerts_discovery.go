package mcp

// alerts_discovery.go: how an anonymous or unscoped caller finds the alert tools.
//
// manage_my_alerts is the one tool offered to a request that does NOT carry a verified
// alerts:write token. It does nothing itself. Calling it starts sign-in: the HTTP layer
// answers the call with a challenge, before any tool runs, and the client's OAuth flow
// then asks for alerts:write. Once the token carries the scope, the scoped server lists
// the six alert tools and this one disappears, so a scoped caller never sees it.
//
// The challenge is HTTP-level on purpose. An MCP client starts its OAuth flow on a 401
// or 403 and its WWW-Authenticate header, not on a tool result, so the answer to this
// call is a status code. It follows the quota challenge (ratelimit.go): a caller with no
// credential gets 401 and a resource_metadata pointer; a caller who presented a token
// without the scope gets 403 insufficient_scope, the RFC 6750 step-up.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// ManageMyAlertsTool is the discovery tool's name.
const ManageMyAlertsTool = "manage_my_alerts"

// manageMyAlertsDescription is what an anonymous caller reads in tools/list. It names the
// plan the site shows (Premium, as alertsNeedPremium says) and says what to do next.
const manageMyAlertsDescription = "Short-interest alerts (email when a stock's short position crosses a level) are for Premium subscribers. " +
	"Call this to sign in; your client will open Shorted login, and then create_alert, list_my_alerts, pause_alert, " +
	"resume_alert, delete_alert and list_my_alert_history become available."

// manageMyAlertsFallback is what the tool answers if a call ever reaches its handler
// instead of the challenge (the oversized-body path below). It takes no action.
const manageMyAlertsFallback = "Sign in to a Shorted account with an active Premium subscription to manage short-interest alerts. " +
	"Your client should start sign-in from its connector settings."

// registerManageMyAlerts adds the discovery tool to a server. Only the anonymous and
// unscoped server gets it; the scoped server does not.
func registerManageMyAlerts(server *sdk.Server) {
	sdk.AddTool(server, &sdk.Tool{
		Name:        ManageMyAlertsTool,
		Title:       "Manage my alerts",
		Description: manageMyAlertsDescription,
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)},
	}, func(context.Context, *sdk.CallToolRequest, struct{}) (*sdk.CallToolResult, struct{}, error) {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: manageMyAlertsFallback}}}, struct{}{}, nil
	})
}

// callsManageMyAlerts reports whether a JSON-RPC body contains a tools/call for the
// discovery tool: a single message, or a batch in which any element is one. A body that
// is not JSON is not a discovery call; the SDK answers it with its own parse error.
func callsManageMyAlerts(body []byte) bool {
	type message struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	isCall := func(m message) bool {
		return m.Method == "tools/call" && m.Params.Name == ManageMyAlertsTool
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return false
	}
	switch trimmed[0] {
	case '{':
		var m message
		if json.Unmarshal(trimmed, &m) != nil {
			return false
		}
		return isCall(m)
	case '[':
		var batch []message
		if json.Unmarshal(trimmed, &batch) != nil {
			return false
		}
		for _, m := range batch {
			if isCall(m) {
				return true
			}
		}
	}
	return false
}

// readCloser is an io.Reader that closes the original body.
type readCloser struct {
	io.Reader
	io.Closer
}

// alertsChallenge answers a discovery call from a caller without alerts:write with the
// HTTP challenge, and passes every other request through untouched. It is only mounted
// where the discovery tool is listed, so a deployment without alerts never challenges.
//
// Bodies larger than MaxRequestBytes are not read in full (the rate limiter charges them
// the batch maximum for the same reason). They pass through to the server, where the
// discovery tool answers with its fallback text rather than the challenge. No privileged
// action is reachable that way: the fallback takes none.
func alertsChallenge(resourceMetadataURL string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Body == nil {
			next.ServeHTTP(w, r)
			return
		}
		// Read a bounded prefix to decide, then put the WHOLE body back: the prefix followed by
		// whatever was not read. Restoring only the prefix would truncate a large request.
		orig := r.Body
		body, err := io.ReadAll(io.LimitReader(orig, MaxRequestBytes+1))
		r.Body = readCloser{io.MultiReader(bytes.NewReader(body), orig), orig}
		if err != nil || len(body) > MaxRequestBytes || !callsManageMyAlerts(body) {
			next.ServeHTTP(w, r)
			return
		}
		if hasAlertsWrite(r) {
			// A scoped caller does not see the tool; the scoped server answers with unknown tool.
			next.ServeHTTP(w, r)
			return
		}
		writeAlertsChallenge(w, r, resourceMetadataURL)
	})
}

// writeAlertsChallenge sends the challenge. The status and WWW-Authenticate header are the
// answer; the JSON-RPC body echoes the request id so a client can match it to the call.
func writeAlertsChallenge(w http.ResponseWriter, r *http.Request, resourceMetadataURL string) {
	signedIn := auth.TokenInfoFromContext(r.Context()) != nil
	var status int
	var challenge, message string
	if signedIn {
		status = http.StatusForbidden
		challenge = fmt.Sprintf(`Bearer error="insufficient_scope", error_description="alerts need the alerts:write scope", scope="%s", resource_metadata="%s"`,
			ScopeAlertsWrite, resourceMetadataURL)
		message = "this connection was not granted the alerts:write scope; sign in again and approve it to manage alerts"
	} else {
		status = http.StatusUnauthorized
		challenge = fmt.Sprintf(`Bearer resource_metadata="%s", scope="%s"`, resourceMetadataURL, ScopeAlertsWrite)
		message = "sign in to a Shorted account with Premium to manage short-interest alerts"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("WWW-Authenticate", challenge)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID(r),
		"error":   map[string]any{"code": -32000, "message": strings.TrimSpace(message)},
	})
}
