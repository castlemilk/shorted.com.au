package workloadauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// These tests pin checks that the behaviour tests alone do not isolate. Each one
// fails when its own check is removed, not only when every check is removed.

// Rule 3, audience: the match is exact. A prefix or suffix match would accept every
// case below, so each must be refused.
func TestAudienceIsExactNotAPrefix(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	now := clk.Now()

	mustVerify(t, v, s.sign(t, validClaims(ti.issuer, now)))

	cases := map[string]string{
		"trailing slash":          testAud + "/",
		"path suffix":             testAud + "/extra",
		"letter suffix":           testAud + "x",
		"query suffix":            testAud + "?x=1",
		"bare host":               "https://api.shorted.com.au",
		"parent path":             "https://api.shorted.com.au/",
		"sibling path prefix":     "https://api.shorted.com.au/housing",
		"other host same path":    "https://api.example.com/housing-ingest",
		"upper-case host":         "https://API.shorted.com.au/housing-ingest",
		"upper-case path":         "https://api.shorted.com.au/HOUSING-INGEST",
		"empty string":            "",
		"http scheme":             "http://api.shorted.com.au/housing-ingest",
		"leading space":           " " + testAud,
		"suffix on the array one": testAud + "/v2",
	}
	for name, aud := range cases {
		t.Run(name, func(t *testing.T) {
			c := validClaims(ti.issuer, now)
			c["aud"] = aud
			wantUnauth(t, v, s.sign(t, c))
			if got := ReasonOf(mustErr(t, v, s.sign(t, c))); got != ReasonAudience {
				t.Fatalf("reason = %q, want %q", got, ReasonAudience)
			}
		})
	}
}

func mustErr(t *testing.T, v *Verifier, raw string) error {
	t.Helper()
	_, err := v.Verify(t.Context(), raw)
	if err == nil {
		t.Fatal("Verify accepted a token that must be refused")
	}
	return err
}

// Rule 1, on its own: selectKey refuses every algorithm but ES256 before it chooses
// a key. Each case has a real kid, which the cache holds, so the only thing that can
// refuse it is the algorithm check. Removing that check makes every case return a key.
func TestSelectKeyRefusesNonES256Alone(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)

	methods := map[string]jwt.SigningMethod{
		"none":  jwt.SigningMethodNone,
		"HS256": jwt.SigningMethodHS256,
		"RS256": jwt.SigningMethodRS256,
		"ES384": jwt.SigningMethodES384,
		"PS256": jwt.SigningMethodPS256,
	}
	for name, m := range methods {
		t.Run(name, func(t *testing.T) {
			tok := &jwt.Token{Method: m, Header: map[string]any{"alg": m.Alg(), "kid": "k1"}}
			key, _, err := v.selectKey(t.Context(), tok)
			if key != nil || !errors.Is(err, ErrUnauthenticated) || ReasonOf(err) != ReasonAlgorithm {
				t.Fatalf("selectKey(%s) = key %v, err %v; want algorithm rejection", name, key != nil, err)
			}
		})
	}
	t.Run("nil method", func(t *testing.T) {
		tok := &jwt.Token{Header: map[string]any{"kid": "k1"}}
		if _, _, err := v.selectKey(t.Context(), tok); ReasonOf(err) != ReasonAlgorithm {
			t.Fatalf("nil method: err %v", err)
		}
	})
	t.Run("ES256 with the published kid is chosen", func(t *testing.T) {
		tok := &jwt.Token{Method: jwt.SigningMethodES256, Header: map[string]any{"kid": "k1"}}
		key, kid, err := v.selectKey(t.Context(), tok)
		if err != nil || key == nil || kid != "k1" {
			t.Fatalf("selectKey(ES256) = key %v, kid %q, err %v", key != nil, kid, err)
		}
	})
}

