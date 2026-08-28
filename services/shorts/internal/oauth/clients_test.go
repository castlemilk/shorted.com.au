package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

// fakeClientStore is fakeTokenStore plus the registration surface. Reusing the
// token fake keeps ONE definition of client/code/refresh behaviour in the
// tests, so a registration test and a token test cannot disagree about what a
// stored client looks like.
type fakeClientStore struct {
	*fakeTokenStore

	mu      sync.Mutex
	saved   []ClientRegistration
	touched []string
	deleted []time.Time

	saveErr error
}

func newFakeClientStore() *fakeClientStore {
	return &fakeClientStore{fakeTokenStore: newFakeTokenStore()}
}

func (f *fakeClientStore) SaveClient(_ context.Context, reg ClientRegistration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.saveErr != nil {
		return f.saveErr
	}
	f.saved = append(f.saved, reg)
	c := reg.Client
	f.clients[reg.ClientID] = &c
	return nil
}

func (f *fakeClientStore) TouchClient(_ context.Context, clientID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, clientID)
	return nil
}

func (f *fakeClientStore) DeleteUnusedClients(_ context.Context, idleBefore time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, idleBefore)
	return 0, nil
}

func (f *fakeClientStore) savedRegistrations() []ClientRegistration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ClientRegistration(nil), f.saved...)
}

// countingCIMDServer serves a metadata document and counts requests, so cache
// behaviour is observable rather than assumed.
type countingCIMDServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests int
}

func (c *countingCIMDServer) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requests
}

// newCIMDServer serves handler and counts hits. It is plain HTTP on loopback;
// tests that exercise the real scheme/address policy do NOT use it.
func newCIMDServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *countingCIMDServer {
	t.Helper()
	s := &countingCIMDServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests++
		s.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

// testFetcher is a fetcher whose scheme and address policies are relaxed so a
// loopback httptest server is reachable at all. Every test that asserts an
// SSRF REFUSAL constructs a fetcher with the DEFAULT policy instead.
func testFetcher(cfg MetadataFetcherConfig) *MetadataFetcher {
	cfg.allowPrivateAddresses = true
	cfg.allowPlainHTTP = true
	if cfg.Timeout == 0 {
		cfg.Timeout = 2 * time.Second
	}
	return NewMetadataFetcher(cfg)
}

func metadataDoc(clientID string, redirectURIs ...string) map[string]any {
	return map[string]any{
		"client_id":     clientID,
		"client_name":   "Test Client",
		"redirect_uris": redirectURIs,
		"grant_types":   []string{"authorization_code", "refresh_token"},
	}
}

// ---------------------------------------------------------------------------
// Step 1 — CIMD
// ---------------------------------------------------------------------------

func TestCIMDResolvesRedirectURIsFromTheFetchedDocument(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc(srv.URL+"/client.json", "https://app.example/cb"))
	})
	f := testFetcher(MetadataFetcherConfig{})

	reg, err := f.Resolve(context.Background(), srv.URL+"/client.json")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got := reg.RedirectURIs; len(got) != 1 || got[0] != "https://app.example/cb" {
		t.Fatalf("redirect URIs = %v, want [https://app.example/cb]", got)
	}
	if reg.Source != "cimd" {
		t.Fatalf("source = %q, want cimd", reg.Source)
	}
	// The whole point: a URI the document does NOT list must not match.
	if matchRedirectURI(reg.RedirectURIs, "https://attacker.example/cb") {
		t.Fatal("an unlisted redirect URI matched the fetched document")
	}
}

func TestCIMDRejectsADocumentWhoseClientIDIsNotItsOwnURL(t *testing.T) {
	srv := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		// Claims to be somebody else's client_id — this is impersonation, and
		// accepting it would let any URL speak for any registered client.
		_ = json.NewEncoder(w).Encode(metadataDoc("https://victim.example/client.json", "https://attacker.example/cb"))
	})
	f := testFetcher(MetadataFetcherConfig{})

	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err == nil {
		t.Fatal("expected a self-reference mismatch to be refused")
	}
}

