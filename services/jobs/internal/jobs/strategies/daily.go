package strategies

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// `shorted strategies -mode daily` snapshots one session of the strategy engine
// and records the canonical versions' transitions. The session is today's (or the
// last trading day's); a session the run finds held, or missed, is backfilled
// oldest first by the next run that can.

const (
	phaseFeatures   = "features"
	phaseEvaluation = "evaluation"
	phaseEvents     = "events"

	// backfillLimit is how many sessions one run processes at most.
	backfillLimit = 10
	// deadlineMinute is the start of the last scheduled run, 16:40 UTC. A session
	// still held then exits 10 once, so the monitor pages once.
	deadlineMinute = 16*60 + 40
	// revalidateWait lets the API's own cache of the strategy reads turn over
	// (15 minutes) before the web tier is asked to revalidate.
	revalidateWait = 16 * time.Minute
	// revalidateTags names the cache tags a daily run changes.
	revalidateTags = "strategy-picks,strategy-versions"
)

// dailyOptions is one run's configuration. Write false is a dry run: the run
// reads, computes and logs, and writes nothing (no lease, no rows, no prune).
type dailyOptions struct {
	Write  bool
	Holder string
	Now    time.Time
	Logf   func(string, ...any)
	Sleep  func(context.Context, time.Duration) error
	Ping   func(platform.RevalidateRequest)
}

// heldSession is a session the run could not snapshot yet.
type heldSession struct {
	Date   civil.Date
	Reason string
}

// dailyResult is what one run did.
type dailyResult struct {
	D           civil.Date
	Done        []civil.Date
	Held        *heldSession
	AlreadyDone bool
	Skipped     bool // another execution holds the lease
	// PastDeadline is true when a session is still held and the run started at or
	// after 16:40 UTC, the last scheduled run: the monitor should page.
	PastDeadline bool
	Events       int
}

// runDaily runs the daily job once. Errors are returned for the job to classify;
// a held session is a normal outcome, not an error.
func runDaily(ctx context.Context, pool *pgxpool.Pool, opts dailyOptions) (dailyResult, error) {
	logf := opts.Logf
	today := civil.DateOf(opts.Now.UTC())
	d := sessionFor(today)
	res := dailyResult{D: d}
	st := store{pool: pool}

	if opts.Write {
		proceed, absent, current, err := st.claimLease(ctx, opts.Holder)
		if err != nil {
			return res, err
		}
		if !proceed {
			logf("strategies: daily lease held by %s; exiting without work", current)
			res.Skipped = true
			return res, nil
		}
		if absent {
			logf("strategies: picks_run_lease does not exist (migration 000132 not applied); running without the lease")
		} else {
			defer st.releaseLease(opts.Holder, logf)
		}
	}

	done, err := st.completedPhases(ctx, d)
	if err != nil {
		return res, err
	}
	if allPhasesDone(done) {
		res.AlreadyDone = true
		logf("strategies: session %s already completed", d)
		return res, nil
	}

	last, err := st.completedSessions(ctx, d, true, 1)
	if err != nil {
		return res, err
	}
	var lastDone *civil.Date
	if len(last) > 0 {
		lastDone = &last[0]
	}
	sessions := sessionsToProcess(lastDone, d, backfillLimit)
	logf("strategies: session %s; processing %d session(s): %v", d, len(sessions), sessions)

	for _, s := range sessions {
		held, err := runSession(ctx, pool, st, s, isLate(s, opts.Now), opts, &res)
		if err != nil {
			return res, err
		}
		if held != nil {
			res.Held = held
			break
		}
		res.Done = append(res.Done, s)
	}

	res.PastDeadline = pastDeadline(res.Held, opts.Now)
	if opts.Write && len(res.Done) > 0 {
		if err := revalidateAfter(ctx, opts, logf); err != nil {
			logf("strategies: revalidation skipped (%v); pages self-heal on their ISR TTL", err)
		}
		if err := pruneAfter(ctx, pool, st, d, logf); err != nil {
			return res, err
		}
	}
	return res, nil
}

// isLate reports whether a session is snapshotted after its own day: a session a
// later run takes, including one whose run falls on a weekend or an ASX holiday.
// A same-day run is current.
func isLate(s civil.Date, now time.Time) bool {
	return s.Before(civil.DateOf(now.UTC()))
}

