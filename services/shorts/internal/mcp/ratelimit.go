package mcp

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// MaxRequestBytes bounds how much of a JSON-RPC body the cost function will
// buffer.
//
// The body has to be read to be counted, and reading an unbounded one to decide
// whether the caller may make a request is a denial of service with extra
// steps. A megabyte is far above any real MCP request (the largest tool
// arguments in this server are a handful of stock codes); anything larger is
// charged the maximum batch cost rather than being parsed.
const MaxRequestBytes = 1 << 20

// MaxBatchCost caps what one HTTP request can consume, so an oversized or
// unparseable body cannot be either free or unbounded.
const MaxBatchCost = 50

// TierResolver returns the subscription tier for a user id. It is the SAME
// lookup the Connect auth interceptor performs, passed in rather than
// reimplemented — the published tier table has to mean one thing.
type TierResolver func(userID string) (string, error)

// RateLimitCost counts what a /mcp request consumes: one unit per TOOL CALL.
//
// NOT one per HTTP request, and this is the deliberate part:
//
//   - A JSON-RPC batch carrying five tools/call entries is five calls' worth of
//     work. Charging it as one would make the batch the way around the limit.
//   - Session preamble — initialize, tools/list, resources/list, prompts/list,
//     server/discover — costs ZERO. It is paid once when a client connects, it
//     is the thing a first-time user does before they have any value from the
//     server, and charging for it means a client can be rate limited before it
//     has made a single request anyone asked for. The tools/list payload is
//     ~72KB, so it is not free to serve; the edge bucket is what bounds someone
//     who connects in a loop.
//
// The body is restored, because a cost function that consumed it would leave
// the handler nothing to serve.
func RateLimitCost(r *http.Request) int {
	if r.Body == nil || r.Method != http.MethodPost {
		return 0
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxRequestBytes+1))
	// Whatever happened, the handler still needs the bytes.
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return 0
	}
	if len(body) > MaxRequestBytes {
		// Too big to parse cheaply. Charge the ceiling rather than nothing: an
		// oversized body must not be the cheap path.
		return MaxBatchCost
	}
	return countToolCalls(body)
}

// countToolCalls parses a JSON-RPC request or batch and returns how many
// tools/call entries it contains.
func countToolCalls(body []byte) int {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return 0
	}

	type rpc struct {
		Method string `json:"method"`
	}

	if trimmed[0] == '[' {
		var batch []rpc
		if err := json.Unmarshal(trimmed, &batch); err != nil {
			// Unparseable. The handler will reject it, and charging for a
			// malformed body would let a broken client burn its own quota on
			// requests that were never served.
			return 0
		}
		count := 0
		for _, entry := range batch {
			if entry.Method == "tools/call" {
				count++
			}
		}
		if count > MaxBatchCost {
			return MaxBatchCost
		}
		return count
	}

	var single rpc
	if err := json.Unmarshal(trimmed, &single); err != nil {
		return 0
	}
	if single.Method == "tools/call" {
		return 1
	}
	return 0
}

// RateLimitIdentity derives who a /mcp request is metered against.
//
// Three classes, in descending order of what we actually know:
//
//	oauth:<user id>    an OAuth access token whose audience is this resource.
//	                   The strongest identity available, and the one whose tier
//	                   is re-resolved from api_subscriptions on every request.
//	token:<sha256[:32]> a bearer token present but not carrying a subject.
//	                   Hashed, never stored or logged raw.
//	mcp-anon:<ip>      no credential at all. Anonymous MCP access is the
//	                   adoption path and must keep working; it is metered, not
//	                   refused.
//
// Tier resolution NEVER trusts the token. An access token is stamped with the
// tier that was current when it was minted, and it lives an hour; a
// subscription can lapse inside that window. So the tier is looked up, and a
// failed lookup degrades to "free" rather than to whatever the token claimed.
func RateLimitIdentity(resolveTier TierResolver) func(*http.Request) ratelimit.Caller {
	return func(r *http.Request) ratelimit.Caller {
		if info := auth.TokenInfoFromContext(r.Context()); info != nil && info.UserID != "" {
			tier := "free"
			if resolveTier != nil {
				if resolved, err := resolveTier(info.UserID); err == nil && resolved != "" {
					tier = resolved
				} else if err != nil {
					log.Warnf("mcp: tier lookup failed for %s, defaulting to free: %v", info.UserID, err)
				}
			}
			return ratelimit.Caller{Identifier: "oauth:" + info.UserID, Tier: tier}
		}

		if token := bearerToken(r); token != "" {
			return ratelimit.Caller{Identifier: "token:" + hashToken(token), Tier: "free"}
		}

		return ratelimit.Caller{
			Identifier: "mcp-anon:" + ratelimit.ClientIP(r),
			Tier:       "anonymous",
		}
	}
}

func bearerToken(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(header) > 7 && strings.EqualFold(header[:7], "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

// hashToken keeps 128 bits of sha256 — enough that two live tokens will not
// collide, and short enough to sit in a log line. The raw token never appears
// in a rate-limit key, a metric or a log.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])[:32]
}

// RateLimitRejection writes a rejected /mcp request as a JSON-RPC error rather
// than a bare HTTP 429.
//
// An MCP client speaks JSON-RPC. A 429 with an HTML or plain-JSON body arrives
// as a transport failure with no method, no id, and nothing an agent can relay
// to the user — so "you have used your quota, here is how to raise it" becomes
// "the server is broken". The HTTP status stays 429 for anything watching the
// transport, and the headers still carry the full contract.
//
// The payload is the existing RateLimitDetail, verbatim. Its field names are a
// documented contract shared with the web app; restating them in an MCP-shaped
// struct would be a second copy to keep in step.
func RateLimitRejection(w http.ResponseWriter, r *http.Request, result *ratelimit.Result, detail ratelimit.RateLimitDetail) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	ratelimit.ApplyDetailHeaders(w.Header().Set, result, detail)
	w.WriteHeader(http.StatusTooManyRequests)

	// Echo the request id when there is one, so a client can match the error to
	// the call it made. A batch or an unreadable body yields a null id, which
	// JSON-RPC permits for an error that could not be attributed.
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID(r),
		"error": map[string]any{
			// -32000 is the JSON-RPC "implementation-defined server error"
			// range. There is no standard code for a quota, and inventing one
			// outside the reserved range would collide with the SDK's.
			"code":    -32000,
			"message": detail.Message,
			"data":    detail,
		},
	})
}

func requestID(r *http.Request) any {
	if r.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxRequestBytes))
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return nil
	}
	var single struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(body), &single); err != nil || len(single.ID) == 0 {
		return nil
	}
	var id any
	if err := json.Unmarshal(single.ID, &id); err != nil {
		return nil
	}
	return id
}
