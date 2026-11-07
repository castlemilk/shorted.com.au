package strategies

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The paper track (5.13): the only out-of-sample record. For each canonical
// version with a registered recipe that the database records as live, and each
// superseded one until it stopped, the paper track steps backtest.Step through
// the complete sessions of the snapshot. It reads the stored snapshot rows of
// each session and the one before, never stock_prices, so a price re-sync after
// a session cannot change its record.
//
// The paper phase is not part of a session's completion (session completeness is
// the three snapshot phases). It runs after the snapshot work of a run, as one
// catch-up over every track: each track's failure is its own, its error is
// returned at the end of the run, and the snapshot work of the run is already
// committed. Its record is its own tables (strategy_paper_*), never
// strategy_daily_runs.
//
// The rows are append-only: an equity row is inserted once and never updated, a
// trade moves forward only (pending_entry -> open -> pending_exit -> closed, or
// pending_entry -> cancelled; its flags may grow), and the checkpoint is replaced
// by the next session's.
//
// Engine versions: a track continues across engine bumps. Every equity row and
// checkpoint records the engine that computed it (engine_version).
//
// How a track ends: a superseded version is stepped through the sessions before
// its superseded_on and then stopped (checkpoint.stopped_on). Its open and
// pending trades keep their last recorded status: no exit is fabricated. A later
// re-promotion of a stopped version does not resume its track; the job logs that
// once and writes nothing for it.

// caBlockSessionsPaper is the batch's corporate-action block in sessions: a
// suspect known more than this long before a track's seed session is dropped.
const caBlockSessionsPaper = 60

// paperVersion is a canonical version and recipe the paper track records.
type paperVersion struct {
	Target       backtestTarget
	Status       string     // "live" or "superseded"
	LiveFrom     civil.Date // the version's first live session (kept across re-promotion)
	SupersededOn civil.Date // zero while live
}

// once is the set of log lines a catch-up has printed. It is created per run, so
// a line prints once per run (not once per process, which would make a test's
// assertions depend on the order of the tests) and a test starts with none.
type once struct {
	mu   sync.Mutex
	seen map[string]bool
}

func newOnce() *once { return &once{seen: map[string]bool{}} }

// logOnce prints a line the first time its key is seen in this run.
func (o *once) logOnce(key string, logf func(string, ...any), format string, args ...any) {
	o.mu.Lock()
	first := !o.seen[key]
	o.seen[key] = true
	o.mu.Unlock()
	if first {
		logf(format, args...)
	}
}

