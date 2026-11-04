package backtest

import (
	"math"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Exit reasons, as a trade reports them.
const (
	ReasonPivotStop       = "pivot_stop"
	ReasonTimeStop        = "time_stop"
	ReasonStopLoss        = "stop_loss"
	ReasonSMAStop         = "sma_stop"
	ReasonStatusExit      = "status_exit"
	ReasonDelisted        = "delisted_exit"
	ReasonSuspended       = "suspended_exit"
	ReasonCorporateAction = "corporate_action_exit"
	ReasonOpenAtEnd       = "open_at_end"
)

// Flags on a trade.
const (
	FlagFallbackClose   = "fallback_close"
	FlagDelayedExit     = "delayed_exit"
	FlagStaleMarks      = "stale_marks"
	FlagCapacityCapped  = "capacity_capped"
	FlagPriceReturnOnly = "price_return_only"
)

// Cancellation reasons for an entry order.
const (
	CancelUntraded = "cancelled_untraded"
	CancelGap      = "cancelled_gap"
	CancelCash     = "cancelled_cash"
)

// Event kinds recorded in State.Events.
const (
	EventEntryFilled     = "entry_filled"
	EventEntryCancelled  = "entry_cancelled"
	EventExitDelayed     = "exit_delayed"
	EventExitFilled      = "exit_filled"
	EventDividendCredit  = "dividend_credited"
	caBlockSessions      = 60
	defaultStaleSessions = 20
)

// statusTriggered is the engine's triggered status as the session's string.
const statusTriggered = string(engine.StatusTriggered)

// traded reports whether a session's bar exists and has volume: a row with no
// volume is an untraded session, where no order fills.
func traded(b *features.Bar) bool { return b != nil && b.Volume > 0 }

// CASuspect is a corporate-action suspect as it is known on a session. The
// exclusion price is not supplied: the simulator closes a position at its own
// P&L-basis close from the session before the suspect bar.
type CASuspect struct {
	// Known is true on the session the suspect becomes known (ca_known_at).
	Known bool
	// SuspectDate is the bar the suspect sits on. A position entered before it
	// is closed as a data exclusion; one entered on or after it is unaffected.
	SuspectDate civil.Date
}

// CodeSession is one code's inputs on one session. Signals are as at this
// session's close.
type CodeSession struct {
	Code string
	// Bar is the code's row on the session, nil when it has none.
	Bar    *features.Bar
	Status string
	Score  float64
	// Pivot is the captured pivot (base_high) at this close.
	Pivot float64
	// BreakoutDate is the current breakout date; zero when none.
	BreakoutDate civil.Date
	// DV20 is the 20-session dollar volume at this close, the decision basis
	// for capacity and spread.
	DV20          float64
	SMA50, SMA200 float64
	// Dividend is the cash dividend per share with its ex-date on this session.
	Dividend float64
	CA       CASuspect
}

// Session is one calendar session. Codes must be sorted by Code and unique.
type Session struct {
	Date  civil.Date
	Index int
	// CashRate is the annual RBA cash rate as a fraction (0.0435 for 4.35%),
	// forward-filled to this session.
	CashRate             float64
	Benchmark, Reference float64
	Codes                []CodeSession
}

// Config is the simulator's parameters. ConfigOf builds the recipe's part; the
// caller sets the price-precision date and the last loaded bars, which a recipe
// does not hold.
type Config struct {
	Capital          float64
	WeightPct        float64 // % of equity at the decision's prior close
	MaxPositions     int
	CapacityPctDV20  float64 // notional <= this % of the decision's DV20
	Costs            spec.Costs
	ExitRules        []spec.ExitRule
	CooldownSessions int
	// StaleExitSessions is the run of sessions without a bar after which a
	// position exits at its last close. Zero means the default of 20.
	StaleExitSessions int
	// MaxAbovePivotPct cancels an entry whose open is above pivot*(1+x/100).
	MaxAbovePivotPct *float64
	// NewBreakoutOnly admits a candidate only when its breakout date was never
	// traded in this code (the recipe's fresh rule).
	NewBreakoutOnly bool
	// Price4dpFrom is the first date stored to four decimal places. It is
	// required: a zero value would read all history as four-decimal prices.
	Price4dpFrom civil.Date
	// LastLoaded is each code's last loaded bar date. A stale exit is labelled
	// delisted when no later bar exists, and suspended otherwise.
	LastLoaded map[string]civil.Date
}

// ConfigOf is the part of a simulator configuration that a recipe holds: the
// sizing, costs, exits, cooldown, entry gap and fresh rule. It copies the
// recipe's slices, so the caller may change the result freely.
func ConfigOf(r spec.Recipe) Config {
	cfg := Config{
		Capital:           r.Capital,
		WeightPct:         r.Sizing.WeightPct,
		MaxPositions:      r.Sizing.MaxPositions,
		CapacityPctDV20:   r.Sizing.CapacityPctDV20,
		Costs:             copyCosts(r.Costs),
		ExitRules:         append([]spec.ExitRule(nil), r.Exits...),
		CooldownSessions:  r.CooldownSessions,
		StaleExitSessions: r.StaleExitSessions,
		NewBreakoutOnly:   r.Entry.Fresh == spec.EntryFreshNewBreakout,
	}
	if r.Entry.MaxAbovePivotPct != nil {
		limit := *r.Entry.MaxAbovePivotPct
		cfg.MaxAbovePivotPct = &limit
	}
	return cfg
}

// copyCosts copies the cost model's slice and pointer, so a change to the copy
// reaches neither the recipe nor its hash. A nil field stays nil.
func copyCosts(c spec.Costs) spec.Costs {
	if c.SpreadTiers != nil {
		c.SpreadTiers = append([]spec.SpreadTier{}, c.SpreadTiers...)
	}
	if c.FlatSlippageBps != nil {
		flat := *c.FlatSlippageBps
		c.FlatSlippageBps = &flat
	}
	return c
}

// Trade is one round trip. EntryPrice and ExitPrice are on the P&L basis (price
// x multiplier) and carry the returns; EntryFill and ExitFill are the executed
// prices on the signal basis, the ones a trade list shows beside the pivot.
// Gross is the total return before costs, cash dividends included; Net is after
// both sides' costs and cash dividends, so Net never exceeds Gross.
type Trade struct {
	Code           string
	SignalDate     civil.Date
	EntryDate      civil.Date
	EntryPrice     float64
	EntryFill      float64
	Pivot          float64
	EntryScore     float64
	ExitSignalDate civil.Date
	ExitDate       civil.Date
	ExitPrice      float64
	ExitFill       float64
	ExitReason     string
	Qty            float64
	Gross          float64
	Net            float64
	SessionsHeld   int
	Dividends      float64
	Fees           float64
	Flags          []string
	OpenAtEnd      bool
}

// Record is one session's end-of-day state.
type Record struct {
	Date                 civil.Date
	Index                int
	Equity, Cash         float64
	Invested             float64
	Exposure             float64 // invested / equity
	Drawdown             float64 // equity / highest equity so far - 1
	Benchmark, Reference float64
}

// Event is a fill, cancellation or dividend, for audit.
type Event struct {
	Date   civil.Date
	Code   string
	Kind   string
	Reason string
}

// mark is one session's close for a held position: the signal-basis close and
// the P&L-basis close it was marked at.
type mark struct {
	date    civil.Date
	raw, pl float64
}

type position struct {
	code       string
	signalDate civil.Date
	breakout   civil.Date
	entryDate  civil.Date
	entryIdx   int
	entryRaw   float64 // signal basis fill, for the stop loss
	entryPL    float64 // P&L basis fill
	qty        float64 // notional / entryPL: units on the P&L basis
	pivot      float64
	score      float64
	dv20       float64
	entryFee   float64
	dividends  float64
	missing    int // consecutive sessions without a bar
	ruleCount  []int
	flags      map[string]bool
	// marks holds the position's closes from its entry on, by session.
	marks []mark
}

// preSuspect is the position's close on the last session before suspect: the
// price a corporate-action exclusion closes at.
func (p *position) preSuspect(suspect civil.Date) (raw, pl float64) {
	for i := len(p.marks) - 1; i >= 0; i-- {
		if p.marks[i].date.Before(suspect) {
			return p.marks[i].raw, p.marks[i].pl
		}
	}
	return p.entryRaw, p.entryPL
}

type pendingEntry struct {
	code       string
	score      float64
	pivot      float64
	dv20       float64
	signalDate civil.Date
	breakout   civil.Date
}

type pendingExit struct {
	code       string
	reason     string
	signalDate civil.Date
	dv20       float64
}

type perCode struct {
	mult          float64
	prev          features.Bar
	hasPrev       bool
	lastRaw       float64
	lastPL        float64
	lastPLDate    civil.Date
	prevStatus    string
	hasPrevStatus bool
	lastExitIdx   int
	hasExit       bool
	caKnownIdx    int
	hasCA         bool
	traded        map[civil.Date]bool
}

// State is the simulation's carried state. Create it with NewState and feed it
// sessions in ascending order with Step.
type State struct {
	cfg        Config
	cash       float64
	lastEquity float64
	peak       float64
	lastIndex  int
	// dividendsDue is the session's cash dividends, held out of cash until the
	// session's close.
	dividendsDue float64
	codes        map[string]*perCode
	positions    map[string]*position
	exits        map[string]pendingExit
	entries      []pendingEntry
	trades       []Trade
	events       []Event
	records      []Record
}

// NewState starts a run with Capital in cash. It panics when Price4dpFrom is
// unset, because the total-return tolerance depends on it, and when the cost
// multiplier is not above zero, which a validated recipe guarantees.
func NewState(cfg Config) *State {
	if cfg.Price4dpFrom.IsZero() {
		panic("backtest: Config.Price4dpFrom must be set to the first four-decimal session")
	}
	if !(cfg.Costs.Multiplier > 0) {
		panic("backtest: Config.Costs.Multiplier must be above zero")
	}
	if cfg.StaleExitSessions == 0 {
		cfg.StaleExitSessions = defaultStaleSessions
	}
	return &State{
		cfg:        cfg,
		cash:       cfg.Capital,
		lastEquity: cfg.Capital,
		peak:       cfg.Capital,
		codes:      map[string]*perCode{},
		positions:  map[string]*position{},
		exits:      map[string]pendingExit{},
	}
}

// Records are the recorded sessions, in order.
func (st *State) Records() []Record { return st.records }

// Events are the fills, cancellations and dividends, in order.
func (st *State) Events() []Event { return st.events }

// Equity is the last recorded equity, or the capital before any session.
func (st *State) Equity() float64 { return st.lastEquity }

// Finish returns the closed trades followed by the positions still open,
// marked at their last P&L close and flagged OpenAtEnd. Open trades are not
// charged an exit cost, and they are excluded from closed-trade statistics. An
// open trade's exit signal date is set only when an exit is pending on it.
func (st *State) Finish() []Trade {
	out := append([]Trade(nil), st.trades...)
	var date civil.Date
	if n := len(st.records); n > 0 {
		date = st.records[n-1].Date
	}
	for _, code := range sortedKeys(st.positions) {
		pos := st.positions[code]
		cs := st.codeState(code)
		var signal civil.Date
		if px, ok := st.exits[code]; ok {
			signal = px.signalDate
		}
		out = append(out, pos.trade(date, st.lastIndex, cs.lastRaw, cs.lastPL, ReasonOpenAtEnd, signal, 0, true))
	}
	return out
}

// Step advances the simulation by one session. The order is fixed: the
// session's bars are classified and the P&L multiplier steps; the cash dividends
// of positions held at the previous close are registered; exits and entries
// queued at the previous close fill at this open; positions are marked at the
// close; idle cash accrues; the dividends are paid into cash; exits are decided;
// entries for the next session are scheduled; and the session is recorded.
//
// Dividends are registered before the fills because the register is the one at
// the previous close: a buyer at an ex-date open is not paid, and a seller at
// that open is. They are paid into cash after the fills and the interest, so
// they fund no fill on their ex-date and earn no interest that day.
func Step(st *State, s Session) {
	by := make(map[string]*CodeSession, len(s.Codes))
	for i := range s.Codes {
		by[s.Codes[i].Code] = &s.Codes[i]
	}
	codes := sortedKeys(by)

	basis := make(map[string]BarBasis, len(codes))
	for _, code := range codes {
		c := by[code]
		cs := st.codeState(code)
		if c.CA.Known {
			cs.hasCA = true
			cs.caKnownIdx = s.Index
		}
		if c.Bar == nil {
			continue
		}
		b := ClassifyBar(cs.prev, *c.Bar, cs.hasPrev, s.Date, st.cfg.Price4dpFrom)
		// A cash-credited bar's step is not applied: the cash dividend is the
		// total-return adjustment for that event, so stepping as well would count
		// it twice when the vendor stored a small dividend as an adjustment.
		if b.TotalReturn && !cashCredited(b, c) {
			cs.mult = float64(cs.mult * math.Exp(b.RK))
		}
		basis[code] = b
	}

	st.creditDividends(s, by, basis)
	st.fillExits(s, by, basis)
	st.fillEntries(s, by)
	st.markToMarket(s, by, basis)
	st.accrueCash(s)
	st.payDividends()
	st.decideExits(s, by)
	st.scheduleEntries(s, by, codes)
	st.record(s)
	st.advance(s, by)
}

// cashCredited reports whether a recorded dividend on this bar is paid in cash:
// the bar is unadjusted by the vendor (r_k at or below the tolerance).
func cashCredited(b BarBasis, c *CodeSession) bool {
	return c.Dividend > 0 && b.Unadjusted
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (st *State) codeState(code string) *perCode {
	cs, ok := st.codes[code]
	if !ok {
		cs = &perCode{mult: 1, traded: map[civil.Date]bool{}}
		st.codes[code] = cs
	}
	return cs
}

func (st *State) event(date civil.Date, code, kind, reason string) {
	st.events = append(st.events, Event{Date: date, Code: code, Kind: kind, Reason: reason})
}

// fillPrice is the signal-basis open of a traded bar. An open of zero or less
// falls back to the close.
func fillPrice(b features.Bar) (float64, bool) {
	if b.Open > 0 {
		return b.Open, false
	}
	return b.Close, true
}

// creditDividends registers each held position's cash dividend on an unadjusted
// ex-date, so an exit filled at this open still carries it, and holds the cash
// until payDividends. The credit is qty x m_t: qty counts units on the P&L basis,
// so the shares held are qty x m_t, and the amount is the dividend per share on
// them.
func (st *State) creditDividends(s Session, by map[string]*CodeSession, basis map[string]BarBasis) {
	for _, code := range sortedKeys(st.positions) {
		c := by[code]
		if c == nil || c.Bar == nil || !cashCredited(basis[code], c) {
			continue
		}
		pos := st.positions[code]
		amt := float64(float64(c.Dividend*pos.qty) * st.codeState(code).mult)
		pos.dividends += amt
		st.dividendsDue += amt
		st.event(s.Date, code, EventDividendCredit, "")
	}
}

// payDividends moves the session's registered dividends into cash. It runs at
// the close, after the session's fills and interest.
func (st *State) payDividends() {
	st.cash += st.dividendsDue
	st.dividendsDue = 0
}

func (st *State) fillExits(s Session, by map[string]*CodeSession, basis map[string]BarBasis) {
	for _, code := range sortedKeys(st.exits) {
		px := st.exits[code]
		pos := st.positions[code]
		if pos == nil {
			delete(st.exits, code)
			continue
		}
		c := by[code]
		// A position entered before a suspect bar is closed by the exclusion at
		// that session's close, at the pre-suspect price. The suspect bar's open
		// is an unadjusted level, so a fill there would book a phantom move.
		if c != nil && c.CA.Known && pos.entryDate.Before(c.CA.SuspectDate) {
			continue
		}
		if c == nil || !traded(c.Bar) {
			pos.flags[FlagDelayedExit] = true
			st.event(s.Date, code, EventExitDelayed, px.reason)
			continue
		}
		raw, fallback := fillPrice(*c.Bar)
		if raw <= 0 {
			pos.flags[FlagDelayedExit] = true
			st.event(s.Date, code, EventExitDelayed, px.reason)
			continue
		}
		if fallback {
			pos.flags[FlagFallbackClose] = true
		}
		// The exit is priced with this bar's multiplier, so a bar whose step was
		// ignored makes the exit a price-return fill.
		if b := basis[code]; b.HasPrev && !b.TotalReturn {
			pos.flags[FlagPriceReturnOnly] = true
		}
		pl := float64(raw * st.codeState(code).mult)
		st.closePosition(s.Date, s.Index, pos, raw, pl, px.reason, px.signalDate, px.dv20)
	}
}

// sizeEntry is the notional an entry buys at the fill, or false when no cash
// can pay for it and its minimum fee. Capacity caps the notional at a share of
// the decision's DV20.
func (st *State) sizeEntry(e pendingEntry) (notional float64, capped, ok bool) {
	want := float64(st.cfg.WeightPct / 100 * st.lastEquity)
	if capN := float64(st.cfg.CapacityPctDV20 / 100 * e.dv20); capN < want {
		want = capN
		capped = true
	}
	if want > st.cash {
		want = st.cash
	}
	if want <= 0 {
		return 0, capped, false
	}
	if want+feeFor(st.cfg.Costs, want, e.dv20) > st.cash {
		want = st.cash - feeFor(st.cfg.Costs, want, e.dv20)
	}
	if want <= 0 || want+feeFor(st.cfg.Costs, want, e.dv20) > st.cash {
		return 0, capped, false
	}
	return want, capped, true
}

func (st *State) fillEntries(s Session, by map[string]*CodeSession) {
	pending := st.entries
	st.entries = nil
	for _, e := range pending {
		c := by[e.code]
		if c == nil || !traded(c.Bar) {
			st.event(s.Date, e.code, EventEntryCancelled, CancelUntraded)
			continue
		}
		raw, fallback := fillPrice(*c.Bar)
		if raw <= 0 {
			st.event(s.Date, e.code, EventEntryCancelled, CancelUntraded)
			continue
		}
		if limit := st.cfg.MaxAbovePivotPct; limit != nil && raw > float64(e.pivot*(1+*limit/100)) {
			st.event(s.Date, e.code, EventEntryCancelled, CancelGap)
			continue
		}
		notional, capped, ok := st.sizeEntry(e)
		if !ok {
			st.event(s.Date, e.code, EventEntryCancelled, CancelCash)
			continue
		}
		cs := st.codeState(e.code)
		pl := float64(raw * cs.mult)
		fee := feeFor(st.cfg.Costs, notional, e.dv20)
		st.cash -= notional + fee
		pos := &position{
			code:       e.code,
			signalDate: e.signalDate,
			breakout:   e.breakout,
			entryDate:  s.Date,
			entryIdx:   s.Index,
			entryRaw:   raw,
			entryPL:    pl,
			qty:        notional / pl,
			pivot:      e.pivot,
			score:      e.score,
			dv20:       e.dv20,
			entryFee:   fee,
			ruleCount:  make([]int, len(st.cfg.ExitRules)),
			flags:      map[string]bool{},
		}
		if fallback {
			pos.flags[FlagFallbackClose] = true
		}
		if capped {
			pos.flags[FlagCapacityCapped] = true
		}
		st.positions[e.code] = pos
		cs.lastRaw = raw
		cs.lastPL = pl
		cs.lastPLDate = s.Date
		if !e.breakout.IsZero() {
			cs.traded[e.breakout] = true
		}
		st.event(s.Date, e.code, EventEntryFilled, "")
	}
}

// markToMarket records each held code's P&L-basis close. A code with no bar
// keeps its last mark, and its missing count rises. On a session where a held
// position's corporate-action exclusion applies, the mark is the pre-suspect
// close instead of the suspect bar's close, so no phantom mark is recorded.
func (st *State) markToMarket(s Session, by map[string]*CodeSession, basis map[string]BarBasis) {
	for _, code := range sortedKeys(st.positions) {
		pos := st.positions[code]
		c := by[code]
		cs := st.codeState(code)
		if c == nil || c.Bar == nil {
			pos.missing++
			pos.flags[FlagStaleMarks] = true
			continue
		}
		pos.missing = 0
		if c.CA.Known && pos.entryDate.Before(c.CA.SuspectDate) {
			cs.lastRaw, cs.lastPL = pos.preSuspect(c.CA.SuspectDate)
		} else {
			cs.lastRaw = c.Bar.Close
			cs.lastPL = float64(c.Bar.Close * cs.mult)
			pos.marks = append(pos.marks, mark{date: s.Date, raw: cs.lastRaw, pl: cs.lastPL})
		}
		cs.lastPLDate = s.Date
		// The entry bar is priced on the same multiplier as its fill, so only the
		// bars after entry can change the position's basis.
		if s.Index > pos.entryIdx {
			if b := basis[code]; b.HasPrev && !b.TotalReturn {
				pos.flags[FlagPriceReturnOnly] = true
			}
		}
	}
}

// accrueCash earns the session's cash rate on the cash held at the close.
func (st *State) accrueCash(s Session) {
	st.cash = float64(st.cash * (1 + DailyRate(s.CashRate)))
}

// decideExits evaluates the data exclusions and the recipe's exits on signal
// prices. A rule's decision fills at the next traded open; a data exclusion or
// a stale exit fills at once.
func (st *State) decideExits(s Session, by map[string]*CodeSession) {
	for _, code := range sortedKeys(st.positions) {
		pos := st.positions[code]
		c := by[code]
		cs := st.codeState(code)

		if c != nil && c.CA.Known && pos.entryDate.Before(c.CA.SuspectDate) {
			delete(st.exits, code)
			raw, pl := pos.preSuspect(c.CA.SuspectDate)
			st.closePosition(s.Date, s.Index, pos, raw, pl, ReasonCorporateAction, s.Date, c.DV20)
			continue
		}
		if c == nil || c.Bar == nil {
			if st.cfg.StaleExitSessions > 0 && pos.missing >= st.cfg.StaleExitSessions {
				reason := ReasonDelisted
				if last, ok := st.cfg.LastLoaded[code]; ok && last.After(cs.lastPLDate) {
					reason = ReasonSuspended
				}
				delete(st.exits, code)
				st.closePosition(s.Date, s.Index, pos, cs.lastRaw, cs.lastPL, reason, s.Date, pos.dv20)
				continue
			}
			// A time stop is decided on its own session, with or without a bar.
			if _, queued := st.exits[code]; !queued {
				for _, r := range st.cfg.ExitRules {
					if r.Kind == spec.ExitTimeStop && timeStopFires(r, pos, s) {
						st.exits[code] = pendingExit{code: code, reason: ReasonTimeStop, signalDate: s.Date, dv20: pos.dv20}
						break
					}
				}
			}
			continue
		}
		if _, queued := st.exits[code]; queued {
			continue
		}
		hit := ""
		for i, r := range st.cfg.ExitRules {
			if fired, why := ruleFires(pos, i, r, s, c); fired && hit == "" {
				hit = why
			}
		}
		if hit != "" {
			st.exits[code] = pendingExit{code: code, reason: hit, signalDate: s.Date, dv20: c.DV20}
		}
	}
}

func timeStopFires(r spec.ExitRule, pos *position, s Session) bool {
	return r.Sessions > 0 && s.Index-pos.entryIdx >= r.Sessions
}

// ruleFires reports whether one exit rule fires at this close, and updates the
// rule's consecutive-close count for the position. The time stop counts sessions
// from entry; the others count consecutive closes, one when the recipe names no
// count. A stop loss takes no count: a single close at or below the stop fires it.
func ruleFires(pos *position, i int, r spec.ExitRule, s Session, c *CodeSession) (bool, string) {
	px := c.Bar.Close
	need := max(r.Sessions, 1)
	switch r.Kind {
	case spec.ExitClosePivot:
		return consecutive(pos, i, need, pos.pivot > 0 && px < pos.pivot), ReasonPivotStop
	case spec.ExitTimeStop:
		return timeStopFires(r, pos, s), ReasonTimeStop
	case spec.ExitStopLoss:
		return consecutive(pos, i, 1, r.Pct > 0 && px <= float64(pos.entryRaw*(1-r.Pct/100))), ReasonStopLoss
	case spec.ExitCloseBelowSMA:
		sma := c.SMA50
		if r.SMA == 200 {
			sma = c.SMA200
		}
		return consecutive(pos, i, need, sma > 0 && px < sma), ReasonSMAStop
	case spec.ExitStatusFalls:
		return consecutive(pos, i, need, containsString(r.Statuses, c.Status)), ReasonStatusExit
	}
	return false, ""
}

// consecutive advances rule i's run of closes that hold, or resets it, and
// reports whether the run has reached need.
func consecutive(pos *position, i, need int, holds bool) bool {
	if holds {
		pos.ruleCount[i]++
	} else {
		pos.ruleCount[i] = 0
	}
	return pos.ruleCount[i] >= need
}

func containsString(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// scheduleEntries queues the candidates that became triggered on this close,
// best score first, up to the free slots. A code is skipped while it is held,
// within its cooldown, within the corporate-action block, or (under the fresh
// rule) when its breakout date was already traded.
func (st *State) scheduleEntries(s Session, by map[string]*CodeSession, codes []string) {
	var cands []pendingEntry
	for _, code := range codes {
		c := by[code]
		cs := st.codeState(code)
		if c.Status != statusTriggered || !cs.hasPrevStatus || cs.prevStatus == statusTriggered {
			continue
		}
		if _, held := st.positions[code]; held {
			continue
		}
		if st.cfg.NewBreakoutOnly && (c.BreakoutDate.IsZero() || cs.traded[c.BreakoutDate]) {
			continue
		}
		if cs.hasExit && s.Index-cs.lastExitIdx < st.cfg.CooldownSessions {
			continue
		}
		if cs.hasCA && s.Index-cs.caKnownIdx >= 0 && s.Index-cs.caKnownIdx <= caBlockSessions {
			continue
		}
		cands = append(cands, pendingEntry{
			code:       code,
			score:      c.Score,
			pivot:      c.Pivot,
			dv20:       c.DV20,
			signalDate: s.Date,
			breakout:   c.BreakoutDate,
		})
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].score != cands[j].score {
			return cands[i].score > cands[j].score
		}
		return cands[i].code < cands[j].code
	})
	free := st.cfg.MaxPositions - st.openNotQueued() - len(st.entries)
	for i := 0; i < len(cands) && i < free; i++ {
		st.entries = append(st.entries, cands[i])
	}
}

// openNotQueued counts the open positions that no exit is queued on: the ones
// that keep a slot. A position queued to exit frees its slot at this close.
func (st *State) openNotQueued() int {
	n := 0
	for code := range st.positions {
		if _, queued := st.exits[code]; !queued {
			n++
		}
	}
	return n
}

// record writes the session's equity and drawdown, and sets the next session's
// sizing base.
func (st *State) record(s Session) {
	invested := 0.0
	for _, code := range sortedKeys(st.positions) {
		invested += float64(st.positions[code].qty * st.codeState(code).lastPL)
	}
	equity := st.cash + invested
	exposure := 0.0
	if equity > 0 {
		exposure = invested / equity
	}
	if equity > st.peak {
		st.peak = equity
	}
	drawdown := 0.0
	if st.peak > 0 {
		drawdown = equity/st.peak - 1
	}
	st.records = append(st.records, Record{
		Date:      s.Date,
		Index:     s.Index,
		Equity:    equity,
		Cash:      st.cash,
		Invested:  invested,
		Exposure:  exposure,
		Drawdown:  drawdown,
		Benchmark: s.Benchmark,
		Reference: s.Reference,
	})
	st.lastEquity = equity
}

// advance keeps the state the next session classifies against: each code's
// last loaded bar and its last status.
func (st *State) advance(s Session, by map[string]*CodeSession) {
	for _, code := range sortedKeys(by) {
		c := by[code]
		cs := st.codeState(code)
		if c.Bar != nil {
			// The bar is dated by the session it was loaded on, so its rounding is
			// priced at that session's quantum.
			cs.prev = *c.Bar
			cs.prev.Date = s.Date
			cs.hasPrev = true
		}
		cs.prevStatus = c.Status
		cs.hasPrevStatus = true
	}
	st.lastIndex = s.Index
}

// closePosition sells the whole position at pl (P&L basis; raw is the same
// price on the signal basis), pays the exit fee, and records the trade. The code
// starts its cooldown from this session.
func (st *State) closePosition(date civil.Date, idx int, pos *position, raw, pl float64, reason string, signalDate civil.Date, dv20 float64) {
	proceeds := float64(pos.qty * pl)
	exitFee := feeFor(st.cfg.Costs, proceeds, dv20)
	st.cash += proceeds - exitFee
	st.trades = append(st.trades, pos.trade(date, idx, raw, pl, reason, signalDate, exitFee, false))
	delete(st.positions, pos.code)
	delete(st.exits, pos.code)
	cs := st.codeState(pos.code)
	cs.lastExitIdx = idx
	cs.hasExit = true
	st.event(date, pos.code, EventExitFilled, reason)
}

func (p *position) trade(date civil.Date, idx int, raw, pl float64, reason string, signalDate civil.Date, exitFee float64, open bool) Trade {
	entry := float64(p.qty * p.entryPL)
	cost := entry + p.entryFee
	exitProceeds := float64(p.qty * pl)
	proceeds := exitProceeds - exitFee + p.dividends
	net := 0.0
	if cost > 0 {
		net = proceeds/cost - 1
	}
	gross := 0.0
	if entry > 0 {
		gross = (exitProceeds+p.dividends)/entry - 1
	}
	flags := make([]string, 0, len(p.flags))
	for f := range p.flags {
		flags = append(flags, f)
	}
	sort.Strings(flags)
	return Trade{
		Code:           p.code,
		SignalDate:     p.signalDate,
		EntryDate:      p.entryDate,
		EntryPrice:     p.entryPL,
		EntryFill:      p.entryRaw,
		Pivot:          p.pivot,
		EntryScore:     p.score,
		ExitSignalDate: signalDate,
		ExitDate:       date,
		ExitPrice:      pl,
		ExitFill:       raw,
		ExitReason:     reason,
		Qty:            p.qty,
		Gross:          gross,
		Net:            net,
		SessionsHeld:   idx - p.entryIdx,
		Dividends:      p.dividends,
		Fees:           p.entryFee + exitFee,
		Flags:          flags,
		OpenAtEnd:      open,
	}
}
