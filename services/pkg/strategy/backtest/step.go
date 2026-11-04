package backtest

import (
	"math"
	"sort"
	"time"
)

// Status labels as the live evaluator names them. They are repeated here
// because this package may not import the engine (the purity rule keeps every
// strategy package to the standard library).
const (
	StatusTriggered = "triggered"
)

// Exit rule kinds, as the recipe names them.
const (
	RuleCloseBelowCapturedPivot = "close_below_captured_pivot"
	RuleTimeStop                = "time_stop"
	RuleStopLoss                = "stop_loss"
	RuleCloseBelowSMA           = "close_below_sma"
	RuleStatusFallsTo           = "status_falls_to"
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

// Bar is one session's OHLC, adjusted close and volume for a code. Present is
// false when the code has no row on the session.
type Bar struct {
	Present                     bool
	Open, High, Low, Close, Adj float64
	Volume                      float64
}

func (b Bar) traded() bool { return b.Present && b.Volume > 0 }

// CASuspect is a corporate-action suspect as it is known on a session.
type CASuspect struct {
	// Known is true on the session the suspect becomes known (ca_known_at).
	Known bool
	// SuspectDate is the bar the suspect sits on. A position entered before it
	// is closed as a data exclusion; one entered on or after it is unaffected.
	SuspectDate time.Time
	// PrePL is the P&L-basis close of the bar before SuspectDate, the price the
	// exclusion closes at.
	PrePL float64
}

// CodeSession is one code's inputs on one session. Signals are as at this
// session's close.
type CodeSession struct {
	Code   string
	Bar    Bar
	Status string
	Score  float64
	// Pivot is the captured pivot (base_high) at this close.
	Pivot float64
	// BreakoutDate is the current breakout date; zero when none.
	BreakoutDate time.Time
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
	Date  time.Time
	Index int
	// CashRate is the annual RBA cash rate forward-filled to this session.
	CashRate             float64
	Benchmark, Reference float64
	Codes                []CodeSession
}

// ExitRule is one exit of the recipe, checked at each close in order; the first
// hit wins and fills at the next traded open.
type ExitRule struct {
	Kind     string
	Sessions int      // time stop: sessions after entry; others: consecutive closes (default 1)
	Pct      float64  // stop loss: exit when close <= entry*(1-Pct/100)
	SMA      int      // close below SMA: 50 or 200
	Statuses []string // status falls to: any of these, on consecutive closes
}

// Config is the recipe's execution parameters.
type Config struct {
	Capital          float64
	WeightPct        float64 // % of equity at the decision's prior close
	MaxPositions     int
	CapacityPctDV20  float64 // notional <= this % of the decision's DV20
	Costs            Costs
	ExitRules        []ExitRule
	CooldownSessions int
	// StaleExitSessions is the run of sessions without a bar after which a
	// position exits at its last close. Zero means the default of 20.
	StaleExitSessions int
	// MaxAbovePivotPct cancels an entry whose open is above pivot*(1+x/100).
	MaxAbovePivotPct *float64
	// NewBreakoutOnly admits a candidate only when its breakout date was never
	// traded in this code (the recipe's fresh rule).
	NewBreakoutOnly bool
	// Price4dpFrom is the first date stored to four decimal places.
	Price4dpFrom time.Time
	// LastLoaded is each code's last loaded bar date. A stale exit is labelled
	// delisted when no later bar exists, and suspended otherwise.
	LastLoaded map[string]time.Time
}

// Trade is one round trip. Prices are on the P&L basis (price x multiplier).
type Trade struct {
	Code           string
	SignalDate     time.Time
	EntryDate      time.Time
	EntryPrice     float64
	Pivot          float64
	EntryScore     float64
	ExitSignalDate time.Time
	ExitDate       time.Time
	ExitPrice      float64
	ExitReason     string
	Qty            float64
	Gross          float64 // price-only return before costs and cash dividends
	Net            float64 // after both sides' costs and cash dividends
	SessionsHeld   int
	Dividends      float64
	Fees           float64
	Flags          []string
	OpenAtEnd      bool
}

// Record is one session's end-of-day state.
type Record struct {
	Date                 time.Time
	Index                int
	Equity, Cash         float64
	Invested             float64
	Exposure             float64 // invested / equity
	Benchmark, Reference float64
}

// Event is a fill, cancellation or dividend, for audit.
type Event struct {
	Date   time.Time
	Code   string
	Kind   string
	Reason string
}

type position struct {
	code       string
	signalDate time.Time
	breakout   time.Time
	entryDate  time.Time
	entryIdx   int
	entryRaw   float64 // signal basis fill, for the stop loss
	entryPL    float64 // P&L basis fill
	qty        float64
	pivot      float64
	score      float64
	dv20       float64
	entryFee   float64
	dividends  float64
	missing    int // consecutive sessions without a bar
	ruleCount  []int
	flags      map[string]bool
}

type pendingEntry struct {
	code       string
	score      float64
	pivot      float64
	dv20       float64
	signalDate time.Time
	breakout   time.Time
}

type pendingExit struct {
	code       string
	reason     string
	signalDate time.Time
	dv20       float64
}

type perCode struct {
	mult          float64
	prev          Bar
	hasPrev       bool
	lastPL        float64
	lastPLDate    time.Time
	prevStatus    string
	hasPrevStatus bool
	lastExitIdx   int
	hasExit       bool
	caKnownIdx    int
	hasCA         bool
	traded        map[int64]bool
}

// State is the simulation's carried state. Create it with NewState and feed it
// sessions in ascending order with Step.
type State struct {
	cfg        Config
	cash       float64
	lastEquity float64
	lastIndex  int
	codes      map[string]*perCode
	positions  map[string]*position
	exits      map[string]pendingExit
	entries    []pendingEntry
	trades     []Trade
	events     []Event
	records    []Record
}

// NewState starts a run with Capital in cash.
func NewState(cfg Config) *State {
	if cfg.StaleExitSessions == 0 {
		cfg.StaleExitSessions = defaultStaleSessions
	}
	return &State{
		cfg:        cfg,
		cash:       cfg.Capital,
		lastEquity: cfg.Capital,
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
// charged an exit cost, and they are excluded from closed-trade statistics.
func (st *State) Finish() []Trade {
	out := append([]Trade(nil), st.trades...)
	var date time.Time
	if n := len(st.records); n > 0 {
		date = st.records[n-1].Date
	}
	for _, code := range sortedKeys(st.positions) {
		pos := st.positions[code]
		out = append(out, pos.trade(date, st.lastIndex, st.codeState(code).lastPL, ReasonOpenAtEnd, pos.signalDate, 0, true))
	}
	return out
}

// Step advances the simulation by one session. The order is fixed: the
// session's bars are classified; exits and entries queued at the previous close
// fill at this open; positions are marked at the close; cash accrues and
// dividends are credited; exits are decided; entries for the next session are
// scheduled; and the session is recorded.
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
		if c.CA.Known && !cs.hasCA {
			cs.hasCA = true
			cs.caKnownIdx = s.Index
		}
		if !c.Bar.Present {
			continue
		}
		b := ClassifyBar(cs.prev, c.Bar, cs.hasPrev, s.Date, st.cfg.Price4dpFrom)
		if b.TotalReturn {
			cs.mult *= math.Exp(b.RK)
		}
		basis[code] = b
	}

	st.fillExits(s, by)
	st.fillEntries(s, by)
	st.markToMarket(s, by, basis)
	st.accrueCash(s, by, basis)
	st.decideExits(s, by)
	st.scheduleEntries(s, by, codes)
	st.record(s)
	st.advance(s, by)
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
		cs = &perCode{mult: 1, traded: map[int64]bool{}}
		st.codes[code] = cs
	}
	return cs
}

