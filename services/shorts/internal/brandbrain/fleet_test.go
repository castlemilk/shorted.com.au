package brandbrain

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const fleetToken = "fleet-ops-token-SECRET-7f3a"

// fleetReq is one request the stand-in received.
type fleetReq struct {
	Method, Path, Query, Body string
	Token, Operator, Idem     string
}

// fleetStandIn records every request and answers from a handler the test sets.
type fleetStandIn struct {
	mu   sync.Mutex
	reqs []fleetReq
	// handler answers each request after it is recorded. The default is 200 {}.
	handler func(w http.ResponseWriter, r *http.Request)
}

func (s *fleetStandIn) requests() []fleetReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fleetReq(nil), s.reqs...)
}

func newFleetStandIn(t *testing.T, handler func(http.ResponseWriter, *http.Request)) (*httptest.Server, *fleetStandIn) {
	t.Helper()
	st := &fleetStandIn{handler: handler}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		st.mu.Lock()
		st.reqs = append(st.reqs, fleetReq{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(raw),
			Token: r.Header.Get(fleetTokenHeader), Operator: r.Header.Get(fleetOperatorHeader), Idem: r.Header.Get(idempotencyHeader),
		})
		st.mu.Unlock()
		if r.Header.Get(fleetTokenHeader) != fleetToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if st.handler == nil {
			_, _ = io.WriteString(w, `{}`)
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(raw)))
		st.handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, st
}

func fleetClient(t *testing.T, base string, timeout time.Duration) *FleetClient {
	t.Helper()
	f, err := NewFleetTestClient(base, fleetToken, timeout)
	if err != nil {
		t.Fatal(err)
	}
	return f.WithOperator("ops@shorted.com.au")
}

func TestFleetIsNotConfiguredWithoutItsToken(t *testing.T) {
	f, err := FleetFromEnv(func(string) string { return "" })
	if err != nil || f != nil {
		t.Fatalf("unset token: client=%v err=%v, want nil and nil", f, err)
	}
	// A nil client sends nothing and says so.
	var none *FleetClient
	if _, err := none.ListRigs(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("nil client: %v", err)
	}
}

func TestFleetFromEnvRefusesAnotherHost(t *testing.T) {
	env := map[string]string{EnvFleetOpsToken: fleetToken, EnvBaseURL: "https://evil.example.com"}
	if _, err := FleetFromEnv(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a base URL off the pinned host was accepted")
	}
	env[EnvBaseURL] = ""
	f, err := FleetFromEnv(func(k string) string { return env[k] })
	if err != nil || f == nil {
		t.Fatalf("default base: %v", err)
	}
}

func TestFleetSendsItsHeadersAndNeverEchoesTheToken(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	if _, err := f.ListRigs(context.Background()); err != nil {
		t.Fatal(err)
	}
	reqs := st.requests()
	if len(reqs) != 1 || reqs[0].Token != fleetToken || reqs[0].Operator != "shorted-admin:ops@shorted.com.au" {
		t.Fatalf("headers = %+v", reqs)
	}
	// A bad token is refused without leaking the token in the error.
	bad, _ := NewFleetTestClient(srv.URL, "wrong", 0)
	_, err := bad.ListRigs(context.Background())
	if !errors.Is(err, ErrRejected) || strings.Contains(err.Error(), fleetToken) {
		t.Fatalf("bad token: %v", err)
	}
}

func TestFleetRedirectIsRefusedAndNeverFollowed(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the token followed a redirect")
	}))
	t.Cleanup(other.Close)
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusTemporaryRedirect)
	})
	_, err := fleetClient(t, srv.URL, 0).ListRigs(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("redirect: %v, want unavailable", err)
	}
}

func TestFleetTimeoutIsUnknownNotAFailure(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = io.WriteString(w, `{}`)
	})
	_, err := fleetClient(t, srv.URL, 20*time.Millisecond).ListRigs(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timeout: %v, want unavailable", err)
	}
}

