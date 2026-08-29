//go:build integration

package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// uniqueClientID keeps rows from colliding with a previous run, and makes it
// obvious in a table dump which rows a test owns.
func uniqueClientID(t *testing.T, prefix string) string {
	t.Helper()
	return prefix + "-" + time.Now().UTC().Format("20060102150405.000000")
}

func TestSaveClientRoundTripsThroughTheRealColumns(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	id := uniqueClientID(t, "itest-save")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, id)
	})

	if err := store.SaveClient(ctx, ClientRegistration{
		Client: Client{
			ClientID:     id,
			ClientName:   "Integration Client",
			RedirectURIs: []string{"https://app.example/cb"},
			GrantTypes:   []string{"authorization_code", "refresh_token"},
			Scope:        "shorts:read",
		},
		ClientURI: "https://app.example",
		Source:    SourceDCR,
		IssuedAt:  time.Now(),
	}); err != nil {
		t.Fatalf("SaveClient: %v", err)
	}

	got, err := store.GetClient(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("GetClient = %v, %v", got, err)
	}
	if len(got.RedirectURIs) != 1 || got.RedirectURIs[0] != "https://app.example/cb" {
		t.Fatalf("redirect_uris = %v", got.RedirectURIs)
	}
	if len(got.GrantTypes) == 0 {
		t.Fatal("grant_types came back empty; the column must never hold '{}'")
	}

	var source string
	if err := pool.QueryRow(ctx, `SELECT registration_source FROM oauth_clients WHERE client_id = $1`, id).Scan(&source); err != nil {
		t.Fatalf("reading source: %v", err)
	}
	if source != SourceDCR {
		t.Fatalf("registration_source = %q", source)
	}
}

// A CIMD document must not be able to rewrite a DCR-registered client just by
// colliding with its client_id.
func TestSaveClientRefusesCrossSourceOverwrite(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	id := uniqueClientID(t, "itest-source")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, id)
	})

	if err := store.SaveClient(ctx, ClientRegistration{
		Client: Client{ClientID: id, RedirectURIs: []string{"https://legit.example/cb"}, GrantTypes: []string{"authorization_code"}},
		Source: SourceDCR,
	}); err != nil {
		t.Fatalf("seeding DCR client: %v", err)
	}
	err := store.SaveClient(ctx, ClientRegistration{
		Client: Client{ClientID: id, RedirectURIs: []string{"https://attacker.example/cb"}, GrantTypes: []string{"authorization_code"}},
		Source: SourceCIMD,
	})
	if err == nil {
		t.Fatal("a cimd save overwrote a dcr client")
	}

	got, _ := store.GetClient(ctx, id)
	if got == nil || got.RedirectURIs[0] != "https://legit.example/cb" {
		t.Fatalf("redirect_uris = %v; the registered value must survive", got)
	}
}

func TestTouchClientRecordsLastUsedAt(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	id := uniqueClientID(t, "itest-touch")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, id)
	})
	if err := store.SaveClient(ctx, ClientRegistration{
		Client: Client{ClientID: id, RedirectURIs: []string{"https://app.example/cb"}, GrantTypes: []string{"authorization_code"}},
		Source: SourceDCR,
	}); err != nil {
		t.Fatalf("SaveClient: %v", err)
	}

	var before *time.Time
	if err := pool.QueryRow(ctx, `SELECT last_used_at FROM oauth_clients WHERE client_id = $1`, id).Scan(&before); err != nil {
		t.Fatalf("reading last_used_at: %v", err)
	}
	if before != nil {
		t.Fatal("last_used_at must start NULL")
	}
	if err := store.TouchClient(ctx, id); err != nil {
		t.Fatalf("TouchClient: %v", err)
	}
	var after *time.Time
	if err := pool.QueryRow(ctx, `SELECT last_used_at FROM oauth_clients WHERE client_id = $1`, id).Scan(&after); err != nil {
		t.Fatalf("re-reading last_used_at: %v", err)
	}
	if after == nil {
		t.Fatal("last_used_at was not recorded")
	}
}

// The sweep cascades. This is the test that says it may not cascade over a
// client that is still in use.
func TestDeleteUnusedClientsSparesAClientHoldingALiveRefreshToken(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	idle := uniqueClientID(t, "itest-idle")
	live := uniqueClientID(t, "itest-live")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = ANY($1)`, []string{idle, live})
	})

	for _, id := range []string{idle, live} {
		if err := store.SaveClient(ctx, ClientRegistration{
			Client: Client{ClientID: id, RedirectURIs: []string{"https://app.example/cb"}, GrantTypes: []string{"authorization_code"}},
			Source: SourceDCR,
			// Registered long ago and never touched.
			IssuedAt: time.Now().Add(-90 * 24 * time.Hour),
		}); err != nil {
			t.Fatalf("SaveClient %s: %v", id, err)
		}
	}
	// The "live" client is just as idle, but still holds an unexpired,
	// unrotated refresh token.
	if err := store.CreateRefreshToken(ctx, RefreshToken{
		TokenHash: "itest-hash-" + uuid.NewString(),
		FamilyID:  uuid.NewString(),
		ClientID:  live,
		UserID:    "itest-uid",
		Resource:  testAPIBase + "/mcp",
		Scope:     "shorts:read",
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("CreateRefreshToken: %v", err)
	}

	if _, err := store.DeleteUnusedClients(ctx, time.Now().Add(-30*24*time.Hour)); err != nil {
		t.Fatalf("DeleteUnusedClients: %v", err)
	}

	gone, err := store.GetClient(ctx, idle)
	if err != nil {
		t.Fatalf("GetClient(idle): %v", err)
	}
	if gone != nil {
		t.Fatal("an idle client with no live grant survived the sweep")
	}
	kept, err := store.GetClient(ctx, live)
	if err != nil {
		t.Fatalf("GetClient(live): %v", err)
	}
	if kept == nil {
		t.Fatal("the sweep deleted a client that still holds a live refresh token")
	}
}

// End to end against the real table: registration writes a row the grant
// handler can find, and its grant_types is never the column default '{}'.
func TestRegistrationWritesAUsableRow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)

	h := NewRegistrationHandler(RegistrationConfig{Store: store})
	body, _ := json.Marshal(map[string]any{
		"client_name":   "Integration DCR",
		"redirect_uris": []string{"https://claude.ai/api/mcp/auth_callback"},
	})
	req := httptest.NewRequest(http.MethodPost, RegisterPath, strings.NewReader(string(body)))
	req.Header.Set("X-Forwarded-For", "203.0.113.77")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, resp.ClientID)
	})

	var grants []string
	if err := pool.QueryRow(ctx, `SELECT grant_types FROM oauth_clients WHERE client_id = $1`, resp.ClientID).Scan(&grants); err != nil {
		t.Fatalf("reading grant_types: %v", err)
	}
	if len(grants) == 0 {
		t.Fatal("grant_types was stored as '{}'")
	}
	if !containsString(grants, "authorization_code") {
		t.Fatalf("grant_types = %v", grants)
	}
}