func (st *State) event(date time.Time, code, kind, reason string) {
	st.events = append(st.events, Event{Date: date, Code: code, Kind: kind, Reason: reason})
}

// fillPrice is the signal-basis open of a traded bar. An open of zero or less
// falls back to the close.
func fillPrice(b Bar) (float64, bool) {
	if b.Open > 0 {
		return b.Open, false
	}
	return b.Close, true
}

func (st *State) fillExits(s Session, by map[string]*CodeSession) {
	for _, code := range sortedKeys(st.exits) {
		px := st.exits[code]
		pos := st.positions[code]
		if pos == nil {
			delete(st.exits, code)
			continue
		}
		c := by[code]
		if c == nil || !c.Bar.traded() {
			pos.flags[FlagDelayedExit] = true
			st.event(s.Date, code, EventExitDelayed, px.reason)
			continue
		}
		price, fallback := fillPrice(c.Bar)
		if price <= 0 {
			pos.flags[FlagDelayedExit] = true
			st.event(s.Date, code, EventExitDelayed, px.reason)
			continue
		}
		if fallback {
			pos.flags[FlagFallbackClose] = true
		}
		st.closePosition(s.Date, s.Index, pos, price*st.codeState(code).mult, px.reason, px.signalDate, px.dv20)
	}
}

