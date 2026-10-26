package workloadauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	testAud = "https://api.shorted.com.au/housing-ingest"
	testOrg = "org-shorted"
	testSub = "rig:abc"
)

// fakeClock is a goroutine-safe injectable clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// signer is one ES256 signing key with its kid.
type signer struct {
	kid string
	key *ecdsa.PrivateKey
}

func newSigner(t *testing.T, kid string) *signer {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &signer{kid: kid, key: k}
}

// jwk returns the public key as a JWKS entry.
func (s *signer) jwk() map[string]any {
	return map[string]any{
		"kty": "EC",
		"crv": "P-256",
		"alg": "ES256",
		"use": "sig",
		"kid": s.kid,
		"x":   coord(s.key.X),
		"y":   coord(s.key.Y),
	}
}

func coord(n *big.Int) string {
	b := make([]byte, coordBytes)
	n.FillBytes(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// sign mints an ES256 token with this signer's kid.
func (s *signer) sign(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = s.kid
	raw, err := tok.SignedString(s.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

var jtiCounter int

// validClaims are a well-formed token issued at now.
func validClaims(issuer string, now time.Time) jwt.MapClaims {
	jtiCounter++
	iat := now.Unix()
	return jwt.MapClaims{
		"iss":           issuer,
		"sub":           testSub,
		"aud":           testAud,
		"iat":           iat,
		"nbf":           iat,
		"exp":           iat + 600,
		"jti":           fmt.Sprintf("jti-%d", jtiCounter),
		"org":           testOrg,
		"rig_type":      "housing",
		"agent_version": "1.4.2",
	}
}

// testIssuer is an httptest TLS server serving discovery and JWKS, with knobs
// for outages, rotation, cache headers and malformed documents.
type testIssuer struct {
	srv    *httptest.Server
	issuer string // srv.URL + "/workload"

	mu           sync.Mutex
	keys         []map[string]any
	cacheControl string // "" means no header
	down         bool
	discoveryDoc map[string]any // nil means the correct document
	jwksURIOver  string         // non-empty overrides jwks_uri
	jwksBody     []byte         // non-nil overrides the JWKS body
	jwksHits     int
	block        chan struct{} // non-nil: JWKS handler waits on it
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	ti := &testIssuer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/workload/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		ti.mu.Lock()
		down, doc, over := ti.down, ti.discoveryDoc, ti.jwksURIOver
		ti.mu.Unlock()
		if down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		if doc == nil {
			jwks := over
			if jwks == "" {
				jwks = ti.srv.URL + "/workload/jwks.json"
			}
			doc = map[string]any{"issuer": ti.issuer, "jwks_uri": jwks}
		}
		writeJSON(w, doc)
	})
	mux.HandleFunc("/workload/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		ti.mu.Lock()
		ti.jwksHits++
		down, body, cc, blk := ti.down, ti.jwksBody, ti.cacheControl, ti.block
		keys := append([]map[string]any(nil), ti.keys...)
		ti.mu.Unlock()
		if blk != nil {
			<-blk
		}
		if down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		if cc != "" {
			w.Header().Set("Cache-Control", cc)
		}
		if body != nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
			return
		}
		writeJSON(w, map[string]any{"keys": keys})
	})
	ti.srv = httptest.NewTLSServer(mux)
	t.Cleanup(ti.srv.Close)
	ti.issuer = ti.srv.URL + "/workload"
	return ti
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (ti *testIssuer) publish(signers ...*signer) {
	ti.mu.Lock()
	defer ti.mu.Unlock()
	ti.keys = nil
	for _, s := range signers {
		ti.keys = append(ti.keys, s.jwk())
	}
}

func (ti *testIssuer) setDown(down bool) {
	ti.mu.Lock()
	defer ti.mu.Unlock()
	ti.down = down
}

func (ti *testIssuer) hits() int {
	ti.mu.Lock()
	defer ti.mu.Unlock()
	return ti.jwksHits
}

// baseConfig is a Config that trusts this issuer and the injected clock.
func baseConfig(ti *testIssuer, clk *fakeClock) Config {
	return Config{
		Issuer:        ti.issuer,
		Audience:      testAud,
		Org:           testOrg,
		AllowSubjects: []string{testSub},
		HTTPClient:    ti.srv.Client(),
		Now:           clk.Now,
	}
}

// startVerifier publishes signers, then builds a Verifier against ti.
func startVerifier(t *testing.T, ti *testIssuer, clk *fakeClock, cfg Config, signers ...*signer) *Verifier {
	t.Helper()
	ti.publish(signers...)
	v, err := NewVerifier(t.Context(), cfg)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return v
}

func pemPublicKey(t *testing.T, pub *ecdsa.PublicKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}
