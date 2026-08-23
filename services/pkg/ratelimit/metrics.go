package ratelimit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// Instrumentation for the app-layer limiter.
//
// # THE TWO RULES THIS FILE EXISTS TO ENFORCE
//
//  1. METRIC ATTRIBUTES ARE BOUNDED, ALWAYS. Every attribute emitted from this
//     package comes from a closed set defined below (tier, access, decision,
//     kind, operation, state, reason, result, error class). The limiter's
//     natural key — the identifier — is an IP or a user id, i.e. unbounded, and
//     using it would create one time series per client. Per-caller detail is a
//     LOG concern, never a metric attribute.
//
//  2. LOGS DO NOT CARRY RAW IDENTIFIERS ABOVE DEBUG. An identifier is either an
//     end-user IP ("ip:1.2.3.4") or a user id ("user:abc123"); both are personal
//     data and both end up in a log sink with a different retention policy than
//     the database they came from. Anything logged at info/warn/error passes
//     through redactIdentifier, which keeps the PREFIX (so an operator can still
//     tell an anonymous IP caller from a signed-in one) and replaces the value
//     with a stable short hash (so the same caller correlates across log lines
//     and across instances) without being reversible from the log alone.
//     log.Debugf may still carry the raw value — debug is opt-in and not shipped.
//
// # AND THE RULE THAT KEEPS IT HONEST
//
// NOTHING HERE PERFORMS I/O. The whole point of the design is that Check
// touches memory only; instrumentation must not smuggle a network call, a
// syscall or a lock onto the request path. Request-path instrumentation is
// limited to two in-memory OTel record calls (a counter Add and a histogram
// Record) in the interceptor. Everything else — gauges, flush metrics, store
// timings, breaker transitions — is emitted from background goroutines
// (flusher, refresher, sweeper) or from the store, all of which are already off
// the request path.

// Attribute keys. Kept as constants so a typo cannot silently fork a series.
const (
	attrTier      = "tier"
	attrAccess    = "access"
	attrDecision  = "decision"
	attrKind      = "kind"
	attrOperation = "operation"
	attrState     = "state"
	attrReason    = "reason"
	attrResult    = "result"
	attrBuffer    = "buffer"
	attrClass     = "class"
)

// Closed attribute value sets.
const (
	accessAPI     = "api"
	accessBrowser = "browser"

	decisionAllowed = "allowed"
	decisionBlocked = "blocked"

	kindNone = "none" // allowed: no limit fired

	opApplyDeltas = "apply_deltas"
	opTotals      = "totals"

	statusOK    = "ok"
	statusError = "error"

	breakerOpen     = "open"
	breakerHalfOpen = "half_open"
	breakerClosed   = "closed"

	flushSuccess           = "success"
	flushFailure           = "failure"
	flushSkippedBreaker    = "skipped_breaker_open"
	evictReasonExpired     = "expired"
	evictReasonLeastRecent = "least_recently_seen"

	bufferPending = "pending"
	bufferOrphan  = "orphan"

	dropReasonOrphanCap  = "orphan_buffer_full"
	dropReasonMonthlyCap = "monthly_identifier_cap"
)

// knownTiers is the closed set of tier labels allowed onto a metric.
//
// The tier reaches the limiter from a caller's claims, and a claim is not a
// closed set by construction — a malformed token or a future subscription
// product could put an arbitrary string here, which is a cardinality hole
// dressed up as a label. Anything unrecognised becomes "other"; the exact value
// is still available in logs.
var knownTiers = map[string]struct{}{
	"anonymous":  {},
	"free":       {},
	"paid":       {},
	"premium":    {},
	"pro":        {},
	"enterprise": {},
}

const (
	tierUnknown = "unknown"
	tierOther   = "other"
)

func tierLabel(tier string) string {
	if tier == "" {
		return tierUnknown
	}
	if _, ok := knownTiers[tier]; ok {
		return tier
	}
	return tierOther
}

// accessLabel maps the browser flag onto the documented tier-table column.
func accessLabel(isBrowser bool) string {
	if isBrowser {
		return accessBrowser
	}
	return accessAPI
}

// storeErrorClass reduces a driver error to a bounded label. Raw error strings
// carry query text, host names and identifiers, and are unbounded — they are a
// logging concern, not a metric attribute.
func storeErrorClass(err error) string {
	switch {
	case err == nil:
		return statusOK
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline"):
		return "timeout"
	case strings.Contains(msg, "connection"), strings.Contains(msg, "connect"),
		strings.Contains(msg, "broken pipe"), strings.Contains(msg, "eof"):
		return "connection"
	case strings.Contains(msg, "too many clients"), strings.Contains(msg, "pool"):
		return "pool_exhausted"
	case strings.Contains(msg, "scan "), strings.Contains(msg, "iterate "):
		return "decode"
	case strings.Contains(msg, "does not exist"), strings.Contains(msg, "permission denied"):
		return "schema"
	default:
		return "query"
	}
}

// redactIdentifier renders an identifier safe for an info-level log: the scheme
// prefix survives, the value becomes a stable 8-hex-character digest. Stable so
// the same caller correlates across lines and instances; short because this is
// a correlation handle, not a lookup key.
func redactIdentifier(identifier string) string {
	prefix, value, found := strings.Cut(identifier, ":")
	if !found {
		prefix, value = "id", identifier
	}
	if value == "" {
		return prefix + ":unknown"
	}
	sum := sha256.Sum256([]byte(value))
	return prefix + ":" + hex.EncodeToString(sum[:4])
}

