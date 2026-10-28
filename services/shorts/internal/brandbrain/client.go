// Package brandbrain is the admin MCP's client for the one BrandBrain API surface
// shorted uses: the operator grant housing_crawl_v1 on a fleet rig.
//
// The grant is one of two independent switches that let a BrandBrain rig push
// housing listings into shorted. The other is shorted's own allowlist
// (housing_ingest_rigs, read by the ingest's rigGate). This package changes only
// the BrandBrain side.
//
// The client is deliberately narrow:
//
//   - it talks to two routes, GET and PUT .../housing-crawl/grant, and nothing else;
//   - its token works only on those routes, and is sent only in the Authorization
//     header, never in an error, a log line or a returned value;
//   - the base URL must be https and must name exactly api.brandbrain.dev (no port,
//     no userinfo). Production never reaches any other host;
//   - redirects are refused, so a 3xx cannot move the token to another host;
//   - every request has a hard timeout (10 s by default).
//
// Outcomes are typed. A request that definitely did not change anything is one of
// ErrRigNotFound, ErrInvalidRequest or ErrRejected. A PUT whose outcome is not
// known (a timeout, a transport error or a 5xx) is ErrUnavailable, and callers must
// report that as unknown, not as a failure, and must not retry it on their own.
package brandbrain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// EnvBaseURL overrides the API base URL. It must be https://api.brandbrain.dev.
	EnvBaseURL = "BRANDBRAIN_API_URL"
	// EnvGrantToken carries the housing grant credential. Unset means the write
	// tool is not configured.
	EnvGrantToken = "BRANDBRAIN_HOUSING_GRANT_TOKEN"

	// DefaultBaseURL is the production API.
	DefaultBaseURL = "https://api.brandbrain.dev"
	// AllowedHost is the only host the client will talk to.
	AllowedHost = "api.brandbrain.dev"
	// DefaultTimeout bounds every request.
	DefaultTimeout = 10 * time.Second

	// maxResponseBytes bounds how much of a response is read. A grant reply is a
	// few hundred bytes; anything larger is not one.
	maxResponseBytes = 64 << 10
)

// Typed outcomes. Match them with errors.Is; the text is fixed and never carries
// a response body or the token.
var (
	// ErrNotConfigured means no grant token is set, so no request is sent.
	ErrNotConfigured = errors.New("not_configured")
	// ErrRigNotFound is a 404: BrandBrain has no such rig. Nothing was changed.
	ErrRigNotFound = errors.New("rig_not_found")
	// ErrInvalidRequest is a 400 from BrandBrain. Nothing was changed.
	ErrInvalidRequest = errors.New("invalid_request")
	// ErrRejected is a 401 or 403: the token does not work on this route. Nothing was changed.
	ErrRejected = errors.New("rejected")
	// ErrUnavailable means the outcome is unknown: a timeout, a transport error,
	// a redirect or a 5xx. For a PUT the change may or may not have landed.
	ErrUnavailable = errors.New("unavailable")
)

// Grant is BrandBrain's answer for one rig. Only the fields shorted acts on or
// reports are kept.
type Grant struct {
	RigID           string `json:"rig_id"`
	Granted         bool   `json:"granted"`
	AdminState      string `json:"admin_state"`
	PrincipalKind   string `json:"principal_kind"`
	CanMint         bool   `json:"can_mint"`
	CanMintReason   string `json:"can_mint_reason"`
	WorkloadSubject string `json:"workload_subject"`
}

// Client calls the grant routes.
type Client struct {
	base    *url.URL
	token   string
	http    *http.Client
	timeout time.Duration
}

// FromEnv builds the client from the environment. It returns (nil, nil) when the
// grant token is unset, so the caller can report the write tool as not configured.
// It returns an error when the base URL is set and not allowed.
func FromEnv(getenv func(string) string) (*Client, error) {
	token := strings.TrimSpace(getenv(EnvGrantToken))
	if token == "" {
		return nil, nil
	}
	base := strings.TrimSpace(getenv(EnvBaseURL))
	if base == "" {
		base = DefaultBaseURL
	}
	u, err := ValidateBaseURL(base)
	if err != nil {
		return nil, err
	}
	return newClient(u, token, DefaultTimeout), nil
}