// paperVersions lists the versions the paper track records: each canonical
// version the database records as live or superseded that has a registered
// recipe. A version the registry no longer names, or that has no recipe, is
// skipped with a log line.
func paperVersions(ctx context.Context, st store, logf func(string, ...any), o *once) ([]paperVersion, error) {
	rows, err := st.pool.Query(ctx, `
		SELECT rules_hash, status, live_from, superseded_on FROM strategy_rule_versions
		 WHERE kind = 'canonical' AND status IN ('live','superseded') AND live_from IS NOT NULL
		 ORDER BY strategy_id, label`)
	if err != nil {
		if isUndefinedTable(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read the versions the paper track records: %w", err)
	}
	defer rows.Close()
	var out []paperVersion
	for rows.Next() {
		var (
			hash, status string
			liveFrom     time.Time
			supersededOn *time.Time
		)
		if err := rows.Scan(&hash, &status, &liveFrom, &supersededOn); err != nil {
			return nil, fmt.Errorf("scan a version the paper track records: %w", err)
		}
		reg, ok := spec.ByHash(hash)
		if !ok || reg.Recipe == nil {
			// The version is a database row this build does not register (a v0 row
			// has no recipe). It is named once per run, at debug level: it is not a
			// fault, and it would otherwise print for every version on every run.
			o.logOnce("paper-skip-"+hash, logf, "strategies: paper track: version %s has no registered recipe in this build; not recorded (once per run)", hash[:12])
			continue
		}
		rh, err := spec.RecipeHash(*reg.Recipe)
		if err != nil {
			return nil, fmt.Errorf("hash recipe %s: %w", reg.Recipe.ID, err)
		}
		v := paperVersion{
			Target: backtestTarget{Reg: reg, RulesHash: hash, Recipe: *reg.Recipe, RecipeHash: rh},
			Status: status, LiveFrom: civil.DateOf(liveFrom),
		}
		if supersededOn != nil {
			v.SupersededOn = civil.DateOf(*supersededOn)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// paperConfig is the simulator's configuration for a recipe under a version: the
// recipe's sizing, costs and exits, the version's first four-decimal session.
// LastLoaded stays empty. The paper track cannot see future bars, so it cannot
// tell a stale exit's code will trade again: every stale exit is labelled
// delisted_exit (the spec's rule for a stale exit that cannot be known to be a
// suspension), never suspended_exit.
func paperConfig(t backtestTarget) (backtest.Config, error) {
	if err := t.Recipe.Validate(); err != nil {
		return backtest.Config{}, fmt.Errorf("recipe %s: %w", t.Recipe.ID, err)
	}
	price4dp, err := civil.ParseDate(t.Reg.Spec.Data.Price4dpFrom)
	if err != nil || price4dp.IsZero() {
		return backtest.Config{}, fmt.Errorf("version %s has no price_4dp_from", t.Reg.Label)
	}
	cfg := backtest.ConfigOf(t.Recipe)
	cfg.Price4dpFrom = price4dp
	return cfg, nil
}

// paperSnapshot is one stored session's inputs to the paper track.
type paperSnapshot struct {
	Rows   []snapshot.Row
	Blobs  map[string]features.Fundamentals
	Regime engine.Regime
}

// readPaperSnapshot reads one session's feature rows, the fundamentals blobs
// they point at and the regime. ok is false when the session has no rows.
// paperSnapshotReadHook counts the full-snapshot reads, for the wait's test. It is
// nil outside tests.
var paperSnapshotReadHook func()

func readPaperSnapshot(ctx context.Context, pool *pgxpool.Pool, d civil.Date) (paperSnapshot, bool, error) {
	if paperSnapshotReadHook != nil {
		paperSnapshotReadHook()
	}
	rows, err := pgsource.ReadFeatureRows(ctx, pool, d, snapshotFeatureSet)
	if err != nil {
		return paperSnapshot{}, false, fmt.Errorf("read feature rows of %s: %w", d, err)
	}
	if len(rows) == 0 {
		return paperSnapshot{}, false, nil
	}
	hashes := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.FundamentalsHash != "" {
			hashes = append(hashes, r.FundamentalsHash)
		}
	}
	blobs, err := pgsource.ReadFundamentalsBlobs(ctx, pool, hashes)
	if err != nil {
		return paperSnapshot{}, false, fmt.Errorf("read fundamentals of %s: %w", d, err)
	}
	regime, ok, err := pgsource.ReadRegime(ctx, pool, d, engine.DefaultIndexCode)
	if err != nil {
		return paperSnapshot{}, false, fmt.Errorf("read regime of %s: %w", d, err)
	}
	if !ok {
		return paperSnapshot{}, false, fmt.Errorf("session %s has feature rows but no regime; the features phase is incomplete", d)
	}
	return paperSnapshot{Rows: rows, Blobs: blobs, Regime: regime}, true, nil
}

// caForSession is one code's corporate-action suspect as the batch's caBySession
// gives it for the simulator's session s. A suspect becomes known on KnownAt; on
// a track's seed session (the first session the simulator steps) a suspect known
// earlier is admitted with its age in sessions, and dropped when older than the
// block. Otherwise the suspects known since the previous session are new on s,
// and the earliest of them sets the bar the position exclusion reads.
func caForSession(known []snapshot.CAKnown, s, prev civil.Date, seed bool) backtest.CASuspect {
	var best *backtest.CASuspect
	for _, k := range known {
		var cand backtest.CASuspect
		switch {
		case seed && k.KnownAt.After(s):
			continue
		case seed && k.KnownAt.Before(s):
			age := sessionsBetweenPaper(k.KnownAt, s)
			if age > caBlockSessionsPaper {
				continue
			}
			cand = backtest.CASuspect{Known: true, SuspectDate: k.Date, Age: age}
		case seed: // known on the seed session itself
			cand = backtest.CASuspect{Known: true, SuspectDate: k.Date}
		case k.KnownAt.After(s) || !k.KnownAt.After(prev):
			continue
		default:
			cand = backtest.CASuspect{Known: true, SuspectDate: k.Date}
		}
		if best == nil || cand.Age < best.Age || (cand.Age == best.Age && cand.SuspectDate.Before(best.SuspectDate)) {
			c := cand
			best = &c
		}
	}
	if best == nil {
		return backtest.CASuspect{}
	}
	return *best
}

// sessionsBetweenPaper counts the ASX sessions s with from <= s < to.
func sessionsBetweenPaper(from, to civil.Date) int {
	n := 0
	for d := from; d.Before(to); d = d.AddDays(1) {
		if isTradingDay(d) {
			n++
		}
	}
	return n
}

// paperSessionOf builds the simulator's session for one stored session. Each
// code's status and score come from the version's evaluation of the session's
// eligible rows, as the evaluation phase makes them. A code's bar is set only when
// the row's bar is dated on the session AND priced: a NULL close is stored as zero,
// and the batch's barOn reads the session as having no bar. holdings are the codes
// the simulator holds, so a held code with no row still gets a session entry for
// its stale-exit rule.
func paperSessionOf(rows []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime,
	reg spec.Registered, s, prev civil.Date, index int, seed bool, rate, benchmark float64, holdings []string) (backtest.Session, error) {
	strategy, ok := engine.Lookup(reg.Spec.StrategyID)
	if !ok {
		return backtest.Session{}, fmt.Errorf("no engine strategy for %s", reg.Spec.StrategyID)
	}
	strategy.UnknownStatus = reg.Spec.Ladder.UnknownStatus

	sorted := append([]snapshot.Row(nil), rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].StockCode < sorted[j].StockCode })

	feats := map[string]engine.Candidate{}
	var eligible []engine.Candidate
	var eligibleCodes []string
	isEligible := map[string]bool{}
	for _, r := range sorted {
		ok, _ := snapshot.Eligible(r, reg.Spec)
		c, err := snapshot.ToCandidate(r, reg.Spec, blobs[r.FundamentalsHash])
		if err != nil {
			if ok {
				return backtest.Session{}, fmt.Errorf("candidate %s: %w", r.StockCode, err)
			}
			continue
		}
		feats[r.StockCode] = c
		if ok {
			isEligible[r.StockCode] = true
			eligible = append(eligible, c)
			eligibleCodes = append(eligibleCodes, r.StockCode)
		}
	}
	engine.PrepareCandidates(eligible)
	for i, code := range eligibleCodes {
		feats[code] = eligible[i]
	}
	env := engine.NewEnvFromStats(regime, engine.UniverseStatsOf(eligible))

	byCode := map[string]backtest.CodeSession{}
	for _, r := range sorted {
		cs := backtest.CodeSession{Code: r.StockCode, Status: string(engine.StatusNone)}
		if c, has := feats[r.StockCode]; has {
			cs.Pivot = optFloat(c.BaseHigh)
			cs.DV20 = optFloat(c.DollarVolume20d)
			cs.SMA50 = optFloat(c.SMA50)
			cs.SMA200 = optFloat(c.SMA200)
			if c.BreakoutDate != nil {
				cs.BreakoutDate = civil.DateOf(*c.BreakoutDate)
			}
		}
		if isEligible[r.StockCode] {
			if pick, isPick := engine.EvaluateOne(strategy, feats[r.StockCode], env); isPick {
				cs.Status = string(pick.Status)
				cs.Score = pick.Score
			}
		}
		if r.BarDate == s && features.Priced(r.Features.Bar.C) {
			b := r.Features.Bar
			cs.Bar = &features.Bar{Date: s, Open: b.O, High: b.H, Low: b.L, Close: b.C, AdjClose: b.Adj, Volume: b.V}
		}
		cs.Dividend = r.Features.ExDiv
		// The batch computes corporate-action suspects only for a version whose
		// universe has the CA guard or whose short source is the latest complete
		// published report (pipeline.Index); the features phase stores them for
		// every version. The paper track follows the batch's policy, so a version
		// without the guard sees no suspect.
		if usesCASuspects(reg.Spec) {
			cs.CA = caForSession(r.Features.CASuspects, s, prev, seed)
		}
		byCode[r.StockCode] = cs
	}
	for _, code := range holdings {
		if _, has := byCode[code]; !has {
			byCode[code] = backtest.CodeSession{Code: code, Status: string(engine.StatusNone)}
		}
	}
	codes := make([]backtest.CodeSession, 0, len(byCode))
	for _, cs := range byCode {
		codes = append(codes, cs)
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i].Code < codes[j].Code })
	return backtest.Session{Date: s, Index: index, Seed: seed, CashRate: rate, Benchmark: benchmark, Codes: codes}, nil
}

