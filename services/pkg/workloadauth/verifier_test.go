package workloadauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"math/big"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func mustVerify(t *testing.T, v *Verifier, raw string) *Identity {
	t.Helper()
	id, err := v.Verify(t.Context(), raw)
	if err != nil {
		t.Fatalf("Verify: unexpected error: %v", err)
	}
	return id
}

func wantUnauth(t *testing.T, v *Verifier, raw string) {
	t.Helper()
	_, err := v.Verify(t.Context(), raw)
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("Verify: want ErrUnauthenticated, got %v", err)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Fatalf("Verify: a bad token must not be ErrUnavailable: %v", err)
	}
	if raw != "" && strings.Contains(err.Error(), raw) {
		t.Fatalf("error leaks the raw token: %v", err)
	}
}

func wantUnavailable(t *testing.T, v *Verifier, raw string) {
	t.Helper()
	_, err := v.Verify(t.Context(), raw)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Verify: want ErrUnavailable, got %v", err)
	}
	if errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("Verify: an outage must not be ErrUnauthenticated: %v", err)
	}
}

func TestVerifyAcceptsValidToken(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	id := mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if id.Subject != testSub || id.Org != testOrg || id.KID != "k1" {
		t.Fatalf("identity = %+v", id)
	}
	if id.RigType != "housing" || id.AgentVersion != "1.4.2" || id.JTI == "" {
		t.Fatalf("identity fields = %+v", id)
	}
	if id.ExpiresAt.Sub(id.IssuedAt) != 600*time.Second {
		t.Fatalf("lifetime = %v", id.ExpiresAt.Sub(id.IssuedAt))
	}
}

// Rule 1: ES256 only. Each case must fail on the algorithm, not on anything else.
func TestAlgorithmAllowlist(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	claims := validClaims(ti.issuer, clk.Now())

	// none: unsigned.
	none := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	none.Header["kid"] = "k1"
	noneRaw, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, noneRaw)

	// HS256 keyed with the public key's PEM bytes: the classic key-confusion attack.
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	hs.Header["kid"] = "k1"
	hsRaw, err := hs.SignedString(pemPublicKey(t, &s.key.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, hsRaw)

	// HS256 with an arbitrary secret.
	hs2 := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	hs2.Header["kid"] = "k1"
	hs2Raw, err := hs2.SignedString([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, hs2Raw)

	// RS256 with the real kid.
	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rs := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	rs.Header["kid"] = "k1"
	rsRaw, err := rs.SignedString(rk)
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, rsRaw)

	// ES384 signed by a P-384 key with the real kid.
	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	es := jwt.NewWithClaims(jwt.SigningMethodES384, claims)
	es.Header["kid"] = "k1"
	esRaw, err := es.SignedString(p384)
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, esRaw)
}

// Rule 2: kid is required, must be in the JWKS, and an outage never turns a
// missing kid into ErrUnavailable.
func TestHeaderKidRules(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	noKid := jwt.NewWithClaims(jwt.SigningMethodES256, validClaims(ti.issuer, clk.Now()))
	raw, err := noKid.SignedString(s.key)
	if err != nil {
		t.Fatal(err)
	}
	wantUnauth(t, v, raw)

	unknown := newSigner(t, "k-unknown")
	wantUnauth(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))

	// Issuer down and the cache expired: a missing kid is still a bad token.
	ti.setDown(true)
	clk.Advance(2 * time.Hour)
	wantUnauth(t, v, raw)
}

// Rule 2: JWKS keys must be EC P-256 signing keys with a kid, and an ES256 alg
// if one is given. One bad key rejects the whole document.
func TestJWKSKeyRules(t *testing.T) {
	s := newSigner(t, "k1")
	good := s.jwk()

	mutate := func(f func(map[string]any)) map[string]any {
		m := make(map[string]any, len(good))
		for k, v := range good {
			m[k] = v
		}
		f(m)
		return m
	}
	cases := map[string]map[string]any{
		"alg RS256":       mutate(func(m map[string]any) { m["alg"] = "RS256" }),
		"kty RSA label":   mutate(func(m map[string]any) { m["kty"] = "RSA" }),
		"crv P-384 label": mutate(func(m map[string]any) { m["crv"] = "P-384" }),
		"use enc":         mutate(func(m map[string]any) { m["use"] = "enc" }),
		"no kid":          mutate(func(m map[string]any) { delete(m, "kid") }),
		"short x":         mutate(func(m map[string]any) { m["x"] = "AAAA" }),
		"off curve point": mutate(func(m map[string]any) { m["y"] = coord(new(big.Int).Add(s.key.Y, big.NewInt(1))) }),
	}
	for name, bad := range cases {
		t.Run(name, func(t *testing.T) {
			ti := newTestIssuer(t)
			clk := newClock()
			ti.publish()
			ti.mu.Lock()
			ti.keys = []map[string]any{good, bad}
			ti.mu.Unlock()
			if _, err := NewVerifier(t.Context(), baseConfig(ti, clk)); err == nil {
				t.Fatal("NewVerifier accepted a JWKS with a disallowed key")
			}
		})
	}

	t.Run("duplicate kid", func(t *testing.T) {
		ti := newTestIssuer(t)
		clk := newClock()
		ti.publish(s, s)
		if _, err := NewVerifier(t.Context(), baseConfig(ti, clk)); err == nil {
			t.Fatal("NewVerifier accepted a duplicate kid")
		}
	})
}

