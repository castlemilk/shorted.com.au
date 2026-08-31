package ratelimit

import (
	"context"
	"testing"

	"connectrpc.com/connect"
)

// OUR OWN SERVER-SIDE RENDERING, at the app layer.
//
// This is the class that has to exist before RATE_LIMIT_ENABLED can be turned
// on at all. Vercel SSR reaches this API from a handful of shared egress IPs
// carrying no user token, so without it every render the fleet performs shares
// one anonymous 30-requests-a-minute bucket and the site stops rendering.
//
// The edge worker already learned this the expensive way: between 2026-08-22
// and 08-23 an unprovable first-party marker fell through to the anonymous
// bucket and produced 7,045 zone 429s, all our own CI prerender, with fallback
// data baked into the static output and nothing alerting. These tests exist so
// the app layer cannot repeat it.

// fakeRequest is the smallest thing extractIdentifierAndTier needs: headers and
// a peer. connect.NewRequest gives us both without a server.
func fakeRequest(headers map[string]string, remoteAddr string) connect.AnyRequest {
	req := connect.NewRequest(&struct{}{})
	for k, v := range headers {
		req.Header().Set(k, v)
	}
	if remoteAddr != "" {
		req.Header().Set("X-Forwarded-For", remoteAddr)
	}
	return req
}

func classify(t *testing.T, headers map[string]string) (identifier, tier string) {
	t.Helper()
	id, tr, _ := extractIdentifierAndTier(context.Background(), fakeRequest(headers, "203.0.113.9"), DefaultUserClaimsKey)
	return id, tr
}

// THE PROPERTY. Everything else in this file is a variation on it.
func TestOurOwnSSRIsNeverMeteredAsAnonymous(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")

	cases := map[string]map[string]string{
		"verified": {
			"User-Agent":     "Mozilla/5.0 (compatible) shorted-web-ssr/1.0",
			defaultSSRHeader: "the-shared-secret",
		},
		"marker present, secret wrong": {
			"User-Agent":     "Mozilla/5.0 (compatible) shorted-web-ssr/1.0",
			defaultSSRHeader: "not-the-secret",
		},
		"marker present, secret missing entirely": {
			"User-Agent": "Mozilla/5.0 (compatible) shorted-web-ssr/1.0",
		},
	}

	for name, headers := range cases {
		t.Run(name, func(t *testing.T) {
			id, tier := classify(t, headers)
			if tier == "anonymous" {
				t.Fatalf("our own SSR was metered as anonymous (id=%q) — this is the 7,045-429 bug", id)
			}
			// 0 means unlimited. Anything else is a finite bucket shared by
			// every reader behind one egress address, which is the failure
			// shape this class exists to avoid.
			if got := DefaultConfig().Tiers[tier].RequestsPerMinute; got != 0 {
				t.Errorf("tier %q is capped at %d/min; a rejection here fails every reader behind that address at once", tier, got)
			}
		})
	}
}

// The secret is what separates "us" from "someone who copied our user-agent",
// and the only thing it changes is the MONTHLY ceiling.
func TestTheSecretDecidesTheMonthlyCeilingAndNothingElse(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")

	_, verified := classify(t, map[string]string{
		"User-Agent":     "node shorted-web-ssr/1.0",
		defaultSSRHeader: "the-shared-secret",
	})
	_, unverified := classify(t, map[string]string{
		"User-Agent": "node shorted-web-ssr/1.0",
	})

	if verified != TierFirstParty || unverified != TierFirstPartyUnverified {
		t.Fatalf("verified=%q unverified=%q", verified, unverified)
	}

	tiers := DefaultConfig().Tiers
	// Same headroom per minute: a rotation gap must not throttle rendering.
	if tiers[verified].RequestsPerMinute != tiers[unverified].RequestsPerMinute {
		t.Error("an unverified marker gets less per-minute headroom, so a secret rotation throttles our own site")
	}
	// Different monthly: a spoofable header must not buy unlimited scraping.
	if tiers[verified].RequestsPerMonth != 0 {
		t.Errorf("verified first-party monthly = %d, want unmetered", tiers[verified].RequestsPerMonth)
	}
	if tiers[unverified].RequestsPerMonth == 0 {
		t.Error("an UNVERIFIED first-party claim is monthly-unmetered — one spoofed header is then a free pass to unlimited scraping")
	}
}

