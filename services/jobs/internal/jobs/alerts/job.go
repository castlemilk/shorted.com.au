// Package alerts is the `shorted alerts` job: the evaluator behind the short-interest
// alerts a customer creates on /alerts.
//
// Each run reads the newest ASIC report dates, decides which of them are new since
// the watermark, evaluates every active monitor against them (evaluate.go, pure),
// records one alert_events row per monitor per date, checks the owner's
// entitlement with the shorts API, and emails the entitled owners through Resend.
//
// It runs as a VKE CronJob on the weekday hour, before any ASIC ingest has
// finished: a sync in progress (sync_status running) is a reason to exit 0 and
// wait, never to evaluate a half-written date.
//
// Exit codes follow the runner: 0 success (including nothing to do, a sync in
// progress, bootstrap and a dry run), 1 a configuration, database, entitlement or
// canary failure, a credential failure, and 10 DEGRADED. 10 means the evaluation
// committed but some customer email ended not-sent (retrying or failed), a held
// date stopped evaluation, or Resend's quota ran out. Telesis pages on any non-zero.
//
// The dry run is the default. A hand run with nothing set writes nothing and sends
// nothing. The CronJob sets ALERTS_DRY_RUN=false.
package alerts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
)

// exitDegraded is the runner's code for DEGRADED.
const exitDegraded = 10

// syncCompleted is the sync_status value of a sync that finished every file.
const syncCompleted = "completed"

