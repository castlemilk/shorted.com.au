package alerts

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/industry"
)

// This file is pure: no I/O, no clock. Plan decides which report dates a run
// evaluates and which watermarks it writes; Evaluate decides which monitors
// fired. Every rule in the alert spec (section 1) lives here, so the table tests
// next to it are the executable form of that spec.

// Date is a report date as YYYY-MM-DD. ISO dates order as strings, so Date
// values compare with < and > directly. The empty Date means "none" or NULL.
type Date string

const (
	dateLayout = "2006-01-02"

	// windowDates is how many of the newest report dates a run loads. The
	// lookbacks (five dates) and the planners all fit inside it.
	windowDates = 20
	// lookbackDates is how many report dates back a previous reading may come
	// from. A code absent from all of them has no previous reading.
	lookbackDates = 5
	// dailyBacklogCap is the most daily dates one run evaluates. More than this
	// means an outage, and only the newest date is evaluated, to avoid a flood.
	dailyBacklogCap = 5
	// weeklyBacklogCap is the most weeks one run evaluates, for the same reason.
	weeklyBacklogCap = 2
	// topTenSize is the size of an industry's ranked set.
	topTenSize = 10
	// storedCompanies caps a payload. The email lists fewer, but the count is kept.
	storedCompanies = 50
)

// Day returns the civil date as a time at UTC midnight.
func (d Date) Day() (time.Time, error) {
	return time.Parse(dateLayout, string(d))
}

// dateOf formats a report date from the database. The timestamp carries no zone,
// so its wall-clock date is the report date.
func dateOf(t time.Time) Date {
	return Date(t.Format(dateLayout))
}

// round2 is r(x) in the spec: two decimal places, which removes float noise
// such as 5.30 - 4.30 = 0.9999999 and matches what the site shows.
func round2(x float64) float64 {
	return math.Round(x*100) / 100
}

// State is alert_evaluator_state: the watermarks. An empty field is NULL.
type State struct {
	DailyThrough  Date
	WeeklyThrough Date
}

// bootstrap reports the first run: nothing has been evaluated yet.
func (s State) bootstrap() bool {
	return s.DailyThrough == "" && s.WeeklyThrough == ""
}

// Monitor is an active alert_monitors row as the evaluator reads it.
type Monitor struct {
	ID        string
	UserID    string
	Email     string // user_email; may be empty
	Scope     string
	Target    string
	Condition string
	Threshold *float64 // nil for new_top_ten_entry
	Cadence   string
	CreatedAt time.Time
}

// CompanyInfo is the metadata the evaluator needs for one code. LogoURL is the
// icon when there is one, else the full logo, and empty when neither exists.
type CompanyInfo struct {
	Name     string
	Industry string
	LogoURL  string
}

// Snapshot is the report window the planner and the evaluator read: the newest
// report dates, each date's readings, and the company metadata.
type Snapshot struct {
	// Dates are the distinct report dates, newest first, at most windowDates.
	Dates []Date
	// SyncUnsettled is true when the newest ASIC sync did not complete (failed,
	// partial or stuck). Its last file may have been cancelled part-way, so the
	// dates it wrote are not trusted yet and planning holds them. The zero value
	// means settled, so a snapshot built without the sync state evaluates as before.
	SyncUnsettled bool

	rows map[Date]map[string]float64 // raw percent by code, per date
	// unranked are codes left out of the market ranking: the product lines the site's
	// top-shorts view also excludes, such as DEFERRED SETTLEMENT.
	unranked map[string]bool
	names    map[string]string
	members  map[string][]string // industry slug -> codes, sorted
	index    map[Date]int        // position of each date in Dates
}

// NewSnapshot indexes a window of readings. rows maps each report date to the
// codes that have a reading that day. companies is the metadata for every code.
func NewSnapshot(dates []Date, rows map[Date]map[string]float64, companies map[string]CompanyInfo) *Snapshot {
	s := &Snapshot{
		Dates:   dates,
		rows:    rows,
		names:   make(map[string]string, len(companies)),
		members: map[string][]string{},
		index:   make(map[Date]int, len(dates)),
	}
	for i, d := range dates {
		s.index[d] = i
	}
	for code, info := range companies {
		s.names[code] = info.Name
		if industry.IsPlaceholder(info.Industry) {
			continue
		}
		slug := industry.Slug(info.Industry)
		if slug == "" {
			continue
		}
		s.members[slug] = append(s.members[slug], code)
	}
	for slug := range s.members {
		sort.Strings(s.members[slug])
	}
	return s
}

