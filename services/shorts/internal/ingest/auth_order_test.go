package ingest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
)

// TestAuth_ForgedTokenForDisabledRigIsUnauthenticated: authentication runs before the
// enable check, so a forged credential for a rig that is disabled gets Unauthenticated,
// not PermissionDenied. PermissionDenied would confirm to a forger that the subject
// exists and is merely switched off.
func TestAuth_ForgedTokenForDisabledRigIsUnauthenticated(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, false)

	forged := signedWithOtherKey(t, issuer, testRig, clock.Now())
	_, err := rig.probe(context.Background(), forged)
	wantCode(t, err, connect.CodeUnauthenticated)
}

// TestHealth_ReportsOnlyAGenericStatus: the health endpoint is public. Its body names a
// status word and nothing else, so a configuration problem never reaches it.
func TestHealth_ReportsOnlyAGenericStatus(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	if rig.svc.HealthStatus() != "ready" {
		t.Fatalf("a loaded service is ready, got %q", rig.svc.HealthStatus())
	}

	broken := New(context.Background(), Options{
		Config:        Config{Enabled: true, Issuer: issuer.issuer, Audience: testAudience},
		ConfigProblem: "HOUSING_INGEST_ORG is required (secret-looking detail)",
		Pool:          pool,
		Now:           clock.Now,
	})
	srv := httptest.NewServer(HealthHandler(broken))
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "unavailable" || len(body) != 1 {
		t.Errorf("the health body must be the status word only, got %v", body)
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "HOUSING_INGEST") || strings.Contains(string(raw), "secret") {
		t.Errorf("the health body leaks the config problem: %s", raw)
	}
}

// TestProbeAuth_ShapeAndAuthRequired is the control for the probe: it reports the
// subject and the floor, and an unauthenticated call is refused.
func TestProbeAuth_RequiresAuth(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	client := housingingestv1connect.NewCrawlIngestServiceClient(http.DefaultClient, rig.srv.URL)
	_, err := client.ProbeAuth(context.Background(), connect.NewRequest(&pb.ProbeAuthRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)
}
