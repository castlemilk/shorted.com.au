package workloadauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	maxDocBytes  = 1 << 20 // discovery and JWKS responses
	fetchTimeout = 10 * time.Second
	minRefetch   = time.Minute // at most one fetch attempt per minute
	coordBytes   = 32          // P-256
	// maxMaxAgeSeconds caps the issuer's max-age. A longer value would let a
	// removed key keep verifying for days, past any revocation.
	maxMaxAgeSeconds = 3600
	defaultMaxAge    = time.Hour
)

// errRateLimited means a fetch was skipped because one ran within the last minute.
var errRateLimited = errors.New("workloadauth: jwks refetch rate limited")

// defaultTransport is the transport of the default fetch client. Nil means
// http.DefaultTransport. Tests swap it so the default client trusts httptest
// certificates; production never sets it.
var defaultTransport http.RoundTripper

// fetchClient returns the client for discovery and JWKS. It is always a copy,
// so the caller's client is never changed, and it never follows a redirect:
// a 3xx response fails the 200 check, so a redirect cannot move key discovery
// to a host the issuer did not name.
func fetchClient(base *http.Client) *http.Client {
	c := &http.Client{Timeout: fetchTimeout, Transport: defaultTransport}
	if base != nil {
		c.Transport = base.Transport
		if c.Transport == nil {
			c.Transport = defaultTransport
		}
		if base.Timeout > 0 {
			c.Timeout = base.Timeout
		}
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return c
}

// discover checks <issuer>/.well-known/openid-configuration. Its issuer must
// equal Config.Issuer exactly and its jwks_uri must be exactly the pinned
// <issuer>/jwks.json. A transport failure is ErrUnavailable; a document that
// disagrees with the config is a plain error, a configuration problem and not
// an outage.
func (v *Verifier) discover(ctx context.Context) error {
	body, _, err := v.get(ctx, v.cfg.Issuer+"/.well-known/openid-configuration")
	if err != nil {
		return err
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return errors.New("workloadauth: discovery document is not valid JSON")
	}
	if doc.Issuer != v.cfg.Issuer {
		return errors.New("workloadauth: discovery issuer does not match Config.Issuer")
	}
	if doc.JWKSURI != v.pinnedJWKS {
		return errors.New("workloadauth: discovery jwks_uri is not <issuer>/jwks.json")
	}
	return nil
}

// get performs a GET with a deadline and a response size cap. Its errors never
// contain response bodies.
func (v *Verifier) get(ctx context.Context, target string) ([]byte, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, errors.New("workloadauth: bad fetch URL")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := v.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, unavailable("fetch failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, unavailable(fmt.Sprintf("fetch returned HTTP %d", resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDocBytes+1))
	if err != nil {
		return nil, nil, unavailable("read failed")
	}
	if len(body) > maxDocBytes {
		return nil, nil, unavailable("response exceeds size cap")
	}
	return body, resp.Header, nil
}

// fetchOnce runs discovery the first time it succeeds, then fetches the JWKS.
// It is called only from the singleflight fetch, so discovered is never raced.
func (v *Verifier) fetchOnce(ctx context.Context) (map[string]*ecdsa.PublicKey, time.Duration, error) {
	if !v.discovered {
		if err := v.discover(ctx); err != nil {
			return nil, 0, err
		}
		v.discovered = true
	}
	body, hdr, err := v.get(ctx, v.pinnedJWKS)
	if err != nil {
		return nil, 0, err
	}
	keys, err := parseJWKS(body)
	if err != nil {
		return nil, 0, unavailable(err.Error())
	}
	return keys, maxAgeFrom(hdr.Get("Cache-Control")), nil
}

// fetchIfDue performs one fetch unless an attempt ran within the last minute.
// Every failure is recorded in the state Status reports, and logged.
func (v *Verifier) fetchIfDue(ctx context.Context) error {
	v.mu.Lock()
	now := v.cfg.Now()
	if !v.lastAttempt.IsZero() && now.Sub(v.lastAttempt) < minRefetch {
		v.mu.Unlock()
		return errRateLimited
	}
	v.lastAttempt = now
	v.mu.Unlock()

	keys, maxAge, err := v.fetchOnce(ctx)

	v.mu.Lock()
	if err != nil {
		v.down = true
		v.lastErr = err
		v.lastErrAt = now
		v.mu.Unlock()
		v.cfg.Logger.Warn("workloadauth: identity key refresh failed", "error", err.Error())
		return err
	}
	v.keys = keys
	v.maxAge = maxAge
	v.fetchedAt = v.cfg.Now()
	v.down = false
	v.lastErr = nil
	v.mu.Unlock()
	return nil
}

type jwkSet struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	KTY string `json:"kty"`
	CRV string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	KID string `json:"kid"`
	ALG string `json:"alg"`
	USE string `json:"use"`
}

// parseJWKS accepts only EC P-256 signing keys with a kid, and ES256 if an alg
// is given. One bad key rejects the whole set. A set with no keys is rejected
// too, so a 200 with an empty or missing keys array cannot wipe a good cache.
func parseJWKS(body []byte) (map[string]*ecdsa.PublicKey, error) {
	var set jwkSet
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, errors.New("jwks is not valid JSON")
	}
	if len(set.Keys) == 0 {
		return nil, errors.New("jwks has no keys")
	}
	keys := make(map[string]*ecdsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		switch {
		case k.KID == "":
			return nil, errors.New("jwks key has no kid")
		case k.KTY != "EC":
			return nil, errors.New("jwks key kty is not EC")
		case k.CRV != "P-256":
			return nil, errors.New("jwks key crv is not P-256")
		case k.ALG != "" && k.ALG != algES256:
			return nil, errors.New("jwks key alg is not ES256")
		case k.USE != "" && k.USE != "sig":
			return nil, errors.New("jwks key use is not sig")
		}
		if _, dup := keys[k.KID]; dup {
			return nil, errors.New("jwks has a duplicate kid")
		}
		pub, err := jwkP256Key(k.X, k.Y)
		if err != nil {
			return nil, err
		}
		keys[k.KID] = pub
	}
	return keys, nil
}

