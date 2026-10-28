package workloadauth

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
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
	// for example "https://api.brandbrain.dev/workload". It must be https, with
	// no trailing slash, query, fragment or userinfo. The JWKS is always
	// <Issuer>/jwks.json.
	Issuer string
	// Audience is the exact aud value, for example
	// "https://api.shorted.com.au/housing-ingest". See the package doc for the
	// accepted aud forms.
	Audience string
	// Org is the required org claim value.
	Org string
	// AllowSubjects lists the sub values (for example "rig:<id>") that may
	// authenticate. Entries are trimmed; an empty entry is a config error.
	// Empty denies every token.
	AllowSubjects []string
	// DenyKIDs is an emergency kill list. Entries are trimmed; an empty entry is
	// a config error. A token whose kid is listed is rejected even when its
	// signature is valid.
	DenyKIDs []string
	// Leeway applied to exp, nbf and iat. Zero means 60s.
	Leeway time.Duration
	// MaxLifetime bounds exp - iat. Zero means 900s.
	MaxLifetime time.Duration
	// StaleKeysFor is how long cached keys may be used after the last
	// successful JWKS fetch while the issuer is unreachable. Zero means 24h.
	StaleKeysFor time.Duration
	// HTTPClient is used for discovery and JWKS. The verifier always uses a copy
	// with redirects disabled, so the caller's client is never changed. Nil
	// means a client with a 10s timeout.
	HTTPClient *http.Client
	// Logger receives refresh failures. Nil means slog.Default().
	Logger *slog.Logger
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

// Status reports the key cache for readiness and health. It holds no token
// data: LastError is a fixed reason string.
type Status struct {
	// LastSuccess is the last successful JWKS fetch. Zero if none yet.
	LastSuccess time.Time
	// KeyCount is the number of keys in the cache.
	KeyCount int
	// LastError is the most recent refresh failure, empty after a success.
	LastError string
	// LastErrorAt is when LastError happened.
	LastErrorAt time.Time
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
	pinnedJWKS    string
	group         singleflight.Group

	// discovered is read and written only inside the singleflight fetch.
	discovered bool

	mu          sync.RWMutex
	keys        map[string]*ecdsa.PublicKey
	maxAge      time.Duration
	fetchedAt   time.Time // last successful JWKS fetch
	lastAttempt time.Time // last attempt, successful or not
	down        bool      // the most recent attempt failed
	lastErr     error
	lastErrAt   time.Time
}

// NewVerifier validates cfg and starts the first discovery and JWKS fetch in
// the background. It does not contact the issuer, so startup does not depend on
// it. Until a fetch succeeds, Verify returns ErrUnavailable and Ready reports
// why. Config errors are returned here.
func NewVerifier(ctx context.Context, cfg Config) (*Verifier, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	v := &Verifier{
		cfg:           cfg,
		allowSubjects: make(map[string]struct{}, len(cfg.AllowSubjects)),
		denyKIDs:      make(map[string]struct{}, len(cfg.DenyKIDs)),
		pinnedJWKS:    cfg.Issuer + "/jwks.json",
	}
	for _, s := range cfg.AllowSubjects {
		v.allowSubjects[s] = struct{}{}
	}
	for _, k := range cfg.DenyKIDs {
		v.denyKIDs[k] = struct{}{}
	}
	_ = v.startRefresh(ctx)
	return v, nil
}

// Ready reports whether the verifier has current keys: the last fetch
// succeeded and the cache is usable. If the cache is not fresh it attempts a
// fetch first, subject to the once-a-minute limit, and waits for it, bounded
// by ctx. On failure it returns the most recent refresh error, so
// errors.Is(err, ErrUnavailable) tells an outage from a config problem.
func (v *Verifier) Ready(ctx context.Context) error {
	now := v.cfg.Now()
	if c := v.snapshot(); c.fresh(now) && !c.down {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-v.startRefresh(ctx):
	}
	c := v.snapshot()
	if c.usable(v.cfg.Now()) && !c.down {
		return nil
	}
	v.mu.RLock()
	err := v.lastErr
	v.mu.RUnlock()
	if err == nil {
		err = unavailable("no usable keys loaded")
	}
	return err
}

