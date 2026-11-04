package shorts

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"golang.org/x/sync/singleflight"
)

// The index fund flow (spec 14.10): what the tracked index funds did between two
// dates, per stock, read by the map. A fund's position at a date is its newest
// file on or before it. A change compares a fund only with itself: its file at
// the window's start (or its first file inside the window) against its newest
// file at the end. A fund whose first file falls inside the window is therefore
// never read as new money. Shares are compared, and the change is valued at the
// later file's price, so a price move is not a position move.

// validFundDate reports whether d is a YYYY-MM-DD date.
func validFundDate(d string) bool {
	if len(d) != len(time.DateOnly) {
		return false
	}
	_, err := time.Parse(time.DateOnly, d)
	return err == nil
}

// fundFlowFund is one fund's files, oldest first.
type fundFlowFund struct {
	slug, name, code, sourceKind string
	files                        []shortsstore.FundSnapshotRow
}

// at is the fund's newest file on or before d, or nil.
func (f *fundFlowFund) at(d string) *shortsstore.FundSnapshotRow {
	i := sort.Search(len(f.files), func(i int) bool { return f.files[i].AsAt > d })
	if i == 0 {
		return nil
	}
	return &f.files[i-1]
}

// startIn is the file a window's change starts from: the newest on or before
// from, else the oldest inside the window, else nil.
func (f *fundFlowFund) startIn(from, to string) *shortsstore.FundSnapshotRow {
	if s := f.at(from); s != nil {
		return s
	}
	i := sort.Search(len(f.files), func(i int) bool { return f.files[i].AsAt >= from })
	if i < len(f.files) && f.files[i].AsAt <= to {
		return &f.files[i]
	}
	return nil
}

// fundIndex is every fund's files, indexed by fund and by file id. It is
// immutable once built.
type fundIndex struct {
	funds      []*fundFlowFund // by slug, then fund name
	fundBySnap map[int64]*fundFlowFund
}

// newFundIndex groups the files by fund, one file per date. It is pure.
func newFundIndex(snaps []shortsstore.FundSnapshotRow) *fundIndex {
	idx := &fundIndex{fundBySnap: map[int64]*fundFlowFund{}}
	byKey := map[string]*fundFlowFund{}
	for _, s := range snaps {
		if !validFundDate(s.AsAt) {
			continue
		}
		key := s.InstitutionSlug + "|" + s.FundName
		f := byKey[key]
		if f == nil {
			f = &fundFlowFund{slug: s.InstitutionSlug, name: s.FundName, code: s.FundCode, sourceKind: s.SourceKind}
			byKey[key] = f
			idx.funds = append(idx.funds, f)
		}
		f.files = append(f.files, s)
		idx.fundBySnap[s.ID] = f
	}
	for _, f := range idx.funds {
		sort.SliceStable(f.files, func(i, j int) bool {
			if f.files[i].AsAt != f.files[j].AsAt {
				return f.files[i].AsAt < f.files[j].AsAt
			}
			return f.files[i].ID < f.files[j].ID
		})
		// One file per date: a re-run rewrites its row, so two ids on one date
		// are not expected, and the later id wins if they occur.
		dedup := f.files[:0]
		for i, s := range f.files {
			if i+1 < len(f.files) && f.files[i+1].AsAt == s.AsAt {
				continue
			}
			dedup = append(dedup, s)
		}
		f.files = dedup
		if f.code == "" && len(f.files) > 0 {
			f.code = f.files[len(f.files)-1].FundCode
		}
	}
	sort.Slice(idx.funds, func(i, j int) bool {
		if idx.funds[i].slug != idx.funds[j].slug {
			return idx.funds[i].slug < idx.funds[j].slug
		}
		return idx.funds[i].name < idx.funds[j].name
	})
	return idx
}