func TestCIMDRejectsADocumentWithNoRedirectURIs(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc(srv.URL + "/client.json"))
	})
	f := testFetcher(MetadataFetcherConfig{})

	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err == nil {
		t.Fatal("expected a document with no redirect_uris to be refused")
	}
}

func TestCIMDNormalisesGrantTypes(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		doc := metadataDoc(srv.URL+"/client.json", "https://app.example/cb")
		delete(doc, "grant_types")
		_ = json.NewEncoder(w).Encode(doc)
	})
	f := testFetcher(MetadataFetcherConfig{})

	reg, err := f.Resolve(context.Background(), srv.URL+"/client.json")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(reg.GrantTypes) == 0 {
		t.Fatal("grant_types is empty; an omitted grant_types must default to authorization_code")
	}
	if !containsString(reg.GrantTypes, "authorization_code") {
		t.Fatalf("grant_types = %v, want it to contain authorization_code", reg.GrantTypes)
	}
}

// --- SSRF -------------------------------------------------------------------

func TestCIMDRefusesNonHTTPSClientIDs(t *testing.T) {
	f := NewMetadataFetcher(MetadataFetcherConfig{})
	for _, id := range []string{
		"http://evil.example/client.json",
		"file:///etc/passwd",
		"gopher://evil.example/",
		"https://user:pass@evil.example/client.json",
		"https://evil.example/client.json#frag",
		"https://",
	} {
		if _, err := f.Resolve(context.Background(), id); err == nil {
			t.Fatalf("client_id %q was accepted; it must be refused", id)
		}
	}
}

func TestCIMDRefusesPrivateAndMetadataAddressSpace(t *testing.T) {
	f := NewMetadataFetcher(MetadataFetcherConfig{Timeout: 2 * time.Second})
	for _, id := range []string{
		"https://127.0.0.1/client.json",
		"https://[::1]/client.json",
		"https://10.0.0.1/client.json",
		"https://192.168.1.1/client.json",
		"https://172.16.0.1/client.json",
		// The one that matters most: the cloud metadata service.
		"https://169.254.169.254/latest/meta-data/",
		"https://[fd00::1]/client.json",
		"https://100.64.0.1/client.json",
		"https://0.0.0.0/client.json",
		// IPv4-mapped IPv6 must be unmapped before the check, or it is a bypass.
		"https://[::ffff:127.0.0.1]/client.json",
	} {
		if _, err := f.Resolve(context.Background(), id); err == nil {
			t.Fatalf("client_id %q reached private address space", id)
		}
	}
}

// A HOSTNAME that resolves to loopback. String inspection of the URL cannot
// catch this; only a post-DNS check can. "localhost" resolves to 127.0.0.1 or
// ::1 without touching a network.
func TestCIMDRefusesAHostnameThatResolvesToPrivateSpace(t *testing.T) {
	srv := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc("x", "https://app.example/cb"))
	})
	port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]

	f := NewMetadataFetcher(MetadataFetcherConfig{Timeout: 2 * time.Second})
	if _, err := f.Resolve(context.Background(), "https://localhost:"+port+"/client.json"); err == nil {
		t.Fatal("a hostname resolving to loopback was fetched")
	}
	if srv.count() != 0 {
		t.Fatalf("the server was reached %d times; the dial must be refused before connecting", srv.count())
	}
}

func TestCIMDRefusesRedirects(t *testing.T) {
	target := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc("x", "https://app.example/cb"))
	})
	redirector := newCIMDServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/client.json", http.StatusFound)
	})

	f := testFetcher(MetadataFetcherConfig{})
	if _, err := f.Resolve(context.Background(), redirector.URL+"/client.json"); err == nil {
		t.Fatal("a redirect was followed; redirects must be refused outright")
	}
	if target.count() != 0 {
		t.Fatalf("the redirect target was fetched %d times", target.count())
	}
}