// Rule 3: exact iss; aud is exactly one audience.
func TestClaimIssuerAndAudience(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	now := clk.Now()

	cases := []struct {
		name string
		edit func(jwt.MapClaims)
		ok   bool
	}{
		{"iss exact", func(jwt.MapClaims) {}, true},
		{"iss other", func(c jwt.MapClaims) { c["iss"] = "https://evil.example/workload" }, false},
		{"iss trailing slash", func(c jwt.MapClaims) { c["iss"] = ti.issuer + "/" }, false},
		{"iss missing", func(c jwt.MapClaims) { delete(c, "iss") }, false},
		{"aud string exact", func(jwt.MapClaims) {}, true},
		{"aud array of one exact", func(c jwt.MapClaims) { c["aud"] = []string{testAud} }, true},
		{"aud other string", func(c jwt.MapClaims) { c["aud"] = "https://api.shorted.com.au/other" }, false},
		{"aud missing", func(c jwt.MapClaims) { delete(c, "aud") }, false},
		{"aud empty array", func(c jwt.MapClaims) { c["aud"] = []string{} }, false},
		{"aud array with the audience and another", func(c jwt.MapClaims) {
			c["aud"] = []string{testAud, "https://api.shorted.com.au/other"}
		}, false},
		{"aud array with another first", func(c jwt.MapClaims) {
			c["aud"] = []string{"https://api.shorted.com.au/other", testAud}
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validClaims(ti.issuer, now)
			tc.edit(c)
			raw := s.sign(t, c)
			if tc.ok {
				mustVerify(t, v, raw)
			} else {
				wantUnauth(t, v, raw)
			}
		})
	}
}

// Rule 4: time claims, with leeway, and the lifetime bound.
func TestClaimTimeRules(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	now := clk.Now()
	iat := now.Unix()

	cases := []struct {
		name string
		edit func(jwt.MapClaims)
		ok   bool
	}{
		{"valid", func(jwt.MapClaims) {}, true},
		{"exp missing", func(c jwt.MapClaims) { delete(c, "exp") }, false},
		{"expired beyond leeway", func(c jwt.MapClaims) {
			c["iat"], c["nbf"], c["exp"] = iat-661, iat-661, iat-61
		}, false},
		{"expired within leeway", func(c jwt.MapClaims) {
			c["iat"], c["nbf"], c["exp"] = iat-660, iat-660, iat-60
		}, true},
		{"nbf beyond leeway", func(c jwt.MapClaims) { c["nbf"] = iat + 61; c["exp"] = iat + 661 }, false},
		{"nbf within leeway", func(c jwt.MapClaims) { c["nbf"] = iat + 60; c["exp"] = iat + 660 }, true},
		{"nbf absent", func(c jwt.MapClaims) { delete(c, "nbf") }, true},
		{"iat missing", func(c jwt.MapClaims) { delete(c, "iat") }, false},
		{"iat future beyond leeway", func(c jwt.MapClaims) { c["iat"], c["nbf"], c["exp"] = iat+61, iat+61, iat+661 }, false},
		{"iat future within leeway", func(c jwt.MapClaims) { c["iat"], c["nbf"], c["exp"] = iat+60, iat+60, iat+660 }, true},
		{"lifetime exactly MaxLifetime", func(c jwt.MapClaims) { c["exp"] = iat + 900 }, true},
		{"lifetime over MaxLifetime", func(c jwt.MapClaims) { c["exp"] = iat + 901 }, false},
		{"exp before iat", func(c jwt.MapClaims) { c["exp"] = iat - 1 }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validClaims(ti.issuer, now)
			tc.edit(c)
			raw := s.sign(t, c)
			if tc.ok {
				mustVerify(t, v, raw)
			} else {
				wantUnauth(t, v, raw)
			}
		})
	}
}