// Keyed by egress IP, so one looping instance is contained without taking the
// rest of the fleet down with it.
func TestFirstPartyIsKeyedByEgressIP(t *testing.T) {
	t.Setenv(envSSRSecret, "s")
	headers := map[string]string{"User-Agent": "node shorted-web-ssr/1.0", defaultSSRHeader: "s"}

	a, _, _ := extractIdentifierAndTier(context.Background(), fakeRequest(headers, "203.0.113.1"), DefaultUserClaimsKey)
	b, _, _ := extractIdentifierAndTier(context.Background(), fakeRequest(headers, "203.0.113.2"), DefaultUserClaimsKey)

	if a == b {
		t.Fatalf("both egress IPs share the bucket %q", a)
	}
	for _, id := range []string{a, b} {
		if len(id) < len("first-party:") || id[:len("first-party:")] != "first-party:" {
			t.Errorf("identifier %q is not namespaced, so it can collide with an anonymous IP key", id)
		}
	}
}

// An ordinary caller must be completely unaffected. This is the regression that
// would matter most: a classifier that is too eager hands every anonymous
// scraper a 3000/min ceiling.
func TestOrdinaryCallersAreStillAnonymous(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")

	for name, ua := range map[string]string{
		"a browser":           "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36",
		"curl":                "curl/8.4.0",
		"an empty user agent": "",
		"the marker as words": "definitely not shorted web ssr",
		"a similar product":   "shorted-web-client/1.0",
	} {
		t.Run(name, func(t *testing.T) {
			id, tier := classify(t, map[string]string{"User-Agent": ua})
			if tier != "anonymous" {
				t.Errorf("%q was classified %q (id=%q); it is not us", ua, tier, id)
			}
		})
	}
}

// SUBSTRING matching is deliberate, and mirrors the edge worker's
// `ua.includes(marker)`.
//
// It looks loose — "shorted-web-ssrX" matches — and that costs nothing: anyone
// willing to spoof the marker would simply send it exactly. The marker is an
// identifier, never a credential, which is why the monthly meter rather than
// the string comparison is what bounds a spoofer.
//
// It has to be a substring because `serverFetchWithUserAgent` APPENDS the
// marker to the real client user-agent, so the real UA survives as a prefix and
// crawler identification still works upstream.
func TestTheMarkerIsMatchedAsASubstringLikeTheEdge(t *testing.T) {
	t.Setenv(envSSRSecret, "s")

	for _, ua := range []string{
		"shorted-web-ssr",
		"node shorted-web-ssr/1.0",
		"Mozilla/5.0 (Macintosh) Chrome/140 shorted-web-ssr",
		"Googlebot/2.1 shorted-web-ssr", // a crawler UA our SSR appended to
	} {
		if _, tier := classify(t, map[string]string{"User-Agent": ua}); tier == "anonymous" {
			t.Errorf("%q was not recognised as first-party", ua)
		}
	}
}

// Presenting the SECRET without the marker proves nothing and must not
// classify: the marker is what identifies the traffic, the secret only proves
// it. Otherwise a leaked secret alone becomes the bypass.
func TestTheSecretAloneDoesNotClassify(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")
	_, tier := classify(t, map[string]string{
		"User-Agent":     "curl/8.4.0",
		defaultSSRHeader: "the-shared-secret",
	})
	if tier != "anonymous" {
		t.Errorf("tier = %q for a request with the secret but no marker", tier)
	}
}

// An authenticated caller is classified by their identity, not by a header they
// happen to be sending. Otherwise a signed-in user behind our SSR marker would
// lose their own tier.
func TestARealUserOutranksTheFirstPartyMarker(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")

	ctx := context.WithValue(context.Background(), DefaultUserClaimsKey, testClaims{id: "uid-1", tier: "premium"})
	id, tier, _ := extractIdentifierAndTier(ctx, fakeRequest(map[string]string{
		"User-Agent":     "node shorted-web-ssr/1.0",
		defaultSSRHeader: "the-shared-secret",
	}, "203.0.113.9"), DefaultUserClaimsKey)

	if tier != "premium" || id != "user:uid-1" {
		t.Errorf("id=%q tier=%q, want the user's own identity", id, tier)
	}
}

