package ratelimit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
)

// WHO ARE WE ACTUALLY METERING?
//
// Every rate-limit key that is not a user id is an IP, so resolving the wrong
// hop does not degrade limiting — it inverts it. Callers who share a proxy
// share a bucket, and one of them can exhaust it for all the others.
//
// This was live in prod. On 2026-08-30, an hour after app-layer limiting was
// first enabled, every identifier in api_usage_monthly was a CLOUDFLARE address
// (104.22.127.86, 172.69.60.206, 162.158.39.167, 108.162.249.77 ...) rather
// than a caller. It had not yet 429'd anyone only because almost all browser
// traffic carries the first-party marker and lands in a 3000/min class; the
// anonymous tier, at 30/min shared across an entire Cloudflare colo, was a
// mass-rejection waiting for anonymous traffic to grow.

// The topology these tests encode:
//
//	client -> Cloudflare -> Google front end -> Cloud Run
//
// Cloudflare REPLACES XFF's leftmost entry with the true client and sets
// CF-Connecting-IP; Google then APPENDS the address it saw, which is
// Cloudflare's. So the rightmost hop is what tells us whether we are behind our
// own edge, and only then are the client-supplied-looking headers trustworthy —
// because a client cannot forge them THROUGH Cloudflare.
func TestTheRealClientIsMeteredWhenWeAreBehindOurOwnEdge(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	// Leftmost = the real client (written by Cloudflare).
	// Rightmost = Cloudflare, appended by Google's front end.
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 172.69.60.206")
	r.Header.Set("CF-Connecting-IP", "203.0.113.9")

	if got := ClientIP(r); got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q, want the caller — metering the edge pools every visitor behind one colo", got)
	}
}

// The observed production values, verbatim. If the range table ever drifts,
// these are the addresses that were really pooling traffic.
func TestTheAddressesThatWerePoolingProductionTrafficAreRecognised(t *testing.T) {
	for _, edge := range []string{
		"104.22.127.86", "172.69.60.206", "162.158.39.167",
		"108.162.249.77", "172.68.210.183", "104.22.127.59",
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Header.Set("X-Forwarded-For", "198.51.100.4, "+edge)
		r.Header.Set("CF-Connecting-IP", "198.51.100.4")

		if got := ClientIP(r); got != "198.51.100.4" {
			t.Errorf("with edge hop %s: ClientIP = %q, want the caller", edge, got)
		}
	}
}

// THE RULE THAT MUST SURVIVE.
//
// Off the Cloudflare path the rightmost entry is the only hop a client could
// not have written itself. Taking the leftmost there would let any caller pick
// their own bucket by prepending a header, which is not a limiter at all — so
// the fix must not become a general "trust the leftmost" rule.
func TestAForgedForwardedHeaderStillCannotPickItsOwnBucket(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "192.0.2.50:9999"
	// A caller hitting the origin directly, inventing hops. Note it even claims
	// a Cloudflare address — but as a LEFT entry, where it proves nothing.
	r.Header.Set("X-Forwarded-For", "1.1.1.1, 172.69.60.206, 198.51.100.77")
	r.Header.Set("CF-Connecting-IP", "1.1.1.1")

	if got := ClientIP(r); got != "198.51.100.77" {
		t.Fatalf("ClientIP = %q — a caller chose its own rate-limit bucket", got)
	}
}

// Cloud Run is publicly reachable (allUsers invoker, no ingress restriction),
// so someone can bypass Cloudflare entirely and send whatever headers they
// like. CF-Connecting-IP alone must therefore prove nothing.
func TestCFConnectingIPAloneIsNotTrusted(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "192.0.2.50:9999"
	r.Header.Set("CF-Connecting-IP", "1.1.1.1")

	if got := ClientIP(r); got != "192.0.2.50" {
		t.Errorf("ClientIP = %q, want the peer — a forged CF header was believed", got)
	}
}

