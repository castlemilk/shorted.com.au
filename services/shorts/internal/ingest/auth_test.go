package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
)

// client returns a Connect client for rig, with the bearer header set on every call
// the caller makes through the returned helper.
func (r *ingestRig) client() housingingestv1connect.CrawlIngestServiceClient {
	return housingingestv1connect.NewCrawlIngestServiceClient(http.DefaultClient, r.srv.URL)
}

// withToken adds an Authorization header to a request. An empty token adds none.
func withToken[T any](req *connect.Request[T], token string) *connect.Request[T] {
	if token != "" {
		req.Header().Set("Authorization", "Bearer "+token)
	}
	return req
}

// probe calls ProbeAuth with the given token, which is the cheapest authenticated call.
func (r *ingestRig) probe(ctx context.Context, token string) (*connect.Response[pb.ProbeAuthResponse], error) {
	return r.client().ProbeAuth(ctx, withToken(connect.NewRequest(&pb.ProbeAuthRequest{}), token))
}

func wantCode(t *testing.T, err error, want connect.Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("want %v, got success", want)
	}
	if got := connect.CodeOf(err); got != want {
		t.Fatalf("want %v, got %v (%v)", want, got, err)
	}
}

// TestAuth_NoTokenIsUnauthenticated is the 401 for a call with no credential.
func TestAuth_NoTokenIsUnauthenticated(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	rig := startIngest(t, pool, issuer, newTestClock(), nil)

	_, err := rig.probe(context.Background(), "")
	wantCode(t, err, connect.CodeUnauthenticated)
}

// TestAuth_BadSignatureIsUnauthenticated is the 401 for a token signed by a key
// the issuer does not publish, even though its kid names the published key.
func TestAuth_BadSignatureIsUnauthenticated(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	forged := signedWithOtherKey(t, issuer, testRig, clock.Now())
	_, err := rig.probe(context.Background(), forged)
	wantCode(t, err, connect.CodeUnauthenticated)
}

// TestAuth_IssuerDownWithNoCacheIsUnavailable is the verifier's outage: the issuer
// is down and no keys were ever fetched, so the ingest cannot verify and says so
// with the category the rig retries on, never accepting the token.
func TestAuth_IssuerDownWithNoCacheIsUnavailable(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	issuer.setDown(true)

	// startIngest waits for keys; with the issuer down it must not, so build directly.
	svc := New(context.Background(), Options{
		Config: Config{
			Enabled: true, Issuer: issuer.issuer, Audience: testAudience, Org: testIssuerOrg,
			AllowSubjects: []string{testRig}, MinContractVersion: DefaultMinContractVersion,
			PriceFraction: DefaultPriceFraction, DelistFraction: DefaultDelistFraction, DelistFloor: DefaultDelistFloor,
		},
		Pool: pool, Now: clock.Now, HTTPClient: issuer.client,
	})
	path, h := svc.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	client := housingingestv1connect.NewCrawlIngestServiceClient(http.DefaultClient, srv.URL)
	_, err := client.ProbeAuth(context.Background(), withToken(connect.NewRequest(&pb.ProbeAuthRequest{}), token))
	wantCode(t, err, connect.CodeUnavailable)
	if err == nil || !strings.Contains(err.Error(), "jwks_unavailable") {
		t.Errorf("the message must name jwks_unavailable, got %v", err)
	}
}

// TestAuth_SubjectNotAllowlistedIsUnauthenticated: a validly signed token for a
// subject outside AllowSubjects is refused as an unauthenticated caller.
func TestAuth_SubjectNotAllowlistedIsUnauthenticated(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, "rig:stranger", true)

	token := issuer.mint(t, "rig:stranger", clock.Now(), nil)
	_, err := rig.probe(context.Background(), token)
	wantCode(t, err, connect.CodeUnauthenticated)
}

// TestAuth_AllowlistedButDisabledIsPermissionDenied: the subject verifies, but its
// housing_ingest_rigs row is disabled, so it is authenticated and not permitted.
func TestAuth_AllowlistedButDisabledIsPermissionDenied(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, false)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	_, err := rig.probe(context.Background(), token)
	wantCode(t, err, connect.CodePermissionDenied)
}

// TestAuth_AbsentRigRowIsPermissionDenied: an allowlisted subject with no
// housing_ingest_rigs row is not enabled. Absence is never permission.
func TestAuth_AbsentRigRowIsPermissionDenied(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	_, err := rig.probe(context.Background(), token)
	wantCode(t, err, connect.CodePermissionDenied)
}

// TestAuth_EnabledRigProbes is the control: an enabled, allowlisted rig gets
// through, and ProbeAuth reports its subject and the contract floor.
func TestAuth_EnabledRigProbes(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	resp, err := rig.probe(context.Background(), token)
	if err != nil {
		t.Fatalf("ProbeAuth: %v", err)
	}
	if resp.Msg.Subject != testRig {
		t.Errorf("subject = %q, want %q", resp.Msg.Subject, testRig)
	}
	if resp.Msg.MinContractVersion != DefaultMinContractVersion {
		t.Errorf("min_contract_version = %d, want %d", resp.Msg.MinContractVersion, DefaultMinContractVersion)
	}
	if !resp.Msg.ServerTime.AsTime().Equal(clock.Now()) {
		t.Errorf("server_time = %v, want the server clock %v", resp.Msg.ServerTime.AsTime(), clock.Now())
	}
}

// TestAuth_TokenNeverReachesTheResponse guards against echoing the credential.
func TestAuth_TokenNeverReachesTheResponse(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	resp, err := rig.probe(context.Background(), token)
	if err != nil {
		t.Fatalf("ProbeAuth: %v", err)
	}
	if strings.Contains(resp.Msg.String(), token) {
		t.Fatal("the response carries the bearer token")
	}
}
