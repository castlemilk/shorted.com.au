package shorts

// firebase_users.go reads signed-up accounts for the admin MCP server's
// users:read tools. Accounts are Firebase Auth users, which this service cannot
// list itself for the same reason it cannot resolve an admin's email (see
// admin_check.go): the web app holds the Firebase Admin credential, so it
// answers, at /api/internal/admin-users, behind the shared
// INTERNAL_SERVICE_SECRET. Nothing is cached here: every answer is personal
// data and an admin asking wants the current one.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const firebaseUsersTimeout = 20 * time.Second

// firebaseUser is one account as the web endpoint returns it.
type firebaseUser struct {
	UID           string   `json:"uid"`
	Email         string   `json:"email"`
	EmailVerified bool     `json:"emailVerified"`
	Disabled      bool     `json:"disabled"`
	Providers     []string `json:"providers"`
	CreatedAt     string   `json:"createdAt"`
	LastSignInAt  string   `json:"lastSignInAt"`
}

type firebaseUserSummary struct {
	Total              int            `json:"total"`
	EmailVerified      int            `json:"emailVerified"`
	Disabled           int            `json:"disabled"`
	SignedUpLast7Days  int            `json:"signedUpLast7Days"`
	SignedUpLast30Days int            `json:"signedUpLast30Days"`
	SignedInLast30Days int            `json:"signedInLast30Days"`
	ByProvider         map[string]int `json:"byProvider"`
	Truncated          bool           `json:"truncated"`
}

type firebaseUserPage struct {
	Users     []firebaseUser `json:"users"`
	Total     int            `json:"total"`
	Truncated bool           `json:"truncated"`
}

type firebaseUsersReader interface {
	Summary(ctx context.Context) (*firebaseUserSummary, error)
	List(ctx context.Context, query, sort string, limit, offset int) (*firebaseUserPage, error)
	Lookup(ctx context.Context, email string) (*firebaseUser, error)
}

type firebaseUsersClient struct {
	url    string
	secret string
	client *http.Client
}

// newFirebaseUsersClientFromEnv returns nil without INTERNAL_SERVICE_SECRET.
// ADMIN_USERS_URL overrides the endpoint; by default it sits beside the admin
// check, on the same Vercel origin.
func newFirebaseUsersClientFromEnv() firebaseUsersReader {
	secret := os.Getenv("INTERNAL_SERVICE_SECRET")
	if secret == "" {
		return nil
	}
	url := strings.TrimSpace(os.Getenv("ADMIN_USERS_URL"))
	if url == "" {
		check := strings.TrimSpace(os.Getenv("ADMIN_CHECK_URL"))
		if check == "" {
			check = defaultAdminCheckURL
		}
		url = strings.TrimSuffix(check, "/admin-check") + "/admin-users"
	}
	return &firebaseUsersClient{url: url, secret: secret, client: &http.Client{Timeout: firebaseUsersTimeout}}
}

func (c *firebaseUsersClient) call(ctx context.Context, body map[string]any, out any) error {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("admin users: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", c.secret)
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("admin users: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("admin users: HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("admin users: malformed response")
	}
	return nil
}

func (c *firebaseUsersClient) Summary(ctx context.Context) (*firebaseUserSummary, error) {
	var out firebaseUserSummary
	if err := c.call(ctx, map[string]any{"action": "summary"}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *firebaseUsersClient) List(ctx context.Context, query, sort string, limit, offset int) (*firebaseUserPage, error) {
	var out firebaseUserPage
	if err := c.call(ctx, map[string]any{"action": "list", "query": query, "sort": sort, "limit": limit, "offset": offset}, &out); err != nil {
		return nil, err
	}
	if out.Users == nil {
		out.Users = []firebaseUser{}
	}
	return &out, nil
}

func (c *firebaseUsersClient) Lookup(ctx context.Context, email string) (*firebaseUser, error) {
	var out struct {
		User *firebaseUser `json:"user"`
	}
	if err := c.call(ctx, map[string]any{"action": "lookup", "email": email}, &out); err != nil {
		return nil, err
	}
	return out.User, nil
}