// allPhasesDone reports whether every phase of a session completed.
func allPhasesDone(done map[string]bool) bool {
	for _, p := range phaseNames {
		if !done[p] {
			return false
		}
	}
	return true
}

// sessionsToProcess is the sessions the run works on, oldest first: the trading
// days after the last complete session, up to d, at most limit of them. With no
// complete session yet, that is d alone.
func sessionsToProcess(lastDone *civil.Date, d civil.Date, limit int) []civil.Date {
	if lastDone == nil {
		return []civil.Date{d}
	}
	var out []civil.Date
	for s := nextTradingDay(*lastDone); !s.After(d) && len(out) < limit; s = nextTradingDay(s) {
		out = append(out, s)
	}
	return out
}

// pastDeadline reports whether a run that starts at now, and finds a session
// held, is at or past the last scheduled run's deadline. Any held session counts:
// an older one blocks every later session, so it is the day's page too.
func pastDeadline(held *heldSession, now time.Time) bool {
	return held != nil && minuteOfDay(now) >= deadlineMinute
}

// minuteOfDay is the UTC minute of the day of t.
func minuteOfDay(t time.Time) int {
	u := t.UTC()
	return u.Hour()*60 + u.Minute()
}

// runSession snapshots, evaluates and diffs one session. A phase its run log
// records as completed is not written again: a completed features phase is read
// back from the store, never recomputed from inputs that may have changed since.
// It returns the held session when readiness fails, which ends the run.
func runSession(ctx context.Context, pool *pgxpool.Pool, st store, s civil.Date, late bool, opts dailyOptions, res *dailyResult) (*heldSession, error) {
	logf := opts.Logf
	done, err := st.completedPhases(ctx, s)
	if err != nil {
		return nil, err
	}

	// Features. The stored rows of a completed phase stand in for the computation,
	// unless they are incomplete (no regime), when the session is recomputed.
	var out sessionRows
	stored := false
	if done[phaseFeatures] {
		out, stored, err = readStoredFeatures(ctx, pool, s)
		if err != nil {
			return nil, err
		}
		if stored {
			logf("strategies: session %s features already completed; evaluating the stored rows", s)
		} else {
			logf("strategies: session %s features are completed but incomplete in the store; recomputing", s)
		}
	}
	if !stored {
		facts, err := readinessDB(ctx, pool, s)
		if err != nil {
			return nil, err
		}
		if ok, reason := evaluateReadiness(s, facts); !ok {
			logf("strategies: session %s held: %s", s, reason)
			if opts.Write {
				prior, err := st.holdHistory(ctx, s)
				if err != nil {
					return nil, err
				}
				heldCounts, err := counts(map[string]any{"holds": prior.Holds + 1, "last_hold_reason": reason})
				if err != nil {
					return nil, err
				}
				if err := st.writeRun(ctx, pool, runRow{AsOf: s, Phase: phaseFeatures, Status: "held", EngineVersion: engine.Version, Note: reason, Counts: heldCounts}); err != nil {
					return nil, err
				}
			}
			return &heldSession{Date: s, Reason: reason}, nil
		}

		fs, err := featureParams()
		if err != nil {
			return nil, err
		}
		in, err := loadSessionInputs(ctx, pool, s)
		if err != nil {
			return nil, fmt.Errorf("load session %s: %w", s, err)
		}
		out = buildSessionRows(in, fs)
		// The holds the session took before it completed stay in its counts: the
		// completed row replaces the held one, which is the only place they are kept.
		prior, err := st.holdHistory(ctx, s)
		if err != nil {
			return nil, err
		}
		featCounts, err := counts(map[string]any{
			"codes": len(out.Rows), "priced": out.Priced, "blobs": len(out.Blobs), "late": late, "xjo_bar": out.XJOBar,
			"holds": prior.Holds, "last_hold_reason": prior.LastReason,
		})
		if err != nil {
			return nil, err
		}
		logf("strategies: session %s features: %d code(s), %d priced, late=%t", s, len(out.Rows), out.Priced, late)
		if opts.Write {
			if err := writeFeatures(ctx, pool, st, s, out, featCounts); err != nil {
				return nil, err
			}
		}
	}

	// Evaluation: the versions are recorded and the recipes registered, then every
	// live canonical version is evaluated on the session's rows. The baseline is
	// read before the write, so a retry does not count the version it just made live.
	versions, err := registeredVersions(spec.Registry())
	if err != nil {
		return nil, err
	}
	live := liveOnly(versions)
	rulesHashes := hashesOf(live)
	before, err := st.liveVersions(ctx)
	if err != nil {
		return nil, err
	}
	baseline := newlyLive(versions, before, s)
	evals := map[string]versionEval{}
	evalCounts := map[string]any{}
	picks := map[string]any{}
	for _, v := range live {
		ev, err := evaluateVersion(out.Rows, out.Blobs, out.Regime, v)
		if err != nil {
			return nil, err
		}
		h, err := spec.RulesHash(v.Spec)
		if err != nil {
			return nil, err
		}
		evals[h] = ev
		// Keyed by strategy and label: each strategy's v0 is a different version.
		key := v.Spec.StrategyID + "/" + v.Label
		evalCounts[key] = ev.Eligible
		picks[key] = len(ev.Picks)
		logf("strategies: session %s evaluation %s (%s): %d eligible, %d pick(s)", s, v.Label, v.Spec.StrategyID, ev.Eligible, len(ev.Picks))
	}
	evalRunCounts, err := counts(map[string]any{"eligible": evalCounts, "picks": picks})
	if err != nil {
		return nil, err
	}
	if opts.Write && !done[phaseEvaluation] {
		if err := writeEvaluation(ctx, pool, st, s, versions, rulesHashes, evalRunCounts); err != nil {
			return nil, err
		}
	}

	// Events: the diff against the previous complete session, recomputed from its
	// stored rows. A version's first session is a baseline with no events.
	if done[phaseEvents] {
		logf("strategies: session %s events already completed", s)
		return nil, nil
	}
	prev, err := st.completedSessions(ctx, s, false, 1)
	if err != nil {
		return nil, err
	}
	events, err := diffSession(ctx, pool, s, prev, live, evals, baseline, logf)
	if err != nil {
		return nil, err
	}
	res.Events += len(events)
	eventCounts, err := counts(map[string]any{"events": len(events)})
	if err != nil {
		return nil, err
	}
	if opts.Write {
		if err := writeEvents(ctx, pool, st, s, rulesHashes, events, eventCounts); err != nil {
			return nil, err
		}
	}
	logf("strategies: session %s complete (%d event(s))", s, len(events))
	return nil, nil
}

