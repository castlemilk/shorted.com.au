package ingest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	"github.com/castlemilk/shorted.com.au/services/pkg/workloadauth"
)

// The harness for the ingest's end-to-end tests: a TLS workload issuer that serves
// discovery and JWKS and mints ES256 tokens, a throwaway Postgres whose schema is
// the real 000089 and 000150 migrations applied over the listing fixtures, and a
// clock the tests can move. It is the same shape as pkg/workloadauth's harness, and
// it is kept here because that one is not importable.
//
// The DB tests need a throwaway Postgres. They recreate the schema, so do not point
// them at a shared one. Either name a server, or let testcontainers start one (the
// CI route, and the one that works on the self-hosted runners):
//
//	HOUSING_TEST_DB_URL='postgres://…/throwaway' GOWORK=off go test -p 1 ./shorts/internal/ingest/
//	HOUSING_TESTCONTAINERS=1 GOWORK=off CGO_ENABLED=0 go test -tags=testcontainers -p 1 ./shorts/internal/ingest/

const (
	testIssuerOrg = "org-shorted"
	testRig       = "rig:gamma-64"
	testAudience  = "https://api.shorted.com.au/housing-ingest"
)

// issuerFixture is a TLS issuer with one ES256 key, plus a knob to take it down.
type issuerFixture struct {
	srv    *httptest.Server
	issuer string
	key    *ecdsa.PrivateKey
	kid    string
	client *http.Client

	mu   sync.Mutex
	down bool
}

func newIssuerFixture(t *testing.T) *issuerFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := &issuerFixture{key: key, kid: "kid-test-1"}
	mux := http.NewServeMux()
	mux.HandleFunc("/workload/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		if f.isDown() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, map[string]any{"issuer": f.issuer, "jwks_uri": f.issuer + "/jwks.json"})
	})
	mux.HandleFunc("/workload/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		if f.isDown() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, map[string]any{"keys": []map[string]any{f.jwk()}})
	})
	f.srv = httptest.NewTLSServer(mux)
	t.Cleanup(f.srv.Close)
	f.issuer = f.srv.URL + "/workload"

	pool := x509.NewCertPool()
	pool.AddCert(f.srv.Certificate())
	f.client = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
	return f
}

func (f *issuerFixture) isDown() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.down
}

func (f *issuerFixture) setDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down = down
}

func (f *issuerFixture) jwk() map[string]any {
	return map[string]any{
		"kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": f.kid,
		"x": coord(f.key.X), "y": coord(f.key.Y),
	}
}

