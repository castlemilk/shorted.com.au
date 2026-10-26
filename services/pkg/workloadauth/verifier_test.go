package workloadauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
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

// Rule 2: kid is required, and must be in the JWKS.
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
// if one is given. One bad key rejects the whole document, which is recorded
// in Status so it is not a silent countdown.
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
			// The bad key is the only key published, so the rule under test is
			// the one that rejects it.
			ti.mu.Lock()
			ti.keys = []map[string]any{bad}
			ti.mu.Unlock()
			v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
			if err != nil {
				t.Fatalf("NewVerifier: %v", err)
			}
			if err := v.Ready(t.Context()); err == nil {
				t.Fatal("Ready accepted a JWKS with a disallowed key")
			}
			st := v.Status()
			if st.LastError == "" || st.KeyCount != 0 {
				t.Fatalf("Status = %+v, want the rejection recorded and no keys", st)
			}
		})
	}

	t.Run("duplicate kid", func(t *testing.T) {
		ti := newTestIssuer(t)
		clk := newClock()
		ti.publish(s, s)
		v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if err := v.Ready(t.Context()); err == nil {
			t.Fatal("Ready accepted a duplicate kid")
		}
	})
}

// Rule 3: exact iss and aud, case included, and aud is exactly one audience.
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
		{"iss differs only in path case", func(c jwt.MapClaims) {
			c["iss"] = strings.Replace(ti.issuer, "/workload", "/WORKLOAD", 1)
		}, false},
		{"iss differs only in scheme case", func(c jwt.MapClaims) {
			c["iss"] = strings.Replace(ti.issuer, "https://", "HTTPS://", 1)
		}, false},
		{"aud string exact", func(jwt.MapClaims) {}, true},
		{"aud array of one exact", func(c jwt.MapClaims) { c["aud"] = []string{testAud} }, true},
		{"aud other string", func(c jwt.MapClaims) { c["aud"] = "https://api.shorted.com.au/other" }, false},
		{"aud missing", func(c jwt.MapClaims) { delete(c, "aud") }, false},
		{"aud empty array", func(c jwt.MapClaims) { c["aud"] = []string{} }, false},
		{"aud differs only in case", func(c jwt.MapClaims) {
			c["aud"] = strings.Replace(testAud, "housing-ingest", "Housing-Ingest", 1)
		}, false},
		{"aud array differs only in case", func(c jwt.MapClaims) {
			c["aud"] = []string{strings.ToUpper(testAud)}
		}, false},
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
		// nbf stays at now, so only the iat rule can reject these.
		{"iat future beyond leeway", func(c jwt.MapClaims) { c["iat"], c["exp"] = iat+61, iat+661 }, false},
		{"iat future within leeway", func(c jwt.MapClaims) { c["iat"], c["exp"] = iat+60, iat+660 }, true},
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
		{"org case differs", func(c jwt.MapClaims) { c["org"] = strings.ToUpper(testOrg) }},
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

// Config entries are trimmed, so " k1" denies k1 and " rig:abc " allows rig:abc.
// An empty entry is a config error.
func TestConfigEntriesTrimmedAndValidated(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	killed := newSigner(t, "k-killed")

	t.Run("padded kid still denies", func(t *testing.T) {
		cfg := baseConfig(ti, clk)
		cfg.AllowSubjects = []string{" " + testSub + " "}
		cfg.DenyKIDs = []string{" k-killed "}
		v := startVerifier(t, ti, clk, cfg, killed)
		wantUnauth(t, v, killed.sign(t, validClaims(ti.issuer, clk.Now())))
	})

	t.Run("padded subject is allowed", func(t *testing.T) {
		cfg := baseConfig(ti, clk)
		cfg.AllowSubjects = []string{" " + testSub + " "}
		v := startVerifier(t, ti, clk, cfg, killed)
		// killed's kid is not denied in this config, so the token verifies.
		mustVerify(t, v, killed.sign(t, validClaims(ti.issuer, clk.Now())))
	})

	for name, cfg := range map[string]Config{
		"empty deny entry":  func() Config { c := baseConfig(ti, clk); c.DenyKIDs = []string{"k1", ""}; return c }(),
		"blank allow entry": func() Config { c := baseConfig(ti, clk); c.AllowSubjects = []string{"  "}; return c }(),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewVerifier(t.Context(), cfg); err == nil {
				t.Fatal("NewVerifier accepted an empty entry")
			}
		})
	}
}