// readStoredFeatures reads back a session's features phase: its feature rows,
// the fundamentals blobs they point at and the regime. ok is false when the
// session has no stored regime, which means the phase is not whole.
func readStoredFeatures(ctx context.Context, pool *pgxpool.Pool, s civil.Date) (sessionRows, bool, error) {
	rows, err := pgsource.ReadFeatureRows(ctx, pool, s, snapshotFeatureSet)
	if err != nil {
		return sessionRows{}, false, err
	}
	hashes := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.FundamentalsHash != "" {
			hashes = append(hashes, r.FundamentalsHash)
		}
	}
	blobs, err := pgsource.ReadFundamentalsBlobs(ctx, pool, hashes)
	if err != nil {
		return sessionRows{}, false, err
	}
	regime, ok, err := pgsource.ReadRegime(ctx, pool, s, engine.DefaultIndexCode)
	if err != nil {
		return sessionRows{}, false, err
	}
	return sessionRows{Rows: rows, Blobs: blobs, Regime: regime}, ok, nil
}

// liveOnly is the registered versions the engine evaluates now.
func liveOnly(versions []versionRow) []spec.Registered {
	var out []spec.Registered
	for _, v := range versions {
		if v.Reg.Live {
			out = append(out, v.Reg)
		}
	}
	return out
}

// hashesOf is the rules hash of each registered version, in order.
func hashesOf(regs []spec.Registered) []string {
	out := make([]string, 0, len(regs))
	for _, r := range regs {
		h, err := spec.RulesHash(r.Spec)
		if err != nil {
			continue
		}
		out = append(out, h)
	}
	return out
}

// counts marshals a run's counts object.
func counts(m map[string]any) (string, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("encode run counts: %w", err)
	}
	return string(raw), nil
}

