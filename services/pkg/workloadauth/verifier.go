package workloadauth

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/sync/singleflight"
)

// ErrUnauthenticated means the token itself is bad. Callers return 401.
var ErrUnauthenticated = errors.New("workloadauth: unauthenticated")

// ErrUnavailable means the issuer could not be reached and the cached keys
// cannot answer for this token. Callers return 503. It never means the token
// was accepted.
var ErrUnavailable = errors.New("workloadauth: identity issuer unavailable")

const (
	algES256            = "ES256"
	defaultLeeway       = 60 * time.Second
	defaultMaxLifetime  = 900 * time.Second
	defaultStaleKeysFor = 24 * time.Hour
	maxTokenBytes       = 8 << 10
)

// Config describes the one issuer, audience and org a Verifier accepts.
type Config struct {
	// Issuer is the exact iss value and the base of the discovery document,
	// for example "https://api.brandbrain.dev/workload". It must be https.
	Issuer string
	// Audience is the exact aud value, for example
	// "https://api.shorted.com.au/housing-ingest". See the package doc for the
	// accepted aud forms.
	Audience string
	// Org is the required org claim value.
	Org string
	// AllowSubjects lists the sub values (for example "rig:<id>") that may
	// authenticate. Empty denies every token.
	AllowSubjects []string
	// DenyKIDs is an emergency kill list. A token whose kid is listed is
	// rejected even when its signature is valid.
	DenyKIDs []string
	// JWKSHosts lists extra host[:port] values the jwks_uri may use. By default
	// the jwks_uri must be on the issuer's host.
	JWKSHosts []string
	// Leeway applied to exp, nbf and iat. Zero means 60s.
	Leeway time.Duration
	// MaxLifetime bounds exp - iat. Zero means 900s.
	MaxLifetime time.Duration
	// StaleKeysFor is how long cached keys may be used after the last
	// successful JWKS fetch while the issuer is unreachable. Zero means 24h.
	StaleKeysFor time.Duration
	// HTTPClient is used for discovery and JWKS. Nil means a client with a
	// 10s timeout that refuses non-https redirects.
	HTTPClient *http.Client
	// Now is the clock. Nil means time.Now.
	Now func() time.Time
}

// Identity is the verified caller of a token.
type Identity struct {
	Subject      string
	Org          string
	RigType      string
	AgentVersion string
	JTI          string
	KID          string
	IssuedAt     time.Time
	ExpiresAt    time.Time
}

// tokenClaims are the claims the verifier reads. Registered claims are
// validated by this package against the injected clock, not by the library.
type tokenClaims struct {
	jwt.RegisteredClaims
	Org          string `json:"org"`
	RigType      string `json:"rig_type"`
	AgentVersion string `json:"agent_version"`
}

// Verifier checks workload tokens against one issuer. It is safe for
// concurrent use.
type Verifier struct {
	cfg           Config
	allowSubjects map[string]struct{}
	denyKIDs      map[string]struct{}
	jwksURL       string
	group         singleflight.Group

	mu          sync.RWMutex
	keys        map[string]*ecdsa.PublicKey
	maxAge      time.Duration
	fetchedAt   time.Time // last successful JWKS fetch
	lastAttempt time.Time // last JWKS fetch attempt, successful or not
	issuerDown  bool      // the most recent attempt failed
}

// NewVerifier validates cfg, fetches the discovery document and the JWKS. It
// fails if the issuer cannot be reached at startup.
func NewVerifier(ctx context.Context, cfg Config) (*Verifier, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	v := &Verifier{
		cfg:           cfg,
		allowSubjects: make(map[string]struct{}, len(cfg.AllowSubjects)),
		denyKIDs:      make(map[string]struct{}, len(cfg.DenyKIDs)),
	}
	for _, s := range cfg.AllowSubjects {
		v.allowSubjects[s] = struct{}{}
	}
	for _, k := range cfg.DenyKIDs {
		v.denyKIDs[k] = struct{}{}
	}
	jwksURL, err := v.discover(ctx)
	if err != nil {
		return nil, err
	}
	v.jwksURL = jwksURL
	if err := v.refresh(ctx); err != nil {
		return nil, fmt.Errorf("workloadauth: initial jwks fetch: %w", err)
	}
	return v, nil
}