// changePrice is the price a change row's shares are valued at, and whether the row
// has one: the end's priced price (the sum of its value over its priced units), or
// the start's when the position is gone. ok is false when the row is left out: a
// row with no units on either side, a side whose file holds a row for the stock
// with no units (a value alone, or neither figure, is never a holding of none), or
// no priced row for the side that prices it. A row stating a value alone counts
// only in fund_value_aud, and its start is left out too.
func changePrice(r shortsstore.FundHoldingChangeRow) (price float64, ok bool) {
	if !r.HasUnitsFrom && !r.HasUnitsTo {
		return 0, false
	}
	if (r.RowFrom && !r.HasUnitsFrom) || (r.RowTo && !r.HasUnitsTo) {
		return 0, false
	}
	switch {
	case r.UnitsTo > 0:
		if r.PricedUnitsTo <= 0 {
			return 0, false
		}
		return r.UnitValueTo / r.PricedUnitsTo, true
	case r.UnitsFrom > 0:
		if r.PricedUnitsFrom <= 0 {
			return 0, false
		}
		return r.UnitValueFrom / r.PricedUnitsFrom, true
	}
	return 0, true
}

// changeFlow values one change row: the change in shares at changePrice (the
// earlier file's price for a position gone), and startAtEnd, the earlier shares at
// that price. ok is false when the row is left out (see changePrice), so it never
// sets a figure.
func changeFlow(r shortsstore.FundHoldingChangeRow) (flow, startAtEnd float64, ok bool) {
	price, ok := changePrice(r)
	if !ok {
		return 0, 0, false
	}
	return (r.UnitsTo - r.UnitsFrom) * price, r.UnitsFrom * price, true
}

// windowGroup is the group of the window's own pairs; the window has no buckets.
const windowGroup int32 = -1

// fundWindow is the index funds' comparison over one window: the pairs whose
// changes are read, the end files whose holdings are read, and the as-at ranges
// of both sides.
type fundWindow struct {
	pairs                              []shortsstore.FundSnapshotPair
	endIDs                             []int64
	compared                           int
	startFrom, startTo, endFrom, endTo string
}

// widen extends the range [lo, hi] to cover d; an empty lo takes d.
func widen(lo, hi *string, d string) {
	if *lo == "" || d < *lo {
		*lo = d
	}
	if d > *hi {
		*hi = d
	}
}

// pairsFor compares each index fund with itself across [from, to]. Only the
// index funds (etf) count; a super option's files are not compared.
func (idx *fundIndex) pairsFor(from, to string) fundWindow {
	var w fundWindow
	if to == "" {
		return w
	}
	for _, f := range idx.funds {
		if f.sourceKind != "etf" {
			continue
		}
		end := f.at(to)
		if end == nil {
			continue
		}
		w.endIDs = append(w.endIDs, end.ID)
		widen(&w.endFrom, &w.endTo, end.AsAt)
		start := f.startIn(from, to)
		if start == nil || start.AsAt >= end.AsAt {
			continue
		}
		w.compared++
		widen(&w.startFrom, &w.startTo, start.AsAt)
		w.pairs = append(w.pairs, shortsstore.FundSnapshotPair{Group: windowGroup, From: start.ID, To: end.ID})
	}
	return w
}

// pairsByGroup numbers each pair as its own group, so the store reads each pair's
// change apart from the others (its row, its price, its exclusion).
func pairsByGroup(pairs []shortsstore.FundSnapshotPair) []shortsstore.FundSnapshotPair {
	out := make([]shortsstore.FundSnapshotPair, len(pairs))
	for i, p := range pairs {
		p.Group = int32(i)
		out[i] = p
	}
	return out
}

// indexFundStock is one stock's index fund figures in a window.
type indexFundStock struct {
	value, startAtEnd, flow float64
	hasValue, hasFlow       bool
}

// indexFundFigures are the index funds' figures over one window: per stock, the
// holdings at the window's end and the change the compared funds show, and the
// compared count and file ranges beside them.
type indexFundFigures struct {
	stocks                             map[string]*indexFundStock
	fundsCompared                      int
	startFrom, startTo, endFrom, endTo string
}

// fundFlowReader is the two reads a window's figures need. A nil reader has no
// fund figures.
type fundFlowReader interface {
	FundSnapshotHoldings(ctx context.Context, snapshotIDs []int64, stockCode string) ([]shortsstore.FundSnapshotHoldingRow, error)
	FundHoldingChanges(ctx context.Context, pairs []shortsstore.FundSnapshotPair, stockCodes []string) ([]shortsstore.FundHoldingChangeRow, error)
}