// ValidateBaseURL accepts only https://api.brandbrain.dev, with no port, userinfo,
// query or fragment. A path is allowed only when it is empty or "/".
func ValidateBaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%s is not a URL", EnvBaseURL)
	}
	switch {
	case u.Scheme != "https":
		return nil, fmt.Errorf("%s must be https", EnvBaseURL)
	case u.User != nil:
		return nil, fmt.Errorf("%s must not carry credentials", EnvBaseURL)
	case u.Port() != "":
		return nil, fmt.Errorf("%s must not name a port", EnvBaseURL)
	case u.Hostname() != AllowedHost:
		return nil, fmt.Errorf("%s must name %s", EnvBaseURL, AllowedHost)
	case u.RawQuery != "" || u.Fragment != "":
		return nil, fmt.Errorf("%s must not carry a query or fragment", EnvBaseURL)
	case u.Path != "" && u.Path != "/":
		return nil, fmt.Errorf("%s must not carry a path", EnvBaseURL)
	}
	return &url.URL{Scheme: "https", Host: AllowedHost}, nil
}

// NewTestClient is the test hook. It builds a client against an arbitrary
// loopback http base URL (an httptest server), with the given timeout. Nothing in
// production calls it. The redirect refusal and the token handling are the same.
func NewTestClient(baseURL, token string, timeout time.Duration) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return nil, errors.New("NewTestClient needs an http loopback base URL")
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return newClient(u, token, timeout), nil
}

func newClient(base *url.URL, token string, timeout time.Duration) *Client {
	return &Client{
		base:    base,
		token:   token,
		timeout: timeout,
		http: &http.Client{
			Timeout: timeout,
			// A redirect is an error, never followed: the token must not travel
			// to a host the operator did not name.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errRedirect
			},
		},
	}
}

var errRedirect = errors.New("brandbrain redirected the request, which is refused")

// GetGrant reads the rig's grant state.
func (c *Client) GetGrant(ctx context.Context, rigID string) (*Grant, error) {
	return c.do(ctx, http.MethodGet, rigID, nil, "")
}

// PutGrant sets the rig's grant. operator is recorded by BrandBrain for audit only
// (X-Operator); it is never trusted for authorization. An empty operator sends no
// header.
func (c *Client) PutGrant(ctx context.Context, rigID string, granted bool, operator string) (*Grant, error) {
	body, err := json.Marshal(struct {
		Granted bool `json:"granted"`
	}{Granted: granted})
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPut, rigID, body, operator)
}

// isRigNotFoundBody reports whether a 404 body is BrandBrain's {"code":"rig_not_found"}.
func isRigNotFoundBody(raw []byte) bool {
	var body struct {
		Code string `json:"code"`
	}
	return json.Unmarshal(raw, &body) == nil && body.Code == "rig_not_found"
}

func (c *Client) do(ctx context.Context, method, rigID string, body []byte, operator string) (*Grant, error) {
	if c == nil {
		return nil, ErrNotConfigured
	}
	endpoint := *c.base
	endpoint.Path = "/api/v1/fleet/rigs/" + url.PathEscape(rigID) + "/housing-crawl/grant"

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return nil, ErrInvalidRequest
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if op := strings.TrimSpace(operator); op != "" && !strings.ContainsAny(op, "\r\n") {
		req.Header.Set("X-Operator", op)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// A timeout, a refused redirect or a dropped connection: the outcome is not known.
		return nil, ErrUnavailable
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))

	switch resp.StatusCode {
	case http.StatusOK:
		if readErr != nil {
			return nil, ErrUnavailable
		}
		var g Grant
		if err := json.Unmarshal(raw, &g); err != nil || g.RigID == "" {
			return nil, ErrUnavailable
		}
		return &g, nil
	case http.StatusNotFound:
		// Only the contract's body means the rig does not exist. Any other 404 (a route
		// that is not deployed, a proxy page) says nothing about the rig, so it is an
		// unknown outcome.
		if isRigNotFoundBody(raw) {
			return nil, ErrRigNotFound
		}
		return nil, ErrUnavailable
	case http.StatusBadRequest:
		return nil, ErrInvalidRequest
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, ErrRejected
	default:
		// 5xx, or any status we do not know: the outcome is not known.
		return nil, ErrUnavailable
	}
}