// Behind the edge but with CF-Connecting-IP missing: fall back to the leftmost
// XFF entry, which Cloudflare also rewrites. Belt and braces, because losing
// the header must not silently re-pool everyone onto the edge address.
func TestBehindTheEdgeWithoutCFConnectingIPTheLeftmostEntryIsUsed(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.42, 162.158.39.167")

	if got := ClientIP(r); got != "203.0.113.42" {
		t.Errorf("ClientIP = %q, want 203.0.113.42", got)
	}
}

// IPv6 Cloudflare egress is the same story and is easy to omit from a range
// table, which would quietly restore the pooling bug for part of the traffic.
func TestIPv6EdgeAddressesAreRecognisedToo(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Forwarded-For", "2001:db8::5, 2a06:98c0::1")
	r.Header.Set("CF-Connecting-IP", "2001:db8::5")

	if got := ClientIP(r); got != "2001:db8::5" {
		t.Errorf("ClientIP = %q, want the caller", got)
	}
}

// Degenerate inputs must still yield a usable key. A limiter that returns ""
// buckets every unparseable request together.
func TestClientIPAlwaysYieldsAKey(t *testing.T) {
	cases := map[string]func(*http.Request){
		"nothing at all":       func(r *http.Request) { r.RemoteAddr = "" },
		"edge hop but no left": func(r *http.Request) { r.Header.Set("X-Forwarded-For", "172.69.60.206") },
		"whitespace and empty": func(r *http.Request) { r.Header.Set("X-Forwarded-For", " , ,172.69.60.206") },
		"garbage":              func(r *http.Request) { r.Header.Set("X-Forwarded-For", "not-an-ip, also-not") },
	}
	for name, prime := range cases {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			prime(r)
			if got := ClientIP(r); got == "" {
				t.Error("empty rate-limit key: every such request shares one bucket")
			}
		})
	}
}

// A single-hop XFF from the edge (no appended hop) still must not be read as
// "the client is Cloudflare".
func TestASingleEdgeHopDoesNotBecomeTheIdentity(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "172.69.60.206")
	r.Header.Set("CF-Connecting-IP", "203.0.113.99")

	if got := ClientIP(r); got != "203.0.113.99" {
		t.Errorf("ClientIP = %q, want the caller Cloudflare named", got)
	}
}

// THE PATH THAT WAS ACTUALLY WRONG IN PRODUCTION.
//
// ClientIP serves plain HTTP (/mcp, /oauth). The Connect interceptor had its
// OWN copy of this rule, and it is the one carrying nearly all the traffic —
// which is how a fix to one could leave the other broken. Both now share
// resolveClientIP; this asserts it end-to-end through the real classification
// entry point rather than through the helper.
func TestConnectTrafficBehindTheEdgeIsKeyedOnTheCaller(t *testing.T) {
	req := connect.NewRequest(&struct{}{})
	req.Header().Set("X-Forwarded-For", "203.0.113.9, 172.69.60.206")
	req.Header().Set("CF-Connecting-IP", "203.0.113.9")

	id, tier, _ := extractIdentifierAndTier(context.Background(), req, DefaultUserClaimsKey)

	if tier != "anonymous" {
		t.Fatalf("tier = %q", tier)
	}
	if id != "ip:203.0.113.9" {
		t.Errorf("identifier = %q, want ip:203.0.113.9 — every caller behind that colo shared one 30/min bucket", id)
	}
}

// Same for the first-party class, whose key is the egress address. Keyed on the
// edge instead, all of our SSR through one colo shares a single bucket rather
// than one per egress IP.
func TestFirstPartyIsKeyedOnTheEgressAddressNotTheEdge(t *testing.T) {
	t.Setenv(envSSRSecret, "s")
	req := connect.NewRequest(&struct{}{})
	req.Header().Set("User-Agent", "node shorted-web-ssr/1.0")
	req.Header().Set(defaultSSRHeader, "s")
	req.Header().Set("X-Forwarded-For", "76.76.21.9, 104.22.127.86")
	req.Header().Set("CF-Connecting-IP", "76.76.21.9")

	id, _, _ := extractIdentifierAndTier(context.Background(), req, DefaultUserClaimsKey)
	if id != "first-party:76.76.21.9" {
		t.Errorf("identifier = %q, want the Vercel egress address", id)
	}
}