// count is how many codes have a reading on d.
func (s *Snapshot) count(d Date) int {
	return len(s.rows[d])
}

// nameOf is the company name, or the code when the metadata has none.
func (s *Snapshot) nameOf(code string) string {
	if n := s.names[code]; n != "" {
		return n
	}
	return code
}

// previousAt is the most recent reading of code in the lookback window that starts
// at index from (newest first), and the report date it was taken on. A daily
// comparison starts at the previous report, so the window is the five dates before
// the one being evaluated. A weekly comparison starts at the previous week's last
// report, so that day is included. A code absent from the first report of the
// window is read from the next one that has it, and the date says which.
func (s *Snapshot) previousAt(code string, from int) (value float64, date Date, ok bool) {
	for i := from; i < len(s.Dates) && i < from+lookbackDates; i++ {
		if v, found := s.rows[s.Dates[i]][code]; found {
			return v, s.Dates[i], true
		}
	}
	return 0, "", false
}

// ranked is the industry's full ranked list on d: every code with a positive
// reading that day, by raw percent descending, ties by code ascending. Index 0 is
// rank 1. It is not capped, so a code's place past the top ten is still a rank.
func (s *Snapshot) ranked(slug string, d Date) []string {
	type entry struct {
		code string
		v    float64
	}
	var list []entry
	for _, code := range s.members[slug] {
		v, ok := s.rows[d][code]
		if !ok || v <= 0 {
			continue
		}
		list = append(list, entry{code, v})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].v != list[j].v {
			return list[i].v > list[j].v
		}
		return list[i].code < list[j].code
	})
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, e.code)
	}
	return out
}

// marketRank is code's place by short percent among every code with a positive
// reading on d, ties broken by code as ranked does. It returns rank 0 when the code
// has no positive reading that day, and the count of codes that do.
func (s *Snapshot) marketRank(code string, d Date) (rank, ranked int) {
	readings := s.rows[d]
	for c, x := range readings {
		if x > 0 && !s.unranked[c] {
			ranked++
		}
	}
	v, ok := readings[code]
	if !ok || v <= 0 || s.unranked[code] {
		return 0, ranked
	}
	rank = 1
	for c, x := range readings {
		if c == code || x <= 0 || s.unranked[c] {
			continue
		}
		if x > v || (x == v && c < code) {
			rank++
		}
	}
	return rank, ranked
}

// topTen is the industry's ranked set on d: the first ten of ranked.
func (s *Snapshot) topTen(slug string, d Date) []string {
	all := s.ranked(slug, d)
	return all[:min(len(all), topTenSize)]
}

// DailyEval is one daily report date to evaluate, against the report before it.
type DailyEval struct {
	Date Date
	// Prev is the previous report, or "" when the window holds none. Such a date
	// is not evaluated: a move needs two readings.
	Prev Date
}

// WeekEval is one complete ISO week to evaluate: its last report against the
// previous week's last report.
type WeekEval struct {
	Date Date // the week's last report
	Prev Date // the previous week's last report; "" when the window does not reach it
}

// Plan is what one run evaluates and where the watermarks move to.
type Plan struct {
	// Bootstrap is the first run. It evaluates nothing and only sets the watermarks,
	// so no backlog of pre-deploy alerts is sent.
	Bootstrap bool
	// Daily is ascending.
	Daily        []DailyEval
	DailySkipped int // dates dropped by the backlog cap
	// Weekly is ascending.
	Weekly        []WeekEval
	WeeklySkipped int // weeks dropped by the backlog cap
	// Held is a daily date the completeness guard, or an unsettled sync, held back,
	// or "". Evaluation stops before it, and its watermark is not advanced past it.
	Held Date
	// HeldBySync is true when the hold is the unsettled sync, not a short date.
	HeldBySync bool
	// Next is the watermark state a commit writes for this plan.
	Next State
}

// PlanRun decides a normal run from the watermarks and the window.
func PlanRun(state State, snap *Snapshot) Plan {
	p := Plan{Next: state}
	if len(snap.Dates) == 0 {
		return p
	}
	if state.bootstrap() {
		p.Bootstrap = true
		p.Next = State{DailyThrough: snap.Dates[0], WeeklyThrough: latestCompleteWeekLast(snap)}
		return p
	}
	p.planDaily(state, snap)
	p.planWeekly(state, snap)
	return p
}

