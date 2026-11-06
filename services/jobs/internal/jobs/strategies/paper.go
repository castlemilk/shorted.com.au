package strategies

import (
	"context"
	"fmt"
	"sort"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The paper track (5.13): the only out-of-sample record. For each live canonical
// version with a recipe it steps the simulator (backtest.Step) one session at a
// time, from the stored snapshot rows of the session and the one before it, never
// from stock_prices. Each session's equity, its trades and the simulator's
// checkpoint are written in one transaction, so a session is recorded whole or
// not at all.
//
// The rows are append-only: an equity row is inserted once and never updated, a
// trade moves forward only (pending_entry -> open -> pending_exit -> closed, or
// pending_entry -> cancelled), and the checkpoint is replaced by the next
// session's. The job refuses a trade that would move backwards.

const phasePaper = "paper"

// paperSessionBuilder builds a stored session's simulator session, and
// paperTargetsOf names the live versions with a recipe. Both default to the
// production functions. A test replaces them to set statuses the engine would
// not reach on fixture rows, or to exercise the idle phase; it restores them
// when it is done.
var (
	paperSessionBuilder = paperSessionOf
	paperTargetsOf      = func() ([]backtestTarget, error) { return backtestTargets(spec.Registry()) }
)

// paperSnapshot is one stored session's inputs to the paper track.
type paperSnapshot struct {
	Rows   []snapshot.Row
	Blobs  map[string]features.Fundamentals
	Regime engine.Regime
}

// readPaperSnapshot reads one session's feature rows, the fundamentals blobs
// they point at and the regime. ok is false when the session has no rows, which
// is a session the features phase has not completed.
func readPaperSnapshot(ctx context.Context, pool *pgxpool.Pool, d civil.Date) (paperSnapshot, bool, error) {
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

// paperConfig is the simulator's configuration for a recipe under a version: the
// recipe's sizing, costs and exits, the version's first four-decimal session.
// LastLoaded stays empty: the paper track cannot know which codes trade later,
// so every stale exit is labelled delisted_exit (the batch run labels a code
// suspended when a later bar exists in its loaded data).
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

// paperSessionOf builds the simulator's session for one stored session. Each
// code's bar, status, score, captured pivot, dollar volume, moving averages,
// breakout date, cash dividend and corporate-action suspect come from its
// snapshot row; the statuses are the version's evaluation of the session's
// eligible rows, as the daily evaluation phase makes them. prev is the session
// before (nil for a track's first session, whose suspects are then all new).
// holdings are the codes the simulator holds: one with no row on the session
// still gets a session entry, with no bar, so its stale-exit rule can run.
func paperSessionOf(rows, prev []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime,
	reg spec.Registered, s civil.Date, index int, seed bool, rate float64, holdings []string) (backtest.Session, error) {
	strategy, ok := engine.Lookup(reg.Spec.StrategyID)
	if !ok {
		return backtest.Session{}, fmt.Errorf("no engine strategy for %s", reg.Spec.StrategyID)
	}
	strategy.UnknownStatus = reg.Spec.Ladder.UnknownStatus

	sorted := append([]snapshot.Row(nil), rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].StockCode < sorted[j].StockCode })

	prevSuspect := make(map[string]civil.Date, len(prev))
	for _, r := range prev {
		if r.CASuspectDate != nil {
			prevSuspect[r.StockCode] = *r.CASuspectDate
		}
	}

	// The candidates the universe admits are prepared together and set the
	// universe statistics, as evaluateVersion does; the rest keep their price
	// features for an exit decided on their session.
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
		if r.BarDate == s {
			b := r.Features.Bar
			cs.Bar = &features.Bar{Date: s, Open: b.O, High: b.H, Low: b.L, Close: b.C, AdjClose: b.Adj, Volume: b.V}
		}
		cs.Dividend = r.Features.ExDiv
		if r.CASuspectDate != nil {
			cs.CA = backtest.CASuspect{Known: prevSuspect[r.StockCode] != *r.CASuspectDate, SuspectDate: *r.CASuspectDate}
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
	return backtest.Session{Date: s, Index: index, Seed: seed, CashRate: rate, Codes: codes}, nil
}

func optFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// paperTrack is one live canonical version's paper account: its recipe, its
// configuration, the session it went live and the simulator's state after its
// last recorded session.
type paperTrack struct {
	target   backtestTarget
	liveFrom civil.Date
	cfg      backtest.Config
	// asOf is the last session the track recorded, zero before its first.
	asOf civil.Date
	// state is the simulator after asOf; nil until the track starts.
	state *backtest.State
}

// paperStep is what one session did for one track: the rows it writes.
type paperStep struct {
	Equity  backtest.Record
	Trades  []paperTradeRow
	Holds   int
	Raw     []byte
	Session civil.Date
}

// advance steps the track through session x. It reports whether the track
// stepped: a track that has not started waits for a session whose previous
// session has rows, the one its first step reads, and a session with no rows at
// all is not part of its record. write false computes the step and writes nothing.
func (tr *paperTrack) advance(ctx context.Context, pool *pgxpool.Pool, st store, x civil.Date, write bool) (*paperStep, error) {
	if !tr.asOf.IsZero() && !x.After(tr.asOf) {
		return nil, nil
	}
	reg := tr.target.Reg
	prevDate := prevTradingDay(x)
	prev, havePrev, err := readPaperSnapshot(ctx, pool, prevDate)
	if err != nil {
		return nil, err
	}
	if tr.state == nil {
		if !havePrev || x.Before(tr.liveFrom) {
			return nil, nil
		}
		// The track starts on this session: the session before it is the seed,
		// which classifies the bars and records the statuses, but fills, marks
		// and records nothing.
		prevPrev, _, err := readPaperSnapshot(ctx, pool, prevTradingDay(prevDate))
		if err != nil {
			return nil, err
		}
		state := backtest.NewState(tr.cfg)
		seedRates, err := pgsource.CashRate(ctx, pool, prevDate)
		if err != nil {
			return nil, fmt.Errorf("read the cash rate on %s: %w", prevDate, err)
		}
		seed, err := paperSessionBuilder(prev.Rows, prevPrev.Rows, prev.Blobs, prev.Regime, reg, prevDate, 0, true,
			backtest.CashRateFraction(seedRates, prevDate), nil)
		if err != nil {
			return nil, fmt.Errorf("paper track %s seed %s: %w", reg.Label, prevDate, err)
		}
		backtest.Step(state, seed)
		raw, err := state.Checkpoint()
		if err != nil {
			return nil, err
		}
		if tr.state, err = backtest.RestoreState(tr.cfg, raw); err != nil {
			return nil, err
		}
	}
	cur, ok, err := readPaperSnapshot(ctx, pool, x)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("paper track %s: session %s has no feature rows", reg.Label, x)
	}
	if !havePrev {
		return nil, fmt.Errorf("paper track %s: session %s has no feature rows to step from", reg.Label, prevDate)
	}
	rates, err := pgsource.CashRate(ctx, pool, x)
	if err != nil {
		return nil, fmt.Errorf("read the cash rate on %s: %w", x, err)
	}
	var holdings []string
	for _, h := range tr.state.Holdings() {
		holdings = append(holdings, h.Code)
	}
	sess, err := paperSessionBuilder(cur.Rows, prev.Rows, cur.Blobs, cur.Regime, reg, x, tr.state.LastIndex()+1, false,
		backtest.CashRateFraction(rates, x), holdings)
	if err != nil {
		return nil, fmt.Errorf("paper track %s session %s: %w", reg.Label, x, err)
	}
	before := tr.state.PendingEntries()
	backtest.Step(tr.state, sess)

	rows, err := paperLedgerRows(before, tr.state.PendingEntries(), tr.state.Holdings(), tr.state.Closed(), tr.state.Events())
	if err != nil {
		return nil, fmt.Errorf("paper track %s session %s: %w", reg.Label, x, err)
	}
	recs := tr.state.Records()
	if len(recs) != 1 {
		return nil, fmt.Errorf("paper track %s session %s: the step recorded %d sessions, want 1", reg.Label, x, len(recs))
	}
	raw, err := tr.state.Checkpoint()
	if err != nil {
		return nil, err
	}
	out := &paperStep{Equity: recs[0], Trades: rows, Holds: len(tr.state.Holdings()), Raw: raw, Session: x}
	if write {
		if err := st.writePaperStep(ctx, tr.target, reg.Spec.StrategyID, out); err != nil {
			return nil, err
		}
	}
	// The next session starts from the checkpoint, as a later run would: the
	// outputs above are this session's only, and an in-memory run and a daily
	// run step the same state.
	if tr.state, err = backtest.RestoreState(tr.cfg, raw); err != nil {
		return nil, err
	}
	tr.asOf = x
	return out, nil
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
	ExitSignalDate civil.Date
	ExitDate       civil.Date
	ExitPrice      float64
	HasExitPrice   bool
	ExitReason     string
	Flags          []string
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
			CapturedPivot: p.Pivot, HasPivot: true,
		})
	}
	for _, h := range holdings {
		row := paperTradeRow{
			Status: "open", Code: h.Code, SignalDate: h.SignalDate,
			EntryDate: h.EntryDate, EntryPrice: h.EntryFill, HasEntry: true,
			CapturedPivot: h.Pivot, HasPivot: true,
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
			CapturedPivot: t.Pivot, HasPivot: true,
			Quantity: t.Qty, HasQuantity: true,
			ExitSignalDate: t.ExitSignalDate, ExitDate: t.ExitDate,
			ExitPrice: t.ExitFill, HasExitPrice: true, ExitReason: t.ExitReason,
			Flags: t.Flags,
		})
	}
	for _, ev := range events {
		if ev.Kind != backtest.EventEntryCancelled {
			continue
		}
		signal, found := civil.Date{}, false
		for _, p := range before {
			if p.Code == ev.Code {
				signal, found = p.SignalDate, true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("entry of %s cancelled with no pending entry", ev.Code)
		}
		rows = append(rows, paperTradeRow{Status: "cancelled", Code: ev.Code, SignalDate: signal, Flags: []string{ev.Reason}})
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
// decided on the same session goes pending_entry -> open -> pending_exit, and one
// that also closes that session goes through open to closed: the fill is a
// session of its own in the record, even when the simulator's state shows only
// the end of the session.
func paperPath(from, to string) ([]string, bool) {
	if paperMayMove(from, to) {
		return []string{to}, true
	}
	if from == "pending_entry" && (to == "pending_exit" || to == "closed") {
		return []string{"open", to}, true
	}
	return nil, false
}

// runPaperPhase brings every live canonical version with a recipe up to session
// s. A version has no paper record before its live_from. A version whose track
// has not started steps from live_from, once the session before it has rows;
// one whose track has started steps every session after its last recorded one,
// oldest first, so a session the daily job did not reach is caught up here. A
// version with no live_from, or no recipe, is skipped. With no live version
// with a recipe the phase is idle: it completes with nothing to do.
func runPaperPhase(ctx context.Context, pool *pgxpool.Pool, st store, s civil.Date, write bool, logf func(string, ...any)) error {
	targets, err := paperTargetsOf()
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		logf("strategies: paper track idle: no live version with a recipe")
		if write {
			return st.writePaperRunDone(ctx, s, nil, 0)
		}
		return nil
	}
	live, err := st.liveVersions(ctx)
	if err != nil {
		return err
	}
	var tracks []*paperTrack
	from := s
	for _, t := range targets {
		lv, ok := live[t.RulesHash]
		if !ok || lv.LiveFrom.IsZero() {
			logf("strategies: paper track %s %s: not recorded as live yet", t.Reg.Spec.StrategyID, t.Reg.Label)
			continue
		}
		if s.Before(lv.LiveFrom) {
			continue
		}
		cfg, err := paperConfig(t)
		if err != nil {
			return err
		}
		tr := &paperTrack{target: t, liveFrom: lv.LiveFrom, cfg: cfg}
		cp, found, err := st.paperCheckpoint(ctx, t.RulesHash, t.RecipeHash)
		if err != nil {
			return err
		}
		start := sessionOnOrAfter(lv.LiveFrom)
		if found {
			tr.asOf = cp.AsOf
			if tr.state, err = backtest.RestoreState(cfg, cp.Raw); err != nil {
				return fmt.Errorf("paper track %s: %w", t.Reg.Label, err)
			}
			start = nextTradingDay(cp.AsOf)
		}
		if start.Before(from) {
			from = start
		}
		tracks = append(tracks, tr)
	}
	if len(tracks) == 0 {
		if write {
			return st.writePaperRunDone(ctx, s, nil, 0)
		}
		return nil
	}

	var hashes []string
	for _, tr := range tracks {
		hashes = append(hashes, tr.target.RulesHash)
	}
	sort.Strings(hashes)
	for x := from; !x.After(s); x = nextTradingDay(x) {
		if err := ctx.Err(); err != nil {
			return err
		}
		stepped := 0
		for _, tr := range tracks {
			out, err := tr.advance(ctx, pool, st, x, write)
			if err != nil {
				return err
			}
			if out == nil {
				continue
			}
			stepped++
			logf("strategies: paper %s %s %s: equity %.2f, cash %.2f, %d open, %d trade row(s)",
				tr.target.Reg.Spec.StrategyID, tr.target.Reg.Label, x, out.Equity.Equity, out.Equity.Cash, out.Holds, len(out.Trades))
		}
		if write {
			if err := st.writePaperRunDone(ctx, x, hashes, stepped); err != nil {
				return err
			}
		}
	}
	if from.After(s) && write {
		// Every track has recorded s already: the phase is complete for it.
		return st.writePaperRunDone(ctx, s, hashes, 0)
	}
	return nil
}

// sessionOnOrAfter is d when the ASX traded on it, else the next trading day.
func sessionOnOrAfter(d civil.Date) civil.Date {
	if isTradingDay(d) {
		return d
	}
	return nextTradingDay(d)
}