// usesCASuspects is the batch's rule for computing corporate-action suspects
// (pipeline.NewIndex): the CA guard, or the latest complete published short source.
func usesCASuspects(s spec.Spec) bool {
	return s.Universe.CAGuard || s.Data.ShortSource == "latest_complete_published"
}

func optFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// paperCatchUp runs the paper phase for one run: every version the database
// records as live or superseded, stepped through the complete sessions up to d.
// A missing paper table idles the phase with one log line. Each track fails on
// its own: a track whose step errors stops there (its next run retries it), the
// others still step, and the errors come back together at the end.
func paperCatchUp(ctx context.Context, pool *pgxpool.Pool, st store, d civil.Date, write bool, logf func(string, ...any)) error {
	missing, err := st.paperTablesMissing(ctx)
	if err != nil {
		return err
	}
	if len(missing) > 0 {
		logf("strategies: paper track idle: %s missing (migration 000159 not applied)", strings.Join(missing, ", "))
		return nil
	}
	o := newOnce()
	versions, err := paperVersions(ctx, st, logf, o)
	if err != nil {
		return err
	}
	if len(versions) == 0 {
		logf("strategies: paper track idle: no live version with a recipe")
		return nil
	}
	from := versions[0].LiveFrom
	for _, v := range versions {
		if v.LiveFrom.Before(from) {
			from = v.LiveFrom
		}
	}
	sessions, err := st.snapshotSessions(ctx, from, d)
	if err != nil {
		return err
	}
	c := &paperRun{pool: pool, st: st, write: write, logf: logf, snaps: map[civil.Date]paperSnapped{},
		bench: map[civil.Date]float64{}, caRecord: map[civil.Date]bool{}, o: o}
	var errs []error
	for _, v := range versions {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.track(ctx, v, sessions, d); err != nil {
			logf("strategies: paper track %s %s stopped this run: %v", v.Target.Reg.Spec.StrategyID, v.Target.Reg.Label, err)
			errs = append(errs, fmt.Errorf("paper track %s %s: %w", v.Target.Reg.Spec.StrategyID, v.Target.Reg.Label, err))
		}
	}
	return errors.Join(errs...)
}

