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
	"os"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
)

// exitDegraded is the runner's code for DEGRADED.
const exitDegraded = 10

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
	sent              int
	retrying          int
	failed            int
	skippedUnentitled int
	skippedNoEmail    int
	canary            string
	exit              int
}

func (s summary) line() string {
	return fmt.Sprintf("alerts: dates=[%s] weekly=%s monitors=%d candidates=%d events=%d sent=%d retrying=%d failed=%d skipped_unentitled=%d skipped_no_email=%d canary=%s exit=%d",
		joinDates(s.dates), dateLabel(s.weekly), s.monitors, s.candidates, s.events, s.sent, s.retrying, s.failed,
		s.skippedUnentitled, s.skippedNoEmail, s.canary, s.exit)
}

// execute runs the phases in order. The run row is opened only once there is work,
// so a no-op run leaves no row. A failure after it is opened is recorded on the row.
func (a *alertRun) execute(ctx context.Context) (sum summary, err error) {
	sum.canary = "skipped"
	var (
		runID int64
		res   runResult
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

	// Phase 10: entitlement, once per owner with an email.
	ents, checked, err := a.entitlements(ctx, cands)
	if err != nil {
		return sum, err
	}

	if a.opts.dryRun {
		a.logCandidates(cands, ents, checked)
		sum.events = len(cands)
		sum.canary = dryCanaryWord(a.opts.canary, due)
		sum.exit = exitCode(plan, deliveryStats{})
		log.Printf("alerts: dry run: nothing written, nothing sent; canary would be %s", sum.canary)
		return sum, nil
	}

	// Phase 8: the run row. Its id is the canary's idempotency key.
	runID, err = a.st.insertRun(ctx, a.getenv("CLOUD_RUN_EXECUTION"), planNote(plan, a.opts), dailyDates(plan), weeklyLast(plan))
	if err != nil {
		return sum, err
	}

	// Phase 11: commit the events and the watermarks in one transaction.
	rows, unentitled, noEmail := decideRows(cands, ents, checked)
	sum.skippedUnentitled, sum.skippedNoEmail = unentitled, noEmail
	applied, inserted, err := a.st.commit(ctx, state, plan.Next, replay, runID, rows)
	if err != nil {
		return sum, err
	}
	sum.events = inserted
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

	// Phase 12: delivery.
	client := &resend.Client{APIKey: a.env.resendAPIKey, BaseURL: a.env.resendAPIURL}
	dlv, err := deliver(ctx, a.st, client, a.env, deliverOpts{
		canaryMode: a.opts.canary,
		canaryDue:  due,
		maxSends:   a.opts.maxSends,
		rps:        a.env.rps,
		userID:     a.opts.user,
		runID:      runID,
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

// entitlements returns the entitlement of each owner with an email, and whether the
// lookup ran at all. A dry run without the API settings, or whose lookup fails,
// reports unchecked and goes on. A live run fails on a lookup error.
func (a *alertRun) entitlements(ctx context.Context, cands []Candidate) (map[string]entitlement, bool, error) {
	if a.env.shortsAPIURL == "" || a.env.internalSecret == "" {
		log.Printf("alerts: entitlement=unchecked (SHORTS_API_URL or INTERNAL_SERVICE_SECRET is unset)")
		return nil, false, nil
	}
	ents := map[string]entitlement{}
	checker := newEntitlementChecker(a.env.shortsAPIURL, a.env.internalSecret)
	for _, c := range cands {
		if c.Monitor.Email == "" {
			continue
		}
		if _, ok := ents[c.Monitor.UserID]; ok {
			continue
		}
		e, err := checker.check(ctx, c.Monitor.UserID)
		if err != nil {
			if a.opts.dryRun {
				log.Printf("alerts: entitlement=unchecked: the shorts API lookup failed")
				return nil, false, nil
			}
			return nil, false, fmt.Errorf("entitlement lookup failed: %w", err)
		}
		ents[c.Monitor.UserID] = e
	}
	return ents, true, nil
}

// decideRows turns candidates into the rows a commit inserts. A candidate with no
// email is skipped_no_email. One whose owner is not entitled is skipped_unentitled.
// Everything else is pending for delivery.
func decideRows(cands []Candidate, ents map[string]entitlement, checked bool) (rows []eventRow, unentitled, noEmail int) {
	for _, c := range cands {
		row := eventRow{
			monitorID: c.Monitor.ID,
			userID:    c.Monitor.UserID,
			msg:       messageOf(c),
			status:    alertevents.StatusPending,
		}
		switch {
		case c.Monitor.Email == "":
			row.status = alertevents.StatusSkippedNoEmail
			noEmail++
		case checked && !ents[c.Monitor.UserID].Entitled:
			row.status = alertevents.StatusSkippedUnentitled
			row.lastError = "entitlement: status=" + ents[c.Monitor.UserID].Status
			unentitled++
		}
		rows = append(rows, row)
	}
	return rows, unentitled, noEmail
}

// logCandidates prints a dry run's candidates. Addresses and bodies are never
// printed. The subject carries only a ticker and figures, and the user id appears
// only under -verbose.
func (a *alertRun) logCandidates(cands []Candidate, ents map[string]entitlement, checked bool) {
	for _, c := range cands {
		entitled := "unchecked"
		switch {
		case c.Monitor.Email == "":
			entitled = "no-email"
		case checked && ents[c.Monitor.UserID].Entitled:
			entitled = "yes"
		case checked:
			entitled = "no"
		}
		line := fmt.Sprintf("alerts: candidate monitor=%s scope=%s condition=%s target=%s report=%s compared=%s latest=%s previous=%s entitled=%s subject=%q",
			c.Monitor.ID, c.Monitor.Scope, c.Monitor.Condition, c.Monitor.Target, c.ReportDate, c.ComparedTo,
			pct(c.Latest), pct(c.Previous), entitled, subjectLine(messageOf(c)))
		if a.opts.verbose {
			line += " user=" + c.Monitor.UserID
		}
		log.Print(line)
	}
}

// exitCode is 10 when the run needs a human: a held date, an email that is still
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
		parts = append(parts, fmt.Sprintf("report %s is incomplete, so evaluation stopped before it", plan.Held))
	}
	if dlv.retrying > 0 || dlv.failed > 0 {
		parts = append(parts, fmt.Sprintf("%d email(s) retrying, %d failed", dlv.retrying, dlv.failed))
	}
	if dlv.quota {
		parts = append(parts, "resend sending quota exhausted; remaining emails stay pending")
	}
	return strings.Join(parts, "; ")
}

// planNote is the run row's note: what kind of run this was.
func planNote(plan Plan, opts options) string {
	var parts []string
	if opts.date != "" {
		owner := "all"
		if opts.user != "" {
			owner = opts.user
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
		parts = append(parts, "held "+string(plan.Held))
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
