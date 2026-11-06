package backtest

import (
	"encoding/json"
	"fmt"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// The paper track (5.13) steps one session at a time from stored snapshot rows,
// so the simulator's state must survive from one daily run to the next. A
// checkpoint is that state: everything Step reads before it steps the next
// session, and nothing it only writes out. Trades, events and records are the
// outputs; the paper track stores them as rows and does not carry them.
//
// A restored State steps exactly as the one that wrote the checkpoint: the
// round trip is exact because the floats are written in their shortest
// round-trip form and the dates in their text form.

// checkpointVersion names the layout. A reader refuses any other value rather
// than guessing at a field it does not know.
const checkpointVersion = 1

type checkpoint struct {
	Version      int                       `json:"version"`
	Cash         float64                   `json:"cash"`
	LastEquity   float64                   `json:"last_equity"`
	Peak         float64                   `json:"peak"`
	LastIndex    int                       `json:"last_index"`
	DividendsDue float64                   `json:"dividends_due"`
	Codes        map[string]codeCheckpoint `json:"codes"`
	Positions    []positionCheckpoint      `json:"positions"`
	Exits        []exitCheckpoint          `json:"exits"`
	Entries      []entryCheckpoint         `json:"entries"`
}

type barCheckpoint struct {
	Date string  `json:"date"`
	O    float64 `json:"o"`
	H    float64 `json:"h"`
	L    float64 `json:"l"`
	C    float64 `json:"c"`
	Adj  float64 `json:"adj"`
	V    float64 `json:"v"`
}

type codeCheckpoint struct {
	Mult          float64       `json:"mult"`
	Prev          barCheckpoint `json:"prev"`
	HasPrev       bool          `json:"has_prev"`
	LastRaw       float64       `json:"last_raw"`
	LastPL        float64       `json:"last_pl"`
	LastPLDate    string        `json:"last_pl_date"`
	PrevStatus    string        `json:"prev_status"`
	HasPrevStatus bool          `json:"has_prev_status"`
	LastExitIdx   int           `json:"last_exit_idx"`
	HasExit       bool          `json:"has_exit"`
	CAKnownIdx    int           `json:"ca_known_idx"`
	HasCA         bool          `json:"has_ca"`
	Traded        []string      `json:"traded"`
}

type markCheckpoint struct {
	Date string  `json:"date"`
	Raw  float64 `json:"raw"`
	PL   float64 `json:"pl"`
}

type positionCheckpoint struct {
	Code       string           `json:"code"`
	SignalDate string           `json:"signal_date"`
	Breakout   string           `json:"breakout"`
	EntryDate  string           `json:"entry_date"`
	EntryIdx   int              `json:"entry_idx"`
	EntryRaw   float64          `json:"entry_raw"`
	EntryPL    float64          `json:"entry_pl"`
	Qty        float64          `json:"qty"`
	Pivot      float64          `json:"pivot"`
	Score      float64          `json:"score"`
	DV20       float64          `json:"dv20"`
	EntryFee   float64          `json:"entry_fee"`
	Dividends  float64          `json:"dividends"`
	Missing    int              `json:"missing"`
	RuleCount  []int            `json:"rule_count"`
	Flags      []string         `json:"flags"`
	Marks      []markCheckpoint `json:"marks"`
}

type exitCheckpoint struct {
	Code       string  `json:"code"`
	Reason     string  `json:"reason"`
	SignalDate string  `json:"signal_date"`
	DV20       float64 `json:"dv20"`
}

type entryCheckpoint struct {
	Code       string  `json:"code"`
	Score      float64 `json:"score"`
	Pivot      float64 `json:"pivot"`
	DV20       float64 `json:"dv20"`
	SignalDate string  `json:"signal_date"`
	Breakout   string  `json:"breakout"`
	Lag        int     `json:"lag"`
}

// dateText is a civil date as text, or "" for the zero date. civil.Date's own
// text form has no parse for the zero date, so a checkpoint must not use it.
func dateText(d civil.Date) string {
	if d.IsZero() {
		return ""
	}
	return d.String()
}

func parseDateText(s string) (civil.Date, error) {
	if s == "" {
		return civil.Date{}, nil
	}
	d, err := civil.ParseDate(s)
	if err != nil {
		return civil.Date{}, fmt.Errorf("checkpoint date %q: %w", s, err)
	}
	return d, nil
}

// Checkpoint returns the state Step carries into the next session, as JSON. A
// checkpoint is a function of the state alone: the same state always gives the
// same bytes.
func (st *State) Checkpoint() ([]byte, error) {
	cp := checkpoint{
		Version:      checkpointVersion,
		Cash:         st.cash,
		LastEquity:   st.lastEquity,
		Peak:         st.peak,
		LastIndex:    st.lastIndex,
		DividendsDue: st.dividendsDue,
		Codes:        make(map[string]codeCheckpoint, len(st.codes)),
	}
	for code, cs := range st.codes {
		cc := codeCheckpoint{
			Mult:          cs.mult,
			Prev:          barToCheckpoint(cs.prev),
			HasPrev:       cs.hasPrev,
			LastRaw:       cs.lastRaw,
			LastPL:        cs.lastPL,
			LastPLDate:    dateText(cs.lastPLDate),
			PrevStatus:    cs.prevStatus,
			HasPrevStatus: cs.hasPrevStatus,
			LastExitIdx:   cs.lastExitIdx,
			HasExit:       cs.hasExit,
			CAKnownIdx:    cs.caKnownIdx,
			HasCA:         cs.hasCA,
		}
		for d := range cs.traded {
			cc.Traded = append(cc.Traded, d.String())
		}
		sort.Strings(cc.Traded)
		cp.Codes[code] = cc
	}
	for _, code := range sortedKeys(st.positions) {
		cp.Positions = append(cp.Positions, positionToCheckpoint(st.positions[code]))
	}
	for _, code := range sortedKeys(st.exits) {
		px := st.exits[code]
		cp.Exits = append(cp.Exits, exitCheckpoint{Code: px.code, Reason: px.reason, SignalDate: dateText(px.signalDate), DV20: px.dv20})
	}
	for _, e := range st.entries {
		cp.Entries = append(cp.Entries, entryCheckpoint{
			Code: e.code, Score: e.score, Pivot: e.pivot, DV20: e.dv20,
			SignalDate: dateText(e.signalDate), Breakout: dateText(e.breakout), Lag: e.lag,
		})
	}
	raw, err := json.Marshal(cp)
	if err != nil {
		return nil, fmt.Errorf("encode the simulator checkpoint: %w", err)
	}
	return raw, nil
}

// RestoreState returns the state a Checkpoint wrote, under the configuration
// cfg. cfg must be the configuration the checkpointed run used: the checkpoint
// holds no recipe. Trades, events and records start empty, so after a restore
// Closed, Events and Records describe only the sessions stepped since.
func RestoreState(cfg Config, raw []byte) (*State, error) {
	var cp checkpoint
	if err := json.Unmarshal(raw, &cp); err != nil {
		return nil, fmt.Errorf("decode the simulator checkpoint: %w", err)
	}
	if cp.Version != checkpointVersion {
		return nil, fmt.Errorf("simulator checkpoint version %d; this build reads %d", cp.Version, checkpointVersion)
	}
	st := NewState(cfg)
	st.cash = cp.Cash
	st.lastEquity = cp.LastEquity
	st.peak = cp.Peak
	st.lastIndex = cp.LastIndex
	st.dividendsDue = cp.DividendsDue
	for code, cc := range cp.Codes {
		cs := &perCode{
			mult:          cc.Mult,
			prev:          checkpointToBar(cc.Prev),
			hasPrev:       cc.HasPrev,
			lastRaw:       cc.LastRaw,
			lastPL:        cc.LastPL,
			prevStatus:    cc.PrevStatus,
			hasPrevStatus: cc.HasPrevStatus,
			lastExitIdx:   cc.LastExitIdx,
			hasExit:       cc.HasExit,
			caKnownIdx:    cc.CAKnownIdx,
			hasCA:         cc.HasCA,
			traded:        map[civil.Date]bool{},
		}
		var err error
		if cs.lastPLDate, err = parseDateText(cc.LastPLDate); err != nil {
			return nil, err
		}
		if cs.prev.Date, err = parseDateText(cc.Prev.Date); err != nil {
			return nil, err
		}
		for _, t := range cc.Traded {
			d, err := parseDateText(t)
			if err != nil {
				return nil, err
			}
			cs.traded[d] = true
		}
		st.codes[code] = cs
	}
	for _, pc := range cp.Positions {
		pos, err := positionFromCheckpoint(pc)
		if err != nil {
			return nil, err
		}
		st.positions[pc.Code] = pos
	}
	for _, xc := range cp.Exits {
		d, err := parseDateText(xc.SignalDate)
		if err != nil {
			return nil, err
		}
		st.exits[xc.Code] = pendingExit{code: xc.Code, reason: xc.Reason, signalDate: d, dv20: xc.DV20}
	}
	for _, ec := range cp.Entries {
		signal, err := parseDateText(ec.SignalDate)
		if err != nil {
			return nil, err
		}
		breakout, err := parseDateText(ec.Breakout)
		if err != nil {
			return nil, err
		}
		st.entries = append(st.entries, pendingEntry{
			code: ec.Code, score: ec.Score, pivot: ec.Pivot, dv20: ec.DV20,
			signalDate: signal, breakout: breakout, lag: ec.Lag,
		})
	}
	return st, nil
}

func barToCheckpoint(b features.Bar) barCheckpoint {
	return barCheckpoint{Date: dateText(b.Date), O: b.Open, H: b.High, L: b.Low, C: b.Close, Adj: b.AdjClose, V: b.Volume}
}

func checkpointToBar(b barCheckpoint) features.Bar {
	return features.Bar{Open: b.O, High: b.H, Low: b.L, Close: b.C, AdjClose: b.Adj, Volume: b.V}
}

func positionToCheckpoint(p *position) positionCheckpoint {
	pc := positionCheckpoint{
		Code: p.code, SignalDate: dateText(p.signalDate), Breakout: dateText(p.breakout),
		EntryDate: dateText(p.entryDate), EntryIdx: p.entryIdx, EntryRaw: p.entryRaw,
		EntryPL: p.entryPL, Qty: p.qty, Pivot: p.pivot, Score: p.score, DV20: p.dv20,
		EntryFee: p.entryFee, Dividends: p.dividends, Missing: p.missing,
		RuleCount: append([]int{}, p.ruleCount...),
	}
	for f, on := range p.flags {
		if on {
			pc.Flags = append(pc.Flags, f)
		}
	}
	sort.Strings(pc.Flags)
	for _, m := range p.marks {
		pc.Marks = append(pc.Marks, markCheckpoint{Date: dateText(m.date), Raw: m.raw, PL: m.pl})
	}
	return pc
}

func positionFromCheckpoint(pc positionCheckpoint) (*position, error) {
	signal, err := parseDateText(pc.SignalDate)
	if err != nil {
		return nil, err
	}
	breakout, err := parseDateText(pc.Breakout)
	if err != nil {
		return nil, err
	}
	entry, err := parseDateText(pc.EntryDate)
	if err != nil {
		return nil, err
	}
	p := &position{
		code: pc.Code, signalDate: signal, breakout: breakout, entryDate: entry,
		entryIdx: pc.EntryIdx, entryRaw: pc.EntryRaw, entryPL: pc.EntryPL, qty: pc.Qty,
		pivot: pc.Pivot, score: pc.Score, dv20: pc.DV20, entryFee: pc.EntryFee,
		dividends: pc.Dividends, missing: pc.Missing,
		ruleCount: append([]int{}, pc.RuleCount...),
		flags:     map[string]bool{},
	}
	for _, f := range pc.Flags {
		p.flags[f] = true
	}
	for _, m := range pc.Marks {
		d, err := parseDateText(m.Date)
		if err != nil {
			return nil, err
		}
		p.marks = append(p.marks, mark{date: d, raw: m.Raw, pl: m.PL})
	}
	return p, nil
}

// Closed returns the round trips closed since the state was created or
// restored, in the order they closed.
func (st *State) Closed() []Trade { return append([]Trade(nil), st.trades...) }

// Holding is an open position as the paper track records it: the entry fill on
// the signal basis, the quantity, the captured pivot, and any exit queued on it.
type Holding struct {
	Code           string
	SignalDate     civil.Date
	EntryDate      civil.Date
	EntryFill      float64
	Quantity       float64
	Pivot          float64
	Score          float64
	Flags          []string
	ExitPending    bool
	ExitSignalDate civil.Date
	ExitReason     string
}

// Holdings returns the open positions, by code.
func (st *State) Holdings() []Holding {
	var out []Holding
	for _, code := range sortedKeys(st.positions) {
		p := st.positions[code]
		h := Holding{
			Code: p.code, SignalDate: p.signalDate, EntryDate: p.entryDate, EntryFill: p.entryRaw,
			Quantity: p.qty, Pivot: p.pivot, Score: p.score,
		}
		for f, on := range p.flags {
			if on {
				h.Flags = append(h.Flags, f)
			}
		}
		sort.Strings(h.Flags)
		if px, queued := st.exits[code]; queued {
			h.ExitPending = true
			h.ExitSignalDate = px.signalDate
			h.ExitReason = px.reason
		}
		out = append(out, h)
	}
	return out
}

// PendingEntry is an entry scheduled for the session after its signal, not yet
// filled or cancelled.
type PendingEntry struct {
	Code       string
	SignalDate civil.Date
	Breakout   civil.Date
	Pivot      float64
	Score      float64
}

// PendingEntries returns the scheduled entries, in the order they were scheduled.
func (st *State) PendingEntries() []PendingEntry {
	out := make([]PendingEntry, 0, len(st.entries))
	for _, e := range st.entries {
		out = append(out, PendingEntry{Code: e.code, SignalDate: e.signalDate, Breakout: e.breakout, Pivot: e.pivot, Score: e.score})
	}
	return out
}

// CashRateFraction is the RBA cash rate target on t as an annual fraction, the
// rate Session.CashRate takes (0.0435 for 4.35%), forward-filled from the stored
// points as the batch run fills them.
func CashRateFraction(points []features.RatePoint, t civil.Date) float64 {
	return rateOn(points, t) / 100
}

// LastIndex is the session index the state last stepped on: the index the next
// session takes one more than.
func (st *State) LastIndex() int { return st.lastIndex }