// paperRun is one catch-up's shared reads: the snapshot sessions and the levels
// are read once however many tracks step through them.
type paperRun struct {
	pool     *pgxpool.Pool
	st       store
	write    bool
	logf     func(string, ...any)
	snaps    map[civil.Date]paperSnapped
	bench    map[civil.Date]float64
	caRecord map[civil.Date]bool
	o        *once
}

// caRecorded is whether a session's rows were written after the suspects were stored.
func (c *paperRun) caRecorded(ctx context.Context, d civil.Date) (bool, error) {
	if v, seen := c.caRecord[d]; seen {
		return v, nil
	}
	v, err := c.st.snapshotCARecorded(ctx, d)
	if err != nil {
		return false, err
	}
	c.caRecord[d] = v
	return v, nil
}

type paperSnapped struct {
	snap paperSnapshot
	ok   bool
}

func (c *paperRun) snapshot(ctx context.Context, d civil.Date) (paperSnapshot, bool, error) {
	if s, seen := c.snaps[d]; seen {
		return s.snap, s.ok, nil
	}
	snap, ok, err := readPaperSnapshot(ctx, c.pool, d)
	if err != nil {
		return paperSnapshot{}, false, err
	}
	c.snaps[d] = paperSnapped{snap: snap, ok: ok}
	return snap, ok, nil
}

