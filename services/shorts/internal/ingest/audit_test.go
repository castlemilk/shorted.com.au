package ingest

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// auditLog captures the auth decision lines for one test. The lines are read back
// exactly as the service wrote them.
type auditLog struct {
	accepted []string
	rejected []string
}

func captureAudit(t *testing.T) *auditLog {
	t.Helper()
	a := &auditLog{}
	prevA, prevR := logAuthAccepted, logAuthRejected
	logAuthAccepted = func(format string, args ...any) { a.accepted = append(a.accepted, fmt.Sprintf(format, args...)) }
	logAuthRejected = func(format string, args ...any) { a.rejected = append(a.rejected, fmt.Sprintf(format, args...)) }
	t.Cleanup(func() { logAuthAccepted, logAuthRejected = prevA, prevR })
	return a
}

// mintWithKid signs a token whose header names kid, signed by the fixture's key. The
// kid is the only thing the test changes.
func mintWithKid(t *testing.T, f *issuerFixture, kid, sub string, now time.Time, mutate func(jwt.MapClaims)) string {
	t.Helper()
	iat := now.Unix()
	claims := jwt.MapClaims{
		"iss": f.issuer, "sub": sub, "aud": testAudience, "iat": iat, "nbf": iat,
		"exp": iat + 600, "jti": fmt.Sprintf("jti-%d-%s", iat, kid), "org": testIssuerOrg,
	}
	if mutate != nil {
		mutate(claims)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = kid
	raw, err := tok.SignedString(f.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// wantRejected asserts exactly one rejected line, with the reason, and that no token
// text reached any line.
func wantRejected(t *testing.T, a *auditLog, raw, reason string) string {
	t.Helper()
	if len(a.accepted) != 0 {
		t.Fatalf("a refused token logged an accepted line: %v", a.accepted)
	}
	if len(a.rejected) != 1 {
		t.Fatalf("want exactly one rejected line, got %d: %v", len(a.rejected), a.rejected)
	}
	line := a.rejected[0]
	if !strings.HasPrefix(line, "housing ingest auth decision=rejected reason="+reason+" ") {
		t.Fatalf("reason = %q, want %q: %s", line, reason, line)
	}
	assertNoTokenText(t, raw, a)
	return line
}

// assertNoTokenText fails if any part of the raw token's signature, or the whole
// token, appears in a logged line. The header and payload are base64, so the
// signature segment is the one a leak would be checked against.
func assertNoTokenText(t *testing.T, raw string, a *auditLog) {
	t.Helper()
	if raw == "" {
		return
	}
	parts := strings.Split(raw, ".")
	for _, line := range append(append([]string{}, a.accepted...), a.rejected...) {
		if strings.Contains(line, raw) || (len(parts) == 3 && strings.Contains(line, parts[2])) {
			t.Fatalf("a log line carries token text: %s", line)
		}
	}
}

// The accepted line names the verified subject, kid and jti, the validity window and
// the client, and carries no token text.
func TestAudit_AcceptedLineCarriesTheVerifiedIdentity(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	a := captureAudit(t)

	raw := issuer.mint(t, testRig, clock.Now(), nil)
	if _, err := rig.client().ProbeAuth(context.Background(), withToken(connect.NewRequest(&pb.ProbeAuthRequest{}), raw)); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if len(a.accepted) != 1 || len(a.rejected) != 0 {
		t.Fatalf("want one accepted line, got accepted=%v rejected=%v", a.accepted, a.rejected)
	}
	line := a.accepted[0]
	iat := clock.Now().Unix()
	for _, want := range []string{
		"housing ingest auth decision=accepted",
		`subject="rig:gamma-64"`,
		`kid="kid-test-1"`,
		fmt.Sprintf(`jti="jti-%d-rig:gamma-64"`, iat),
		fmt.Sprintf("iat=%d exp=%d", iat, iat+600),
		"client_ip=",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("accepted line lacks %q: %s", want, line)
		}
	}
	assertNoTokenText(t, raw, a)
}

// Each refusal logs its closed reason. A subject or kid from an unverified token is
// shown when it parses, and the token itself is never shown.
func TestAudit_EachRefusalLogsItsClosedReason(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedRig(t, pool, testRig2, false)
	now := clock.Now()

	cases := []struct {
		name   string
		token  func() string
		reason string
	}{
		{"no credential", func() string { return "" }, "missing_token"},
		{"bad signature", func() string { return signedWithOtherKey(t, issuer, testRig, now) }, "bad_signature"},
		{"unknown kid", func() string {
			return mintWithKid(t, issuer, "kid-not-published", testRig, now, nil)
		}, "unknown_kid"},
		{"expired", func() string {
			return issuer.mint(t, testRig, now.Add(-time.Hour), nil)
		}, "expired"},
		{"audience", func() string {
			return issuer.mint(t, testRig, now, func(c jwt.MapClaims) { c["aud"] = "https://api.shorted.com.au/other" })
		}, "audience"},
		{"issuer", func() string {
			return issuer.mint(t, testRig, now, func(c jwt.MapClaims) { c["iss"] = "https://evil.example/workload" })
		}, "issuer"},
		{"subject not allowed", func() string { return issuer.mint(t, "rig:stranger", now, nil) }, "subject_not_allowed"},
		{"org", func() string {
			return issuer.mint(t, testRig, now, func(c jwt.MapClaims) { c["org"] = "someone-else" })
		}, "org"},
		{"rig disabled", func() string { return issuer.mint(t, testRig2, now, nil) }, "rig_disabled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := captureAudit(t)
			raw := tc.token()
			_, err := rig.probe(context.Background(), raw)
			if err == nil {
				t.Fatal("a refused token was accepted")
			}
			line := wantRejected(t, a, raw, tc.reason)
			if raw != "" && !strings.Contains(line, "client_ip=") {
				t.Fatalf("rejected line lacks the client: %s", line)
			}
		})
	}
}

// A subject that is hostile text cannot forge a second line: it is quoted and escaped.
func TestAudit_HostileSubjectCannotForgeALine(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	a := captureAudit(t)

	hostile := "rig:x\nhousing ingest auth decision=accepted subject=\"rig:gamma-64\""
	raw := issuer.mint(t, hostile, clock.Now(), nil)
	if _, err := rig.probe(context.Background(), raw); err == nil {
		t.Fatal("an unallowlisted subject was accepted")
	}
	line := wantRejected(t, a, raw, "subject_not_allowed")
	if strings.Contains(line, "\n") {
		t.Fatalf("a newline reached the log: %q", line)
	}
	if !strings.Contains(line, `subject="rig:x\nhousing`) {
		t.Fatalf("the subject is not escaped: %s", line)
	}
}

// A replayed token is accepted again, and both accepted lines carry the same jti. That
// is the detection the log gives: a replay is the same jti seen twice.
func TestAudit_ReplayShowsAsTheSameJTI(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	a := captureAudit(t)

	raw := issuer.mint(t, testRig, clock.Now(), nil)
	for i := 0; i < 2; i++ {
		if _, err := rig.probe(context.Background(), raw); err != nil {
			t.Fatalf("replay %d refused: %v", i, err)
		}
	}
	if len(a.accepted) != 2 {
		t.Fatalf("want two accepted lines, got %d", len(a.accepted))
	}
	jti := func(s string) string {
		i := strings.Index(s, `jti="`)
		return s[i : i+strings.Index(s[i+5:], `"`)+6]
	}
	if jti(a.accepted[0]) != jti(a.accepted[1]) {
		t.Fatalf("replays carry different jtis: %s / %s", a.accepted[0], a.accepted[1])
	}
}

// An outage of the issuer is its own closed reason, not verify_failed.
func TestAudit_IssuerOutageLogsJWKSUnavailable(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	issuer.setDown(true)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	a := captureAudit(t)

	raw := issuer.mint(t, testRig, clock.Now(), nil)
	_, err := rig.probe(context.Background(), raw)
	wantCode(t, err, connect.CodeUnavailable)
	wantRejected(t, a, raw, "jwks_unavailable")
}

// The receipt records the token that made the push: its jti and its kid.
func TestReceipt_RecordsTheTokenThatMadePush(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-audit", "run-audit", "rea")

	raw := issuer.mint(t, testRig, clock.Now(), nil)
	if _, err := rig.client().PushSweep(context.Background(), withToken(connect.NewRequest(
		sweepReq("job-audit", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))), raw)); err != nil {
		t.Fatalf("push: %v", err)
	}
	var jti, kid, sub string
	if err := pool.QueryRow(context.Background(),
		`SELECT jwt_jti, jwt_kid, rig_subject FROM crawl_ingest_receipts WHERE key = 'job-audit:1:rea'`).
		Scan(&jti, &kid, &sub); err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if want := fmt.Sprintf("jti-%d-rig:gamma-64", clock.Now().Unix()); jti != want {
		t.Fatalf("jwt_jti = %q, want %q", jti, want)
	}
	if kid != "kid-test-1" || sub != testRig {
		t.Fatalf("kid = %q, sub = %q", kid, sub)
	}
}

// Before migration 000152 is applied, the columns do not exist. The push must still
// succeed, write its listings and its receipt, and not abort its transaction.
func TestReceipt_PushSucceedsBeforeTheAuditColumnsExist(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-old", "run-old", "rea")
	if _, err := pool.Exec(context.Background(),
		`ALTER TABLE crawl_ingest_receipts DROP COLUMN jwt_jti, DROP COLUMN jwt_kid`); err != nil {
		t.Fatalf("drop columns: %v", err)
	}

	resp := mustPush(t, rig, sweepReq("job-old", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedRea("A", 1_000_000), fixedRea("B", 1_100_000)))
	if resp.ListingsUpserted != 2 {
		t.Fatalf("listings not written: %+v", resp)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE ingest_receipt_key = 'job-old:1:rea'`); n != 2 {
		t.Fatalf("the sweep's transaction was aborted: %d listings stamped", n)
	}
	if n := count(t, rig, `SELECT count(*) FROM crawl_ingest_receipts WHERE key = 'job-old:1:rea'`); n != 1 {
		t.Fatalf("receipt not written without the columns: %d", n)
	}
}