// writeFeatures writes the features phase in one transaction under no statement
// timeout and a 15 s lock timeout, and records it complete with the same commit.
func writeFeatures(ctx context.Context, pool *pgxpool.Pool, st store, s civil.Date, out sessionRows, featCounts string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin features transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = 0`); err != nil {
		return fmt.Errorf("lift statement timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '15s'`); err != nil {
		return fmt.Errorf("set lock timeout: %w", err)
	}
	if err := pgsource.WriteFundamentalsBlobs(ctx, tx, out.Blobs, s); err != nil {
		return err
	}
	if err := pgsource.WriteFeatureRows(ctx, tx, out.Rows); err != nil {
		return err
	}
	if err := pgsource.WriteRegime(ctx, tx, s, engine.DefaultIndexCode, out.Regime); err != nil {
		return err
	}
	row := runRow{
		AsOf: s, Phase: phaseFeatures, Status: "completed", EngineVersion: engine.Version,
		Report: out.Report, Avail: out.Avail, XJO: xjoDate(out, s), Counts: featCounts,
	}
	if err := st.writeRun(ctx, tx, row); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit features for %s: %w", s, err)
	}
	return nil
}

// xjoDate is the session's date when the index has a bar on it, else zero.
func xjoDate(out sessionRows, s civil.Date) civil.Date {
	if out.XJOBar {
		return s
	}
	return civil.Date{}
}