// ---------------------------------------------------------------------------
// Nil-safe emit helpers
//
// InitCustomMetrics is called by otel.InitProvider, but the limiter must work
// in unit tests and in binaries that never initialise OTel. Every instrument is
// therefore nil-checked here rather than at ~20 call sites, and no emit path
// can panic.
// ---------------------------------------------------------------------------

func addCount(ctx context.Context, c otelmetric.Int64Counter, n int64, attrs ...attribute.KeyValue) {
	if c == nil {
		return
	}
	c.Add(ctx, n, otelmetric.WithAttributes(attrs...))
}

func recordFloat(ctx context.Context, h otelmetric.Float64Histogram, v float64, attrs ...attribute.KeyValue) {
	if h == nil {
		return
	}
	h.Record(ctx, v, otelmetric.WithAttributes(attrs...))
}

func recordInt(ctx context.Context, h otelmetric.Int64Histogram, v int64, attrs ...attribute.KeyValue) {
	if h == nil {
		return
	}
	h.Record(ctx, v, otelmetric.WithAttributes(attrs...))
}

func setGauge(ctx context.Context, g otelmetric.Int64Gauge, v int64, attrs ...attribute.KeyValue) {
	if g == nil {
		return
	}
	g.Record(ctx, v, otelmetric.WithAttributes(attrs...))
}

// ---------------------------------------------------------------------------
// Emitters, one per instrumented event
// ---------------------------------------------------------------------------

// checkAttrKey is the full label space of a rate limit decision. Because every
// component is drawn from a closed set, the number of distinct keys is a small
// constant (tiers x 2 x 2 x 3) — which is what makes caching safe AND is the
// same property that keeps the time series count bounded.
type checkAttrKey struct {
	tier     string
	access   string
	decision string
	kind     string
}

type checkAttrSet struct {
	check otelmetric.MeasurementOption
	quota otelmetric.MeasurementOption
}

// checkAttrCache memoises the attribute sets used on the REQUEST PATH.
//
// Building a MeasurementOption allocates and sorts an attribute.Set on every
// call; measured at ~5us per Check for the two records below, against a ~2.5us
// Check. Precomputing them cuts that to a map lookup, so instrumentation stays
// in the noise of a Connect handler rather than being a visible tax on every
// request. sync.Map is right here: writes stop after the first request per
// label combination, and the read path is then lock-free.
var checkAttrCache sync.Map // checkAttrKey -> checkAttrSet

func checkAttrsFor(k checkAttrKey) checkAttrSet {
	if v, ok := checkAttrCache.Load(k); ok {
		return v.(checkAttrSet)
	}
	set := checkAttrSet{
		check: otelmetric.WithAttributes(
			attribute.String(attrTier, k.tier),
			attribute.String(attrAccess, k.access),
			attribute.String(attrDecision, k.decision),
			attribute.String(attrKind, k.kind),
		),
		quota: otelmetric.WithAttributes(
			attribute.String(attrTier, k.tier),
			attribute.String(attrAccess, k.access),
		),
	}
	checkAttrCache.Store(k, set)
	return set
}

// recordCheck records one rate limit decision. Called from the interceptor,
// i.e. ON THE REQUEST PATH: exactly two in-memory OTel records against cached
// attribute sets, no I/O, no lock the limiter does not already hold.
func recordCheck(ctx context.Context, result *Result) {
	if result == nil {
		return
	}

	key := checkAttrKey{
		tier:     tierLabel(result.Tier),
		access:   accessLabel(result.IsBrowser),
		decision: decisionAllowed,
		kind:     kindNone,
	}
	if !result.Allowed {
		key.decision = decisionBlocked
		if result.ExceededKind != LimitKindNone {
			key.kind = string(result.ExceededKind)
		}
	}
	attrs := checkAttrsFor(key)

	if c := shortedotel.RateLimitChecks; c != nil {
		c.Add(ctx, 1, attrs.check)
	}

	// Leading indicator: where callers sit against their monthly quota, as a
	// bucketed distribution. A limit of 0 means unlimited for this tier, and a
	// ratio against zero is meaningless, so it is not recorded.
	if result.MonthlyLimit > 0 {
		if h := shortedotel.RateLimitQuotaConsumed; h != nil {
			pct := float64(result.MonthlyUsed) / float64(result.MonthlyLimit) * 100
			if pct < 0 {
				pct = 0
			}
			h.Record(ctx, pct, attrs.quota)
		}
	}
}

// recordBreakerTransition counts a circuit breaker state change.
func recordBreakerTransition(state string) {
	addCount(context.Background(), shortedotel.RateLimitBreakerTransitions, 1,
		attribute.String(attrState, state),
	)
}

// recordFlush records the outcome and width of one flush attempt.
func recordFlush(ctx context.Context, result string, rows int) {
	addCount(ctx, shortedotel.RateLimitFlushTotal, 1, attribute.String(attrResult, result))
	if result == flushSuccess {
		recordInt(ctx, shortedotel.RateLimitFlushRows, int64(rows))
	}
}

// recordStoreCall records one api_usage_monthly statement's latency and, on
// failure, its error class. Called from the store, which is only ever invoked
// by background goroutines.
func recordStoreCall(ctx context.Context, operation string, started time.Time, err error) {
	status := statusOK
	if err != nil {
		status = statusError
	}
	recordFloat(ctx, shortedotel.RateLimitStoreDuration, time.Since(started).Seconds(),
		attribute.String(attrOperation, operation),
		attribute.String(attrResult, status),
	)
	if err != nil {
		addCount(ctx, shortedotel.RateLimitStoreErrors, 1,
			attribute.String(attrOperation, operation),
			attribute.String(attrClass, storeErrorClass(err)),
		)
	}
}