func coord(n *big.Int) string {
	b := make([]byte, 32)
	n.FillBytes(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// mint signs a token for sub at now. mutate may change any claim before signing.
func (f *issuerFixture) mint(t *testing.T, sub string, now time.Time, mutate func(jwt.MapClaims)) string {
	t.Helper()
	iat := now.Unix()
	claims := jwt.MapClaims{
		"iss":           f.issuer,
		"sub":           sub,
		"aud":           testAudience,
		"iat":           iat,
		"nbf":           iat,
		"exp":           iat + 600,
		"jti":           fmt.Sprintf("jti-%d-%s", iat, sub),
		"org":           testIssuerOrg,
		"rig_type":      "housing",
		"agent_version": "1.0.0",
	}
	if mutate != nil {
		mutate(claims)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = f.kid
	raw, err := tok.SignedString(f.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// signedWithOtherKey mints a token whose header names the published kid but whose
// signature comes from a different key. It must fail verification.
func signedWithOtherKey(t *testing.T, f *issuerFixture, sub string, now time.Time) string {
	t.Helper()
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	iat := now.Unix()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": f.issuer, "sub": sub, "aud": testAudience, "iat": iat, "nbf": iat,
		"exp": iat + 600, "jti": "forged", "org": testIssuerOrg,
	})
	tok.Header["kid"] = f.kid
	raw, err := tok.SignedString(other)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// testClock is a goroutine-safe clock the tests move forward.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func newTestClock() *testClock {
	// Postgres keeps microseconds, so the clock does too, and comparisons stay exact.
	return &testClock{t: time.Now().UTC().Truncate(time.Microsecond)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// ingestDBSchema is the listing fixture the migrations sit on. It is the base
// tables WITHOUT the 000150 columns, so applying 000150 over it is the real test
// of that migration.
const ingestDBSchema = `
DROP TABLE IF EXISTS crawl_ingest_quarantine;
DROP TABLE IF EXISTS housing_ingest_rigs;
DROP TABLE IF EXISTS crawl_ingest_receipts;
DROP TABLE IF EXISTS crawl_dispatch;
DROP TABLE IF EXISTS crawl_run_status;
DROP TABLE IF EXISTS property_price_events;
DROP TABLE IF EXISTS property_listings;
DROP TABLE IF EXISTS house_price_regions;
CREATE TABLE house_price_regions (
  region_code TEXT PRIMARY KEY, region_type TEXT, region_name TEXT, state_code TEXT, postcode TEXT);
CREATE TABLE property_listings (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, listing_id TEXT NOT NULL, address_key TEXT,
  listing_url TEXT NOT NULL, region_code TEXT REFERENCES house_price_regions(region_code), sal_code TEXT,
  suburb TEXT, state_code TEXT, postcode TEXT, display_address TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, property_type TEXT,
  bedrooms SMALLINT, bathrooms SMALLINT, car_spaces SMALLINT, land_size_sqm DOUBLE PRECISION,
  price DOUBLE PRECISION, price_high DOUBLE PRECISION, price_display TEXT,
  price_kind TEXT NOT NULL DEFAULT 'unknown', listing_status TEXT NOT NULL DEFAULT 'for_sale',
  is_active BOOLEAN NOT NULL DEFAULT true, missed_sweeps SMALLINT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_price_change_at TIMESTAMPTZ, source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
  content_hash TEXT NOT NULL, agency_id TEXT, agency_name TEXT, agent_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, listing_id));
CREATE TABLE property_price_events (
  id BIGSERIAL PRIMARY KEY, listing_pk BIGINT NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
  source TEXT NOT NULL, listing_id TEXT NOT NULL, region_code TEXT, address_key TEXT, sal_code TEXT,
  observed_at TIMESTAMPTZ NOT NULL, event_type TEXT NOT NULL,
  price DOUBLE PRECISION, price_high DOUBLE PRECISION, price_display TEXT, price_kind TEXT,
  prev_price DOUBLE PRECISION, drop_abs DOUBLE PRECISION, drop_pct DOUBLE PRECISION,
  listing_status TEXT, prev_status TEXT, source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (listing_pk, event_type, observed_at));`

// migrationFile reads a file from services/migrations, relative to this package.
func migrationFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("../../../migrations/" + name)
	if err != nil {
		t.Fatalf("read migration %s: %v", name, err)
	}
	return string(b)
}

// ingestTestDB connects to HOUSING_TEST_DB_URL, builds the fixture, applies the two
// real migrations, and seeds the target region. It skips without the variable.
func ingestTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("HOUSING_TEST_DB_URL", "HOUSING_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the test Postgres: %v", err)
	}
	if dsn == "" {
		t.Skip("set HOUSING_TEST_DB_URL, or HOUSING_TESTCONTAINERS=1 with -tags=testcontainers, to run the ingest DB tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, ingestDBSchema); err != nil {
		t.Fatalf("fixture schema: %v", err)
	}
	if _, err := pool.Exec(ctx, migrationFile(t, "000089_crawl_run_status.up.sql")); err != nil {
		t.Fatalf("apply 000089: %v", err)
	}
	if _, err := pool.Exec(ctx, migrationFile(t, "000150_add_crawl_ingest.up.sql")); err != nil {
		t.Fatalf("apply 000150: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
		VALUES ('SUBURB:VIC-3000-TESTVILLE', 'suburb', 'Testville', 'VIC', '3000')`); err != nil {
		t.Fatalf("seed region: %v", err)
	}
	return pool
}

// seedDispatch records a job in the ledger. The target is the suburb's display name
// and the source is "rea" or "domain", which is what the enqueue will write.
func seedDispatch(t *testing.T, pool *pgxpool.Pool, job, runID, source string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source)
		VALUES ($1, $2, 'delta', 'Testville', 'VIC', '3000', $3)`, job, runID, source); err != nil {
		t.Fatalf("seed dispatch %s: %v", job, err)
	}
}

// seedRig records a subject's enable flag.
func seedRig(t *testing.T, pool *pgxpool.Pool, subject string, enabled bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO housing_ingest_rigs (subject, enabled) VALUES ($1, $2)
		ON CONFLICT (subject) DO UPDATE SET enabled = EXCLUDED.enabled`, subject, enabled); err != nil {
		t.Fatalf("seed rig %s: %v", subject, err)
	}
}

// ingestRig is one running ingest: the service, its issuer, its clock, its DB and a
// test server to call it with a real Connect client.
type ingestRig struct {
	svc    *Service
	issuer *issuerFixture
	clock  *testClock
	pool   *pgxpool.Pool
	srv    *httptest.Server
}

// startIngest builds the service against the fixtures and waits until its verifier
// has keys, so a test starts from a loaded cache. It is a no-op wait when the issuer
// is down on purpose.
func startIngest(t *testing.T, pool *pgxpool.Pool, issuer *issuerFixture, clock *testClock, mutate func(*Config)) *ingestRig {
	t.Helper()
	cfg := Config{
		Enabled:            true,
		Issuer:             issuer.issuer,
		Audience:           testAudience,
		Org:                testIssuerOrg,
		AllowSubjects:      []string{testRig},
		MinContractVersion: DefaultMinContractVersion,
		PriceFraction:      DefaultPriceFraction,
		DelistFraction:     DefaultDelistFraction,
		DelistFloor:        DefaultDelistFloor,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	svc := New(context.Background(), Options{
		Config:     cfg,
		Pool:       pool,
		Now:        clock.Now,
		HTTPClient: issuer.client,
	})
	if svc.wa != nil && !issuerDownForTest(issuer) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := svc.wa.Ready(ctx); err != nil {
			t.Fatalf("verifier never loaded keys: %v", err)
		}
	}
	path, h := svc.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &ingestRig{svc: svc, issuer: issuer, clock: clock, pool: pool, srv: srv}
}

func issuerDownForTest(f *issuerFixture) bool { return f.isDown() }

// verifierForTest is a compile-time check that the real verifier satisfies the
// interface the auth interceptor takes.
var _ tokenVerifier = (*workloadauth.Verifier)(nil)