// PlanReplay evaluates one daily report date for an operator replay. It never
// moves a watermark: a replay re-runs a date the watermarks have passed.
func PlanReplay(snap *Snapshot, day Date) (Plan, error) {
	i, ok := snap.index[day]
	if !ok {
		return Plan{}, fmt.Errorf("%s is not one of the last %d report dates", day, windowDates)
	}
	if i+1 >= len(snap.Dates) {
		return Plan{}, fmt.Errorf("%s has no earlier report to compare with", day)
	}
	return Plan{Daily: []DailyEval{{Date: day, Prev: snap.Dates[i+1]}}}, nil
}

func (p *Plan) planDaily(state State, snap *Snapshot) {
	// Fresh dates, oldest first.
	var fresh []int
	for i, v := range slices.Backward(snap.Dates) {
		if state.DailyThrough != "" && v <= state.DailyThrough {
			continue
		}
		fresh = append(fresh, i)
	}
	if len(fresh) > dailyBacklogCap {
		p.DailySkipped = len(fresh) - 1
		fresh = fresh[len(fresh)-1:]
	}
	for _, i := range fresh {
		ev := DailyEval{Date: snap.Dates[i]}
		if i+1 < len(snap.Dates) {
			ev.Prev = snap.Dates[i+1]
		}
		// An unsettled sync may have left any fresh date half-written, so none of
		// them is evaluated until a sync completes.
		if snap.SyncUnsettled {
			p.Held, p.HeldBySync = ev.Date, true
			break
		}
		// Completeness guard. ASIC files are about 800 rows; a half-written day
		// would compare a few codes against a full day and fire on noise.
		if ev.Prev != "" && 2*snap.count(ev.Date) < snap.count(ev.Prev) {
			p.Held = ev.Date
			break
		}
		p.Daily = append(p.Daily, ev)
	}
	if n := len(p.Daily); n > 0 {
		p.Next.DailyThrough = p.Daily[n-1].Date
	}
}

func (p *Plan) planWeekly(state State, snap *Snapshot) {
	ws := weeks(snap)
	// Candidates are complete weeks newer than the watermark, newest first.
	var cand []int
	for i, w := range ws {
		if !w.complete {
			continue
		}
		// Watermarks compare weeks. A week the watermark already covers, including
		// one whose Friday report was backfilled after it was evaluated, is done.
		if state.WeeklyThrough != "" && !laterWeek(w.last, state.WeeklyThrough) {
			continue
		}
		// A week that reaches a held daily date is not evaluated either. Its
		// comparison would read the half-written date, and moving the watermark past
		// the held date would skip the week for good.
		if p.Held != "" && w.last >= p.Held {
			continue
		}
		cand = append(cand, i)
	}
	if len(cand) == 0 {
		return
	}
	if len(cand) > weeklyBacklogCap {
		p.WeeklySkipped = len(cand) - 1
		cand = cand[:1]
	}
	for _, i := range slices.Backward(cand) {
		ev := WeekEval{Date: ws[i].last}
		if i+1 < len(ws) {
			ev.Prev = ws[i+1].last
		}
		p.Weekly = append(p.Weekly, ev)
	}
	p.Next.WeeklyThrough = ws[cand[0]].last
}

// week is one ISO week (Monday to Sunday) that has at least one report.
type week struct {
	last     Date // the newest report in the week
	complete bool
}

// weeks groups the window's report dates by ISO week, newest week first.
//
// A week is complete when a report exists for its last ASX trading day (Friday,
// or Thursday when Friday is a holiday). It is also complete when any report from
// a later week exists, which covers a holiday the calendar does not know and a
// data gap.
func weeks(snap *Snapshot) []week {
	var out []week
	var curMonday string
	for _, d := range snap.Dates {
		t, err := d.Day()
		if err != nil {
			continue
		}
		monday := mondayOf(t).Format(dateLayout)
		if monday != curMonday {
			out = append(out, week{last: d})
			curMonday = monday
		}
	}
	for i := range out {
		t, err := out[i].last.Day()
		if err != nil {
			continue
		}
		td := lastTradingDay(mondayOf(t))
		_, haveTradingDay := snap.index[td]
		out[i].complete = (td != "" && haveTradingDay) || i > 0
	}
	return out
}

// latestCompleteWeekLast is the bootstrap target: the last report of the newest
// complete week, or "" when no week is complete yet.
func latestCompleteWeekLast(snap *Snapshot) Date {
	for _, w := range weeks(snap) {
		if w.complete {
			return w.last
		}
	}
	return ""
}

