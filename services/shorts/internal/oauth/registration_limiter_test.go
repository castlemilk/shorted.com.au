package oauth

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The abuse cap on /oauth/register.
//
// This endpoint is unauthenticated by definition — RFC 7591 registration is the
// path Claude and ChatGPT still use, and it WRITES A ROW. So the cap is the
// only thing between an open write endpoint and whoever finds it.
//
// Its fail rule is deliberately the OPPOSITE of pkg/ratelimit's. The quota
// limiter fails OPEN, because a sick database must never 429 a reader. This one
// fails CLOSED, because failing open would hand an attacker who filled the
// table an unlimited write endpoint. Those two rules look contradictory in a
// diff and are not; the tests below pin both the behaviour and the reason.

// clock is a controllable time source. Registration limits are measured in
// hours and days, so a test that used real time could only ever assert the
// first few attempts.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock {
	// A fixed instant, not time.Now(): a window boundary that depends on when
	// the suite runs is a flake waiting for a particular hour of the day.
	return &clock{t: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)}
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestLimiter(perHour, perDay int, c *clock) *registrationLimiter {
	return &registrationLimiter{
		perHour: perHour,
		perDay:  perDay,
		now:     c.now,
		seen:    map[string][]time.Time{},
	}
}

func TestRegistrationLimiterAllowsUpToTheHourlyCap(t *testing.T) {
	c := newClock()
	l := newTestLimiter(3, 100, c)

	for i := 0; i < 3; i++ {
		if _, ok := l.allow("203.0.113.1"); !ok {
			t.Fatalf("attempt %d was refused inside the cap", i+1)
		}
	}
	retry, ok := l.allow("203.0.113.1")
	if ok {
		t.Fatal("the fourth attempt in an hour was allowed against a cap of 3")
	}
	// A Retry-After of 0 invites an immediate retry, which is not a limit.
	if retry < 1 {
		t.Errorf("Retry-After = %d, must be at least 1", retry)
	}
	if retry > 3600 {
		t.Errorf("Retry-After = %d, longer than the window it is waiting for", retry)
	}
}

// The window has to actually slide, or the cap becomes permanent and a
// legitimate client is locked out for good by one bad hour.
func TestTheHourlyWindowSlides(t *testing.T) {
	c := newClock()
	l := newTestLimiter(2, 100, c)

	l.allow("203.0.113.1")
	l.allow("203.0.113.1")
	if _, ok := l.allow("203.0.113.1"); ok {
		t.Fatal("the cap did not apply")
	}

	c.advance(time.Hour + time.Minute)
	if _, ok := l.allow("203.0.113.1"); !ok {
		t.Fatal("still refused an hour later — the window is not sliding")
	}
}

func TestTheDailyCapAppliesBeyondTheHourly(t *testing.T) {
	c := newClock()
	// Generous per hour, tight per day: the only thing that can stop the
	// caller is the daily window.
	l := newTestLimiter(100, 5, c)

	for i := 0; i < 5; i++ {
		c.advance(90 * time.Minute) // outrun the hourly window every time
		if _, ok := l.allow("203.0.113.1"); !ok {
			t.Fatalf("attempt %d refused while under the daily cap", i+1)
		}
	}
	c.advance(90 * time.Minute)
	if _, ok := l.allow("203.0.113.1"); ok {
		t.Fatal("the daily cap did not apply")
	}

	// And it slides too.
	c.advance(24 * time.Hour)
	if _, ok := l.allow("203.0.113.1"); !ok {
		t.Fatal("still refused a day later — the daily window is not sliding")
	}
}

// One noisy address must not spend another's allowance.
func TestCapsArePerAddress(t *testing.T) {
	c := newClock()
	l := newTestLimiter(1, 10, c)

	if _, ok := l.allow("203.0.113.1"); !ok {
		t.Fatal("first attempt refused")
	}
	if _, ok := l.allow("203.0.113.1"); ok {
		t.Fatal("the cap did not apply to the noisy address")
	}
	if _, ok := l.allow("198.51.100.7"); !ok {
		t.Fatal("a different address was refused for someone else's traffic")
	}
}

// A refused attempt still COUNTS. Otherwise the cap is trivially defeated:
// once refused, every subsequent attempt is free, and an attacker simply keeps
// asking.
func TestARefusedAttemptStillCounts(t *testing.T) {
	c := newClock()
	l := newTestLimiter(1, 3, c)

	l.allow("203.0.113.1")             // 1, allowed
	l.allow("203.0.113.1")             // 2, refused but recorded
	l.allow("203.0.113.1")             // 3, refused but recorded
	c.advance(time.Hour + time.Minute) // hourly window clears
	if _, ok := l.allow("203.0.113.1"); ok {
		t.Fatal("refused attempts were not counted toward the daily cap")
	}
}