// Rule 5: sub on the allowlist (empty denies all), org exact, jti present.
func TestClaimIdentityRules(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	now := clk.Now()

	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	cases := []struct {
		name string
		edit func(jwt.MapClaims)
	}{
		{"sub not on allowlist", func(c jwt.MapClaims) { c["sub"] = "rig:other" }},
		{"sub case differs", func(c jwt.MapClaims) { c["sub"] = "RIG:ABC" }},
		{"sub missing", func(c jwt.MapClaims) { delete(c, "sub") }},
		{"org mismatch", func(c jwt.MapClaims) { c["org"] = "org-other" }},
		{"org missing", func(c jwt.MapClaims) { delete(c, "org") }},
		{"jti missing", func(c jwt.MapClaims) { delete(c, "jti") }},
		{"jti empty", func(c jwt.MapClaims) { c["jti"] = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validClaims(ti.issuer, now)
			tc.edit(c)
			wantUnauth(t, v, s.sign(t, c))
		})
	}

	t.Run("empty allowlist denies everything", func(t *testing.T) {
		cfg := baseConfig(ti, clk)
		cfg.AllowSubjects = nil
		deny := startVerifier(t, ti, clk, cfg, s)
		wantUnauth(t, deny, s.sign(t, validClaims(ti.issuer, now)))
	})
}

// Rule 6: the kill list rejects a valid signature.
func TestKillList(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	killed := newSigner(t, "k-killed")
	live := newSigner(t, "k-live")
	cfg := baseConfig(ti, clk)
	cfg.DenyKIDs = []string{"k-killed"}
	v := startVerifier(t, ti, clk, cfg, killed, live)

	now := clk.Now()
	wantUnauth(t, v, killed.sign(t, validClaims(ti.issuer, now)))
	mustVerify(t, v, live.sign(t, validClaims(ti.issuer, now)))
}

// Rule 7 / rotation: two keys verify; a removed key stops after the refresh.
func TestKeyRotation(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	k2 := newSigner(t, "k2")
	cfg := baseConfig(ti, clk)
	v := startVerifier(t, ti, clk, cfg, k1, k2)

	now := clk.Now()
	mustVerify(t, v, k1.sign(t, validClaims(ti.issuer, now)))
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, now)))

	// k1 is removed at the issuer. The cached copy still verifies until the
	// cache is refreshed.
	ti.publish(k2)
	clk.Advance(2 * time.Hour) // past max-age
	wantUnauth(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Rule 7: max-age from Cache-Control is honoured; default is 1h.
func TestCacheControlMaxAge(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	ti.mu.Lock()
	ti.cacheControl = "public, max-age=60"
	ti.mu.Unlock()
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	if ti.hits() != 1 {
		t.Fatalf("startup hits = %d, want 1", ti.hits())
	}

	clk.Advance(30 * time.Second)
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 1 {
		t.Fatalf("refetched inside max-age: hits = %d", ti.hits())
	}

	clk.Advance(31 * time.Second)
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 2 {
		t.Fatalf("did not refetch after max-age: hits = %d", ti.hits())
	}
}

func TestCacheControlDefaultIsOneHour(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	clk.Advance(59 * time.Minute)
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 1 {
		t.Fatalf("refetched before the default 1h: hits = %d", ti.hits())
	}
	clk.Advance(2 * time.Minute)
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 2 {
		t.Fatalf("no refetch after the default 1h: hits = %d", ti.hits())
	}
}

// Rule 7: an unknown kid triggers a refetch at most once a minute.
func TestUnknownKidRefetchRateLimited(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	// A new key is published, but the startup fetch was less than a minute ago.
	k2 := newSigner(t, "k2")
	ti.publish(k1, k2)

	clk.Advance(10 * time.Second)
	wantUnauth(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
	wantUnauth(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 1 {
		t.Fatalf("unknown kid refetched inside a minute: hits = %d", ti.hits())
	}

	clk.Advance(51 * time.Second)
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
	if ti.hits() != 2 {
		t.Fatalf("unknown kid did not refetch after a minute: hits = %d", ti.hits())
	}
}

// Rule 7: concurrent unknown-kid requests share one fetch. Joiners must wait
// for the in-flight fetch, not see it as rate-limited and fail.
func TestConcurrentUnknownKidSharesOneFetch(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	// Publish a new key, then move past the rate limit so one fetch is due.
	k2 := newSigner(t, "k2")
	ti.publish(k1, k2)
	clk.Advance(2 * time.Minute)

	block := make(chan struct{})
	ti.mu.Lock()
	ti.block = block
	ti.mu.Unlock()
	before := ti.hits()

	const n = 16
	raw := k2.sign(t, validClaims(ti.issuer, clk.Now()))
	var (
		wg      sync.WaitGroup
		started atomic.Int32
		errs    = make(chan error, n)
	)
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started.Add(1)
			_, err := v.Verify(t.Context(), raw)
			errs <- err
		}()
	}
	for started.Load() < n {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // let the joiners reach the in-flight fetch
	ti.mu.Lock()
	ti.block = nil
	ti.mu.Unlock()
	close(block)
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent caller failed: %v", err)
		}
	}
	if got := ti.hits() - before; got != 1 {
		t.Fatalf("concurrent unknown-kid fetches = %d, want 1", got)
	}
}