// laterWeek reports whether report date a falls in a later ISO week than date b.
// Weekly watermarks compare weeks, not dates: a report that lands later in an
// already-evaluated week must not evaluate that week a second time.
func laterWeek(a, b Date) bool {
	ta, errA := a.Day()
	tb, errB := b.Day()
	if errA != nil || errB != nil {
		return a > b
	}
	return mondayOf(ta).After(mondayOf(tb))
}

// mondayOf is the Monday that starts t's ISO week.
func mondayOf(t time.Time) time.Time {
	offset := (int(t.Weekday()) + 6) % 7 // Monday = 0 ... Sunday = 6
	return time.Date(t.Year(), t.Month(), t.Day()-offset, 0, 0, 0, 0, time.UTC)
}

// lastTradingDay scans Friday back to Monday of the week that starts at monday
// and returns the first ASX trading day, or "" when none is one.
func lastTradingDay(monday time.Time) Date {
	for off := 4; off >= 0; off-- {
		d := monday.AddDate(0, 0, off)
		if asxcalendar.IsTradingDay(d) {
			return dateOf(d)
		}
	}
	return ""
}

// Candidate is one monitor that fired on one evaluated date.
type Candidate struct {
	Monitor    Monitor
	ReportDate Date
	ComparedTo Date
	// Latest and Previous are the rounded readings. Stock scope only.
	Latest   *float64
	Previous *float64
	Payload  alertevents.Payload
}

// Evaluate returns every monitor that fired on the plan's dates. Daily monitors
// are checked against the daily dates and weekly monitors against the weeks.
// Output is ordered by plan date, then by the monitors' input order.
func Evaluate(monitors []Monitor, snap *Snapshot, plan Plan) []Candidate {
	var out []Candidate
	for _, m := range monitors {
		switch m.Cadence {
		case alertevents.CadenceDaily:
			for _, ev := range plan.Daily {
				if ev.Prev == "" {
					continue
				}
				if c, ok := evaluateAt(m, snap, ev.Date, ev.Prev); ok {
					out = append(out, c)
				}
			}
		case alertevents.CadenceWeekly:
			for _, ev := range plan.Weekly {
				if ev.Prev == "" {
					continue
				}
				if c, ok := evaluateAt(m, snap, ev.Date, ev.Prev); ok {
					out = append(out, c)
				}
			}
		}
	}
	return out
}

// move is one code's reading across the two compared dates, rounded.
type move struct {
	code         string
	name         string
	latest       float64
	previous     float64
	previousDate Date // the report the previous reading was taken on
	change       float64
}

// move reads code at latest and at its previous reading in the window that starts
// at prevIdx. It returns false when either reading is missing: a code needs two
// readings to move at all.
func (s *Snapshot) move(code string, latestDate Date, prevIdx int) (move, bool) {
	cur, ok := s.rows[latestDate][code]
	if !ok {
		return move{}, false
	}
	prev, prevDate, ok := s.previousAt(code, prevIdx)
	if !ok {
		return move{}, false
	}
	l, p := round2(cur), round2(prev)
	return move{code: code, name: s.nameOf(code), latest: l, previous: p, previousDate: prevDate, change: round2(l - p)}, true
}

// satisfies applies a stock-scope rule to one move. Crossing is upward only:
// being above the threshold at both dates does not fire. A rise must be at least
// the threshold, and a fall never fires.
func (m move) satisfies(condition string, threshold float64) bool {
	switch condition {
	case alertevents.ConditionShortInterestAbove:
		return m.previous < threshold && threshold <= m.latest
	case alertevents.ConditionShortInterestRises:
		return m.change >= threshold
	}
	return false
}

// company converts a move into a payload entry, with its ranks (0 = not ranked).
func (m move) company(rank, previousRank int) alertevents.Company {
	prev, change := m.previous, m.change
	return alertevents.Company{
		Code:         m.code,
		Name:         m.name,
		Latest:       m.latest,
		Previous:     &prev,
		Change:       &change,
		Rank:         rank,
		PreviousRank: previousRank,
		PreviousDate: string(m.previousDate),
	}
}