// Rule 7 / rotation: two keys verify; a removed key stops verifying once the
// cache has been refreshed.
func TestKeyRotation(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	k2 := newSigner(t, "k2")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1, k2)

	now := clk.Now()
	mustVerify(t, v, k1.sign(t, validClaims(ti.issuer, now)))
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, now)))

	// k1 is removed at the issuer. Past max-age, Ready refreshes the cache.
	ti.publish(k2)
	clk.Advance(2 * time.Hour)
	if err := v.Ready(t.Context()); err != nil {
		t.Fatalf("Ready after rotation: %v", err)
	}
	wantUnauth(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Past max-age a cached key is still served while a refresh runs in the
// background. Once the refresh lands, the removed key is rejected.
func TestStaleKeyServedWhileRefreshing(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	k2 := newSigner(t, "k2")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	ti.publish(k2) // k1 is removed at the issuer
	clk.Advance(2 * time.Hour)

	// The valid token is not blocked on the issuer. The cached key answers.
	mustVerify(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
	waitForSuccess(t, v, clk)
	wantUnauth(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
	mustVerify(t, v, k2.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Rule 7: max-age from Cache-Control is honoured.
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
	waitForSuccess(t, v, clk)
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
	waitForSuccess(t, v, clk)
	if ti.hits() != 2 {
		t.Fatalf("no refetch after the default 1h: hits = %d", ti.hits())
	}
}

// Item 2: an issuer max-age is clamped to one hour, so a removed key cannot
// outlive revocation. Each case reads the clamped value through Ready, which
// refreshes only when the cache is not fresh. With no clamp, the cache would
// still be fresh at 2h and the removed key would keep verifying.
func TestMaxAgeIsClamped(t *testing.T) {
	for name, header := range map[string]string{
		"max-age=604800 (7 days)":          "max-age=604800",
		"max-age overflows 64-bit seconds": "max-age=99999999999999999999999999",
	} {
		t.Run(name, func(t *testing.T) {
			ti := newTestIssuer(t)
			clk := newClock()
			k1 := newSigner(t, "k1")
			k2 := newSigner(t, "k2")
			ti.mu.Lock()
			ti.cacheControl = header
			ti.mu.Unlock()
			v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

			ti.publish(k2) // k1 is removed
			clk.Advance(2 * time.Hour)
			if err := v.Ready(t.Context()); err != nil {
				t.Fatalf("Ready: %v", err)
			}
			wantUnauth(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
		})
	}
}

// Item 2: the fast path honours StaleKeysFor. A cache older than StaleKeysFor
// is not used even while the issuer is down and max-age has not passed. The
// test sets max-age to its one-hour cap and StaleKeysFor to 30 minutes, and
// checks at 40 minutes with the issuer down.
func TestFastPathRespectsStaleKeysFor(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	cfg := baseConfig(ti, clk)
	cfg.StaleKeysFor = 30 * time.Minute
	v := startVerifier(t, ti, clk, cfg, s)

	ti.setDown(true)
	clk.Advance(40 * time.Minute)
	wantUnavailable(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Item 2: a key removed while the issuer is down stops verifying once the
// cache is older than StaleKeysFor, even with a 7-day max-age header.
func TestRemovedKeyStopsAfterStaleWindow(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	ti.mu.Lock()
	ti.cacheControl = "max-age=604800"
	ti.mu.Unlock()
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	ti.setDown(true)
	clk.Advance(30 * time.Hour)
	wantUnavailable(t, v, k1.sign(t, validClaims(ti.issuer, clk.Now())))
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

	k2 := newSigner(t, "k2")
	ti.publish(k1, k2)
	clk.Advance(2 * time.Minute) // past the rate limit, so one fetch is due

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

// Caller context: a waiting Verify returns when its ctx ends, and does not hang
// on a stalled issuer.
func TestVerifyHonoursCallerContext(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	k2 := newSigner(t, "k2")
	ti.publish(k1, k2)
	clk.Advance(2 * time.Minute)
	block := make(chan struct{})
	ti.mu.Lock()
	ti.block = block
	ti.mu.Unlock()
	// Release the stalled handler before the server closes (cleanups run LIFO).
	t.Cleanup(func() { close(block) })

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	_, err := v.Verify(ctx, k2.sign(t, validClaims(ti.issuer, clk.Now())))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Verify = %v, want the caller's deadline", err)
	}
}

// Rule 7 outage: cached keys serve until StaleKeysFor, then fail closed.
func TestOutageUsesCacheThenFailsClosed(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	ti.setDown(true)

	// Past max-age (1h), inside StaleKeysFor (24h): the refresh fails, the cache serves.
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

// A rate-limited unknown kid right after a failed fetch is still ErrUnavailable,
// not a verdict on the token.
func TestOutageRateLimitedUnknownKidIsUnavailable(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	k1 := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), k1)

	clk.Advance(2 * time.Hour)
	ti.setDown(true)
	unknown := newSigner(t, "k-new")
	wantUnavailable(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))
	// The second call inside the minute is rate-limited, and must still be Unavailable.
	wantUnavailable(t, v, unknown.sign(t, validClaims(ti.issuer, clk.Now())))
}

// Item 4: startup does not depend on the issuer. NewVerifier succeeds with the
// issuer down, Verify and Ready report ErrUnavailable, and the verifier
// recovers when the issuer returns.
func TestStartupIsLazy(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	ti.setDown(true)

	v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
	if err != nil {
		t.Fatalf("NewVerifier with the issuer down: want nil, got %v", err)
	}
	if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Ready with the issuer down: want ErrUnavailable, got %v", err)
	}
	wantUnavailable(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if st := v.Status(); st.LastSuccess != (time.Time{}) || st.LastError == "" || st.KeyCount != 0 {
		t.Fatalf("Status before any success = %+v", st)
	}

	ti.publish(s)
	ti.setDown(false)
	clk.Advance(2 * time.Minute)
	if err := v.Ready(t.Context()); err != nil {
		t.Fatalf("Ready after recovery: %v", err)
	}
	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
	if st := v.Status(); st.LastError != "" || st.KeyCount != 1 || st.LastSuccess.IsZero() {
		t.Fatalf("Status after recovery = %+v", st)
	}
}

// Config errors are still fatal at construction.
func TestNewVerifierValidatesConfig(t *testing.T) {
	clk := newClock()
	bad := []Config{
		{Audience: testAud, Org: testOrg},
		{Issuer: "https://x.example", Org: testOrg},
		{Issuer: "https://x.example", Audience: testAud},
		{Issuer: "https://x.example/?q=1", Audience: testAud, Org: testOrg},
		{Issuer: "https://x.example/", Audience: testAud, Org: testOrg},
		{Issuer: "http://x.example", Audience: testAud, Org: testOrg},
		{Issuer: "https://x.example", Audience: testAud, Org: testOrg, Leeway: -time.Second},
	}
	for i, cfg := range bad {
		cfg.Now = clk.Now
		if _, err := NewVerifier(t.Context(), cfg); err == nil {
			t.Fatalf("config %d accepted", i)
		}
	}
}

// Item 1: discovery must name exactly <issuer>/jwks.json. A mismatch is not an
// outage, so Ready reports it as a plain error.
func TestDiscoveryPinsJWKSAndIssuer(t *testing.T) {
	cases := map[string]func(*testIssuer){
		"jwks_uri other path, same host": func(ti *testIssuer) { ti.jwksURIOver = ti.issuer + "/other.json" },
		"jwks_uri other host": func(ti *testIssuer) {
			ti.jwksURIOver = "https://keys.example.com/workload/jwks.json"
		},
		"jwks_uri http": func(ti *testIssuer) {
			ti.jwksURIOver = "http://" + strings.TrimPrefix(ti.issuer, "https://") + "/jwks.json"
		},
		"jwks_uri with query": func(ti *testIssuer) { ti.jwksURIOver = ti.issuer + "/jwks.json?x=1" },
		"issuer differs": func(ti *testIssuer) {
			ti.discoveryDoc = map[string]any{"issuer": ti.issuer + "/other", "jwks_uri": ti.issuer + "/jwks.json"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			ti := newTestIssuer(t)
			clk := newClock()
			ti.mu.Lock()
			mutate(ti)
			ti.mu.Unlock()
			v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
			if err != nil {
				t.Fatalf("NewVerifier: %v", err)
			}
			err = v.Ready(t.Context())
			if err == nil {
				t.Fatal("Ready accepted a discovery document that does not match the config")
			}
			if errors.Is(err, ErrUnavailable) {
				t.Fatalf("a config mismatch must not be ErrUnavailable: %v", err)
			}
			if v.Status().LastError == "" {
				t.Fatal("Status did not record the discovery mismatch")
			}
		})
	}
}

// Item 1: the default client refuses redirects. A 302 to another host or to
// http, and a caller-supplied client that follows redirects, must all fail the
// fetch as ErrUnavailable, and the attacker's keys must never be fetched.
func TestRedirectsAreNotFollowed(t *testing.T) {
	attacker := newSigner(t, "k-attacker")

	t.Run("default client refuses a 302 to another https host", func(t *testing.T) {
		var mu sync.Mutex
		hits := 0
		ti := newTestIssuer(t)
		evil := attackerServer(t, attacker, true, &hits, &mu)
		trustServers(t, ti.srv, evil) // the redirect target must be trusted, or TLS would fail anyway
		ti.mu.Lock()
		ti.jwksRedirect = evil.URL + "/keys.json"
		ti.mu.Unlock()
		clk := newClock()

		v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Ready = %v, want ErrUnavailable", err)
		}
		wantUnavailable(t, v, attacker.sign(t, validClaims(ti.issuer, clk.Now())))
		mu.Lock()
		defer mu.Unlock()
		if hits != 0 {
			t.Fatalf("the redirect was followed: attacker host hit %d times", hits)
		}
	})

	t.Run("default client refuses a 302 to http", func(t *testing.T) {
		var mu sync.Mutex
		hits := 0
		ti := newTestIssuer(t)
		evil := attackerServer(t, attacker, false, &hits, &mu)
		ti.mu.Lock()
		ti.jwksRedirect = evil.URL + "/keys.json"
		ti.mu.Unlock()
		clk := newClock()

		v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Ready = %v, want ErrUnavailable", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if hits != 0 {
			t.Fatalf("the http redirect was followed: attacker host hit %d times", hits)
		}
	})

	t.Run("a 302 on discovery is not followed", func(t *testing.T) {
		var mu sync.Mutex
		hits := 0
		ti := newTestIssuer(t)
		evil := attackerServer(t, attacker, true, &hits, &mu)
		trustServers(t, ti.srv, evil)
		ti.mu.Lock()
		ti.discoveryRedir = evil.URL + "/.well-known/openid-configuration"
		ti.mu.Unlock()
		clk := newClock()

		v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Ready = %v, want ErrUnavailable", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if hits != 0 {
			t.Fatalf("the discovery redirect was followed: %d hits", hits)
		}
	})

	t.Run("a caller-supplied client that follows redirects is still refused", func(t *testing.T) {
		var mu sync.Mutex
		hits := 0
		ti := newTestIssuer(t)
		evil := attackerServer(t, attacker, true, &hits, &mu)
		ti.mu.Lock()
		ti.jwksRedirect = evil.URL + "/keys.json"
		ti.mu.Unlock()
		clk := newClock()

		// A client with no CheckRedirect follows redirects by default.
		caller := &http.Client{Transport: trustedTransport(ti.srv, evil)}
		cfg := baseConfig(ti, clk)
		cfg.HTTPClient = caller

		v, err := NewVerifier(t.Context(), cfg)
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Ready = %v, want ErrUnavailable", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if hits != 0 {
			t.Fatalf("the caller's client followed a redirect: %d hits", hits)
		}
		if caller.CheckRedirect != nil {
			t.Fatal("NewVerifier changed the caller's client")
		}
	})
}

// Item 3: a 200 with an empty or missing keys array is a failed fetch, and the
// cache stays. Ready reports the failure, Status records it, and a token the
// cache already holds still verifies.
func TestEmptyJWKSKeepsCache(t *testing.T) {
	payloads := map[string]string{
		"empty keys":        `{"keys":[]}`,
		"null keys":         `{"keys":null}`,
		"missing keys":      `{}`,
		"null document":     `null`,
		"error document":    `{"error":"boom"}`,
		"keys not an array": `{"keys":{}}`,
	}
	for name, body := range payloads {
		t.Run(name, func(t *testing.T) {
			ti := newTestIssuer(t)
			clk := newClock()
			s := newSigner(t, "k1")
			v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
			loaded := v.Status().LastSuccess

			ti.mu.Lock()
			ti.jwksBody = []byte(body)
			ti.mu.Unlock()
			clk.Advance(2 * time.Hour) // past max-age, so Ready refetches
			if err := v.Ready(t.Context()); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("Ready = %v, want ErrUnavailable", err)
			}
			st := v.Status()
			if st.KeyCount != 1 || st.LastSuccess != loaded || st.LastError == "" {
				t.Fatalf("Status = %+v: the cache was replaced or the failure was not recorded", st)
			}
			mustVerify(t, v, s.sign(t, validClaims(ti.issuer, clk.Now())))
		})
	}
}