// The case that motivates refusing redirects at all: a document host that 302s
// into the cloud metadata service. The fetcher here has BOTH relaxations on, so
// private space and plain HTTP are otherwise reachable — the only thing that
// can refuse this is the redirect policy itself.
func TestCIMDRefusesARedirectIntoPrivateSpace(t *testing.T) {
	redirector := newCIMDServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	})
	f := testFetcher(MetadataFetcherConfig{Timeout: 2 * time.Second})
	_, err := f.Resolve(context.Background(), redirector.URL+"/client.json")
	if err == nil {
		t.Fatal("a redirect into private space succeeded")
	}
	if !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("error = %v, want it to be the redirect refusal", err)
	}
}

func TestCIMDRefusesAnOversizedDocument(t *testing.T) {
	srv := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 1 MiB of junk against a small cap.
		blob := strings.Repeat("a", 1<<20)
		_, _ = fmt.Fprintf(w, `{"client_id":"x","padding":%q}`, blob)
	})
	f := testFetcher(MetadataFetcherConfig{MaxBytes: 4 << 10})

	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err == nil {
		t.Fatal("an oversized document was accepted")
	}
}

// Slow loris: headers never arrive. The fetch must give up on its own clock.
func TestCIMDTimesOutOnASlowServer(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	srv := newCIMDServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
	})
	f := testFetcher(MetadataFetcherConfig{Timeout: 150 * time.Millisecond})

	start := time.Now()
	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err == nil {
		t.Fatal("a hung server did not produce an error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("fetch took %v; the timeout is not bounding it", elapsed)
	}
}

// --- caching ----------------------------------------------------------------

func TestCIMDCachesSuccesses(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc(srv.URL+"/client.json", "https://app.example/cb"))
	})
	f := testFetcher(MetadataFetcherConfig{})

	for i := 0; i < 3; i++ {
		if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err != nil {
			t.Fatalf("Resolve %d: %v", i, err)
		}
	}
	if srv.count() != 1 {
		t.Fatalf("fetched %d times, want 1 — successes must be cached", srv.count())
	}
}

// Failures are cached too, or a hostile client_id is a free amplifier: every
// request to /oauth/authorize/grant would become an outbound fetch.
func TestCIMDCachesFailures(t *testing.T) {
	srv := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	f := testFetcher(MetadataFetcherConfig{})

	for i := 0; i < 5; i++ {
		if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err == nil {
			t.Fatalf("Resolve %d: expected an error", i)
		}
	}
	if srv.count() != 1 {
		t.Fatalf("fetched %d times, want 1 — failures must be cached", srv.count())
	}
}

func TestCIMDCacheExpires(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc(srv.URL+"/client.json", "https://app.example/cb"))
	})
	now := time.Now()
	f := testFetcher(MetadataFetcherConfig{SuccessTTL: time.Minute, Now: func() time.Time { return now }})

	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	now = now.Add(2 * time.Minute)
	if _, err := f.Resolve(context.Background(), srv.URL+"/client.json"); err != nil {
		t.Fatalf("Resolve after expiry: %v", err)
	}
	if srv.count() != 2 {
		t.Fatalf("fetched %d times, want 2 — an expired entry must be refetched", srv.count())
	}
}

// --- the resolving store ----------------------------------------------------

func TestResolvingStoreServesCIMDClientsAndPersistsThem(t *testing.T) {
	var srv *countingCIMDServer
	srv = newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metadataDoc(srv.URL+"/client.json", "https://app.example/cb"))
	})
	inner := newFakeClientStore()
	store := NewResolvingStore(inner, testFetcher(MetadataFetcherConfig{}))

	client, err := store.GetClient(context.Background(), srv.URL+"/client.json")
	if err != nil {
		t.Fatalf("GetClient: %v", err)
	}
	if client == nil {
		t.Fatal("CIMD client_id did not resolve")
	}
	// It must be persisted: oauth_authorization_codes.client_id has a foreign
	// key to oauth_clients, so an unpersisted CIMD client cannot be granted a
	// code at all.
	saved := inner.savedRegistrations()
	if len(saved) != 1 || saved[0].Source != "cimd" {
		t.Fatalf("registrations saved = %+v, want one cimd row", saved)
	}
}

