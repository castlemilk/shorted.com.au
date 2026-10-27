package ingest

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/workloadauth"
)

// Connect error messages. They are fixed strings: a caller learns the category,
// never token data or the verifier's internal reason.
const (
	msgJWKSUnavailable = "jwks_unavailable"
	msgUnauthenticated = "unauthenticated"
	msgRigNotEnabled   = "rig_not_enabled"
	msgRigLookupFailed = "rig_lookup_unavailable"
	// msgMisconfigured is the answer to every call while the service cannot serve.
	// The reason is in the startup log and in Health, not in the response.
	msgMisconfigured = "ingest_unavailable"
	msgDatabaseDown  = "database_unavailable"
)

// identity is the verified rig attached to a request's context by the interceptor.
type identity struct {
	Subject string
	KID     string
}

type identityKey struct{}

// rigFromContext returns the rig the auth interceptor verified. It is empty when
// the request did not pass through the interceptor, which the handler treats as an
// internal error, never as anonymous.
func rigFromContext(ctx context.Context) (identity, bool) {
	id, ok := ctx.Value(identityKey{}).(identity)
	return id, ok && id.Subject != ""
}

// tokenVerifier is the subset of *workloadauth.Verifier the ingest uses. Tests
// inject a verifier built against an httptest issuer through the same method.
type tokenVerifier interface {
	Verify(ctx context.Context, raw string) (*workloadauth.Identity, error)
}

// verifyError maps a workloadauth error onto the Connect code the spec fixes:
// ErrUnavailable is Unavailable with jwks_unavailable, and ErrUnauthenticated is
// Unauthenticated. An unknown error is treated as Unauthenticated, never accepted.
func verifyError(err error) error {
	switch {
	case errors.Is(err, workloadauth.ErrUnavailable):
		return connect.NewError(connect.CodeUnavailable, errors.New(msgJWKSUnavailable))
	default:
		return connect.NewError(connect.CodeUnauthenticated, errors.New(msgUnauthenticated))
	}
}

// bearerToken returns the bearer credential from an Authorization header, or ""
// when it is absent or malformed. The token value is never logged.
func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// rigGate answers whether a verified subject is enabled in housing_ingest_rigs. The
// answer is cached for a minute: an admin's kill switch takes effect within that,
// and the database is not read on every push. A lookup error is never cached.
type rigGate struct {
	pool  *pgxpool.Pool
	ttl   time.Duration
	now   func() time.Time
	mu    sync.Mutex
	cache map[string]gateEntry
}

type gateEntry struct {
	enabled bool
	expires time.Time
}

func newRigGate(pool *pgxpool.Pool, now func() time.Time) *rigGate {
	return &rigGate{pool: pool, ttl: time.Minute, now: now, cache: map[string]gateEntry{}}
}

// enabled reports whether subject has housing_ingest_rigs.enabled = true. A subject
// with no row is not enabled.
func (g *rigGate) enabled(ctx context.Context, subject string) (bool, error) {
	now := g.now()
	g.mu.Lock()
	if e, ok := g.cache[subject]; ok && now.Before(e.expires) {
		g.mu.Unlock()
		return e.enabled, nil
	}
	g.mu.Unlock()

	if g.pool == nil {
		return false, errors.New("no database")
	}
	var enabled bool
	err := g.pool.QueryRow(ctx,
		`SELECT enabled FROM housing_ingest_rigs WHERE subject = $1`, subject).Scan(&enabled)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No row: the subject is not enabled. Absence is never permission.
		enabled = false
	case err != nil:
		return false, err
	}

	g.mu.Lock()
	g.cache[subject] = gateEntry{enabled: enabled, expires: now.Add(g.ttl)}
	// Keep the map bounded by the number of rigs, not requests. Expired entries are
	// dropped whenever the map grows past a small size.
	if len(g.cache) > 256 {
		for k, e := range g.cache {
			if !now.Before(e.expires) {
				delete(g.cache, k)
			}
		}
	}
	g.mu.Unlock()
	return enabled, nil
}

// pushLimiter caps PushSweep calls per rig per window, in process. A call counts
// when it arrives, whether or not it is valid, so a broken rig cannot spin the
// validator either. Idle rigs are pruned, so the map is bounded by the rigs that
// pushed in the last window.
type pushLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu        sync.Mutex
	hits      map[string][]time.Time
	lastPrune time.Time
}

func newPushLimiter(limit int, window time.Duration, now func() time.Time) *pushLimiter {
	return &pushLimiter{limit: limit, window: window, now: now, hits: map[string][]time.Time{}}
}

// allow records one push for subject. When the subject is at its limit it returns
// false and how long until the oldest push in the window expires.
func (l *pushLimiter) allow(subject string) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	if now.Sub(l.lastPrune) >= l.window {
		for k, ts := range l.hits {
			if kept := pruneBefore(ts, now.Add(-l.window)); len(kept) == 0 {
				delete(l.hits, k)
			} else {
				l.hits[k] = kept
			}
		}
		l.lastPrune = now
	}

	ts := pruneBefore(l.hits[subject], now.Add(-l.window))
	if len(ts) >= l.limit {
		l.hits[subject] = ts
		return false, ts[0].Add(l.window).Sub(now)
	}
	l.hits[subject] = append(ts, now)
	return true, 0
}

// pruneBefore drops the leading timestamps at or before cutoff. The slice is in
// arrival order, so the expired ones are a prefix.
func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}

// authInterceptor verifies the bearer token, then checks the rig's enable flag. It
// runs on every method, ProbeAuth included. Only the rate limit is per method.
//
// A service that cannot serve (a bad config, or no verifier) answers Unavailable
// before it reads the credential. That is fail-closed, and it tells the rig to
// retry rather than to re-mint a token that would not help.
func authInterceptor(v tokenVerifier, gate *rigGate, problem string) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if problem != "" || v == nil {
				return nil, connect.NewError(connect.CodeUnavailable, errors.New(msgMisconfigured))
			}
			raw := bearerToken(req.Header().Get("Authorization"))
			if raw == "" {
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New(msgUnauthenticated))
			}
			id, err := v.Verify(ctx, raw)
			if err != nil {
				return nil, verifyError(err)
			}
			on, err := gate.enabled(ctx, id.Subject)
			if err != nil {
				return nil, connect.NewError(connect.CodeUnavailable, errors.New(msgRigLookupFailed))
			}
			if !on {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New(msgRigNotEnabled))
			}
			ctx = context.WithValue(ctx, identityKey{}, identity{Subject: id.Subject, KID: id.KID})
			return next(ctx, req)
		}
	}
}

// rateLimitError is the ResourceExhausted a rig receives over its push limit. The
// retry hint travels in the Retry-After metadata, in whole seconds.
func rateLimitError(retryAfter time.Duration) error {
	secs := int(retryAfter.Round(time.Second).Seconds())
	if secs < 1 {
		secs = 1
	}
	err := connect.NewError(connect.CodeResourceExhausted, errors.New("rate_limited"))
	err.Meta().Set("Retry-After", strconv.Itoa(secs))
	return err
}