// Job is the registry entry for `shorted alerts`.
func Job() runner.Job {
	return runner.Func{
		JobName: "alerts",
		Desc:    "evaluate short-interest alert monitors against new ASIC reports and email their owners",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run is the job entry point.
func Run(ctx context.Context, args []string) error {
	return run(ctx, args, runner.FromContext(ctx), os.Stderr, os.Getenv)
}

// run is Run with its inputs injected, so the end-to-end test can drive it with stub
// services and its own environment.
func run(ctx context.Context, args []string, g runner.Globals, out io.Writer, getenv func(string) string) error {
	opts, err := parseOptions(args, g, out)
	if err != nil {
		return err
	}
	env, err := loadSettings(opts.dryRun, getenv)
	if err != nil {
		return err
	}
	log.Printf("alerts: start dryRun=%t canary=%s date=%s", opts.dryRun, opts.canary, dateLabel(opts.date))

	pool, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(2))
	if err != nil {
		return err
	}
	defer pool.Close()

	a := &alertRun{
		st:      store{pool: pool},
		opts:    opts,
		env:     env,
		getenv:  getenv,
		started: time.Now().UTC(),
	}
	sum, err := a.execute(ctx)
	log.Print(sum.line())
	if err != nil {
		return err
	}
	if sum.exit == exitDegraded {
		return &runner.ExitCodeError{Code: exitDegraded, Err: errDegraded}
	}
	return nil
}

var errDegraded = errors.New("alerts degraded: see the run's log line")

// alertRun carries one invocation.
type alertRun struct {
	st      store
	opts    options
	env     settings
	getenv  func(string) string
	started time.Time
}

// summary is the one line a run ends with.
type summary struct {
	dates             []Date
	weekly            Date
	monitors          int
	candidates        int
	events            int
	vanished          int
	sent              int
	retrying          int
	failed            int
	skippedUnentitled int
	skippedNoEmail    int
	canary            string
	exit              int
	note              string
}

func (s summary) line() string {
	out := fmt.Sprintf("alerts: dates=[%s] weekly=%s monitors=%d candidates=%d events=%d vanished=%d sent=%d retrying=%d failed=%d skipped_unentitled=%d skipped_no_email=%d canary=%s exit=%d",
		joinDates(s.dates), dateLabel(s.weekly), s.monitors, s.candidates, s.events, s.vanished, s.sent, s.retrying, s.failed,
		s.skippedUnentitled, s.skippedNoEmail, s.canary, s.exit)
	if s.note != "" {
		out += fmt.Sprintf(" note=%q", s.note)
	}
	return out
}

// execute runs the phases in order. The run row is opened only once there is work,
// so a no-op run leaves no row. A failure after it is opened is recorded on the row.
func (a *alertRun) execute(ctx context.Context) (sum summary, err error) {
	sum.canary = "skipped"
	var (
		runID      int64
		runStarted time.Time
		res        runResult
	)
	defer func() {
		if err != nil {
			sum.exit = 1
			if runID != 0 {
				res.Outcome, res.Error = "failed", err.Error()
				if ferr := a.st.finishRun(context.WithoutCancel(ctx), runID, res); ferr != nil {
					log.Printf("alerts: could not record the failed run: %v", ferr)
				}
			}
		}
	}()

	// Phase 2: the watermark row, and runs a crash left open.
	if !a.opts.dryRun {
		if err = a.st.ensureState(ctx); err != nil {
			return sum, err
		}
		if err = a.st.abandonStaleRuns(ctx); err != nil {
			return sum, err
		}
	}

	// Phase 3: the readiness gate. A replay is an operator's explicit request, so
	// it runs regardless.
	if a.opts.date == "" {
		var busy bool
		if busy, err = a.st.syncRunning(ctx); err != nil {
			return sum, err
		}
		if busy {
			log.Printf("alerts: sync in progress; evaluating next run")
			return sum, nil
		}
	}

	// Phase 3b: the newest sync must have completed. A failed or cancelled sync can
	// leave its last report half-written, so planning holds the unevaluated dates
	// until a completed sync lands. A replay is an operator's explicit request.
	unsettled := false
	if a.opts.date == "" {
		status, err := a.st.latestSyncStatus(ctx)
		if err != nil {
			return sum, err
		}
		if unsettled = status != "" && status != syncCompleted; unsettled {
			log.Printf("alerts: latest ASIC sync is %s, not %s; holding report dates until one completes", status, syncCompleted)
		}
	}

	// Phase 4 and 5: the window, the watermarks and the data.
	reportDates, err := a.st.reportDates(ctx)
	if err != nil {
		return sum, err
	}
	if len(reportDates) == 0 {
		log.Printf("alerts: no report dates yet; nothing to do")
		return sum, nil
	}
	state, err := a.st.state(ctx)
	if err != nil {
		return sum, err
	}
	readings, err := a.st.loadRows(ctx, reportDates[len(reportDates)-1], reportDates[0])
	if err != nil {
		return sum, err
	}
	companies, err := a.st.loadCompanies(ctx)
	if err != nil {
		return sum, err
	}
	snap := NewSnapshot(reportDates, readings, companies)
	snap.SyncUnsettled = unsettled

	// Phase 4: the plan.
	replay := a.opts.date != ""
	var plan Plan
	if replay {
		if plan, err = PlanReplay(snap, a.opts.date); err != nil {
			return sum, err
		}
	} else {
		plan = PlanRun(state, snap)
	}
	sum.dates = dailyDates(plan)
	sum.weekly = weeklyLast(plan)
	sum.note = logNote(plan, a.opts)
	if plan.Bootstrap {
		log.Printf("alerts: bootstrap: watermarks set daily_through=%s weekly_through=%s; nothing evaluated, nothing sent",
			dateLabel(plan.Next.DailyThrough), dateLabel(plan.Next.WeeklyThrough))
	}

	// Phase 7: nothing to do. A run with no plan, no pending send and no canary due
	// writes no run row and logs one line.
	due, err := a.st.canaryDue(ctx)
	if err != nil {
		return sum, err
	}
	work := replay || plan.Bootstrap || len(plan.Daily) > 0 || len(plan.Weekly) > 0 || plan.Held != ""
	if !work && !a.opts.dryRun {
		var pending bool
		if pending, err = a.st.hasDeliveryWork(ctx); err != nil {
			return sum, err
		}
		work = pending || wantCanary(a.opts.canary, 0, due)
	}
	if !work {
		log.Printf("alerts: nothing to do: no new report date, no pending email, canary not due exit=0")
		return sum, nil
	}

	// Phase 5 (monitors) and 9: evaluate.
	monitors, err := a.st.loadMonitors(ctx, a.started, a.opts.user)
	if err != nil {
		return sum, err
	}
	cands := Evaluate(monitors, snap, plan)
	sum.monitors, sum.candidates = len(monitors), len(cands)

	// Phase 10: entitlement, once per owner with an email. Every answer must be
	// definitive. A lookup that errors fails the run here, before anything is
	// committed, so no event is ever written as unentitled or waiting on a lookup.
	ents, err := a.entitlements(ctx, cands)
	if err != nil {
		if !a.opts.dryRun {
			return sum, fmt.Errorf("%w: nothing was committed, the next run retries", err)
		}
		log.Printf("alerts: dry run: %v; candidates show entitled=unchecked", err)
		ents = nil
	}

	if a.opts.dryRun {
		a.logCandidates(cands, ents)
		sum.events = len(cands)
		sum.canary = dryCanaryWord(a.opts.canary, due)
		// A dry run always exits 0. A hold it would have reported is logged, not
		// returned: an operator's hand run during a held date is not a failure.
		if reason := degradedReason(plan, deliveryStats{}); reason != "" {
			log.Printf("alerts: dry run: a live run would be degraded: %s", reason)
		}
		log.Printf("alerts: dry run: nothing written, nothing sent; canary would be %s", sum.canary)
		return sum, nil
	}

	// Phase 9b: the detail each event carries. It is stored with the event, so it is
	// decided before any row is, and it never fails the run.
	a.enrich(ctx, cands, snap, companies)

	// Decide every row before the run row exists, so a refusal writes nothing.
	rows, unentitled, noEmail, err := decideRows(cands, ents)
	if err != nil {
		return sum, err
	}
	sum.skippedUnentitled, sum.skippedNoEmail = unentitled, noEmail

	// Phase 8: the run row. Its id and start time make the canary's idempotency key.
	runID, runStarted, err = a.st.insertRun(ctx, a.getenv("CLOUD_RUN_EXECUTION"), planNote(plan, a.opts), dailyDates(plan), weeklyLast(plan))
	if err != nil {
		return sum, err
	}

	// Phase 11: commit the events and the watermarks in one transaction.
	applied, inserted, vanished, err := a.st.commit(ctx, state, plan.Next, replay, runID, rows)
	if err != nil {
		return sum, err
	}
	sum.events, sum.vanished = inserted, vanished
	res = runResult{
		MonitorsEvaluated: len(monitors),
		EventsCreated:     inserted,
		SkippedUnentitled: unentitled,
	}
	if !applied {
		log.Printf("alerts: another run moved the watermarks first; nothing committed")
		res.Outcome, res.Error = "succeeded", "superseded: another run committed first"
		if err = a.st.finishRun(ctx, runID, res); err != nil {
			return sum, err
		}
		return sum, nil
	}
	if vanished > 0 {
		log.Printf("alerts: %d event(s) skipped: their monitor was deleted after the run read it", vanished)
	}

	// Phase 12: delivery.
	client := &resend.Client{APIKey: a.env.resendAPIKey, BaseURL: a.env.resendAPIURL}
	pauseClient := shortsv1alpha1connect.NewAlertsServiceClient(
		&http.Client{Timeout: 10 * time.Second}, a.env.shortsAPIURL)
	dlv, err := deliver(ctx, a.st, client, a.env, deliverOpts{
		canaryMode:  a.opts.canary,
		canaryDue:   due,
		maxSends:    a.opts.maxSends,
		rps:         a.env.rps,
		userID:      a.opts.user,
		runID:       runID,
		runStarted:  runStarted,
		pauseClient: pauseClient,
	})
	sum.sent, sum.retrying, sum.failed, sum.canary = dlv.sent, dlv.retrying, dlv.failed, dlv.canary
	res.EmailsSent, res.EmailsRetrying, res.EmailsFailed, res.CanaryResendID = dlv.sent, dlv.retrying, dlv.failed, dlv.canaryID
	if err != nil {
		return sum, err
	}

	// Phase 13: finish the run row, then prune old runs.
	sum.exit = exitCode(plan, dlv)
	res.Outcome = "succeeded"
	if reason := degradedReason(plan, dlv); reason != "" {
		res.Outcome, res.Error = "degraded", reason
		log.Printf("alerts: degraded: %s", reason)
	}
	if err = a.st.finishRun(ctx, runID, res); err != nil {
		return sum, err
	}
	if perr := a.st.pruneRuns(ctx); perr != nil {
		log.Printf("alerts: could not prune old runs: %v", perr)
	}
	return sum, nil
}

// entitlements asks the shorts API for the entitlement of each owner with a candidate
// and an address. An answer counts only when the lookup succeeds. Any error, whether
// the whole API is unreachable or one owner's answer failed, fails the run, so no
// event is committed as unentitled or waiting because a lookup did not answer. The
// error names the lookup's code, never the owner. Nothing is committed, the
// watermarks stay, and the next run retries.
func (a *alertRun) entitlements(ctx context.Context, cands []Candidate) (map[string]entitlement, error) {
	ents := map[string]entitlement{}
	checker := newEntitlementChecker(a.env.shortsAPIURL, a.env.internalSecret)
	for _, c := range cands {
		uid := c.Monitor.UserID
		if c.Monitor.Email == "" {
			continue
		}
		if _, ok := ents[uid]; ok {
			continue
		}
		e, err := checker.check(ctx, uid)
		if err != nil {
			return nil, fmt.Errorf("entitlement lookup failed (%s)", lookupCode(err))
		}
		ents[uid] = e
	}
	return ents, nil
}

// lookupCode names a lookup failure for the log and the error. It never carries the
// message, which could name an account.
func lookupCode(err error) string {
	if ce, ok := errors.AsType[*connect.Error](err); ok {
		return ce.Code().String()
	}
	return "error"
}

// decideRows turns candidates into the rows a commit inserts. A candidate with no
// address is skipped_no_email. An owner who is not entitled is skipped_unentitled.
// Everything else is pending for delivery. entitlements fails the run before this
// point unless every owner with an address has an answer, so a missing answer is a
// refusal here, not a row that is sent.
func decideRows(cands []Candidate, ents map[string]entitlement) (rows []eventRow, unentitled, noEmail int, err error) {
	for _, c := range cands {
		uid := c.Monitor.UserID
		row := eventRow{
			monitorID: c.Monitor.ID,
			userID:    uid,
			msg:       messageOf(c),
			status:    alertevents.StatusPending,
		}
		if c.Monitor.Email == "" {
			row.status = alertevents.StatusSkippedNoEmail
			noEmail++
		} else {
			e, ok := ents[uid]
			if !ok {
				return nil, 0, 0, errors.New("no entitlement answer for an owner with an address: refusing to decide their alerts")
			}
			if !e.Entitled {
				row.status = alertevents.StatusSkippedUnentitled
				row.lastError = "entitlement: status=" + e.Status
				unentitled++
			}
		}
		rows = append(rows, row)
	}
	return rows, unentitled, noEmail, nil
}

// logCandidates prints a dry run's candidates. Addresses and bodies are never
// printed. The subject carries only a ticker and figures, and the user id appears
// only under -verbose. entitled is "unchecked" when the lookup did not answer.
func (a *alertRun) logCandidates(cands []Candidate, ents map[string]entitlement) {
	for _, c := range cands {
		uid := c.Monitor.UserID
		entitled := "unchecked"
		e, answered := ents[uid]
		switch {
		case c.Monitor.Email == "":
			entitled = "no-email"
		case answered && e.Entitled:
			entitled = "yes"
		case answered:
			entitled = "no"
		}
		line := fmt.Sprintf("alerts: candidate monitor=%s scope=%s condition=%s target=%s report=%s compared=%s latest=%s previous=%s entitled=%s subject=%q",
			c.Monitor.ID, c.Monitor.Scope, c.Monitor.Condition, c.Monitor.Target, c.ReportDate, c.ComparedTo,
			pct(c.Latest), pct(c.Previous), entitled, subjectLine(messageOf(c)))
		if a.opts.verbose {
			line += " user=" + uid
		}
		log.Print(line)
	}
}

// exitCode is 10 when// exitCode is 10 when the run needs a human: a held date, an email that is still
// retrying or has failed, or Resend's quota spent.
func exitCode(plan Plan, dlv deliveryStats) int {
	if degradedReason(plan, dlv) != "" {
		return exitDegraded
	}
	return 0
}

// degradedReason says why a run is DEGRADED, or is "" when it is not.
func degradedReason(plan Plan, dlv deliveryStats) string {
	var parts []string
	if plan.Held != "" {
		if plan.HeldBySync {
			parts = append(parts, fmt.Sprintf("report %s is held: the latest ASIC sync did not complete", plan.Held))
		} else {
			parts = append(parts, fmt.Sprintf("report %s is incomplete, so evaluation stopped before it", plan.Held))
		}
	}
	if dlv.retrying > 0 || dlv.failed > 0 {
		parts = append(parts, fmt.Sprintf("%d email(s) retrying, %d failed", dlv.retrying, dlv.failed))
	}
	if dlv.quota {
		parts = append(parts, "resend sending quota exhausted; remaining emails stay pending")
	}
	return strings.Join(parts, "; ")
}

// planNote is the run row's note: what kind of run this was. The row is the
// operator's record, so it names the owner of a replay.
func planNote(plan Plan, opts options) string {
	return noteOf(plan, opts, true)
}

// logNote is planNote for the summary line, which is logged. It names a replay's owner
// only under -verbose, so the user id of an account never reaches the log by default.
func logNote(plan Plan, opts options) string {
	return noteOf(plan, opts, opts.verbose)
}

func noteOf(plan Plan, opts options, withOwner bool) string {
	var parts []string
	if opts.date != "" {
		owner := "all"
		switch {
		case opts.user == "":
		case withOwner:
			owner = opts.user
		default:
			owner = "one"
		}
		parts = append(parts, fmt.Sprintf("replay %s user=%s", opts.date, owner))
	}
	if plan.Bootstrap {
		parts = append(parts, "bootstrap")
	}
	if plan.DailySkipped > 0 {
		parts = append(parts, fmt.Sprintf("backlog: skipped %d dates", plan.DailySkipped))
	}
	if plan.WeeklySkipped > 0 {
		parts = append(parts, fmt.Sprintf("backlog: skipped %d weeks", plan.WeeklySkipped))
	}
	if plan.Held != "" {
		if plan.HeldBySync {
			parts = append(parts, "held "+string(plan.Held)+" (sync not completed)")
		} else {
			parts = append(parts, "held "+string(plan.Held))
		}
	}
	return strings.Join(parts, "; ")
}

// dailyDates lists the daily dates a plan evaluates.
func dailyDates(plan Plan) []Date {
	out := make([]Date, 0, len(plan.Daily))
	for _, ev := range plan.Daily {
		out = append(out, ev.Date)
	}
	return out
}

// weeklyLast is the last week a plan evaluates, or "".
func weeklyLast(plan Plan) Date {
	if n := len(plan.Weekly); n > 0 {
		return plan.Weekly[n-1].Date
	}
	return ""
}

// dryCanaryWord says what a live run would do about the canary, for the dry-run log.
func dryCanaryWord(mode string, due bool) string {
	if mode == canaryOff {
		return "off"
	}
	if due || mode == canaryAlways {
		return "sent"
	}
	return "not due"
}

func joinDates(ds []Date) string {
	parts := make([]string, 0, len(ds))
	for _, d := range ds {
		parts = append(parts, string(d))
	}
	return strings.Join(parts, ",")
}

func dateLabel(d Date) string {
	if d == "" {
		return "none"
	}
	return string(d)
}