// sizeEntry is the notional an entry buys at the fill, or false when no cash
// can pay for it and its minimum fee. Capacity caps the notional at a share of
// the decision's DV20.
func (st *State) sizeEntry(e pendingEntry) (notional float64, capped, ok bool) {
	want := st.cfg.WeightPct / 100 * st.lastEquity
	if capN := st.cfg.CapacityPctDV20 / 100 * e.dv20; capN < want {
		want = capN
		capped = true
	}
	if want > st.cash {
		want = st.cash
	}
	if want <= 0 {
		return 0, capped, false
	}
	if want+st.cfg.Costs.Fee(want, e.dv20) > st.cash {
		want = st.cash - st.cfg.Costs.Fee(want, e.dv20)
	}
	if want <= 0 || want+st.cfg.Costs.Fee(want, e.dv20) > st.cash {
		return 0, capped, false
	}
	return want, capped, true
}

func (st *State) fillEntries(s Session, by map[string]*CodeSession) {
	pending := st.entries
	st.entries = nil
	for _, e := range pending {
		c := by[e.code]
		if c == nil || !c.Bar.traded() {
			st.event(s.Date, e.code, EventEntryCancelled, CancelUntraded)
			continue
		}
		raw, fallback := fillPrice(c.Bar)
		if raw <= 0 {
			st.event(s.Date, e.code, EventEntryCancelled, CancelUntraded)
			continue
		}
		if limit := st.cfg.MaxAbovePivotPct; limit != nil && raw > e.pivot*(1+*limit/100) {
			st.event(s.Date, e.code, EventEntryCancelled, CancelGap)
			continue
		}
		notional, capped, ok := st.sizeEntry(e)
		if !ok {
			st.event(s.Date, e.code, EventEntryCancelled, CancelCash)
			continue
		}
		cs := st.codeState(e.code)
		pl := raw * cs.mult
		fee := st.cfg.Costs.Fee(notional, e.dv20)
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
		cs.lastPL = pl
		cs.lastPLDate = s.Date
		if !e.breakout.IsZero() {
			cs.traded[e.breakout.Unix()] = true
		}
		st.event(s.Date, e.code, EventEntryFilled, "")
	}
}

// markToMarket records each held code's P&L-basis close. A code with no bar
// keeps its last mark, and its missing count rises.
func (st *State) markToMarket(s Session, by map[string]*CodeSession, basis map[string]BarBasis) {
	for _, code := range sortedKeys(st.positions) {
		pos := st.positions[code]
		c := by[code]
		cs := st.codeState(code)
		if c != nil && c.Bar.Present {
			cs.lastPL = c.Bar.Close * cs.mult
			cs.lastPLDate = s.Date
			pos.missing = 0
			if b := basis[code]; b.HasPrev && !b.TotalReturn {
				pos.flags[FlagPriceReturnOnly] = true
			}
			continue
		}
		pos.missing++
		pos.flags[FlagStaleMarks] = true
	}
}