// Rule 1, the library half: the parser options refuse any algorithm outside ES256
// before keyFunc is consulted. Each token below is correctly signed by its own key, and
// keyFunc hands the parser that key, so the library's algorithm list is the only thing
// that can refuse it. Removing WithValidMethods makes each one verify.
func TestParserOptionsRefuseNonES256Alone(t *testing.T) {
	claims := jwt.MapClaims{"sub": "x"}

	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		method jwt.SigningMethod
		sign   any
		key    any
	}{
		{"HS256", jwt.SigningMethodHS256, []byte("shared"), []byte("shared")},
		{"RS256", jwt.SigningMethodRS256, rk, &rk.PublicKey},
		{"ES384", jwt.SigningMethodES384, p384, &p384.PublicKey},
		{"none", jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, jwt.UnsafeAllowNoneSignatureType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := jwt.NewWithClaims(tc.method, claims).SignedString(tc.sign)
			if err != nil {
				t.Fatal(err)
			}
			keyFunc := func(*jwt.Token) (any, error) { return tc.key, nil }
			if _, err := jwt.ParseWithClaims(raw, &tokenClaims{}, keyFunc, parserOptions()...); err == nil {
				t.Fatalf("parser accepted a %s token", tc.name)
			}
		})
	}
	// Control: the same HS256 token parses without the options, so the case above
	// fails because of the algorithm list and nothing else.
	raw, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("shared"))
	if _, err := jwt.ParseWithClaims(raw, &tokenClaims{}, func(*jwt.Token) (any, error) { return []byte("shared"), nil }, jwt.WithoutClaimsValidation()); err != nil {
		t.Fatalf("control parse failed: %v", err)
	}
}

// Rule 1 end to end still holds with the real Verify path.
func TestRejectReasonsAreTheClosedCodes(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	s := newSigner(t, "k1")
	v := startVerifier(t, ti, clk, baseConfig(ti, clk), s)
	now := clk.Now()

	cases := []struct {
		name string
		raw  func() string
		want Reason
	}{
		{"bad signature", func() string {
			other := newSigner(t, "k1")
			return other.sign(t, validClaims(ti.issuer, now))
		}, ReasonBadSignature},
		{"expired", func() string {
			c := validClaims(ti.issuer, now)
			c["iat"], c["exp"] = now.Add(-time.Hour).Unix(), now.Add(-30*time.Minute).Unix()
			return s.sign(t, c)
		}, ReasonExpired},
		{"issuer", func() string {
			c := validClaims(ti.issuer, now)
			c["iss"] = "https://evil.example/workload"
			return s.sign(t, c)
		}, ReasonIssuer},
		{"subject", func() string {
			c := validClaims(ti.issuer, now)
			c["sub"] = "rig:other"
			return s.sign(t, c)
		}, ReasonSubjectNotAllowed},
		{"org", func() string {
			c := validClaims(ti.issuer, now)
			c["org"] = "someone-else"
			return s.sign(t, c)
		}, ReasonOrg},
		{"malformed", func() string { return "a.b.c" }, ReasonMalformed},
		{"oversized", func() string { return strings.Repeat("a", maxTokenBytes+1) }, ReasonTokenSize},
		{"algorithm", func() string {
			raw, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims(ti.issuer, now)).SignedString([]byte("x"))
			return raw
		}, ReasonAlgorithm},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := mustErr(t, v, tc.raw())
			if got := ReasonOf(err); got != tc.want {
				t.Fatalf("ReasonOf = %q, want %q (err %v)", got, tc.want, err)
			}
		})
	}
	if ReasonOf(ErrUnavailable) != "" {
		t.Fatal("an outage carries no rejection reason")
	}
}

// The JWKS size cap. The body is valid JWKS followed by whitespace, so the reader's
// truncation keeps it parseable. Only the size check refuses it, and only one byte over.
func TestJWKSSizeCapIsExactlyTheLimit(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		ok   bool
	}{
		{"at the cap", maxDocBytes, true},
		{"one byte over", maxDocBytes + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ti := newTestIssuer(t)
			clk := newClock()
			s := newSigner(t, "k1")
			ti.publish(s)
			ti.mu.Lock()
			doc, err := json.Marshal(map[string]any{"keys": ti.keys})
			ti.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			body := append(doc, []byte(strings.Repeat(" ", tc.size-len(doc)))...)
			if len(body) != tc.size {
				t.Fatalf("body is %d bytes, want %d", len(body), tc.size)
			}
			ti.mu.Lock()
			ti.jwksBody = body
			ti.mu.Unlock()

			v, err := NewVerifier(t.Context(), baseConfig(ti, clk))
			if err != nil {
				t.Fatalf("NewVerifier: %v", err)
			}
			err = v.Ready(t.Context())
			if tc.ok && err != nil {
				t.Fatalf("Ready refused a JWKS at the cap: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("Ready accepted a JWKS one byte over the cap")
			}
		})
	}
}