// computeIndexFunds reads the window's end holdings and changes and values them.
func computeIndexFunds(ctx context.Context, idx *fundIndex, store fundFlowReader, from, to string) (indexFundFigures, error) {
	wp := idx.pairsFor(from, to)
	out := indexFundFigures{
		stocks:        map[string]*indexFundStock{},
		fundsCompared: wp.compared,
		startFrom:     wp.startFrom, startTo: wp.startTo, endFrom: wp.endFrom, endTo: wp.endTo,
	}
	if store == nil || len(wp.endIDs) == 0 {
		return out, nil
	}
	endRows, err := store.FundSnapshotHoldings(ctx, wp.endIDs, "")
	if err != nil {
		return out, err
	}
	// Each pair is its own group: a fund's change is priced at its own later file and
	// left out on its own when its file states a value alone, so one fund's row never
	// decides another's (spec 14.10).
	changes, err := store.FundHoldingChanges(ctx, pairsByGroup(wp.pairs), nil)
	if err != nil {
		return out, err
	}
	get := func(code string) *indexFundStock {
		a := out.stocks[code]
		if a == nil {
			a = &indexFundStock{}
			out.stocks[code] = a
		}
		return a
	}
	for _, r := range endRows {
		if f := idx.fundBySnap[r.SnapshotID]; f == nil || f.sourceKind != "etf" {
			continue
		}
		a := get(r.StockCode)
		if r.Value != nil {
			a.value += *r.Value
			a.hasValue = true
		}
	}
	for _, r := range changes {
		flow, startAtEnd, ok := changeFlow(r)
		if !ok {
			continue
		}
		a := get(r.StockCode)
		a.flow += flow
		a.startAtEnd += startAtEnd
		a.hasFlow = true
	}
	return out, nil
}

// fundFlowHolder keeps the fund index of one universe generation, so the map
// reads the fund files' index once per generation. Its zero value is ready.
type fundFlowHolder struct {
	mu  sync.Mutex
	gen int64
	idx *fundIndex
	sf  singleflight.Group
}

// get returns the generation's index, building it once for every caller that
// arrives while it builds.
func (h *fundFlowHolder) get(gen int64, build func() (*fundIndex, error)) (*fundIndex, error) {
	h.mu.Lock()
	if h.gen != gen {
		h.gen, h.idx = gen, nil
	}
	if idx := h.idx; idx != nil {
		h.mu.Unlock()
		return idx, nil
	}
	h.mu.Unlock()
	v, err, _ := h.sf.Do(fmt.Sprintf("index|%d", gen), func() (any, error) {
		idx, err := build()
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		if h.gen == gen {
			h.idx = idx
		}
		h.mu.Unlock()
		return idx, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*fundIndex), nil
}

// fundIndexFor is the fund index of the generation: held by the server when it
// has a holder, else built for the request.
func (s *ShortsServer) fundIndexFor(ctx context.Context, gen int64, fs shortsstore.OwnershipFundFlowStore) (*fundIndex, error) {
	build := func() (*fundIndex, error) {
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownershipBuildTimeout)
		defer cancel()
		snaps, err := fs.FundSnapshots(bctx)
		if err != nil {
			return nil, err
		}
		return newFundIndex(snaps), nil
	}
	if s.ownershipFundFlow == nil {
		return build()
	}
	return s.ownershipFundFlow.get(gen, build)
}

// indexFundsFor is the window's index fund figures. A store without the fund
// reads, or a database without 000137, has none.
func (s *ShortsServer) indexFundsFor(ctx context.Context, u *ownershipUniverse, from, to string) (indexFundFigures, error) {
	fs, _ := s.ownershipStore.(shortsstore.OwnershipFundFlowStore)
	if fs == nil {
		return computeIndexFunds(ctx, &fundIndex{}, nil, from, to)
	}
	idx, err := s.fundIndexFor(ctx, u.generation, fs)
	if err != nil {
		return indexFundFigures{}, err
	}
	return computeIndexFunds(ctx, idx, fs, from, to)
}