// Status returns the cache state for readiness and health.
func (v *Verifier) Status() Status {
	v.mu.RLock()
	defer v.mu.RUnlock()
	st := Status{LastSuccess: v.fetchedAt, KeyCount: len(v.keys), LastErrorAt: v.lastErrAt}
	if v.lastErr != nil {
		st.LastError = v.lastErr.Error()
	}
	return st
}

// Verify parses and checks a raw compact JWT and returns the caller identity.
//
// Accepted aud form: see the package doc. Rejections never include the token
// or any part of it in the error. If ctx ends while a key fetch is in progress,
// Verify returns ctx.Err(), which is neither ErrUnauthenticated nor
// ErrUnavailable.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Identity, error) {
	if raw == "" {
		return nil, unauth(ReasonMalformed, "token missing")
	}
	if len(raw) > maxTokenBytes {
		return nil, unauth(ReasonTokenSize, "token oversized")
	}

	var (
		keyErr error
		kid    string
	)
	keyFunc := func(t *jwt.Token) (any, error) {
		key, k, err := v.selectKey(ctx, t)
		if err != nil {
			keyErr = err
			return nil, err
		}
		kid = k
		return key, nil
	}

	claims := &tokenClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, keyFunc, parserOptions()...)
	if keyErr != nil {
		return nil, keyErr
	}
	if err != nil {
		return nil, parseRejection(raw, err)
	}
	return v.checkClaims(claims, kid)
}

// parseRejection classifies a token the parser refused before keyFunc ran. The
// parser's own list refuses a non-ES256 alg with a signature error, so the algorithm
// is read from the header first, and that answer wins.
func parseRejection(raw string, err error) error {
	if tok, _, perr := jwt.NewParser().ParseUnverified(raw, &jwt.RegisteredClaims{}); perr == nil &&
		tok.Method != nil && tok.Method.Alg() != algES256 {
		return unauth(ReasonAlgorithm, "algorithm not allowed")
	}
	if errors.Is(err, jwt.ErrTokenSignatureInvalid) {
		return unauth(ReasonBadSignature, "signature invalid")
	}
	return unauth(ReasonMalformed, "token malformed")
}

// parserOptions are the library options Verify parses with. They are the second
// of two algorithm checks: the library refuses any alg outside the list before
// keyFunc runs, and selectKey refuses it again before any key is chosen. Each
// check is pinned on its own by a test, so removing either one fails a test.
func parserOptions() []jwt.ParserOption {
	return []jwt.ParserOption{
		jwt.WithValidMethods([]string{algES256}),
		jwt.WithoutClaimsValidation(),
	}
}

// selectKey is the key function. It applies rules 1, 2 and 6 and then chooses the
// key for kid (rule 7). It returns the key and the kid it was chosen for.
func (v *Verifier) selectKey(ctx context.Context, t *jwt.Token) (*ecdsa.PublicKey, string, error) {
	// Rule 1: the algorithm is checked before any key material is chosen.
	if t.Method == nil || t.Method.Alg() != algES256 {
		return nil, "", unauth(ReasonAlgorithm, "algorithm not allowed")
	}
	// Rule 2: kid is required.
	k, _ := t.Header["kid"].(string)
	if k == "" {
		return nil, "", unauth(ReasonKIDMissing, "kid missing")
	}
	// Rule 6: the kill list wins over a valid signature.
	if _, denied := v.denyKIDs[k]; denied {
		return nil, "", unauth(ReasonKIDDenied, "kid denied")
	}
	key, err := v.key(ctx, k)
	if err != nil {
		return nil, "", err
	}
	return key, k, nil
}

