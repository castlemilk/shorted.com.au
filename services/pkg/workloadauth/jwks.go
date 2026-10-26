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
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxDocBytes   = 1 << 20 // discovery and JWKS responses
	fetchTimeout  = 10 * time.Second
	minRefetch    = time.Minute // at most one JWKS fetch attempt per minute
	defaultMaxAge = time.Hour
	coordBytes    = 32 // P-256
)

// errRateLimited is internal: a refetch was skipped because one ran within
// the last minute. The caller falls back to the cache.
var errRateLimited = errors.New("workloadauth: jwks refetch rate limited")

func defaultHTTPClient() *http.Client {
	return &http.Client{
		Timeout: fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return errors.New("workloadauth: redirect to non-https URL refused")
			}
			if len(via) >= 3 {
				return errors.New("workloadauth: too many redirects")
			}
			return nil
		},
	}
}

// discover fetches <issuer>/.well-known/openid-configuration and returns the
// jwks_uri. Transport failures are ErrUnavailable; a document that disagrees
// with the config is a plain error, because it is a configuration problem and
// not an outage.
func (v *Verifier) discover(ctx context.Context) (string, error) {
	body, _, err := v.get(ctx, strings.TrimSuffix(v.cfg.Issuer, "/")+"/.well-known/openid-configuration")
	if err != nil {
		return "", err
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", errors.New("workloadauth: discovery document is not valid JSON")
	}
	if doc.Issuer != v.cfg.Issuer {
		return "", errors.New("workloadauth: discovery issuer does not match Config.Issuer")
	}
	iu, err := url.Parse(v.cfg.Issuer)
	if err != nil {
		return "", errors.New("workloadauth: Config.Issuer is not a URL")
	}
	extra := make(map[string]bool, len(v.cfg.JWKSHosts))
	for _, h := range v.cfg.JWKSHosts {
		extra[strings.ToLower(h)] = true
	}
	return validateJWKSURI(iu, doc.JWKSURI, extra)
}

// validateJWKSURI requires an https jwks_uri with no userinfo, on the issuer's
// host unless the host is explicitly listed.
func validateJWKSURI(issuer *url.URL, raw string, extraHosts map[string]bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", errors.New("workloadauth: jwks_uri must be an absolute https URL")
	}
	host := strings.ToLower(u.Host)
	if host != strings.ToLower(issuer.Host) && !extraHosts[host] {
		return "", errors.New("workloadauth: jwks_uri is on a host other than the issuer's")
	}
	return raw, nil
}

// get performs a GET with a deadline and a response size cap. The returned
// error never contains response bodies.
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

// fetchJWKS fetches and parses the key set and reads max-age from Cache-Control.
func (v *Verifier) fetchJWKS(ctx context.Context) (map[string]*ecdsa.PublicKey, time.Duration, error) {
	body, hdr, err := v.get(ctx, v.jwksURL)
	if err != nil {
		return nil, 0, err
	}
	keys, err := parseJWKS(body)
	if err != nil {
		return nil, 0, unavailable(err.Error())
	}
	return keys, maxAgeFrom(hdr.Get("Cache-Control")), nil
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
// is given. One bad key rejects the whole set, so the cache is never partly
// trusted from a document the issuer got wrong.
func parseJWKS(body []byte) (map[string]*ecdsa.PublicKey, error) {
	var set jwkSet
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, errors.New("jwks is not valid JSON")
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

// maxAgeFrom reads max-age from a Cache-Control header, defaulting to 1h when
// absent or malformed.
func maxAgeFrom(cc string) time.Duration {
	for _, d := range strings.Split(cc, ",") {
		d = strings.ToLower(strings.TrimSpace(d))
		if rest, ok := strings.CutPrefix(d, "max-age="); ok {
			if secs, err := strconv.Atoi(rest); err == nil && secs >= 0 {
				return time.Duration(secs) * time.Second
			}
		}
	}
	return defaultMaxAge
}

// refresh runs one JWKS fetch at a time. Callers that arrive while a fetch is
// in flight share its outcome (singleflight). The fetch itself is detached from
// the first caller's context, so one caller giving up cannot fail the others.
func (v *Verifier) refresh(ctx context.Context) error {
	_, err, _ := v.group.Do("jwks", func() (any, error) {
		return nil, v.fetchIfDue(context.WithoutCancel(ctx))
	})
	return err
}

func (v *Verifier) fetchIfDue(ctx context.Context) error {
	v.mu.Lock()
	now := v.cfg.Now()
	if !v.lastAttempt.IsZero() && now.Sub(v.lastAttempt) < minRefetch {
		v.mu.Unlock()
		return errRateLimited
	}
	v.lastAttempt = now
	v.mu.Unlock()

	keys, maxAge, err := v.fetchJWKS(ctx)

	v.mu.Lock()
	defer v.mu.Unlock()
	if err != nil {
		v.issuerDown = true
		return err
	}
	v.keys = keys
	v.maxAge = maxAge
	v.fetchedAt = v.cfg.Now()
	v.issuerDown = false
	return nil
}

type cacheSnapshot struct {
	keys      map[string]*ecdsa.PublicKey
	maxAge    time.Duration
	fetchedAt time.Time
	down      bool
}

func (v *Verifier) snapshot() cacheSnapshot {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return cacheSnapshot{keys: v.keys, maxAge: v.maxAge, fetchedAt: v.fetchedAt, down: v.issuerDown}
}

// key returns the public key for kid (rule 7).
//
//   - Fresh cache (age < max-age): answer from it.
//   - Otherwise try a refetch, which is rate-limited to once a minute.
//   - If the cache is older than StaleKeysFor, fail with ErrUnavailable: never
//     fail open.
//   - An unknown kid is ErrUnavailable while the issuer is down, and
//     ErrUnauthenticated otherwise.
func (v *Verifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	s := v.snapshot()
	if k, ok := s.keys[kid]; ok && v.cfg.Now().Sub(s.fetchedAt) < s.maxAge {
		return k, nil
	}

	// Errors here are either errRateLimited (no fetch) or a failed fetch,
	// which is already recorded in issuerDown. Both fall through to the cache.
	_ = v.refresh(ctx)

	s = v.snapshot()
	if v.cfg.Now().Sub(s.fetchedAt) >= v.cfg.StaleKeysFor {
		return nil, unavailable("cached keys are older than StaleKeysFor")
	}
	if k, ok := s.keys[kid]; ok {
		return k, nil
	}
	if s.down {
		return nil, unavailable("unknown kid while the issuer is unreachable")
	}
	return nil, unauth("unknown kid")
}