// jwkP256Key builds a P-256 public key from base64url coordinates. The
// uncompressed-point parser checks that the point is on the curve.
func jwkP256Key(xs, ys string) (*ecdsa.PublicKey, error) {
	xb, errX := base64.RawURLEncoding.DecodeString(xs)
	yb, errY := base64.RawURLEncoding.DecodeString(ys)
	if errX != nil || errY != nil || len(xb) != coordBytes || len(yb) != coordBytes {
		return nil, errors.New("jwks key coordinates are malformed")
	}
	point := make([]byte, 0, 1+2*coordBytes)
	point = append(point, 0x04)
	point = append(point, xb...)
	point = append(point, yb...)
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point)
	if err != nil {
		return nil, errors.New("jwks key is not on P-256")
	}
	return pub, nil
}

// maxAgeFrom reads max-age from Cache-Control. A missing or malformed value
// means 1h. The value is clamped to 3600s before any multiplication, and a
// value too large to parse is clamped too.
func maxAgeFrom(cc string) time.Duration {
	for _, d := range strings.Split(cc, ",") {
		rest, ok := strings.CutPrefix(strings.ToLower(strings.TrimSpace(d)), "max-age=")
		if !ok {
			continue
		}
		if rest == "" || !allDigits(rest) {
			return defaultMaxAge
		}
		n, err := strconv.ParseUint(rest, 10, 64)
		if err != nil || n > maxMaxAgeSeconds {
			n = maxMaxAgeSeconds // overflow or too large: clamp
		}
		return time.Duration(n) * time.Second
	}
	return defaultMaxAge
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