// evict drops the cached snapshots of sessions before d. A catch-up steps its
// tracks oldest first, and a session's rows are needed only as the previous and
// current session of the step, so the cache holds the sessions still to read and
// no more: a whole history of snapshots is never decoded at once.
func (c *paperRun) evict(before civil.Date) {
	for d := range c.snaps {
		if d.Before(before) {
			delete(c.snaps, d)
		}
	}
}

// track steps one version's track through the sessions it still owes. A stopped
// track is never stepped. A live track starts on its live_from and resumes from
// its checkpoint. A superseded track steps the sessions before superseded_on and
// then records its stop.
func (c *paperRun) track(ctx context.Context, v paperVersion, sessions []civil.Date, d civil.Date) error {
	reg := v.Target.Reg
	cfg, err := paperConfig(v.Target)
	if err != nil {
		return err
	}
	cp, found, err := c.st.paperCheckpointOf(ctx, v.Target.RulesHash, v.Target.RecipeHash)
	if err != nil {
		return err
	}
	if found && !cp.StoppedOn.IsZero() {
		if v.Status == "live" {
			c.o.logOnce("paper-repromoted-"+v.Target.RulesHash, c.logf,
				"strategies: paper track %s %s was stopped on %s when it was superseded; re-promotion does not resume it, so it records nothing",
				reg.Spec.StrategyID, reg.Label, cp.StoppedOn)
		}
		return nil
	}
	if v.Status == "superseded" && !found {
		return nil
	}
	tr := &paperTrack{v: v, cfg: cfg}
	if found {
		if tr.state, err = backtest.RestoreState(cfg, cp.Raw); err != nil {
			return fmt.Errorf("restore the checkpoint written at engine %s: %w", cp.EngineVersion, err)
		}
		tr.asOf = cp.AsOf
	}
	// A superseded track steps the sessions strictly before superseded_on. The bound
	// is compared with the session itself, not with the calendar day before it: a
	// superseded_on that follows a weekend has no session on the day before.
	superseded := v.Status == "superseded"
	for _, x := range sessions {
		if x.After(d) {
			break
		}
		if superseded && !x.Before(v.SupersededOn) {
			break
		}
		if !tr.asOf.IsZero() && !x.After(tr.asOf) {
			continue
		}
		if tr.state == nil && x.Before(v.LiveFrom) {
			continue
		}
		if _, err := c.step(ctx, tr, x); err != nil {
			return fmt.Errorf("session %s: %w", x, err)
		}
		// A track reads only its previous and current session: the sessions before
		// x are not needed again by this track or any later one (tracks step oldest
		// first from the same sessions).
		c.evict(prevTradingDay(x))
	}
	// Accepted limitation: the stop is recorded only by a catch-up that sees the
	// version superseded. A version superseded and re-promoted between two runs is
	// never seen as superseded, so its track resumes (the catch-up steps the sessions
	// in between). Documented in services/jobs/README.md, "Paper track".
	if v.Status == "superseded" && c.write && !tr.asOf.IsZero() {
		if err := c.st.paperStop(ctx, v.Target.RulesHash, v.Target.RecipeHash, v.SupersededOn); err != nil {
			return err
		}
		c.o.logOnce("paper-stopped-"+v.Target.RulesHash, c.logf,
			"strategies: paper track %s %s stopped at its supersession on %s", reg.Spec.StrategyID, reg.Label, v.SupersededOn)
	}
	return nil
}

// paperTrack is one version's account while a catch-up runs: the simulator's
// state after asOf, restored from the checkpoint each step.
type paperTrack struct {
	v     paperVersion
	cfg   backtest.Config
	state *backtest.State
	asOf  civil.Date
}