// THE FAIL-CLOSED RULE. This is the opposite of pkg/ratelimit's fail-open, on
// purpose: failing open here would hand an attacker who filled the table an
// unlimited write endpoint.
func TestAFullTableRefusesNewAddressesRatherThanOpeningUp(t *testing.T) {
	c := newClock()
	l := newTestLimiter(100, 100, c)

	// Fill it. Every entry is recent, so the prune cannot reclaim anything.
	for i := 0; i < maxRegistrationIPs; i++ {
		l.seen[ipForIndex(i)] = []time.Time{c.now()}
	}

	retry, ok := l.allow("203.0.113.254") // an address not in the table
	if ok {
		t.Fatal("a full table let a NEW address through — this must fail closed")
	}
	if retry < 1 {
		t.Errorf("Retry-After = %d", retry)
	}

	// A known address is still served: it is already accounted for, and
	// refusing it would punish the callers we can actually measure.
	if _, ok := l.allow(ipForIndex(0)); !ok {
		t.Error("an address already in the table was refused")
	}
}

// The table is bounded, and the bound is maintained by pruning EXPIRED entries
// rather than by refusing forever. Without this, one busy day permanently
// wedges the endpoint into its fail-closed state.
func TestAFullTableOfSTALEEntriesIsReclaimed(t *testing.T) {
	c := newClock()
	l := newTestLimiter(100, 100, c)

	for i := 0; i < maxRegistrationIPs; i++ {
		l.seen[ipForIndex(i)] = []time.Time{c.now()}
	}
	// Everything ages out of the 24h window.
	c.advance(25 * time.Hour)

	if _, ok := l.allow("203.0.113.254"); !ok {
		t.Fatal("a table full of EXPIRED entries still refused a new address")
	}
	if len(l.seen) > maxRegistrationIPs {
		t.Errorf("table grew to %d, past its bound", len(l.seen))
	}
	// The stale entries are gone, not merely ignored — otherwise the map is
	// still holding 10,000 dead keys and the bound is decorative.
	if len(l.seen) > 10 {
		t.Errorf("prune left %d entries; expected the stale ones to be deleted", len(l.seen))
	}
}

// The limiter is reached from concurrent requests. A data race here corrupts
// the counter that is protecting a write endpoint.
func TestTheLimiterIsSafeUnderConcurrency(t *testing.T) {
	c := newClock()
	l := newTestLimiter(1000, 1000, c)

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				l.allow(ipForIndex(i % 8))
			}
		}(i)
	}
	wg.Wait()

	total := 0
	for _, stamps := range l.seen {
		total += len(stamps)
	}
	if total != 640 {
		t.Errorf("recorded %d attempts, want 640 — a lost update under contention", total)
	}
}

func ipForIndex(i int) string {
	return "10." + itoa(i/65536%256) + "." + itoa(i/256%256) + "." + itoa(i%256)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// requestIP — which address the cap is keyed on
// ---------------------------------------------------------------------------

// If this takes the LEFTMOST X-Forwarded-For entry, the cap is defeated by one
// header: a caller prepends a random address per request and every attempt
// looks like a new client. Only the rightmost entry was written by our proxy.
func TestRequestIPTakesTheProxyAppendedAddress(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, RegisterPath, nil)
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8, 203.0.113.9")
	if got := requestIP(r); got != "203.0.113.9" {
		t.Errorf("requestIP = %q, want the rightmost (proxy-appended) address", got)
	}
}

func TestRequestIPIgnoresSpoofedPaddingAndWhitespace(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, RegisterPath, nil)
	// Trailing empties are what a caller appends to try to push the real
	// address out of the rightmost slot.
	r.Header.Set("X-Forwarded-For", "  evil ,  203.0.113.9  , , ")
	if got := requestIP(r); got != "203.0.113.9" {
		t.Errorf("requestIP = %q — empty trailing entries defeated the rightmost rule", got)
	}
}

func TestRequestIPFallsBackInOrder(t *testing.T) {
	cases := []struct {
		name   string
		set    func(*http.Request)
		remote string
		want   string
	}{
		{"CF-Connecting-IP", func(r *http.Request) { r.Header.Set("CF-Connecting-IP", "198.51.100.1") }, "", "198.51.100.1"},
		{"X-Real-IP", func(r *http.Request) { r.Header.Set("X-Real-IP", "198.51.100.2") }, "", "198.51.100.2"},
		{"RemoteAddr host:port", func(*http.Request) {}, "192.0.2.5:41234", "192.0.2.5"},
		{"RemoteAddr bare", func(*http.Request) {}, "192.0.2.6", "192.0.2.6"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, RegisterPath, nil)
			r.RemoteAddr = tc.remote
			tc.set(r)
			if got := requestIP(r); got != tc.want {
				t.Errorf("requestIP = %q, want %q", got, tc.want)
			}
		})
	}
}

// XFF beats the other headers, because it is the one the trusted proxy writes.
func TestRequestIPPrefersForwardedForOverTheRest(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, RegisterPath, nil)
	r.RemoteAddr = "192.0.2.5:41234"
	r.Header.Set("CF-Connecting-IP", "198.51.100.1")
	r.Header.Set("X-Real-IP", "198.51.100.2")
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := requestIP(r); got != "203.0.113.9" {
		t.Errorf("requestIP = %q", got)
	}
}

// An unidentifiable caller must still land in SOME bucket. Returning "" would
// key every such request on the same empty string, which is either a shared
// bucket everyone can exhaust or, worse, a map key collision with a real one.
func TestRequestIPNeverReturnsEmpty(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, RegisterPath, nil)
	r.RemoteAddr = ""
	if got := requestIP(r); got == "" {
		t.Error("requestIP returned an empty key")
	}
}