// Verify parses and checks a raw compact JWT and returns the caller identity.
//
// Accepted aud form: see the package doc. Rejections never include the token
// or any part of it in the error.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Identity, error) {
	if raw == "" || len(raw) > maxTokenBytes {
		return nil, unauth("token missing or oversized")
	}

	var (
		keyErr error
		kid    string
	)
	keyFunc := func(t *jwt.Token) (any, error) {
		// Rule 1: the algorithm is checked before any key material is chosen.
		if t.Method == nil || t.Method.Alg() != algES256 {
			keyErr = unauth("algorithm not allowed")
			return nil, keyErr
		}
		// Rule 2: kid is required.
		k, _ := t.Header["kid"].(string)
		if k == "" {
			keyErr = unauth("kid missing")
			return nil, keyErr
		}
		// Rule 6: the kill list wins over a valid signature.
		if _, denied := v.denyKIDs[k]; denied {
			keyErr = unauth("kid denied")
			return nil, keyErr
		}
		key, err := v.key(ctx, k)
		if err != nil {
			keyErr = err
			return nil, err
		}
		kid = k
		return key, nil
	}

	claims := &tokenClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, keyFunc,
		jwt.WithValidMethods([]string{algES256}),
		jwt.WithoutClaimsValidation(),
	)
	if keyErr != nil {
		return nil, keyErr
	}
	if err != nil {
		return nil, unauth("token malformed or signature invalid")
	}
	return v.checkClaims(claims, kid)
}

// checkClaims applies rules 3 to 5 once the signature is known good.
func (v *Verifier) checkClaims(c *tokenClaims, kid string) (*Identity, error) {
	now := v.cfg.Now()
	leeway := v.cfg.Leeway

	// Rule 3: iss exact; aud is exactly one audience (string or one-element array).
	if c.Issuer != v.cfg.Issuer {
		return nil, unauth("issuer mismatch")
	}
	if len(c.Audience) != 1 || c.Audience[0] != v.cfg.Audience {
		return nil, unauth("audience mismatch")
	}

	// Rule 4: time claims.
	if c.ExpiresAt == nil {
		return nil, unauth("exp missing")
	}
	exp := c.ExpiresAt.Time
	if now.After(exp.Add(leeway)) {
		return nil, unauth("token expired")
	}
	if c.NotBefore != nil && c.NotBefore.After(now.Add(leeway)) {
		return nil, unauth("token not yet valid")
	}
	if c.IssuedAt == nil {
		return nil, unauth("iat missing")
	}
	iat := c.IssuedAt.Time
	if iat.After(now.Add(leeway)) {
		return nil, unauth("iat in the future")
	}
	if life := exp.Sub(iat); life <= 0 || life > v.cfg.MaxLifetime {
		return nil, unauth("token lifetime out of range")
	}

	// Rule 5: identity.
	if c.Subject == "" {
		return nil, unauth("sub missing")
	}
	if _, ok := v.allowSubjects[c.Subject]; !ok {
		return nil, unauth("subject not allowed")
	}
	if c.Org != v.cfg.Org {
		return nil, unauth("org mismatch")
	}
	if c.ID == "" {
		return nil, unauth("jti missing")
	}

	return &Identity{
		Subject:      c.Subject,
		Org:          c.Org,
		RigType:      c.RigType,
		AgentVersion: c.AgentVersion,
		JTI:          c.ID,
		KID:          kid,
		IssuedAt:     iat,
		ExpiresAt:    exp,
	}, nil
}

func (c Config) withDefaults() (Config, error) {
	if c.Issuer == "" || c.Audience == "" || c.Org == "" {
		return c, errors.New("workloadauth: Issuer, Audience and Org are required")
	}
	iu, err := url.Parse(c.Issuer)
	if err != nil || iu.Scheme != "https" || iu.Host == "" || iu.RawQuery != "" || iu.Fragment != "" {
		return c, errors.New("workloadauth: Issuer must be an absolute https URL with no query or fragment")
	}
	if c.Leeway < 0 || c.MaxLifetime < 0 || c.StaleKeysFor < 0 {
		return c, errors.New("workloadauth: durations must not be negative")
	}
	if c.Leeway == 0 {
		c.Leeway = defaultLeeway
	}
	if c.MaxLifetime == 0 {
		c.MaxLifetime = defaultMaxLifetime
	}
	if c.StaleKeysFor == 0 {
		c.StaleKeysFor = defaultStaleKeysFor
	}
	if c.HTTPClient == nil {
		c.HTTPClient = defaultHTTPClient()
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c, nil
}

func unauth(reason string) error {
	return fmt.Errorf("%w: %s", ErrUnauthenticated, reason)
}

func unavailable(reason string) error {
	return fmt.Errorf("%w: %s", ErrUnavailable, reason)
}