// writeEvaluation records the versions and recipes, then the evaluation phase.
func writeEvaluation(ctx context.Context, pool *pgxpool.Pool, st store, s civil.Date, versions []versionRow, hashes []string, evalCounts string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin evaluation transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := st.upsertVersions(ctx, tx, s, versions); err != nil {
		return err
	}
	if err := upsertRecipes(ctx, tx, spec.R1Recipes()); err != nil {
		return err
	}
	if err := st.writeRun(ctx, tx, runRow{
		AsOf: s, Phase: phaseEvaluation, Status: "completed", EngineVersion: engine.Version,
		RulesHashes: hashes, Counts: evalCounts,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit evaluation for %s: %w", s, err)
	}
	return nil
}

// diffSession evaluates the previous complete session from its stored rows and
// returns the transitions of every live version against it. With no previous
// session, or for a version that is new on this session, there are no events.
func diffSession(ctx context.Context, pool *pgxpool.Pool, s civil.Date, prev []civil.Date, live []spec.Registered, evals map[string]versionEval, baseline map[string]bool, logf func(string, ...any)) ([]eventRow, error) {
	if len(prev) == 0 {
		logf("strategies: session %s is a baseline: no previous session to diff against", s)
		return nil, nil
	}
	p := prev[0]
	prevRows, err := pgsource.ReadFeatureRows(ctx, pool, p, snapshotFeatureSet)
	if err != nil {
		return nil, err
	}
	if len(prevRows) == 0 {
		// A complete session always has feature rows (readiness rule (c) holds a session
		// with no priced codes). A regime with no rows is a pruned or hand-edited session:
		// diffing against it would record every current pick as none -> its status.
		logf("strategies: session %s: no feature rows stored for %s; no events this session", s, p)
		return nil, nil
	}
	hashes := make([]string, 0, len(prevRows))
	for _, r := range prevRows {
		if r.FundamentalsHash != "" {
			hashes = append(hashes, r.FundamentalsHash)
		}
	}
	prevBlobs, err := pgsource.ReadFundamentalsBlobs(ctx, pool, hashes)
	if err != nil {
		return nil, err
	}
	prevRegime, ok, err := pgsource.ReadRegime(ctx, pool, p, engine.DefaultIndexCode)
	if err != nil {
		return nil, err
	}
	if !ok {
		logf("strategies: session %s: no regime stored for %s; no events this session", s, p)
		return nil, nil
	}

	var out []eventRow
	for _, v := range live {
		h, err := spec.RulesHash(v.Spec)
		if err != nil {
			return nil, err
		}
		if baseline[h] {
			logf("strategies: %s %s: first live session, baseline with no events", v.Spec.StrategyID, v.Label)
			continue
		}
		prevEval, err := evaluateVersion(prevRows, prevBlobs, prevRegime, v)
		if err != nil {
			return nil, err
		}
		for _, t := range diffEvaluations(prevEval.Picks, evals[h].Picks, false) {
			evidence, err := evidenceJSON(t)
			if err != nil {
				return nil, err
			}
			out = append(out, eventRow{
				RulesHash: h, EngineVersion: engine.Version, StrategyID: v.Spec.StrategyID,
				Code: t.Code, AsOf: s, PrevAsOf: p, From: t.From, To: t.To,
				Score: scoreOrNil(t), Evidence: evidence,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].StrategyID != out[j].StrategyID {
			return out[i].StrategyID < out[j].StrategyID
		}
		return out[i].Code < out[j].Code
	})
	return out, nil
}

// scoreOrNil is a transition's score when the stock is still a pick, else NULL.
func scoreOrNil(t transition) *float64 {
	if t.To == noneStatus {
		return nil
	}
	v := t.Score
	return &v
}

// eventEvidence is a signal event's stored explanation, in the compact shape the
// signal history reads. R holds one character per rule, in the rules version's
// rule order: P pass, F fail, U unknown. The rule ids are not stored: the
// event's rules_hash pins the version, and with it the rule list and order. V
// and P are each rule's value and proximity in the same order (null where the
// rule has none). Then the close and pivot, the short report with its
// availability, and the regime. An exit has no pick: R is "", V and P are [].
type eventEvidence struct {
	R              string     `json:"r"`
	V              []*float64 `json:"v"`
	P              []*float64 `json:"p"`
	Close          *float64   `json:"close"`
	Pivot          *float64   `json:"pivot"`
	ShortReport    *string    `json:"short_report"`
	ShortAvailable *string    `json:"short_available"`
	Regime         *string    `json:"regime"`
}

// ruleStatusChar is one rule's character in a signal event's r. Any other status
// is a programming error, so it is an error rather than a wrong character.
func ruleStatusChar(r engine.RuleResult) (byte, error) {
	switch r.Status {
	case engine.RulePass:
		return 'P', nil
	case engine.RuleFail:
		return 'F', nil
	case engine.RuleUnknown:
		return 'U', nil
	}
	return 0, fmt.Errorf("strategies: rule %s has status %q; want pass, fail or unknown", r.RuleID, r.Status)
}

// evidenceJSON is a transition's stored evidence. An exit has no pick, so its
// rules, close and short report are empty.
func evidenceJSON(t transition) (string, error) {
	e := eventEvidence{V: []*float64{}, P: []*float64{}, Pivot: t.Rules.Pivot}
	if t.To != noneStatus {
		c := t.Rules.Close
		e.Close = &c
		e.ShortReport = dateString(t.Rules.ShortReport)
		e.ShortAvailable = dateString(t.Rules.ShortAvailable)
		if t.Rules.Regime != "" {
			r := t.Rules.Regime
			e.Regime = &r
		}
		var chars []byte
		for _, rule := range t.Rules.Rules {
			ch, err := ruleStatusChar(rule)
			if err != nil {
				return "", err
			}
			chars = append(chars, ch)
			e.V = append(e.V, optionalFloat(rule.HasValue, rule.Value))
			e.P = append(e.P, optionalFloat(rule.HasProximity, rule.Proximity))
		}
		e.R = string(chars)
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// optionalFloat is v when present, else nil.
func optionalFloat(present bool, v float64) *float64 {
	if !present {
		return nil
	}
	return &v
}

// dateString is a civil date as YYYY-MM-DD, or nil when there is none.
func dateString(d *civil.Date) *string {
	if d == nil {
		return nil
	}
	s := d.String()
	return &s
}

// writeEvents inserts the events and records the events phase complete.
func writeEvents(ctx context.Context, pool *pgxpool.Pool, st store, s civil.Date, hashes []string, events []eventRow, evCounts string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin events transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := insertEvents(ctx, tx, events); err != nil {
		return err
	}
	if err := st.writeRun(ctx, tx, runRow{
		AsOf: s, Phase: phaseEvents, Status: "completed", EngineVersion: engine.Version,
		RulesHashes: hashes, Counts: evCounts,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit events for %s: %w", s, err)
	}
	return nil
}

// loadSessionInputs reads everything one session needs, as of the session: the
// bars up to it (point-in-time by construction), the ASIC rows and ingests of two
// years, the ETP set, names, metadata, dividends and the fundamentals.
func loadSessionInputs(ctx context.Context, pool *pgxpool.Pool, d civil.Date) (sessionInputs, error) {
	from := d.AddDays(-barLookbackDays)
	codes, err := pgsource.BarCodes(ctx, pool, from, d)
	if err != nil {
		return sessionInputs{}, err
	}
	sort.Strings(codes)
	xjo, err := pgsource.IndexBars(ctx, pool, engine.DefaultIndexCode, from, d)
	if err != nil {
		return sessionInputs{}, err
	}
	bars := make(map[string][]features.Bar, len(codes))
	for _, code := range codes {
		b, err := pgsource.Bars(ctx, pool, code, from, d)
		if err != nil {
			return sessionInputs{}, err
		}
		bars[code] = b
	}
	asicFrom := d.AddDays(-asicWindowDays)
	asic, err := pgsource.ASICRows(ctx, pool, asicFrom, d)
	if err != nil {
		return sessionInputs{}, err
	}
	ingests, err := pgsource.ReportIngests(ctx, pool, asicFrom, d)
	if err != nil {
		return sessionInputs{}, err
	}
	history, err := asicHistoryFor(ctx, pool, codes, d, asic, ingests, xjo)
	if err != nil {
		return sessionInputs{}, err
	}
	etp, err := pgsource.ETPSet(ctx, pool)
	if err != nil {
		return sessionInputs{}, err
	}
	names, err := pgsource.CompanyNames(ctx, pool)
	if err != nil {
		return sessionInputs{}, err
	}
	meta, err := pgsource.Metadata(ctx, pool)
	if err != nil {
		return sessionInputs{}, err
	}
	divs, err := pgsource.Dividends(ctx, pool, pgsource.DividendsFrom)
	if err != nil {
		return sessionInputs{}, err
	}
	fund, err := pgsource.Fundamentals(ctx, pool)
	if err != nil {
		return sessionInputs{}, err
	}
	return sessionInputs{
		D: d, Codes: codes, Bars: bars, XJO: xjo, ASIC: asic, Ingests: ingests,
		ETP: etp, Names: names, Meta: meta, Dividends: divs, Fund: fund,
		ASICHistory: history,
	}, nil
}

// asicHistoryFor reads the whole short history of each code the two-year window
// does not answer for sf0. The reading walks back from the session, so a code
// whose newest qualifying row is older than the window needs every row it has.
// The codes are read in chunks, so the whole history is never held at once.
func asicHistoryFor(ctx context.Context, pool *pgxpool.Pool, codes []string, d civil.Date, asic []features.ASICRow, ingests []features.ReportIngest, xjo []features.IndexBar) ([]features.ASICRow, error) {
	cal := sessionCalendar(sessionInputs{XJO: xjo, ASIC: asic})
	reports := features.NewReports(asic, ingests)
	var older []string
	for _, code := range codes {
		if features.ShortReadingV0(code, d, cal, reports, nil).Status == features.StatusNone {
			older = append(older, code)
		}
	}
	var out []features.ASICRow
	for start := 0; start < len(older); start += historyChunkCodes {
		chunk := older[start:min(start+historyChunkCodes, len(older))]
		rows, err := pgsource.ASICRowsForCodes(ctx, pool, chunk, d)
		if err != nil {
			return nil, fmt.Errorf("read the short history of %d code(s): %w", len(chunk), err)
		}
		out = append(out, rows...)
	}
	return out, nil
}

// revalidateAfter waits for the API's cache to turn over, then asks the web tier
// to revalidate the strategy tags. It is best effort, like the picks job's ping.
func revalidateAfter(ctx context.Context, opts dailyOptions, logf func(string, ...any)) error {
	if opts.Ping == nil {
		return nil
	}
	logf("strategies: waiting %s for the API's strategy cache to turn over before revalidating %s", revalidateWait, revalidateTags)
	if opts.Sleep != nil {
		if err := opts.Sleep(ctx, revalidateWait); err != nil {
			return err
		}
	}
	opts.Ping(platform.RevalidateRequest{Reason: "strategies", Tag: revalidateTags})
	return nil
}

// pruneAfter applies the retention rules after a run that wrote sessions.
func pruneAfter(ctx context.Context, pool *pgxpool.Pool, st store, d civil.Date, logf func(string, ...any)) error {
	completed, err := st.completedSessions(ctx, d, true, keepSessions)
	if err != nil {
		return err
	}
	live, err := st.liveVersions(ctx)
	if err != nil {
		return err
	}
	liveFrom := map[string]civil.Date{}
	labels := map[string]string{}
	for h, v := range live {
		liveFrom[h] = v.LiveFrom
		labels[h] = v.Label
	}
	return pruneRun(ctx, pool, pruneCutoff(completed, paperGuardSessions(liveFrom, labels)), logf)
}