func TestFleetStatusesMapToTypedOutcomes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"contract 404", http.StatusNotFound, `{"code":"rig_not_found"}`, ErrRigNotFound},
		{"plain 404", http.StatusNotFound, `404 page not found`, ErrUnavailable},
		{"400", http.StatusBadRequest, `{}`, ErrInvalidRequest},
		{"403", http.StatusForbidden, `{}`, ErrRejected},
		{"429", http.StatusTooManyRequests, `{"code":"rate_limited"}`, ErrRateLimited},
		{"500", http.StatusInternalServerError, `{}`, ErrUnavailable},
		{"unexpected 418", http.StatusTeapot, `{}`, ErrUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = io.WriteString(w, c.body)
			})
			_, err := fleetClient(t, srv.URL, 0).GetRig(context.Background(), "rig-1")
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestFleetRigDetailCarriesServerTime(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"id":"rig-1","version":"1.4.0","liveness":"alive",
			"resources":{"housing_crawl":{"state":"running","portals":[{"source":"rea","state":"open","open_until":"2026-10-31T10:00:00Z"}]}},
			"server_time":"2026-10-31T09:00:00Z"}`)
	})
	d, err := fleetClient(t, srv.URL, 0).GetRig(context.Background(), "rig-1")
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != "rig-1" || d.ServerTime == nil || !d.ServerTime.Equal(time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("detail = %+v", d)
	}
	if len(d.Resources.HousingCrawl.Portals) != 1 || d.Resources.HousingCrawl.Portals[0].OpenUntil == nil {
		t.Fatalf("portal not decoded: %+v", d.Resources.HousingCrawl)
	}
}

func TestFleetCrawlJobsQueryIsEncodedAndBounded(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"jobs":[],"summary":{"by_status_source":[{"status":"failed","source":"rea","count":3}]}}`)
	})
	page, err := fleetClient(t, srv.URL, 0).ListCrawlJobs(context.Background(), CrawlJobQuery{
		Status: "failed", Kind: "housing", Source: "rea", UpdatedSince: "2026-10-30T00:00:00Z", Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Summary.ByStatusSource[0].Count != 3 {
		t.Fatalf("summary = %+v", page.Summary)
	}
	q := st.requests()[0].Query
	for _, want := range []string{"status=failed", "kind=housing", "source=rea", "limit=1", "updated_since=2026-10-30T00%3A00%3A00Z"} {
		if !strings.Contains(q, want) {
			t.Errorf("query %q lacks %s", q, want)
		}
	}
	if strings.Contains(q, "assigned_agent") || strings.Contains(q, "id=") {
		t.Errorf("unset filters were sent: %q", q)
	}
}

func TestFleetRunDrainSendsOnlyTheClosedCommand(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"id":"cmd-9","kind":"housing_crawl_run","status":"queued"}`)
	})
	cmd, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "smoke-x:drain")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.ID != "cmd-9" {
		t.Fatalf("command = %+v", cmd)
	}
	req := st.requests()[0]
	if req.Method != http.MethodPost || req.Path != "/api/v1/fleet/rigs/rig-1/commands" || req.Idem != "smoke-x:drain" {
		t.Fatalf("request = %+v", req)
	}
	var body struct {
		Kind    string         `json:"kind"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		t.Fatal(err)
	}
	if body.Kind != "housing_crawl_run" || body.Payload["job"] != "drain" || body.Payload["dry_run"] != false || len(body.Payload) != 2 {
		t.Fatalf("body = %s", req.Body)
	}
}

func TestFleetLogRequestRefusesAnyOtherSourceWithoutSending(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	for _, src := range []string{"", "all", "Housing", "../runtime", "housing;x"} {
		if _, err := f.RequestRuntimeLogs(context.Background(), "rig-1", src, "k"); !errors.Is(err, ErrCommandRefused) {
			t.Errorf("source %q: %v, want refused", src, err)
		}
	}
	if n := len(st.requests()); n != 0 {
		t.Fatalf("%d requests were sent for refused sources", n)
	}
	cmd, err := f.RequestRuntimeLogs(context.Background(), "rig-1", LogSourceHousing, "k")
	if err == nil {
		t.Fatalf("a 200 with no command id must be unknown, got %+v", cmd)
	}
}

func TestFleetCommandWithoutAnIDIsUnknown(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"status":"queued"}`)
	})
	if _, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no id: %v, want unavailable", err)
	}
}

func TestFleetCommandFiveHundredIsNotRetried(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("502: %v, want unavailable", err)
	}
	if n := len(st.requests()); n != 1 {
		t.Fatalf("a command with an unknown outcome was sent %d times", n)
	}
}

// A rig id can never add a path segment, a query or a traversal: it is refused before any
// request is built, so nothing reaches the wire.
func TestFleetRefusesARigIDThatWouldChangeTheRoute(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	for _, id := range []string{"", "..", "a/../b", "rig-1/commands", "rig-1?x=1", "rig 1", "-rig"} {
		if _, err := f.GetRig(context.Background(), id); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("rig id %q: %v, want invalid", id, err)
		}
		if _, err := f.RunDrain(context.Background(), id, "k"); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("drain on %q: %v, want invalid", id, err)
		}
	}
	if n := len(st.requests()); n != 0 {
		t.Fatalf("%d requests were sent for bad rig ids", n)
	}
}

// A 429 on a drain is the per-rig live limit: nothing was sent, and the caller must say so.
func TestFleetDrainOver429IsRateLimitedNotFailed(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"code":"rate_limited"}`)
	})
	_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
	if !errors.Is(err, ErrRateLimited) || errors.Is(err, ErrUnavailable) {
		t.Fatalf("429: %v, want rate limited (and not an unknown outcome)", err)
	}
}

// The ops token reads the housing queue only: kind is always housing, a foreign kind is
// refused before a request is built, and source may be rea, domain or both.
func TestFleetCrawlJobsRestrictsKindToHousing(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Source: "both"}); err != nil {
		t.Fatalf("source=both: %v", err)
	}
	if q := st.requests()[0].Query; !strings.Contains(q, "kind=housing") || !strings.Contains(q, "source=both") {
		t.Fatalf("query = %q", q)
	}
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Kind: "other"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("kind=other: %v, want refused", err)
	}
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Source: "all"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("source=all: %v, want refused", err)
	}
	if n := len(st.requests()); n != 1 {
		t.Fatalf("%d requests sent; refused queries must send none", n)
	}
}

// Every drain the client can build is a live drain: dry_run is never true.
func TestFleetDrainNeverSendsADryRun(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"id":"cmd-1"}`)
	})
	if _, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k"); err != nil {
		t.Fatal(err)
	}
	if body := st.requests()[0].Body; strings.Contains(body, `"dry_run":true`) || !strings.Contains(body, `"dry_run":false`) {
		t.Fatalf("drain body = %s", body)
	}
}