// Rule 7 outage: cached keys serve until StaleKeysFor, then fail closed.
func TestOutageUsesCacheThenFailsClosed(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	cfg := baseConfig(ti, clk)
	v := startVerifier(t, ti, clk, cfg, s)

	ti.setDown(true)

	// Past max-age (1h), inside StaleKeysFor (24h): the refetch fails, the cache serves.
	clk.Advance(2 * time.Hour)
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))

	// Past StaleKeysFor since the last successful fetch: fail closed.
	clk.Advance(23 * time.Hour)
	wantUnavailable(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Rule 7 outage: an unknown kid during an outage is ErrUnavailable, so the
// caller can tell "BrandBrain is down" from "bad token".
func TestOutageUnknownKidIsUnavailable(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	ti.setDown(true)
	clk.Advance(2 * time.Hour)
	unknown := newSigner(t, "k-new")
	wantUnavailable(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Rule 7 outage: a rate-limited unknown kid right after a failed fetch is still
// ErrUnavailable, not a verdict on the token.
func TestOutageRateLimitedUnknownKidIsUnavailable(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	clk.Advance(2 * time.Hour)
	ti.setDown(true)
	unknown := newSigner(t, "k-new")
	wantUnavailable(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))
	// Second call inside the minute is rate-limited, and must still be Unavailable.
	wantUnavailable(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))
}

func TestStartupFailsWhenIssuerDown(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	ti.setDown(true)
	_, err := NewVerifier(t.Context(), baseConfig(ti, clk))
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("NewVerifier with issuer down: want ErrUnavailable, got %v", err)
	}
}

// Rule 8: discovery.
func TestDiscoveryRules(t *testing.T) {
	t.Run("issuer in document must match exactly", func(t *testing.T) {
		ti := newTestIssuer(t)
		clk := newClock()
		ti.mu.Lock()
		ti.discoveryDoc = map[string]any{"issuer": ti.issuer + "/other", "jwks_uri": ti.srv.URL + "/workload/jwks.json"}
		ti.mu.Unlock()
		if _, err := NewVerifier(t.Context(), baseConfig(ti, clk)); err == nil {
			t.Fatal("NewVerifier accepted a discovery issuer that differs from Config.Issuer")
		}
	})

	t.Run("jwks_uri must be https", func(t *testing.T) {
		ti := newTestIssuer(t)
		clk := newClock()
		ti.mu.Lock()
		ti.jwksURIOver = "http://" + strings.TrimPrefix(ti.srv.URL, "https://") + "/workload/jwks.json"
		ti.mu.Unlock()
		if _, err := NewVerifier(t.Context(), baseConfig(ti, clk)); err == nil {
			t.Fatal("NewVerifier accepted an http jwks_uri")
		}
	})

	t.Run("issuer must be https", func(t *testing.T) {
		clk := newClock()
		cfg := Config{Issuer: "http://issuer.example/workload", Audience: testAud, Org: testOrg, Now: clk.Now}
		if _, err := NewVerifier(t.Context(), cfg); err == nil {
			t.Fatal("NewVerifier accepted an http issuer")
		}
	})
}