// evaluateAt decides one monitor on one compared pair of dates. latestDate is the
// report evaluated and prevDate the one it is compared with.
func evaluateAt(m Monitor, snap *Snapshot, latestDate, prevDate Date) (Candidate, bool) {
	prevIdx, ok := snap.index[prevDate]
	if !ok {
		return Candidate{}, false
	}
	c := Candidate{Monitor: m, ReportDate: latestDate, ComparedTo: prevDate}

	switch m.Scope {
	case alertevents.ScopeStock:
		if m.Threshold == nil {
			return Candidate{}, false
		}
		mv, ok := snap.move(m.Target, latestDate, prevIdx)
		if !ok || !mv.satisfies(m.Condition, *m.Threshold) {
			return Candidate{}, false
		}
		latest, previous := mv.latest, mv.previous
		c.Latest, c.Previous = &latest, &previous
		c.Payload = payload([]alertevents.Company{mv.company(0, 0)})
		return c, true

	case alertevents.ScopeIndustry:
		if industry.IsPlaceholder(m.Target) {
			return Candidate{}, false
		}
		slug := industry.Slug(m.Target)
		if m.Condition == alertevents.ConditionNewTopTenEntry {
			companies := snap.topTenEntrants(slug, latestDate, prevIdx)
			if len(companies) == 0 {
				return Candidate{}, false
			}
			c.Payload = payload(companies)
			return c, true
		}
		if m.Threshold == nil {
			return Candidate{}, false
		}
		var moves []move
		for _, code := range snap.members[slug] {
			if mv, ok := snap.move(code, latestDate, prevIdx); ok && mv.satisfies(m.Condition, *m.Threshold) {
				moves = append(moves, mv)
			}
		}
		if len(moves) == 0 {
			return Candidate{}, false
		}
		sortMoves(moves, m.Condition)
		companies := make([]alertevents.Company, 0, len(moves))
		for _, mv := range moves {
			companies = append(companies, mv.company(0, 0))
		}
		c.Payload = payload(companies)
		return c, true
	}
	return Candidate{}, false
}

// sortMoves orders crossers by latest reading for an "above" rule and by change
// for a "rises" rule, both descending, ties by code ascending.
func sortMoves(moves []move, condition string) {
	sort.SliceStable(moves, func(i, j int) bool {
		a, b := moves[i], moves[j]
		if condition == alertevents.ConditionShortInterestRises {
			if a.change != b.change {
				return a.change > b.change
			}
		} else if a.latest != b.latest {
			return a.latest > b.latest
		}
		return a.code < b.code
	})
}

// topTenEntrants returns the codes that entered the industry's top ten on latestDate,
// in rank order. prevIdx is the index of the compared report.
//
// A code is an entrant when it is in the top ten on latestDate and was not in it on
// its most recent earlier reading. That reading is taken from the same lookback
// window the stock rules use, so a code missing from the compared report is judged
// by the report before it that has it: if it was in the top ten there, it did not
// enter. A code with no reading in the window has only one reading, and a company
// needs two readings before it can fire, so it is not an entrant.
//
// PreviousRank is the code's place in the full ranking on that earlier reading, so a
// company ranked 11th or lower then reads as 11 or lower. It is 0 only when the code
// had no positive reading that day. PreviousDate names the report it was taken on.
func (s *Snapshot) topTenEntrants(slug string, latestDate Date, prevIdx int) []alertevents.Company {
	var out []alertevents.Company
	for i, code := range s.topTen(slug, latestDate) {
		prev, prevDay, ok := s.previousAt(code, prevIdx)
		if !ok {
			continue
		}
		if s.inTopTen(slug, prevDay, code) {
			continue
		}
		latest := round2(s.rows[latestDate][code])
		p := round2(prev)
		ch := round2(latest - p)
		out = append(out, alertevents.Company{
			Code:         code,
			Name:         s.nameOf(code),
			Latest:       latest,
			Previous:     &p,
			Change:       &ch,
			Rank:         i + 1,
			PreviousRank: s.rankOn(slug, prevDay, code),
			PreviousDate: string(prevDay),
		})
	}
	return out
}

// inTopTen reports whether code is among the industry's top ten on d.
func (s *Snapshot) inTopTen(slug string, d Date, code string) bool {
	return slices.Contains(s.topTen(slug, d), code)
}

// rankOn is code's place in the industry's full ranking on d, or 0 when it has no
// positive reading that day.
func (s *Snapshot) rankOn(slug string, d Date, code string) int {
	for i, c := range s.ranked(slug, d) {
		if c == code {
			return i + 1
		}
	}
	return 0
}

// payload stores up to storedCompanies companies and the full count.
func payload(companies []alertevents.Company) alertevents.Payload {
	total := len(companies)
	if total > storedCompanies {
		companies = companies[:storedCompanies]
	}
	if companies == nil {
		companies = []alertevents.Company{}
	}
	return alertevents.Payload{Companies: companies, CompaniesTotal: total}
}