// step runs one session on a track. It reports whether the session was recorded:
// a session whose previous session has no rows cannot seed a track and is skipped.
func (c *paperRun) step(ctx context.Context, tr *paperTrack, x civil.Date) (bool, error) {
	reg := tr.v.Target.Reg
	prev := prevTradingDay(x)
	// The start rule, read before any snapshot is decoded: a track waits for the
	// first session whose seed carries ca_known. Rows written before the suspects
	// were stored do not, and they are never backfilled. The check is one query per
	// session, so a long wait after a deploy reads no full snapshot.
	if tr.state == nil {
		recorded, err := c.caRecorded(ctx, prev)
		if err != nil {
			return false, err
		}
		if !recorded {
			c.o.logOnce("paper-start-wait-"+tr.v.Target.RulesHash, c.logf,
				"strategies: paper track %s %s waits to start: its seed rows predate ca_known (rows written before the suspects were stored do not carry it, and are not backfilled)",
				reg.Spec.StrategyID, reg.Label)
			return false, nil
		}
	}
	// Every session a track steps must carry ca_known, not only its seed: a session
	// written by an image without the suspects would enter an append-only record
	// with no known suspects and the old ex-dividend rule. Such a session fails its
	// track only, with its own log line.
	recorded, err := c.caRecorded(ctx, x)
	if err != nil {
		return false, err
	}
	if !recorded {
		return false, fmt.Errorf("session %s predates ca_known: its rows carry no known corporate-action suspects, so the track does not step it", x)
	}
	prevSnap, havePrev, err := c.snapshot(ctx, prev)
	if err != nil {
		return false, err
	}
	if tr.state == nil {
		if !havePrev {
			return false, nil
		}
		c.logf("strategies: paper track %s %s starts: first recorded session %s, seed %s carries ca_known",
			reg.Spec.StrategyID, reg.Label, x, prev)
		// The track starts here: the previous session is the seed, which classifies
		// the bars and records the statuses and suspects, and fills and records nothing.
		seedRate, err := c.rate(ctx, prev)
		if err != nil {
			return false, err
		}
		seedBench, err := c.benchmark(ctx, prev)
		if err != nil {
			return false, err
		}
		state := backtest.NewState(tr.cfg)
		seed, err := paperSessionOf(prevSnap.Rows, prevSnap.Blobs, prevSnap.Regime, reg, prev, civil.Date{}, 0, true, seedRate, seedBench, nil)
		if err != nil {
			return false, fmt.Errorf("seed %s: %w", prev, err)
		}
		backtest.Step(state, seed)
		raw, err := state.Checkpoint()
		if err != nil {
			return false, err
		}
		if tr.state, err = backtest.RestoreState(tr.cfg, raw); err != nil {
			return false, err
		}
	}
	cur, ok, err := c.snapshot(ctx, x)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, fmt.Errorf("session %s has no feature rows", x)
	}
	if !havePrev {
		return false, fmt.Errorf("session %s has no feature rows to step from", prev)
	}
	rate, err := c.rate(ctx, x)
	if err != nil {
		return false, err
	}
	bench, err := c.benchmark(ctx, x)
	if err != nil {
		return false, err
	}
	var holdings []string
	for _, h := range tr.state.Holdings() {
		holdings = append(holdings, h.Code)
	}
	sess, err := paperSessionOf(cur.Rows, cur.Blobs, cur.Regime, reg, x, prev, tr.state.LastIndex()+1, false, rate, bench, holdings)
	if err != nil {
		return false, err
	}
	before := tr.state.PendingEntries()
	backtest.Step(tr.state, sess)

	rows, err := paperLedgerRows(before, tr.state.PendingEntries(), tr.state.Holdings(), tr.state.Closed(), tr.state.Events())
	if err != nil {
		return false, err
	}
	recs := tr.state.Records()
	if len(recs) != 1 {
		return false, fmt.Errorf("the step recorded %d sessions, want 1", len(recs))
	}
	raw, err := tr.state.Checkpoint()
	if err != nil {
		return false, err
	}
	out := &paperStep{Equity: recs[0], Benchmark: bench, Trades: rows, Holds: len(tr.state.Holdings()), Raw: raw, Session: x}
	if c.write {
		if err := c.st.writePaperStep(ctx, tr.v.Target, reg.Spec.StrategyID, out); err != nil {
			return false, err
		}
	}
	c.logf("strategies: paper %s %s %s: equity %.2f, cash %.2f, %d open, %d trade row(s)",
		reg.Spec.StrategyID, reg.Label, x, out.Equity.Equity, out.Equity.Cash, out.Holds, len(out.Trades))
	// The next session starts from the checkpoint, as a later run would.
	if tr.state, err = backtest.RestoreState(tr.cfg, raw); err != nil {
		return false, err
	}
	tr.asOf = x
	return true, nil
}

