package alerts

// The binary suite runs the job binary itself, `shorted alerts` built from
// ../../../cmd/shorted, against the same real Postgres, Resend stub and
// BillingService stub as e2e_pg_test.go. Unlike the in-process suite it goes through
// the real flag parsing, environment and exit codes that the CronJob sees.
//
// It is the only test that pins the quiet monitors. Every scope x condition has a
// monitor that fires on the same dates as one that must stay silent, and the exact
// set of events is asserted on every run. It needs ALERTS_TEST_DATABASE_URL and
// skips without it.

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

const (
	binaryAlertsSender  = "Shorted Alerts <alerts@shorted.com.au>"
	binaryUnsubscribeTo = "<https://shorted.com.au/api/alerts/unsubscribe?t="
)

// buildJobBinary compiles the binary the CronJob runs. go test runs in the package
// directory, so the module's cmd/shorted is three levels up.
func buildJobBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "shorted")
	cmd := exec.Command("go", "build", "-o", bin, filepath.Join("..", "..", "..", "cmd", "shorted"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build shorted: %v\n%s", err, out)
	}
	return bin
}

// runAlerts runs `shorted alerts` with the environment newE2E set up and returns the
// process exit code. Its output is logged for a failing run; it never holds a secret
// or an address, since the job logs neither.
func (e *e2e) runAlerts(bin string, args ...string) int {
	e.t.Helper()
	cmd := exec.CommandContext(e.ctx, bin, append([]string{"alerts"}, args...)...)
	out, err := cmd.CombinedOutput()
	e.t.Logf("shorted alerts %s\n%s", strings.Join(args, " "), out)
	if err == nil {
		return 0
	}
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		return exitErr.ExitCode()
	}
	e.t.Fatalf("run shorted alerts: %v", err)
	return -1
}

// seedCombinations registers the companies the combinations fixture needs: Materials
// with AAA, BBB, CCC, EEE and eight fillers, and Energy with DDD, G1 and G2.
func (e *e2e) seedCombinations() {
	e.company("AAA", "Aaa Resources Ltd", "Materials")
	e.company("BBB", "Bbb Metals Ltd", "Materials")
	e.company("CCC", "Ccc Lithium Ltd", "Materials")
	e.company("EEE", "Eee Minerals Ltd", "Materials")
	for i := 1; i <= 8; i++ {
		e.company(fmt.Sprintf("F%d", i), fmt.Sprintf("Filler %d Ltd", i), "Materials")
	}
	e.company("DDD", "Ddd Power Ltd", "Energy")
	e.company("G1", "Ggg Gas Ltd", "Energy")
	e.company("G2", "Gg2 Energy Ltd", "Energy")
}

// comboDay is one report date. The fillers and G1 never move, so they never fire.
func comboDay(aaa, bbb, ccc, eee, ddd, g2 float64, withCCC bool) map[string]float64 {
	rows := map[string]float64{"AAA": aaa, "BBB": bbb, "EEE": eee, "DDD": ddd, "G1": 3.00, "G2": g2}
	if withCCC {
		rows["CCC"] = ccc
	}
	for i := 1; i <= 8; i++ {
		rows[fmt.Sprintf("F%d", i)] = 4.5 - 0.1*float64(i)
	}
	return rows
}

// wantMonitors asserts the exact set of monitors that produced an event on one date.
func wantMonitors(t *testing.T, when string, got map[string]evRow, want ...string) {
	t.Helper()
	var have []string
	for id := range got {
		have = append(have, id)
	}
	sort.Strings(have)
	sort.Strings(want)
	if strings.Join(have, ",") != strings.Join(want, ",") {
		t.Fatalf("%s: monitors with an event = %v, want %v", when, have, want)
	}
}