// checkClaims applies rules 3 to 5 once the signature is known good.
func (v *Verifier) checkClaims(c *tokenClaims, kid string) (*Identity, error) {
	now := v.cfg.Now()
	leeway := v.cfg.Leeway

	// Rule 3: iss and aud are compared exactly, case included.
	if c.Issuer != v.cfg.Issuer {
		return nil, unauth(ReasonIssuer, "issuer mismatch")
	}
	if len(c.Audience) != 1 || c.Audience[0] != v.cfg.Audience {
		return nil, unauth(ReasonAudience, "audience mismatch")
	}

	// Rule 4: time claims.
	if c.ExpiresAt == nil {
		return nil, unauth(ReasonClaimMissing, "exp missing")
	}
	exp := c.ExpiresAt.Time
	if now.After(exp.Add(leeway)) {
		return nil, unauth(ReasonExpired, "token expired")
	}
	if c.NotBefore != nil && c.NotBefore.After(now.Add(leeway)) {
		return nil, unauth(ReasonNotYetValid, "token not yet valid")
	}
	if c.IssuedAt == nil {
		return nil, unauth(ReasonClaimMissing, "iat missing")
	}
	iat := c.IssuedAt.Time
	if iat.After(now.Add(leeway)) {
		return nil, unauth(ReasonIATFuture, "iat in the future")
	}
	if life := exp.Sub(iat); life <= 0 || life > v.cfg.MaxLifetime {
		return nil, unauth(ReasonLifetime, "token lifetime out of range")
	}

	// Rule 5: identity.
	if c.Subject == "" {
		return nil, unauth(ReasonClaimMissing, "sub missing")
	}
	if _, ok := v.allowSubjects[c.Subject]; !ok {
		return nil, unauth(ReasonSubjectNotAllowed, "subject not allowed")
	}
	if c.Org != v.cfg.Org {
		return nil, unauth(ReasonOrg, "org mismatch")
	}
	if c.ID == "" {
		return nil, unauth(ReasonClaimMissing, "jti missing")
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

// cache is a snapshot of the key cache.
//
//   - usable: a successful fetch happened within StaleKeysFor. Past that the
//     keys are never used, whatever max-age says.
//   - fresh: usable and younger than max-age.
type cache struct {
	keys      map[string]*ecdsa.PublicKey
	maxAge    time.Duration
	fetchedAt time.Time
	staleFor  time.Duration
	down      bool
}

func (c cache) usable(now time.Time) bool {
	return !c.fetchedAt.IsZero() && now.Sub(c.fetchedAt) < c.staleFor
}

func (c cache) fresh(now time.Time) bool {
	return c.usable(now) && now.Sub(c.fetchedAt) < c.maxAge
}

func (v *Verifier) snapshot() cache {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return cache{
		keys:      v.keys,
		maxAge:    v.maxAge,
		fetchedAt: v.fetchedAt,
		staleFor:  v.cfg.StaleKeysFor,
		down:      v.down,
	}
}

// startRefresh starts a singleflight fetch and returns its channel. The fetch
// is detached from ctx, so one caller giving up cannot fail the others. The
// channel is buffered, so a caller may drop it.
func (v *Verifier) startRefresh(ctx context.Context) <-chan singleflight.Result {
	detached := context.WithoutCancel(ctx)
	return v.group.DoChan("jwks", func() (any, error) {
		return nil, v.fetchIfDue(detached)
	})
}

// key returns the public key for kid (rule 7).
//
//   - A usable cache that holds kid answers at once. If the cache is past
//     max-age, a background refresh starts, so a valid token is never blocked
//     on the issuer.
//   - Otherwise the caller waits for a refresh (rate-limited, shared,
//     bounded by ctx).
//   - After the wait: a usable cache with kid answers. A usable cache without
//     kid is ErrUnavailable when the last attempt failed, and ErrUnauthenticated
//     when the issuer answered. No usable cache is ErrUnavailable. Never fail
//     open.
func (v *Verifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	now := v.cfg.Now()
	c := v.snapshot()
	if c.usable(now) {
		if k, ok := c.keys[kid]; ok {
			if !c.fresh(now) {
				_ = v.startRefresh(ctx) // serve the cached key; refresh in the background
			}
			return k, nil
		}
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-v.startRefresh(ctx):
	}

	c = v.snapshot()
	now = v.cfg.Now()
	if !c.usable(now) {
		return nil, unavailable("no usable keys")
	}
	if k, ok := c.keys[kid]; ok {
		return k, nil
	}
	if c.down {
		return nil, unavailable("unknown kid while the issuer is unreachable")
	}
	return nil, unauth(ReasonUnknownKID, "unknown kid")
}

func (c Config) withDefaults() (Config, error) {
	if c.Issuer == "" || c.Audience == "" || c.Org == "" {
		return c, errors.New("workloadauth: Issuer, Audience and Org are required")
	}
	iu, err := url.Parse(c.Issuer)
	if err != nil || iu.Scheme != "https" || iu.Host == "" || iu.User != nil ||
		iu.RawQuery != "" || iu.Fragment != "" || strings.HasSuffix(c.Issuer, "/") {
		return c, errors.New("workloadauth: Issuer must be an absolute https URL with no trailing slash, query, fragment or userinfo")
	}
	if c.Leeway < 0 || c.MaxLifetime < 0 || c.StaleKeysFor < 0 {
		return c, errors.New("workloadauth: durations must not be negative")
	}
	allow, err := trimEntries("AllowSubjects", c.AllowSubjects)
	if err != nil {
		return c, err
	}
	deny, err := trimEntries("DenyKIDs", c.DenyKIDs)
	if err != nil {
		return c, err
	}
	c.AllowSubjects, c.DenyKIDs = allow, deny
	if c.Leeway == 0 {
		c.Leeway = defaultLeeway
	}
	if c.MaxLifetime == 0 {
		c.MaxLifetime = defaultMaxLifetime
	}
	if c.StaleKeysFor == 0 {
		c.StaleKeysFor = defaultStaleKeysFor
	}
	c.HTTPClient = fetchClient(c.HTTPClient)
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c, nil
}

// trimEntries returns a trimmed copy of in. An empty entry is an error, so a
// stray comma in a config value cannot silently allow or deny nothing.
func trimEntries(name string, in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, s := range in {
		t := strings.TrimSpace(s)
		if t == "" {
			return nil, fmt.Errorf("workloadauth: %s contains an empty entry", name)
		}
		out = append(out, t)
	}
	return out, nil
}

// Reason is the closed set of codes a rejected token carries. The ingest logs it,
// so it is a fixed vocabulary, never token text. A new rejection gets a new code
// here, not a free-form string.
type Reason string

const (
	ReasonMalformed         Reason = "malformed"
	ReasonBadSignature      Reason = "bad_signature"
	ReasonAlgorithm         Reason = "algorithm"
	ReasonKIDMissing        Reason = "kid_missing"
	ReasonUnknownKID        Reason = "unknown_kid"
	ReasonKIDDenied         Reason = "kid_denied"
	ReasonIssuer            Reason = "issuer"
	ReasonAudience          Reason = "audience"
	ReasonExpired           Reason = "expired"
	ReasonNotYetValid       Reason = "not_yet_valid"
	ReasonIATFuture         Reason = "iat_future"
	ReasonLifetime          Reason = "lifetime"
	ReasonClaimMissing      Reason = "claim_missing"
	ReasonSubjectNotAllowed Reason = "subject_not_allowed"
	ReasonOrg               Reason = "org"
	ReasonTokenSize         Reason = "token_size"
)

// RejectError is a token the verifier refused. It matches ErrUnauthenticated with
// errors.Is. Its Error text is the reason and a fixed detail, never the token.
type RejectError struct {
	Code   Reason
	detail string
}

func (e *RejectError) Error() string {
	return fmt.Sprintf("%v: %s", ErrUnauthenticated, e.detail)
}

// Unwrap makes errors.Is(err, ErrUnauthenticated) hold for every rejection.
func (e *RejectError) Unwrap() error { return ErrUnauthenticated }

// ReasonOf returns the rejection code of err, or "" when err is not a rejection
// (an outage, a cancelled context, or nil).
func ReasonOf(err error) Reason {
	var re *RejectError
	if errors.As(err, &re) {
		return re.Code
	}
	return ""
}

func unauth(code Reason, detail string) error {
	return &RejectError{Code: code, detail: detail}
}

func unavailable(reason string) error {
	return fmt.Errorf("%w: %s", ErrUnavailable, reason)
}