// rate is the RBA cash rate on d as the annual fraction the simulator takes.
func (c *paperRun) rate(ctx context.Context, d civil.Date) (float64, error) {
	rates, err := pgsource.CashRate(ctx, c.pool, d)
	if err != nil {
		return 0, fmt.Errorf("read the cash rate on %s: %w", d, err)
	}
	return backtest.CashRateFraction(rates, d), nil
}

// benchmark is the XJT level on or before d (the batch's levelOn), zero when no
// XJT bar exists on or before d.
func (c *paperRun) benchmark(ctx context.Context, d civil.Date) (float64, error) {
	if v, seen := c.bench[d]; seen {
		return v, nil
	}
	v, err := c.st.indexLevelOn(ctx, pgsource.BacktestIndexBenchmark, d)
	if err != nil {
		return 0, err
	}
	c.bench[d] = v
	return v, nil
}

// paperStep is what one session did for one track: the rows it writes.
type paperStep struct {
	Equity    backtest.Record
	Benchmark float64
	Trades    []paperTradeRow
	Holds     int
	Raw       []byte
	Session   civil.Date
}

// paperTradeRow is one trade as the paper table records it.
type paperTradeRow struct {
	Status         string
	Code           string
	SignalDate     civil.Date
	EntryDate      civil.Date
	EntryPrice     float64
	HasEntry       bool
	CapturedPivot  float64
	HasPivot       bool
	Quantity       float64
	HasQuantity    bool
	EntryScore     float64
	ExitSignalDate civil.Date
	ExitDate       civil.Date
	ExitPrice      float64
	HasExitPrice   bool
	ExitReason     string
	Flags          []string
	// Economics are set on a closed trade only (Closed).
	Closed       bool
	SessionsHeld int
	GrossPct     float64
	NetPct       float64
	Fees         float64
	Dividends    float64
}

// paperLedgerRows is the trade rows one session leaves: every scheduled entry,
// every open position (pending_exit when an exit is queued on it), every trade
// closed this session and every entry cancelled this session. before is the
// pending entries the session started with: a cancellation names its signal
// date through it, because the simulator drops a cancelled entry.
func paperLedgerRows(before, pending []backtest.PendingEntry, holdings []backtest.Holding, closed []backtest.Trade, events []backtest.Event) ([]paperTradeRow, error) {
	var rows []paperTradeRow
	for _, p := range pending {
		rows = append(rows, paperTradeRow{
			Status: "pending_entry", Code: p.Code, SignalDate: p.SignalDate,
			CapturedPivot: p.Pivot, HasPivot: true, EntryScore: p.Score, Flags: []string{},
		})
	}
	for _, h := range holdings {
		row := paperTradeRow{
			Status: "open", Code: h.Code, SignalDate: h.SignalDate,
			EntryDate: h.EntryDate, EntryPrice: h.EntryFill, HasEntry: true,
			CapturedPivot: h.Pivot, HasPivot: true, EntryScore: h.Score,
			Quantity: h.Quantity, HasQuantity: true, Flags: h.Flags,
		}
		if h.ExitPending {
			row.Status = "pending_exit"
			row.ExitSignalDate = h.ExitSignalDate
			row.ExitReason = h.ExitReason
		}
		rows = append(rows, row)
	}
	for _, t := range closed {
		rows = append(rows, paperTradeRow{
			Status: "closed", Code: t.Code, SignalDate: t.SignalDate,
			EntryDate: t.EntryDate, EntryPrice: t.EntryFill, HasEntry: true,
			CapturedPivot: t.Pivot, HasPivot: true, EntryScore: t.EntryScore,
			Quantity: t.Qty, HasQuantity: true,
			ExitSignalDate: t.ExitSignalDate, ExitDate: t.ExitDate,
			ExitPrice: t.ExitFill, HasExitPrice: true, ExitReason: t.ExitReason,
			Flags: t.Flags, Closed: true, SessionsHeld: t.SessionsHeld,
			GrossPct: t.Gross * 100, NetPct: t.Net * 100, Fees: t.Fees, Dividends: t.Dividends,
		})
	}
	for _, ev := range events {
		if ev.Kind != backtest.EventEntryCancelled {
			continue
		}
		// The cancelled row takes the signal date and score of the pending entry it
		// cancels: the score is the entry's, not the cancellation's (which has none).
		var pending *backtest.PendingEntry
		for i := range before {
			if before[i].Code == ev.Code {
				pending = &before[i]
				break
			}
		}
		if pending == nil {
			return nil, fmt.Errorf("entry of %s cancelled with no pending entry", ev.Code)
		}
		rows = append(rows, paperTradeRow{Status: "cancelled", Code: ev.Code, SignalDate: pending.SignalDate,
			EntryScore: pending.Score, Flags: []string{ev.Reason}})
	}
	return rows, nil
}