// TestAlertsE2EEveryCombinationBinary drives the real binary through bootstrap, a
// firing date, an idempotent re-run, a paused monitor and two later dates. Each
// scope x condition has one monitor that fires and one quiet monitor on the same dates.
func TestAlertsE2EEveryCombinationBinary(t *testing.T) {
	e := newE2E(t)
	bin := buildJobBinary(t)
	e.seedCombinations()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.billing.setStatus("u2", "SUBSCRIPTION_STATUS_INACTIVE")

	// Entitled owner u1. a1 to a5 fire on 14 Oct, one per scope x condition.
	e.monitor("a1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("a2", "u1", u1Email, "stock", "BBB", "short_interest_rises", "daily", new(0.5), "")
	e.monitor("a3", "u1", u1Email, "industry", "Materials", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("a4", "u1", u1Email, "industry", "Materials", "short_interest_rises", "daily", new(0.4), "")
	e.monitor("a5", "u1", u1Email, "industry", "Materials", "new_top_ten_entry", "daily", nil, "")
	// The quiet monitors, one or more per scope x condition, with the reason each stays silent.
	e.monitor("b1", "u1", u1Email, "stock", "DDD", "short_interest_above", "daily", new(float64(5)), "")       // 5.00 on both dates: equal is not a crossing
	e.monitor("b2", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(6)), "")       // crosses 5, never reaches 6
	e.monitor("b3", "u1", u1Email, "stock", "BBB", "short_interest_above", "daily", new(float64(5)), "")       // already above at both dates
	e.monitor("b4", "u1", u1Email, "stock", "DDD", "short_interest_rises", "daily", new(0.5), "")              // no move
	e.monitor("b5", "u1", u1Email, "stock", "G2", "short_interest_rises", "daily", new(0.5), "")               // falls by 1.00
	e.monitor("b6", "u1", u1Email, "stock", "EEE", "short_interest_rises", "daily", new(0.5), "")              // moves by 0.01
	e.monitor("b7", "u1", u1Email, "industry", "Energy", "short_interest_above", "daily", new(float64(5)), "") // no company crosses
	e.monitor("b8", "u1", u1Email, "industry", "Energy", "short_interest_rises", "daily", new(0.4), "")        // no company rises 0.4
	e.monitor("b9", "u1", u1Email, "industry", "Energy", "new_top_ten_entry", "daily", nil, "")                // three companies, nobody new
	e.monitor("c1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "paused")
	// Free owner u2. The firing monitor is recorded as skipped and never emailed.
	e.monitor("d1", "u2", u2Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	// Bootstrap on 13 Oct evaluates nothing and sends exactly the canary.
	// CCC's earlier reading sits below the top ten, so CCC has two readings and enters
	// on 14 Oct. Its move also crosses 5% and rises, so a3 and a4 list it first.
	e.day("2026-10-13", comboDay(4.80, 6.00, 0.10, 4.99, 5.00, 7.00, true))
	e.wantExit(e.runAlerts(bin), 0, "bootstrap")
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("bootstrap daily watermark = %s", d)
	}
	if n := e.count(`SELECT count(*) FROM alert_events`); n != 0 {
		t.Fatalf("bootstrap wrote %d events", n)
	}
	if reqs := e.resend.snapshot(); len(reqs) != 1 || reqs[0].to != canaryAddress {
		t.Fatalf("bootstrap must send exactly the canary, got %d requests", len(reqs))
	}

	// 14 Oct: exactly a1 to a5 and d1 have an event, and no quiet or paused monitor does.
	e.day("2026-10-14", comboDay(5.20, 6.50, 7.00, 5.00, 5.00, 6.00, true))
	e.wantExit(e.runAlerts(bin), 0, "first evaluation")
	fired := map[string]evRow{}
	for _, ev := range e.events(`WHERE report_date = '2026-10-14'`) {
		fired[ev.monitorID] = ev
	}
	wantMonitors(t, "14 Oct", fired, "a1", "a2", "a3", "a4", "a5", "d1")
	for _, id := range []string{"a1", "a2", "a3", "a4", "a5"} {
		if ev := fired[id]; ev.status != "sent" || ev.resendID == "" {
			t.Fatalf("%s = %s resend=%q, want sent with a Resend id", id, ev.status, ev.resendID)
		}
	}
	if ev := fired["d1"]; ev.status != "skipped_unentitled" || ev.lastError != "entitlement: status=INACTIVE" {
		t.Fatalf("the free owner's event = status %s error %q", ev.status, ev.lastError)
	}
	if got := codesIn(fired["a3"].payload); got != "CCC,AAA,EEE" {
		t.Fatalf("industry above crossers = %s, want CCC,AAA,EEE by latest reading", got)
	}
	if got := codesIn(fired["a4"].payload); got != "CCC,BBB,AAA" {
		t.Fatalf("industry rises = %s, want CCC,BBB,AAA by change", got)
	}
	if got := codesIn(fired["a5"].payload); got != "CCC" {
		t.Fatalf("top ten entrants = %s, want CCC", got)
	}

	// Emails: five to the entitled owner with the right subjects and headers, none to the free owner.
	customer := requestsTo(e.resend.snapshot(), u1Email)
	if len(customer) != 5 {
		t.Fatalf("emails to the entitled owner = %d, want 5", len(customer))
	}
	if n := len(requestsTo(e.resend.snapshot(), u2Email)); n != 0 {
		t.Fatalf("the free owner was emailed %d times", n)
	}
	wantSubjects := []string{
		"AAA short interest crossed 5% (now 5.20%)",
		"BBB short interest up 0.50 pts to 6.50%",
		"Materials: 3 companies crossed 5% short interest",
		"Materials: 3 companies' short interest rose 0.4+ pts",
		"Materials: CCC entered the top 10 most shorted",
	}
	var gotSubjects []string
	for _, r := range customer {
		gotSubjects = append(gotSubjects, r.subject)
		if r.from != binaryAlertsSender {
			t.Fatalf("From = %q", r.from)
		}
		if r.headers["List-Unsubscribe-Post"] != "List-Unsubscribe=One-Click" || !strings.HasPrefix(r.headers["List-Unsubscribe"], binaryUnsubscribeTo) {
			t.Fatalf("List-Unsubscribe headers = %v", r.headers)
		}
		if !strings.HasPrefix(r.key, "alert-event-") {
			t.Fatalf("idempotency key = %q", r.key)
		}
	}
	sort.Strings(gotSubjects)
	sort.Strings(wantSubjects)
	if strings.Join(gotSubjects, "|") != strings.Join(wantSubjects, "|") {
		t.Fatalf("subjects = %v, want %v", gotSubjects, wantSubjects)
	}
	// The canary goes out before the customer mail of the same run.
	if reqs := e.resend.snapshot(); len(reqs) < 2 || reqs[1].to != canaryAddress {
		t.Fatalf("the canary must precede the customer mail of the run, got %+v", reqs[1:2])
	}

	// A re-run finds nothing new and sends nothing.
	before := e.resend.count()
	e.wantExit(e.runAlerts(bin), 0, "re-run")
	if after := e.resend.count(); after != before {
		t.Fatalf("a re-run made %d requests", after-before)
	}

	// The unsubscribe link in a1's email names a1 and only a1.
	a1Key := idempotencyKey("event", fired["a1"].id, fired["a1"].createdAt)
	var a1Mail *resendReq
	for _, r := range e.resend.snapshot() {
		if r.key == a1Key {
			r := r
			a1Mail = &r
		}
	}
	if a1Mail == nil {
		t.Fatal("no email for a1")
	}
	token := strings.TrimSuffix(strings.TrimPrefix(a1Mail.headers["List-Unsubscribe"], binaryUnsubscribeTo), ">")
	if id, ok := unsubscribe.ParseAlertMonitorToken(token, e2eUnsubKey); !ok || id != "a1" {
		t.Fatalf("a1's List-Unsubscribe token names %q ok=%v", id, ok)
	}
	// The pause the public RPC performs, written as its SQL (the RPC itself is covered
	// in services/shorts and by the live check that runs against the real API).
	mustExec(t, e.pool, `UPDATE alert_monitors SET status = 'paused' WHERE id = 'a1'`)

	// 15 and 16 Oct in one run. 15 Oct is quiet. On 16 Oct AAA crosses 5 again, which
	// fires a3, a4 and the free owner's d1, but not the paused a1.
	e.day("2026-10-15", comboDay(4.00, 6.50, 7.00, 5.00, 5.00, 6.00, true))
	e.day("2026-10-16", comboDay(5.50, 6.50, 7.00, 5.00, 5.00, 6.00, true))
	e.wantExit(e.runAlerts(bin), 0, "two dates after the pause")
	if n := e.count(`SELECT count(*) FROM alert_events WHERE report_date = '2026-10-15'`); n != 0 {
		t.Fatalf("15 Oct wrote %d events, want none", n)
	}
	d3 := map[string]evRow{}
	for _, ev := range e.events(`WHERE report_date = '2026-10-16'`) {
		d3[ev.monitorID] = ev
	}
	wantMonitors(t, "16 Oct after the pause", d3, "a3", "a4", "d1")
	if n := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'a1' AND report_date > '2026-10-14'`); n != 0 {
		t.Fatalf("the paused a1 produced %d events after its pause", n)
	}
	if ev := d3["d1"]; ev.status != "skipped_unentitled" {
		t.Fatalf("the free owner's 16 Oct event = %s", ev.status)
	}
	if n := len(requestsTo(e.resend.snapshot(), u1Email)); n != 7 {
		t.Fatalf("emails to the entitled owner after 16 Oct = %d, want 7", n)
	}
	if n := len(requestsTo(e.resend.snapshot(), u2Email)); n != 0 {
		t.Fatalf("the free owner was emailed %d times by 16 Oct", n)
	}

	// The quiet and paused monitors never produced an event on any date.
	if n := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id IN ('b1','b2','b3','b4','b5','b6','b7','b8','b9','c1')`); n != 0 {
		t.Fatalf("quiet or paused monitors produced %d events", n)
	}
	if n := e.count(`SELECT count(*) FROM alert_events`); n != 9 {
		t.Fatalf("events in total = %d, want 9 (six on 14 Oct, three on 16 Oct)", n)
	}
}