func TestResolvingStoreLeavesOpaqueClientIDsToTheDatabase(t *testing.T) {
	inner := newFakeClientStore()
	store := NewResolvingStore(inner, testFetcher(MetadataFetcherConfig{}))

	client, err := store.GetClient(context.Background(), testClientID)
	if err != nil {
		t.Fatalf("GetClient: %v", err)
	}
	if client == nil {
		t.Fatal("an opaque registered client_id did not resolve through the inner store")
	}
	if len(inner.savedRegistrations()) != 0 {
		t.Fatal("an opaque client_id triggered a registration write")
	}
}

// last_used_at drives the unused-client sweep, and the sweep cascades to codes
// and refresh tokens. A client used in a grant must therefore be touched.
func TestResolvingStoreTouchesLastUsedAt(t *testing.T) {
	inner := newFakeClientStore()
	store := NewResolvingStore(inner, testFetcher(MetadataFetcherConfig{}))

	if _, err := store.GetClient(context.Background(), testClientID); err != nil {
		t.Fatalf("GetClient: %v", err)
	}
	inner.mu.Lock()
	defer inner.mu.Unlock()
	if len(inner.touched) != 1 || inner.touched[0] != testClientID {
		t.Fatalf("touched = %v, want [%s]", inner.touched, testClientID)
	}
}

// ---------------------------------------------------------------------------
// Step 2 — dynamic client registration
// ---------------------------------------------------------------------------

func newRegistrationHandler(t *testing.T, store ClientStore, mutate func(*RegistrationConfig)) http.Handler {
	t.Helper()
	cfg := RegistrationConfig{Store: store}
	if mutate != nil {
		mutate(&cfg)
	}
	return NewRegistrationHandler(cfg)
}