// accrueCash earns the session's cash rate and credits each held code's cash
// dividend when its bar is unadjusted.
func (st *State) accrueCash(s Session, by map[string]*CodeSession, basis map[string]BarBasis) {
	st.cash *= 1 + DailyRate(s.CashRate)
	for _, code := range sortedKeys(st.positions) {
		c := by[code]
		if c == nil || !c.Bar.Present || c.Dividend <= 0 || !basis[code].Unadjusted {
			continue
		}
		pos := st.positions[code]
		amt := c.Dividend * pos.qty
		st.cash += amt
		pos.dividends += amt
		st.event(s.Date, code, EventDividendCredit, "")
	}
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
			st.closePosition(s.Date, s.Index, pos, c.CA.PrePL, ReasonCorporateAction, s.Date, c.DV20)
			continue
		}
		if c == nil || !c.Bar.Present {
			if st.cfg.StaleExitSessions > 0 && pos.missing >= st.cfg.StaleExitSessions {
				reason := ReasonDelisted
				if last, ok := st.cfg.LastLoaded[code]; ok && last.After(cs.lastPLDate) {
					reason = ReasonSuspended
				}
				delete(st.exits, code)
				st.closePosition(s.Date, s.Index, pos, cs.lastPL, reason, s.Date, pos.dv20)
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

// ruleFires reports whether one exit rule fires at this close, and updates the
// rule's consecutive-close count for the position.
func ruleFires(pos *position, i int, r ExitRule, s Session, c *CodeSession) (bool, string) {
	px := c.Bar.Close
	need := r.Sessions
	if need < 1 {
		need = 1
	}
	switch r.Kind {
	case RuleCloseBelowCapturedPivot:
		return pos.pivot > 0 && px < pos.pivot, ReasonPivotStop
	case RuleTimeStop:
		return r.Sessions > 0 && s.Index-pos.entryIdx >= r.Sessions, ReasonTimeStop
	case RuleStopLoss:
		return r.Pct > 0 && px <= pos.entryRaw*(1-r.Pct/100), ReasonStopLoss
	case RuleCloseBelowSMA:
		sma := c.SMA50
		if r.SMA == 200 {
			sma = c.SMA200
		}
		if sma > 0 && px < sma {
			pos.ruleCount[i]++
		} else {
			pos.ruleCount[i] = 0
		}
		return pos.ruleCount[i] >= need, ReasonSMAStop
	case RuleStatusFallsTo:
		if containsString(r.Statuses, c.Status) {
			pos.ruleCount[i]++
		} else {
			pos.ruleCount[i] = 0
		}
		return pos.ruleCount[i] >= need, ReasonStatusExit
	}
	return false, ""
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
		if c.Status != StatusTriggered || !cs.hasPrevStatus || cs.prevStatus == StatusTriggered {
			continue
		}
		if _, held := st.positions[code]; held {
			continue
		}
		if st.cfg.NewBreakoutOnly && (c.BreakoutDate.IsZero() || cs.traded[c.BreakoutDate.Unix()]) {
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
	free := st.cfg.MaxPositions - st.openNotQueued()
	for i := 0; i < len(cands) && i < free; i++ {
		st.entries = append(st.entries, cands[i])
	}
}

func (st *State) openNotQueued() int {
	n := 0
	for code := range st.positions {
		if _, queued := st.exits[code]; !queued {
			n++
		}
	}
	return n
}

// record writes the session's equity and sets the next session's sizing base.
func (st *State) record(s Session) {
	invested := 0.0
	for _, code := range sortedKeys(st.positions) {
		invested += st.positions[code].qty * st.codeState(code).lastPL
	}
	equity := st.cash + invested
	exposure := 0.0
	if equity > 0 {
		exposure = invested / equity
	}
	st.records = append(st.records, Record{
		Date:      s.Date,
		Index:     s.Index,
		Equity:    equity,
		Cash:      st.cash,
		Invested:  invested,
		Exposure:  exposure,
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
		if c.Bar.Present {
			cs.prev = c.Bar
			cs.hasPrev = true
		}
		cs.prevStatus = c.Status
		cs.hasPrevStatus = true
	}
	st.lastIndex = s.Index
}

// closePosition sells the whole position at price (P&L basis), pays the exit
// fee, and records the trade. The code starts its cooldown from this session.
func (st *State) closePosition(date time.Time, idx int, pos *position, price float64, reason string, signalDate time.Time, dv20 float64) {
	proceeds := pos.qty * price
	fee := st.cfg.Costs.Fee(proceeds, dv20)
	st.cash += proceeds - fee
	st.trades = append(st.trades, pos.trade(date, idx, price, reason, signalDate, fee, false))
	delete(st.positions, pos.code)
	delete(st.exits, pos.code)
	cs := st.codeState(pos.code)
	cs.lastExitIdx = idx
	cs.hasExit = true
	st.event(date, pos.code, EventExitFilled, reason)
}

func (p *position) trade(date time.Time, idx int, price float64, reason string, signalDate time.Time, exitFee float64, open bool) Trade {
	cost := p.qty*p.entryPL + p.entryFee
	proceeds := p.qty*price - exitFee + p.dividends
	net := 0.0
	if cost > 0 {
		net = proceeds/cost - 1
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
		Pivot:          p.pivot,
		EntryScore:     p.score,
		ExitSignalDate: signalDate,
		ExitDate:       date,
		ExitPrice:      price,
		ExitReason:     reason,
		Qty:            p.qty,
		Gross:          price/p.entryPL - 1,
		Net:            net,
		SessionsHeld:   idx - p.entryIdx,
		Dividends:      p.dividends,
		Fees:           p.entryFee + exitFee,
		Flags:          flags,
		OpenAtEnd:      open,
	}
}