func TestParseJWKSRejectsEmptySets(t *testing.T) {
	for _, body := range []string{`{"keys":[]}`, `{"keys":null}`, `{}`, `null`, `{"error":"x"}`} {
		if _, err := parseJWKS([]byte(body)); err == nil {
			t.Fatalf("parseJWKS accepted %s", body)
		}
	}
}

// Item 3 companion: a JWKS body over the size cap is rejected.
func TestJWKSSizeCap(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	pad := strings.Repeat("a", maxDocBytes+1024)
	ti.mu.Lock()
	ti.jwksBody = []byte(`{"keys":[],"pad":"` + pad + `"}`)
	ti.mu.Unlock()
	v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if err := v.Ready(t.Context()); err == nil {
		t.Fatal("Ready accepted an oversized JWKS")
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
	for _, p := range strings.Split(raw, ".") {
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

func TestMaxAgeParsing(t *testing.T) {
	cases := map[string]time.Duration{
		"":                                   time.Hour,
		"max-age=60":                         time.Minute,
		"public, max-age=120":                2 * time.Minute,
		"MAX-AGE=30, no-cache":               30 * time.Second,
		"max-age=604800":                     time.Hour, // clamped
		"max-age=3600":                       time.Hour,
		"max-age=99999999999999999999999999": time.Hour, // overflow: clamped
		"max-age=oops":                       time.Hour,
		"max-age=-5":                         time.Hour,
		"max-age=":                           time.Hour,
		"no-store":                           time.Hour,
		"max-age=0":                          0,
	}
	for in, want := range cases {
		if got := maxAgeFrom(in); got != want {
			t.Errorf("maxAgeFrom(%q) = %v, want %v", in, got, want)
		}
	}
}

// Parsing rejects a non-P-256 curve label even with a valid point.
func TestParseJWKSRejectsWrongCurveLabel(t *testing.T) {
	s := newSigner(t, "k1")
	j := s.jwk()
	j["crv"] = "P-521"
	body := mustJSON(t, map[string]any{"keys": []map[string]any{j}})
	if _, err := parseJWKS(body); err == nil {
		t.Fatal("parseJWKS accepted crv P-521")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