func register(t *testing.T, h http.Handler, ip string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, RegisterPath, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", ip)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRegistrationReturnsAUsableClientID(t *testing.T) {
	store := newFakeClientStore()
	h := newRegistrationHandler(t, store, nil)

	rec := register(t, h, "203.0.113.9", map[string]any{
		"client_name":   "Claude",
		"redirect_uris": []string{"https://claude.ai/api/mcp/auth_callback"},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	clientID, _ := resp["client_id"].(string)
	if clientID == "" {
		t.Fatal("no client_id in the response")
	}
	if _, ok := resp["client_secret"]; ok {
		t.Fatal("a client_secret was issued; every client here is public")
	}
	// Usable means the grant handler can find it.
	got, err := store.GetClient(context.Background(), clientID)
	if err != nil || got == nil {
		t.Fatalf("registered client is not retrievable: %v", err)
	}
	if !containsString(got.RedirectURIs, "https://claude.ai/api/mcp/auth_callback") {
		t.Fatalf("redirect URIs = %v", got.RedirectURIs)
	}
}

// RFC 7591 §2: an omitted grant_types defaults to ["authorization_code"].
// Migration 000116 defaults the column to '{}', which makes "omitted" and
// "explicitly empty" indistinguishable — so the default is applied HERE and the
// column is never written empty.
func TestRegistrationNeverStoresEmptyGrantTypes(t *testing.T) {
	store := newFakeClientStore()
	h := newRegistrationHandler(t, store, nil)

	for _, body := range []map[string]any{
		{"redirect_uris": []string{"https://a.example/cb"}},
		{"redirect_uris": []string{"https://b.example/cb"}, "grant_types": []string{}},
	} {
		rec := register(t, h, "203.0.113.10", body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
	}
	for _, reg := range store.savedRegistrations() {
		if len(reg.GrantTypes) == 0 {
			t.Fatalf("grant_types stored empty for %s", reg.ClientID)
		}
		if !containsString(reg.GrantTypes, "authorization_code") {
			t.Fatalf("grant_types = %v, want authorization_code", reg.GrantTypes)
		}
	}
}

func TestRegistrationImpliesAuthorizationCodeForRefreshTokenClients(t *testing.T) {
	store := newFakeClientStore()
	h := newRegistrationHandler(t, store, nil)

	rec := register(t, h, "203.0.113.11", map[string]any{
		"redirect_uris": []string{"https://a.example/cb"},
		"grant_types":   []string{"refresh_token"},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	reg := store.savedRegistrations()[0]
	if !containsString(reg.GrantTypes, "authorization_code") {
		t.Fatalf("grant_types = %v; refresh_token alone is not a usable grant here", reg.GrantTypes)
	}
}

func TestRegistrationRefusesUnsupportedGrantTypes(t *testing.T) {
	h := newRegistrationHandler(t, newFakeClientStore(), nil)
	rec := register(t, h, "203.0.113.12", map[string]any{
		"redirect_uris": []string{"https://a.example/cb"},
		// The password grant is removed in OAuth 2.1; implicit is too.
		"grant_types": []string{"password"},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_client_metadata" {
		t.Fatalf("error = %q", got)
	}
}

func TestRegistrationRefusesDangerousRedirectURIs(t *testing.T) {
	h := newRegistrationHandler(t, newFakeClientStore(), nil)
	for _, uri := range []string{
		"javascript:alert(1)",
		"data:text/html,<script>",
		"http://evil.example/cb", // plain http on a non-loopback host
		"https://app.example/cb#frag",
		"https://*.example/cb",
		"/relative/cb",
		"",
	} {
		rec := register(t, h, "203.0.113.13", map[string]any{"redirect_uris": []string{uri}})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("redirect_uri %q accepted with status %d", uri, rec.Code)
		}
	}
}

func TestRegistrationAllowsLoopbackAndPrivateSchemeRedirects(t *testing.T) {
	h := newRegistrationHandler(t, newFakeClientStore(), nil)
	// RFC 8252: native apps use a loopback redirect or a private-use scheme.
	for _, uri := range []string{
		"http://127.0.0.1:1455/callback",
		"http://localhost:8976/oauth/callback",
		"com.example.app:/oauth2redirect",
	} {
		rec := register(t, h, "203.0.113.14", map[string]any{"redirect_uris": []string{uri}})
		if rec.Code != http.StatusCreated {
			t.Fatalf("redirect_uri %q refused: %d %s", uri, rec.Code, rec.Body.String())
		}
	}
}

func TestRegistrationRefusesMissingRedirectURIs(t *testing.T) {
	h := newRegistrationHandler(t, newFakeClientStore(), nil)
	rec := register(t, h, "203.0.113.15", map[string]any{"client_name": "no redirect"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestRegistrationRateLimitsPerIP(t *testing.T) {
	store := newFakeClientStore()
	h := newRegistrationHandler(t, store, func(c *RegistrationConfig) {
		c.PerIPPerHour = 2
		c.PerIPPerDay = 10
	})
	body := map[string]any{"redirect_uris": []string{"https://a.example/cb"}}

	for i := 0; i < 2; i++ {
		if rec := register(t, h, "198.51.100.7", body); rec.Code != http.StatusCreated {
			t.Fatalf("registration %d: status %d", i, rec.Code)
		}
	}
	rec := register(t, h, "198.51.100.7", body)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("a 429 must carry Retry-After")
	}
	// A different IP is unaffected — the limit is per caller, not global.
	if rec := register(t, h, "198.51.100.8", body); rec.Code != http.StatusCreated {
		t.Fatalf("a different IP was limited: %d", rec.Code)
	}
}

func TestRegistrationCapsTotalRegistrationsPerIP(t *testing.T) {
	now := time.Now()
	h := newRegistrationHandler(t, newFakeClientStore(), func(c *RegistrationConfig) {
		c.PerIPPerHour = 100
		c.PerIPPerDay = 3
		c.Now = func() time.Time { return now }
	})
	body := map[string]any{"redirect_uris": []string{"https://a.example/cb"}}

	for i := 0; i < 3; i++ {
		if rec := register(t, h, "198.51.100.9", body); rec.Code != http.StatusCreated {
			t.Fatalf("registration %d: status %d", i, rec.Code)
		}
		// Move past the hourly window but stay inside the day.
		now = now.Add(2 * time.Hour)
	}
	if rec := register(t, h, "198.51.100.9", body); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 from the daily cap", rec.Code)
	}
}

func TestRegistrationRejectsNonPOST(t *testing.T) {
	h := newRegistrationHandler(t, newFakeClientStore(), nil)
	req := httptest.NewRequest(http.MethodGet, RegisterPath, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestRegistrationWithoutAStoreIsUnavailableRatherThanSilent(t *testing.T) {
	h := NewRegistrationHandler(RegistrationConfig{})
	rec := register(t, h, "203.0.113.20", map[string]any{"redirect_uris": []string{"https://a.example/cb"}})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestRegistrationFiltersScopeToThePublishedVocabulary(t *testing.T) {
	store := newFakeClientStore()
	h := newRegistrationHandler(t, store, nil)

	rec := register(t, h, "203.0.113.21", map[string]any{
		"redirect_uris": []string{"https://a.example/cb"},
		"scope":         "shorts:read wallet:write",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	reg := store.savedRegistrations()[0]
	if reg.Scope != "shorts:read" {
		t.Fatalf("scope = %q, want the published subset only", reg.Scope)
	}
}

// ---------------------------------------------------------------------------
// Step 2 — expiring unused clients
// ---------------------------------------------------------------------------

func TestSweepUnusedClientsUsesTheConfiguredIdlePeriod(t *testing.T) {
	store := newFakeClientStore()
	now := time.Now()
	if _, err := SweepUnusedClients(context.Background(), store, now); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.deleted) != 1 {
		t.Fatalf("sweeps = %d, want 1", len(store.deleted))
	}
	want := now.Add(-UnusedClientTTL)
	if !store.deleted[0].Equal(want) {
		t.Fatalf("cutoff = %v, want %v", store.deleted[0], want)
	}
}

// ---------------------------------------------------------------------------
// address policy, directly
// ---------------------------------------------------------------------------

func TestPublicAddressPolicy(t *testing.T) {
	blocked := []string{
		"0.0.0.0", "127.0.0.1", "127.1.2.3", "10.1.2.3", "172.16.0.1", "172.31.255.255",
		"192.168.0.1", "169.254.169.254", "100.64.0.1", "192.0.0.1", "198.18.0.1",
		"224.0.0.1", "255.255.255.255",
		"::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.1",
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if err := checkPublicIP(ip); err == nil {
			t.Fatalf("%s was allowed", s)
		}
	}
	allowed := []string{"8.8.8.8", "203.0.113.1", "2606:4700:4700::1111"}
	for _, s := range allowed {
		if err := checkPublicIP(net.ParseIP(s)); err != nil {
			t.Fatalf("%s was refused: %v", s, err)
		}
	}
}

func TestIsCIMDClientID(t *testing.T) {
	if !isCIMDClientID("https://claude.ai/client.json") {
		t.Fatal("an https URL is a CIMD client_id")
	}
	for _, id := range []string{"abc123", "http://a.example/c.json", "", "urn:x"} {
		if isCIMDClientID(id) {
			t.Fatalf("%q was treated as a CIMD client_id", id)
		}
	}
}