// The marker name is configurable and must agree with the edge worker's
// binding. A deployment that renamed one and not the other would have the two
// layers disagreeing about what our own traffic looks like.
func TestTheMarkerIsConfigurable(t *testing.T) {
	t.Setenv(envSSRUserAgent, "custom-marker")
	t.Setenv(envSSRHeader, "x-custom-proof")
	t.Setenv(envSSRSecret, "s")

	_, tier := classify(t, map[string]string{
		"User-Agent":     "node custom-marker/1.0",
		"x-custom-proof": "s",
	})
	if tier != TierFirstParty {
		t.Errorf("tier = %q with a custom marker", tier)
	}

	// And the default marker stops working once renamed.
	_, tier = classify(t, map[string]string{"User-Agent": "node shorted-web-ssr/1.0"})
	if tier != "anonymous" {
		t.Errorf("the default marker still classified after being renamed: %q", tier)
	}
}

type testClaims struct {
	id   string
	tier string
}

func (c testClaims) GetUserID() string      { return c.id }
func (c testClaims) GetTier() string        { return c.tier }
func (c testClaims) GetIsBrowserAuth() bool { return false }

// PER-MINUTE MUST BE UNLIMITED FOR BOTH FIRST-PARTY CLASSES.
//
// This class carries our own SSR and EVERY anonymous browser RPC — middleware.ts
// stamps the marker on rewrite-proxied paths, and those requests reach us from
// a handful of shared Vercel egress addresses. So a per-minute rejection here
// is not throttling; it is every reader behind that address failing at the same
// instant.
//
// The unverified class matters just as much: if it were finite, a secret
// rotation gap would move all of our own traffic into a finite bucket and 429
// the site, turning a credential-delivery hiccup into an outage. The rule is
// that the secret costs a meter, never a rejection.
//
// The abuse ceiling is the edge's first-party bucket (600/10s), which sees this
// traffic too, plus the monthly meter on the unverified class.
func TestNeitherFirstPartyClassCanRejectAReader(t *testing.T) {
	tiers := DefaultConfig().Tiers
	for _, tier := range []string{TierFirstParty, TierFirstPartyUnverified} {
		if got := tiers[tier].RequestsPerMinute; got != 0 {
			t.Errorf("%s: RequestsPerMinute = %d, want 0 (unlimited)", tier, got)
		}
		if got := tiers[tier].BrowserRequestsPerMinute; got != 0 {
			t.Errorf("%s: BrowserRequestsPerMinute = %d, want 0 (unlimited)", tier, got)
		}
	}
}

// The monthly meter is what stays, and it is the whole difference between the
// two classes. Removing it from the unverified class would make one spoofable
// header a free pass to unlimited scraping.
func TestTheMonthlyMeterStillSeparatesUsFromASpoofer(t *testing.T) {
	tiers := DefaultConfig().Tiers
	if tiers[TierFirstParty].RequestsPerMonth != 0 {
		t.Error("our own verified traffic is monthly-metered; it will stop rendering mid-month")
	}
	if tiers[TierFirstPartyUnverified].RequestsPerMonth == 0 {
		t.Error("an unverified first-party claim is unmetered, so the marker alone buys unlimited scraping")
	}
}

// A signed-in visitor browsing the site is metered on their OWN tier, even
// though the middleware stamps the first-party marker on their RPC calls too.
// Otherwise every authenticated reader would share one bucket and a paid
// subscriber would get no benefit from paying.
func TestASignedInVisitorKeepsTheirOwnTierBehindTheRewrite(t *testing.T) {
	t.Setenv(envSSRSecret, "the-shared-secret")

	ctx := context.WithValue(context.Background(), DefaultUserClaimsKey,
		testClaims{id: "uid-7", tier: "premium"})
	id, tier, _ := extractIdentifierAndTier(ctx, fakeRequest(map[string]string{
		"User-Agent":     "Mozilla/5.0 (Macintosh) Chrome/140 shorted-web-ssr",
		defaultSSRHeader: "the-shared-secret",
	}, "203.0.113.9"), DefaultUserClaimsKey)

	if tier != "premium" || id != "user:uid-7" {
		t.Errorf("id=%q tier=%q — a paying reader was pooled into the shared bucket", id, tier)
	}
}
