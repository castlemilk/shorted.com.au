package shorts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testIngestResource = "projects/rosy-clover-477102-t5/locations/australia-southeast2/services/housing-ingest"

// fakeRunAPI serves the two Cloud Run reads the reader makes, for the given env.
func fakeRunAPI(t *testing.T, env []map[string]any, hits *atomic.Int32) *ingestAdmission {
	t.Helper()
	const rev = testIngestResource + "/revisions/housing-ingest-00007"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch {
		case strings.HasSuffix(r.URL.Path, "/services/housing-ingest"):
			_ = json.NewEncoder(w).Encode(map[string]any{"latestReadyRevision": rev})
		case strings.HasSuffix(r.URL.Path, "/revisions/housing-ingest-00007"):
			_ = json.NewEncoder(w).Encode(map[string]any{"containers": []any{map[string]any{"env": env}}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return &ingestAdmission{resource: testIngestResource, endpoint: srv.URL + "/", now: time.Now}
}

func lit(name, value string) map[string]any { return map[string]any{"name": name, "value": value} }

func TestIngestAdmitsOnlyAListedSubjectWithOrgAndEnabled(t *testing.T) {
	env := []map[string]any{
		lit("HOUSING_INGEST_ENABLED", "true"),
		lit("HOUSING_INGEST_ORG", "brandbrain"),
		lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1, rig:rig-2"),
	}
	var hits atomic.Int32
	a := fakeRunAPI(t, env, &hits)
	ctx := context.Background()
	if got := a.Admits(ctx, "rig:rig-1"); got != "true" {
		t.Fatalf("listed subject: %s", got)
	}
	if got := a.Admits(ctx, "rig:rig-3"); got != "false" {
		t.Fatalf("unlisted subject: %s", got)
	}
}

// Prod sets neither. An enabled row alone admits nothing, so the signal must say false.
func TestIngestWithoutOrgOrAllowlistAdmitsNothing(t *testing.T) {
	for name, env := range map[string][]map[string]any{
		"no org":       {lit("HOUSING_INGEST_ENABLED", "true"), lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1")},
		"no allowlist": {lit("HOUSING_INGEST_ENABLED", "true"), lit("HOUSING_INGEST_ORG", "brandbrain")},
		"disabled":     {lit("HOUSING_INGEST_ENABLED", "false"), lit("HOUSING_INGEST_ORG", "brandbrain"), lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1")},
	} {
		var hits atomic.Int32
		if got := fakeRunAPI(t, env, &hits).Admits(context.Background(), "rig:rig-1"); got != "false" {
			t.Fatalf("%s: admits = %s, want false", name, got)
		}
	}
}

// A secret-backed variable has no literal value here, so it cannot be read as an org or an
// allowlist. The reader must not treat a secret reference as configuration.
func TestIngestSecretBackedVariablesAreNotLiterals(t *testing.T) {
	env := []map[string]any{
		lit("HOUSING_INGEST_ENABLED", "true"),
		{"name": "HOUSING_INGEST_ORG", "valueSource": map[string]any{"secretKeyRef": map[string]any{"secret": "x"}}},
		lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1"),
	}
	var hits atomic.Int32
	if got := fakeRunAPI(t, env, &hits).Admits(context.Background(), "rig:rig-1"); got != "false" {
		t.Fatalf("a secret-backed org was read as set: %s", got)
	}
}

func TestIngestUnreadableIsUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)
	a := &ingestAdmission{resource: testIngestResource, endpoint: srv.URL + "/", now: time.Now}
	if got := a.Admits(context.Background(), "rig:rig-1"); got != "unknown" {
		t.Fatalf("a failed read = %s, want unknown", got)
	}
	var nilReader *ingestAdmission
	if got := nilReader.Admits(context.Background(), "rig:rig-1"); got != "unknown" {
		t.Fatalf("no reader = %s, want unknown", got)
	}
}

// The parsed config is cached for the TTL, so repeated tool calls do not each call Cloud Run.
func TestIngestConfigIsCachedBriefly(t *testing.T) {
	env := []map[string]any{lit("HOUSING_INGEST_ENABLED", "true"), lit("HOUSING_INGEST_ORG", "brandbrain"), lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1")}
	var hits atomic.Int32
	a := fakeRunAPI(t, env, &hits)
	now := time.Now()
	a.now = func() time.Time { return now }
	ctx := context.Background()
	a.Admits(ctx, "rig:rig-1")
	a.Admits(ctx, "rig:rig-2")
	if n := hits.Load(); n != 2 {
		t.Fatalf("cold read made %d API calls, want 2 (service + revision)", n)
	}
	now = now.Add(ingestAdmissionTTL + time.Second)
	a.Admits(ctx, "rig:rig-1")
	if n := hits.Load(); n != 4 {
		t.Fatalf("after the TTL the config was not re-read: %d calls", n)
	}
}

func TestIngestResourceNameIsValidated(t *testing.T) {
	if newIngestAdmissionFromEnv(func(string) string { return "" }) != nil {
		t.Fatal("an unset resource produced a reader")
	}
	for _, bad := range []string{"housing-ingest", "projects/p/services/s", "projects/p/locations/l/services/s/../x"} {
		if newIngestAdmissionFromEnv(func(string) string { return bad }) != nil {
			t.Fatalf("%q produced a reader", bad)
		}
	}
	if newIngestAdmissionFromEnv(func(string) string { return testIngestResource }) == nil {
		t.Fatal("a valid resource produced no reader")
	}
}

// --- a config the ingest refuses to serve is not an admission ----------------------

// ConfigFromEnv reports a problem, and the ingest then answers Unavailable to every call.
// A listed subject must still read false.
func TestIngestWithAConfigProblemDoesNotAdmit(t *testing.T) {
	for name, extra := range map[string]map[string]any{
		"bad dispatch ttl":     lit("HOUSING_INGEST_DISPATCH_TTL", "soon"),
		"bad db max conns":     lit("HOUSING_INGEST_DB_MAX_CONNS", "0"),
		"bad contract version": lit("HOUSING_INGEST_MIN_CONTRACT_VERSION", "0"),
	} {
		env := []map[string]any{
			lit("HOUSING_INGEST_ENABLED", "true"),
			lit("HOUSING_INGEST_ORG", "brandbrain"),
			lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1"),
			extra,
		}
		var hits atomic.Int32
		if got := fakeRunAPI(t, env, &hits).Admits(context.Background(), "rig:rig-1"); got != "false" {
			t.Fatalf("%s: the ingest refuses every call but admits = %s", name, got)
		}
	}
}

// A stray comma leaves an empty entry. The verifier refuses the config, so it must not admit.
func TestIngestWithAStrayCommaDoesNotAdmit(t *testing.T) {
	for name, list := range map[string]string{"trailing comma": "rig:rig-1,", "whitespace entry": "rig:rig-1, ,rig:rig-2"} {
		env := []map[string]any{
			lit("HOUSING_INGEST_ENABLED", "true"),
			lit("HOUSING_INGEST_ORG", "brandbrain"),
			lit("HOUSING_INGEST_ALLOW_SUBJECTS", list),
		}
		var hits atomic.Int32
		if got := fakeRunAPI(t, env, &hits).Admits(context.Background(), "rig:rig-1"); got != "false" {
			t.Fatalf("%s: the verifier refuses this config but admits = %s", name, got)
		}
	}
}

// --- a failed read is cached, never admits, and recovers --------------------------

func TestIngestErrorIsCachedAndNeverAdmits(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)
	a := &ingestAdmission{resource: testIngestResource, endpoint: srv.URL + "/", now: time.Now}
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		if got := a.Admits(ctx, "rig:rig-1"); got != "unknown" {
			t.Fatalf("call %d: a failed read = %s, want unknown", i, got)
		}
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("50 calls within the error TTL made %d Cloud Run requests, want 1", n)
	}
}

// An error followed by a success gives the success once the error TTL has passed, and an
// error after a good read never gives the old answer.
func TestIngestErrorThenSuccessRecoversAndErrorNeverAdmits(t *testing.T) {
	fail := true
	var hits atomic.Int32
	env := []map[string]any{lit("HOUSING_INGEST_ENABLED", "true"), lit("HOUSING_INGEST_ORG", "brandbrain"), lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:rig-1")}
	const rev = testIngestResource + "/revisions/housing-ingest-00007"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/services/housing-ingest") {
			_ = json.NewEncoder(w).Encode(map[string]any{"latestReadyRevision": rev})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"containers": []any{map[string]any{"env": env}}})
	}))
	t.Cleanup(srv.Close)
	now := time.Now()
	a := &ingestAdmission{resource: testIngestResource, endpoint: srv.URL + "/", now: func() time.Time { return now }}
	ctx := context.Background()

	if got := a.Admits(ctx, "rig:rig-1"); got != "unknown" {
		t.Fatalf("cold failure = %s, want unknown", got)
	}
	fail = false
	now = now.Add(ingestErrorTTL / 2)
	if got := a.Admits(ctx, "rig:rig-1"); got != "unknown" {
		t.Fatalf("inside the error TTL = %s, want the remembered unknown", got)
	}
	now = now.Add(ingestErrorTTL)
	if got := a.Admits(ctx, "rig:rig-1"); got != "true" {
		t.Fatalf("after recovery = %s, want true", got)
	}

	// Good read cached; the TTL passes and the next read fails: unknown, never the stale true.
	fail = true
	now = now.Add(ingestAdmissionTTL + time.Second)
	if got := a.Admits(ctx, "rig:rig-1"); got != "unknown" {
		t.Fatalf("a failed re-read after a good config = %s, want unknown", got)
	}
}

// --- one read per tool call, not per row ------------------------------------------

// A snapshot reads the config once and answers every subject from it.
func TestSnapshotReadsOnceForManySubjects(t *testing.T) {
	env := []map[string]any{lit("HOUSING_INGEST_ENABLED", "true"), lit("HOUSING_INGEST_ORG", "brandbrain"), lit("HOUSING_INGEST_ALLOW_SUBJECTS", "rig:a,rig:b")}
	var hits atomic.Int32
	a := fakeRunAPI(t, env, &hits)
	admit := a.Snapshot(context.Background())
	for _, s := range []string{"rig:a", "rig:b", "rig:c", "rig:a", "rig:b"} {
		_ = admit(s)
	}
	if n := hits.Load(); n != 2 {
		t.Fatalf("a snapshot over five subjects made %d Cloud Run requests, want 2 (service + revision)", n)
	}
}
