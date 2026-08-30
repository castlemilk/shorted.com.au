//go:build integration

package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// OAUTH_TEST_DB_URL is a CAPABILITY GRANT, not a filter: this test WRITES.
// Point it at a throwaway database only — never at production.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("OAUTH_TEST_DB_URL")
	if dsn == "" {
		t.Skip("OAUTH_TEST_DB_URL not set; skipping OAuth storage integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connecting: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// The whole point of the schema: what lands in the table is sha256(code), and
// the code itself appears nowhere in the row.
func TestPostgresStoreWritesOnlyAHashOfTheCode(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	clientID := "itest-client-" + time.Now().UTC().Format("20060102150405.000000")
	redirect := "https://app.example/cb"
	if _, err := pool.Exec(ctx, `
		INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, registration_source)
		VALUES ($1, 'Integration Client', $2, ARRAY['authorization_code','refresh_token'], 'dcr')`,
		clientID, []string{redirect}); err != nil {
		t.Fatalf("seeding client: %v", err)
	}
	// The FK cascades, so removing the client removes the code with it.
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, clientID)
	})

	client, err := store.GetClient(ctx, clientID)
	if err != nil || client == nil {
		t.Fatalf("GetClient = %v, %v", client, err)
	}
	if len(client.RedirectURIs) != 1 || client.RedirectURIs[0] != redirect {
		t.Fatalf("RedirectURIs = %v", client.RedirectURIs)
	}
	if unknown, err := store.GetClient(ctx, clientID+"-nope"); err != nil || unknown != nil {
		t.Fatalf("unknown client = %v, %v; want nil, nil", unknown, err)
	}

	// Drive the real handler so the code is the one a client would receive.
	rec := post(t, NewGrantHandler(GrantConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase},
		Identity:  &fakeIdentity{userID: "itest-uid"},
		Store:     store,
	}), map[string]any{
		"id_token":              "firebase-id-token",
		"client_id":             clientID,
		"redirect_uri":          redirect,
		"code_challenge":        testChallenge,
		"code_challenge_method": "S256",
		"resource":              testAPIBase + "/mcp",
		"scope":                 "shorts:read",
		"state":                 "st",
	})
	if rec.Code != 200 {
		t.Fatalf("grant status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		RedirectTo string `json:"redirect_to"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(resp.RedirectTo)
	code := u.Query().Get("code")

	var storedHash, storedMethod string
	var consumed *time.Time
	var expires time.Time
	if err := pool.QueryRow(ctx, `
		SELECT code_hash, code_challenge_method, consumed_at, expires_at
		FROM oauth_authorization_codes WHERE client_id = $1`, clientID).
		Scan(&storedHash, &storedMethod, &consumed, &expires); err != nil {
		t.Fatalf("reading back the code row: %v", err)
	}

	sum := sha256.Sum256([]byte(code))
	if storedHash != hex.EncodeToString(sum[:]) {
		t.Errorf("code_hash = %q, want sha256(code)", storedHash)
	}
	if strings.Contains(storedHash, code) {
		t.Error("the raw code is present in the stored row")
	}
	if storedMethod != "S256" {
		t.Errorf("code_challenge_method = %q", storedMethod)
	}
	if consumed != nil {
		t.Error("consumed_at must be NULL so Task 4 can consume atomically")
	}
	if ttl := time.Until(expires); ttl <= 0 || ttl > CodeTTL {
		t.Errorf("expires_at TTL = %s", ttl)
	}

	// And nothing anywhere in the row equals the code.
	var rowText string
	if err := pool.QueryRow(ctx,
		`SELECT oauth_authorization_codes::text FROM oauth_authorization_codes WHERE client_id = $1`,
		clientID).Scan(&rowText); err != nil {
		t.Fatalf("dumping row: %v", err)
	}
	if strings.Contains(rowText, code) {
		t.Errorf("the authorization code appears verbatim in the stored row: %s", rowText)
	}
}