// Rule 8: the jwks_uri host check, directly, since a cross-host fetch cannot be
// exercised without a second certificate.
func TestValidateJWKSURIHost(t *testing.T) {
	iss := mustParseURL(t, "https://api.brandbrain.dev/workload")
	cases := []struct {
		name  string
		raw   string
		extra map[string]bool
		ok    bool
	}{
		{"same host", "https://api.brandbrain.dev/workload/jwks.json", nil, true},
		{"same host case-insensitive", "https://API.BrandBrain.dev/workload/jwks.json", nil, true},
		{"other host", "https://keys.example.com/jwks.json", nil, false},
		{"other host explicitly allowed", "https://keys.example.com/jwks.json", map[string]bool{"keys.example.com": true}, true},
		{"subdomain is another host", "https://evil.api.brandbrain.dev/jwks.json", nil, false},
		{"userinfo", "https://user@api.brandbrain.dev/jwks.json", nil, false},
		{"http", "http://api.brandbrain.dev/workload/jwks.json", nil, false},
		{"relative", "/workload/jwks.json", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateJWKSURI(iss, tc.raw, tc.extra)
			if tc.ok && err != nil {
				t.Fatalf("want accept, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want reject, got accept")
			}
		})
	}
}

// Rule 8: the JWKS body is size-capped.
func TestJWKSSizeCap(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	pad := strings.Repeat("a", maxDocBytes+1024)
	ti.mu.Lock()
	ti.jwksBody = []byte(`{"keys":[],"pad":"` + pad + `"}`)
	ti.mu.Unlock()
	if _, err := NewVerifier(t.Context(), baseConfig(ti, clk)); err == nil {
		t.Fatal("NewVerifier accepted an oversized JWKS")
	}
}

// Rule 3, the aud form, with its own table so the decision is visible.
func TestAudienceFormDecision(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	now := clk.Now()

	// Accepted: the JSON string form, and a one-element array.
	c := validClaims(ti.issuer, now)
	mustVerify(t, v, s.sign(t, c))
	c = validClaims(ti.issuer, now)
	c["aud"] = []string{testAud}
	mustVerify(t, v, s.sign(t, c))

	// Rejected: any array with more than one entry, even if one is ours.
	c = validClaims(ti.issuer, now)
	c["aud"] = []string{testAud, "https://other.example"}
	wantUnauth(t, v, s.sign(t, c))
}

// No rule's error may echo the token.
func TestErrorsNeverContainToken(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	c := validClaims(ti.issuer, clk.Now())
	c["sub"] = "rig:nope"
	raw := s.sign(t, c)
	_, err := v.Verify(t.Context(), raw)
	if err == nil {
		t.Fatal("expected rejection")
	}
	parts := strings.Split(raw, ".")
	for _, p := range parts {
		if strings.Contains(err.Error(), p) {
			t.Fatalf("error contains a token segment: %v", err)
		}
	}
}

func TestVerifyRejectsEmptyAndOversized(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	wantUnauth(t, v, "")
	wantUnauth(t, v, strings.Repeat("a", maxTokenBytes+1))
}

func TestNewVerifierValidatesConfig(t *testing.T) {
	clk := newClock()
	bad := []Config{
		{Audience: testAud, Org: testOrg},
		{Issuer: "https://x.example", Org: testOrg},
		{Issuer: "https://x.example", Audience: testAud},
		{Issuer: "https://x.example/?q=1", Audience: testAud, Org: testOrg},
		{Issuer: "https://x.example", Audience: testAud, Org: testOrg, Leeway: -time.Second},
	}
	for i, cfg := range bad {
		cfg.Now = clk.Now
		if _, err := NewVerifier(t.Context(), cfg); err == nil {
			t.Fatalf("config %d accepted", i)
		}
	}
}

func TestMaxAgeParsing(t *testing.T) {
	cases := map[string]time.Duration{
		"":                     time.Hour,
		"max-age=60":           time.Minute,
		"public, max-age=120":  2 * time.Minute,
		"MAX-AGE=30, no-cache": 30 * time.Second,
		"max-age=oops":         time.Hour,
		"max-age=-5":           time.Hour,
		"no-store":             time.Hour,
		"max-age=0":            0,
	}
	for in, want := range cases {
		if got := maxAgeFrom(in); got != want {
			t.Errorf("maxAgeFrom(%q) = %v, want %v", in, got, want)
		}
	}
}

// Parsing rejects a non-P-256 curve even with a valid point, to ensure the
// curve is checked, not inferred from the coordinate size.
func TestParseJWKSRejectsWrongCurveLabel(t *testing.T) {
	s := newSigner(t, "k1")
	j := s.jwk()
	j["crv"] = "P-521"
	body := mustJSON(t, map[string]any{"keys": []map[string]any{j}})
	if _, err := parseJWKS(body); err == nil {
		t.Fatal("parseJWKS accepted crv P-521")
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
