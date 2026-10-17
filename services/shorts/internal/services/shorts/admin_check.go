package shorts

// admin_check.go answers "is this Firebase uid an administrator?" for the admin
// MCP server (/mcp/admin) and the OAuth grants that open it.
//
// OAuth access tokens carry a user id and nothing else — no email, no roles —
// so admin status cannot be read off the token. Turning a uid into an email
// needs Firebase Admin getUser, which this service account cannot call: that
// needs a PROJECT-level IAM grant, and the CI deploy account can only make
// resource-scoped ones (see the note on project-level grants in
// jobmonitor/validate.go). The web app already holds a Firebase Admin
// credential AND the ADMIN_EMAILS allowlist that gates /admin, so it answers,
// via /api/internal/admin-check behind the shared INTERNAL_SERVICE_SECRET. One
// allowlist, in one place.
//
// Answers are cached briefly per uid, so the check costs one HTTP call per
// admin per few minutes rather than one per request, and a revocation still
// lands within minutes. A failed lookup is an ERROR, never a cached "yes", and
// every caller fails closed on it.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// defaultAdminCheckURL is the web app's Vercel origin, not shorted.com.au:
// Cloudflare's managed challenge blocks non-browser POSTs to the canonical
// host (the same reason take-writer revalidates via this origin).
const defaultAdminCheckURL = "https://shorted-com-au-document-analyser.vercel.app/api/internal/admin-check"

const (
	adminCheckPositiveTTL = 5 * time.Minute
	adminCheckNegativeTTL = time.Minute
	adminCheckTimeout     = 5 * time.Second
)

type adminCheckEntry struct {
	admin   bool
	expires time.Time
}

// adminChecker calls the web app's admin-check endpoint.
type adminChecker struct {
	url    string
	secret string
	client *http.Client
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]adminCheckEntry
}

// newAdminCheckerFromEnv returns nil when no internal secret is configured:
// with nothing to authenticate the call, there is no admin check, and a nil
// checker makes the admin resource ungrantable (fail closed).
func newAdminCheckerFromEnv() *adminChecker {
	secret := os.Getenv("INTERNAL_SERVICE_SECRET")
	if secret == "" {
		return nil
	}
	url := strings.TrimSpace(os.Getenv("ADMIN_CHECK_URL"))
	if url == "" {
		url = defaultAdminCheckURL
	}
	return &adminChecker{
		url:    url,
		secret: secret,
		client: &http.Client{Timeout: adminCheckTimeout},
		now:    time.Now,
		cache:  map[string]adminCheckEntry{},
	}
}

// IsAdmin reports whether userID is currently an administrator.
func (c *adminChecker) IsAdmin(ctx context.Context, userID string) (bool, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return false, nil
	}
	now := c.now()
	c.mu.Lock()
	if e, ok := c.cache[userID]; ok && now.Before(e.expires) {
		c.mu.Unlock()
		return e.admin, nil
	}
	c.mu.Unlock()

	admin, err := c.lookup(ctx, userID)
	if err != nil {
		return false, err
	}
	ttl := adminCheckNegativeTTL
	if admin {
		ttl = adminCheckPositiveTTL
	}
	c.mu.Lock()
	c.cache[userID] = adminCheckEntry{admin: admin, expires: now.Add(ttl)}
	c.mu.Unlock()
	return admin, nil
}

func (c *adminChecker) lookup(ctx context.Context, userID string) (bool, error) {
	body, _ := json.Marshal(map[string]string{"user_id": userID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return false, fmt.Errorf("admin check: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", c.secret)
	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("admin check: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("admin check: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Admin *bool `json:"admin"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out); err != nil || out.Admin == nil {
		return false, fmt.Errorf("admin check: malformed response")
	}
	return *out.Admin, nil
}