// paperTransitions is the trade lifecycle: the statuses a trade may move to from
// each status. A trade never moves backwards, and closed and cancelled are final.
var paperTransitions = map[string][]string{
	"pending_entry": {"open", "cancelled"},
	"open":          {"pending_exit", "closed"},
	"pending_exit":  {"closed"},
}

// paperMayMove reports whether a trade may move from one status to another. A
// status that does not change is a no-op and is not asked.
func paperMayMove(from, to string) bool {
	for _, next := range paperTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// paperPath is the statuses a trade passes through to move from one status to
// another, the ones a row records in order. An entry that fills and has its exit
// decided on the same session goes pending_entry -> open -> pending_exit (or
// closed): the fill is a session of its own in the record, even when the
// simulator's state shows only the end of the session.
func paperPath(from, to string) ([]string, bool) {
	if paperMayMove(from, to) {
		return []string{to}, true
	}
	if from == "pending_entry" && (to == "pending_exit" || to == "closed") {
		return []string{"open", to}, true
	}
	return nil, false
}

// paperGuardOf is the earliest snapshot session a track still reads: the session
// two before the track's next step (the session its next step reads, and one
// more). A stopped track needs nothing; a live track with no checkpoint reads
// from its live_from.
func paperGuardOf(cpAsOf civil.Date, found bool, liveFrom civil.Date) civil.Date {
	if found {
		return prevTradingDay(prevTradingDay(nextTradingDay(cpAsOf)))
	}
	if liveFrom.IsZero() {
		return civil.Date{}
	}
	return prevTradingDay(prevTradingDay(liveFrom))
}

// paperGuards is the snapshot guard of every track the paper phase still records
// (see paperGuardOf): one per (rules hash, recipe hash) over the registered
// recipes, so a recipe that is no longer registered never pins pruning.
func paperGuards(ctx context.Context, st store, logf func(string, ...any)) ([]civil.Date, error) {
	missing, err := st.paperTablesMissing(ctx)
	if err != nil {
		return nil, err
	}
	if len(missing) > 0 {
		return nil, nil
	}
	versions, err := paperVersions(ctx, st, logf, newOnce())
	if err != nil {
		return nil, err
	}
	var out []civil.Date
	for _, v := range versions {
		cp, found, err := st.paperCheckpointOf(ctx, v.Target.RulesHash, v.Target.RecipeHash)
		if err != nil {
			return nil, err
		}
		if found && !cp.StoppedOn.IsZero() {
			continue
		}
		// A superseded version with no checkpoint never started its track (a stopped
		// one has its checkpoint): its guard would be its live_from, which no track
		// will read, and which would pin pruning for good.
		if !found && v.Status == "superseded" {
			continue
		}
		if g := paperGuardOf(cp.AsOf, found, v.LiveFrom); !g.IsZero() {
			out = append(out, g)
		}
	}
	return out, nil
}
