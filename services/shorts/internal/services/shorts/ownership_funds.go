package shorts

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/industry"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The fund explorer (spec section 14.4): the tracked funds, one fund's holdings at
// a file date, and two files of one fund compared. A fund is one (institution,
// fund name) pair across its holdings files. Its key is the registry's key
// (abn:<ABN> or asx:<CODE>) when a registry row matches the file by institution
// and ASX code (or the key asx:<CODE>), else "<institution_slug>/<fund_name>"; the
// name form also resolves once a registry key exists. Weights are the fund's own,
// never a share of the company; a share of the company needs ASIC's shares on
// issue from a report at most fundSharesMaxDays before the file, and is withheld
// without them.

const (
	// fundOther is the sector a placeholder or unknown industry is listed under.
	fundOther = "Other"
	// fundTopN is how many of a fund's largest holdings a summary lists and sums.
	fundTopN = 10
	// fundNameMax is the longest fund name a key may carry.
	fundNameMax = 200
	// fundPooledSlug is the institution whose ETF files hold the pooled wholesale
	// fund behind each ETF (the same rule the web applies).
	fundPooledSlug = "vanguard"
)

var (
	registryFundKey   = regexp.MustCompile(`^(abn:[0-9]{11}|asx:[A-Z0-9]{2,10})$`)
	institutionSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
)

// fundStore is the fund explorer's read surface, or nil when the store does not
// serve it.
func (s *ShortsServer) fundStore() shortsstore.OwnershipFundStore {
	fs, _ := s.ownershipStore.(shortsstore.OwnershipFundStore)
	return fs
}

// parseFundKey reads a fund key: a registry key, which is normalised (the prefix
// in lower case, an ASX code in upper case), or "<institution_slug>/<fund_name>",
// the slug lower-cased. Anything else is refused by shape, never guessed at.
func parseFundKey(raw string) (string, error) {
	k := strings.TrimSpace(raw)
	lower := strings.ToLower(k)
	if strings.HasPrefix(lower, "asx:") || strings.HasPrefix(lower, "abn:") {
		canon := lower[:4] + strings.ToUpper(k[4:])
		if registryFundKey.MatchString(canon) {
			return canon, nil
		}
	} else if slug, name, ok := strings.Cut(k, "/"); ok {
		slug = strings.ToLower(slug)
		if institutionSlugRe.MatchString(slug) && validFundName(name) {
			return slug + "/" + name, nil
		}
	}
	return "", fmt.Errorf("fund_key must be a registry key (asx:<CODE> or abn:<ABN>) or <institution_slug>/<fund_name>, got %q", raw)
}

// validFundName is a non-empty name of at most fundNameMax characters with no
// control character and no space at either end.
func validFundName(name string) bool {
	if name == "" || name != strings.TrimSpace(name) || len([]rune(name)) > fundNameMax {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// fundEntry is one tracked fund: its key, its institution, its registry row when
// one matches, and every holdings file it has, oldest first.
type fundEntry struct {
	key, slug, institutionName, name, code, kind string
	registry                                     *shortsstore.OwnershipFundRow
	files                                        []shortsstore.FundFileRow
}

func (e *fundEntry) latest() shortsstore.FundFileRow { return e.files[len(e.files)-1] }

func (e *fundEntry) dates() []string {
	out := make([]string, 0, len(e.files))
	for _, f := range e.files {
		out = append(out, f.AsAt)
	}
	return out
}

func (e *fundEntry) fileAt(asAt string) (shortsstore.FundFileRow, bool) {
	for _, f := range e.files {
		if f.AsAt == asAt {
			return f, true
		}
	}
	return shortsstore.FundFileRow{}, false
}

// fundBook is every tracked fund, ordered for the list (largest registry size
// first, then name), and indexed by key.
type fundBook struct {
	funds []*fundEntry
	byKey map[string]*fundEntry
}

// buildFundBook groups the files into funds and matches each fund to its registry
// row: the same institution and either the row's ASX code or the key asx:<code>
// equal to the file's fund code. A registry row matches one fund only; a key
// already taken falls back to the institution and name. A fund is indexed under
// its key and under its institution and name, so either shape resolves (a fund
// page reached before its registry row existed keeps resolving).
func buildFundBook(files []shortsstore.FundFileRow, registry []shortsstore.OwnershipFundRow) *fundBook {
	sorted := append([]shortsstore.FundFileRow(nil), files...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.InstitutionSlug != b.InstitutionSlug {
			return a.InstitutionSlug < b.InstitutionSlug
		}
		if a.FundName != b.FundName {
			return a.FundName < b.FundName
		}
		if a.AsAt != b.AsAt {
			return a.AsAt < b.AsAt
		}
		return a.ID < b.ID
	})
	book := &fundBook{byKey: map[string]*fundEntry{}}
	claimed := map[string]bool{}
	var cur *fundEntry
	for _, f := range sorted {
		if cur == nil || cur.slug != f.InstitutionSlug || cur.name != f.FundName {
			cur = &fundEntry{slug: f.InstitutionSlug, name: f.FundName}
			book.funds = append(book.funds, cur)
		}
		cur.files = append(cur.files, f)
		cur.institutionName, cur.kind, cur.code = f.InstitutionName, f.SourceKind, f.FundCode
	}
	for _, e := range book.funds {
		e.registry = matchRegistry(e, registry, claimed)
		alias := e.slug + "/" + e.name
		e.key = alias
		if e.registry != nil {
			e.key = e.registry.FundKey
		}
		if _, taken := book.byKey[e.key]; taken {
			e.registry = nil
			e.key = alias
		}
		book.byKey[e.key] = e
		// A registry key contains no "/", so the alias never collides with another
		// fund's key.
		book.byKey[alias] = e
	}
	sort.SliceStable(book.funds, func(i, j int) bool {
		a, b := book.funds[i], book.funds[j]
		if (a.registry != nil && a.registry.Size != nil) != (b.registry != nil && b.registry.Size != nil) {
			return a.registry != nil && a.registry.Size != nil
		}
		if a.registry != nil && b.registry != nil && a.registry.Size != nil && b.registry.Size != nil && *a.registry.Size != *b.registry.Size {
			return *a.registry.Size > *b.registry.Size
		}
		if a.name != b.name {
			return a.name < b.name
		}
		return a.key < b.key
	})
	return book
}

// matchRegistry is the first unclaimed registry row of the fund's institution
// whose ASX code is the fund's code, or whose key is asx:<code>, or nil. The key
// rule covers a row whose code was never filled in.
func matchRegistry(e *fundEntry, registry []shortsstore.OwnershipFundRow, claimed map[string]bool) *shortsstore.OwnershipFundRow {
	if e.code == "" {
		return nil
	}
	codeKey := "asx:" + strings.ToUpper(e.code)
	for i := range registry {
		r := &registry[i]
		if r.InstitutionSlug != e.slug || claimed[r.FundKey] {
			continue
		}
		if (r.ASXCode != "" && strings.EqualFold(r.ASXCode, e.code)) || r.FundKey == codeKey {
			claimed[r.FundKey] = true
			return r
		}
	}
	return nil
}

// cachedFundBook is the book beside the universe of its generation, so a stock's
// fund series (read on every stock click) does not re-read every file. A book that
// cannot be read is logged and comes back nil: the caller names the funds by alias.
func (s *ShortsServer) cachedFundBook(ctx context.Context, fs shortsstore.OwnershipFundStore, generation int64, ttl time.Duration) *fundBook {
	// The book shares the ownership_funds generation key with the list's response, under its own suffix.
	key := s.cache.GetOwnershipFundsKey(generation) + "|book"
	v, err := s.cache.GetOrSetWithTTL(key, ttl, func() (any, error) {
		return s.readFundBook(context.WithoutCancel(ctx), fs)
	})
	if err != nil {
		log.Printf("[WARN] stock fund series: fund book unread, funds named by alias: %v", err)
		return nil
	}
	return v.(*fundBook)
}

// readFundBook reads every file and the registry and builds the book.
func (s *ShortsServer) readFundBook(ctx context.Context, fs shortsstore.OwnershipFundStore) (*fundBook, error) {
	files, err := fs.FundFiles(ctx)
	if err != nil {
		return nil, err
	}
	registry, err := s.ownershipStore.OwnershipFunds(ctx, "")
	if err != nil {
		return nil, err
	}
	return buildFundBook(files, registry), nil
}

// fundSectorLabel is a holding's sector: its industry, or "Other" for a
// placeholder or an unknown one.
func fundSectorLabel(name string) string {
	if industry.IsPlaceholder(name) {
		return fundOther
	}
	return strings.TrimSpace(name)
}

// fundPooled is the rule the web applies: an ETF file of Vanguard's holds the
// pooled wholesale fund behind the ETF, not the ETF alone.
func fundPooled(slug, kind string) bool {
	return kind == "etf" && slug == fundPooledSlug
}

// estCompanyPct is the units as a percentage of the company's shares on issue,
// known only with both.
func estCompanyPct(units, issued *float64) (float64, bool) {
	if units == nil || issued == nil || *issued <= 0 {
		return 0, false
	}
	return *units / *issued * 100, true
}

// fundLargest is the n holdings with the largest weights, weights unknown last,
// ties by code.
func fundLargest(rows []shortsstore.FundHoldingDetail, n int) []shortsstore.FundHoldingDetail {
	sorted := append([]shortsstore.FundHoldingDetail(nil), rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if (a.Weight != nil) != (b.Weight != nil) {
			return a.Weight != nil
		}
		if a.Weight != nil && *a.Weight != *b.Weight {
			return *a.Weight > *b.Weight
		}
		return a.StockCode < b.StockCode
	})
	if len(sorted) > n {
		sorted = sorted[:n]
	}
	return sorted
}

// fundTopPct sums the weights of the n largest holdings. It is known only when
// every one of them states a weight: a partial sum would read as the top n.
func fundTopPct(rows []shortsstore.FundHoldingDetail, n int) (float64, bool) {
	top := fundLargest(rows, n)
	if len(top) == 0 {
		return 0, false
	}
	var sum float64
	for _, h := range top {
		if h.Weight == nil {
			return 0, false
		}
		sum += *h.Weight
	}
	return sum, true
}

// fundSectorWeights groups the holdings' weights by sector: the known sectors
// first, by weight, then the sectors with no stated weight.
func fundSectorWeights(rows []shortsstore.FundHoldingDetail) []*shortsv1alpha1.FundSectorWeight {
	type agg struct {
		sum float64
		has bool
	}
	by := map[string]*agg{}
	for _, r := range rows {
		label := fundSectorLabel(r.Industry)
		a := by[label]
		if a == nil {
			a = &agg{}
			by[label] = a
		}
		if r.Weight != nil {
			a.sum += *r.Weight
			a.has = true
		}
	}
	names := make([]string, 0, len(by))
	for name := range by {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := by[names[i]], by[names[j]]
		if a.has != b.has {
			return a.has
		}
		if a.sum != b.sum {
			return a.sum > b.sum
		}
		return names[i] < names[j]
	})
	out := make([]*shortsv1alpha1.FundSectorWeight, 0, len(names))
	for _, name := range names {
		a := by[name]
		out = append(out, &shortsv1alpha1.FundSectorWeight{Industry: name, WeightPct: a.sum, HasWeightPct: a.has})
	}
	return out
}

// groupHoldings splits the holdings by their file.
func groupHoldings(rows []shortsstore.FundHoldingDetail) map[int64][]shortsstore.FundHoldingDetail {
	out := map[int64][]shortsstore.FundHoldingDetail{}
	for _, r := range rows {
		out[r.SnapshotID] = append(out[r.SnapshotID], r)
	}
	return out
}

// fundSummaryProto is one fund at one of its files.
func fundSummaryProto(e *fundEntry, f shortsstore.FundFileRow, rows []shortsstore.FundHoldingDetail) *shortsv1alpha1.FundSummary {
	out := &shortsv1alpha1.FundSummary{
		FundKey: e.key, Ticker: f.FundCode, Name: f.FundName,
		InstitutionSlug: e.slug, InstitutionName: e.institutionName, SourceKind: f.SourceKind,
		Pooled: fundPooled(e.slug, f.SourceKind), AsAt: f.AsAt, SourceUrl: f.SourceURL,
		Holdings: int32(len(rows)), SectorWeights: fundSectorWeights(rows),
	}
	if out.Ticker == "" && e.registry != nil {
		out.Ticker = e.registry.ASXCode
	}
	if top, ok := fundTopPct(rows, fundTopN); ok {
		out.Top10Pct, out.HasTop10Pct = top, true
	}
	for _, h := range fundLargest(rows, fundTopN) {
		item := &shortsv1alpha1.FundTopHolding{Code: h.StockCode, Name: h.SecurityName}
		if item.Name == "" {
			item.Name = h.StockCode
		}
		if h.Weight != nil {
			item.WeightPct, item.HasWeightPct = *h.Weight, true
		}
		out.Largest = append(out.Largest, item)
	}
	if e.registry != nil && e.registry.Size != nil {
		out.AumAud, out.HasAumAud = *e.registry.Size, true
	}
	return out
}

// ListFunds is every tracked fund at its newest file. The list is cached beside
// the universe of its generation.
func (s *ShortsServer) ListFunds(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListFundsRequest],
) (*connect.Response[shortsv1alpha1.ListFundsResponse], error) {
	fs := s.fundStore()
	if fs == nil {
		return connect.NewResponse(&shortsv1alpha1.ListFundsResponse{}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list funds: %w", err))
	}
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetOwnershipFundsKey(u.generation), u.ttlRemaining(), func() (any, error) {
		// The cache shares this read with every caller of the key, so the caller
		// that started it may leave.
		return s.readFundList(context.WithoutCancel(ctx), fs)
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list funds: %w", err))
	}
	return connect.NewResponse(v.(*shortsv1alpha1.ListFundsResponse)), nil
}

// readFundList builds the list: every fund's newest file, its holdings in one read.
func (s *ShortsServer) readFundList(ctx context.Context, fs shortsstore.OwnershipFundStore) (*shortsv1alpha1.ListFundsResponse, error) {
	book, err := s.readFundBook(ctx, fs)
	if err != nil {
		return nil, err
	}
	out := &shortsv1alpha1.ListFundsResponse{}
	if len(book.funds) == 0 {
		return out, nil
	}
	ids := make([]int64, 0, len(book.funds))
	for _, e := range book.funds {
		ids = append(ids, e.latest().ID)
	}
	holdings, err := fs.FundHoldingsOf(ctx, ids, false)
	if err != nil {
		return nil, err
	}
	byFile := groupHoldings(holdings)
	for _, e := range book.funds {
		f := e.latest()
		out.Funds = append(out.Funds, fundSummaryProto(e, f, byFile[f.ID]))
	}
	return out, nil
}

// GetFundPortfolio is one fund's holdings at a file date: the newest file at or
// before as_at (the newest file when as_at is empty). A fund with no file on or
// before the date answers with its file dates and no holdings.
func (s *ShortsServer) GetFundPortfolio(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetFundPortfolioRequest],
) (*connect.Response[shortsv1alpha1.GetFundPortfolioResponse], error) {
	fs := s.fundStore()
	if fs == nil {
		return connect.NewResponse(&shortsv1alpha1.GetFundPortfolioResponse{}), nil
	}
	key, err := parseFundKey(req.Msg.FundKey)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if _, _, err := deskDate("as_at", req.Msg.AsAt); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	book, err := s.readFundBook(ctx, fs)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("fund portfolio: %w", err))
	}
	e, ok := book.byKey[key]
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no tracked fund %q", key))
	}
	used := e.latest().AsAt
	if req.Msg.AsAt != "" {
		used = newestSnapshot(e.dates(), req.Msg.AsAt)
	}
	out := &shortsv1alpha1.GetFundPortfolioResponse{
		FundKey: e.key, Name: e.name, InstitutionSlug: e.slug, InstitutionName: e.institutionName,
		SourceKind: e.kind, Pooled: fundPooled(e.slug, e.kind), SnapshotDates: e.dates(), AsAt: used,
	}
	f, ok := e.fileAt(used)
	if !ok {
		return connect.NewResponse(out), nil
	}
	out.Ticker, out.SourceUrl = f.FundCode, f.SourceURL
	if out.Ticker == "" && e.registry != nil {
		out.Ticker = e.registry.ASXCode
	}
	rows, err := fs.FundHoldingsOf(ctx, []int64{f.ID}, true)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("fund portfolio: %w", err))
	}
	out.HoldingsTotal = int32(len(rows))
	for _, h := range fundLargest(rows, len(rows)) {
		item := &shortsv1alpha1.FundPortfolioHolding{Code: h.StockCode, Name: h.SecurityName, Industry: fundSectorLabel(h.Industry)}
		if item.Name == "" {
			item.Name = h.StockCode
		}
		if h.Weight != nil {
			item.WeightPct, item.HasWeightPct = *h.Weight, true
		}
		if h.Units != nil {
			item.Units, item.HasUnits = *h.Units, true
		}
		if h.Value != nil {
			item.ValueAud, item.HasValueAud = *h.Value, true
		}
		if h.SharesIssued != nil {
			item.SharesOnIssue, item.HasSharesOnIssue = *h.SharesIssued, true
			item.SharesOnIssueAsAt = h.SharesAsAt
		}
		if pct, ok := estCompanyPct(h.Units, h.SharesIssued); ok {
			item.EstCompanyPct, item.HasEstCompanyPct = pct, true
		}
		out.Holdings = append(out.Holdings, item)
	}
	out.SectorWeights = fundSectorWeights(rows)
	if top, ok := fundTopPct(rows, fundTopN); ok {
		out.Top10Pct, out.HasTop10Pct = top, true
	}
	return connect.NewResponse(out), nil
}

// CompareFundSnapshots is two files of one fund compared holding by holding. Each
// side is the fund's newest file at or before its date; an empty to is the newest
// file, an empty from the file before to. A from after the newest file with no to,
// or after an explicit to, is refused.
func (s *ShortsServer) CompareFundSnapshots(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.CompareFundSnapshotsRequest],
) (*connect.Response[shortsv1alpha1.CompareFundSnapshotsResponse], error) {
	fs := s.fundStore()
	if fs == nil {
		return connect.NewResponse(&shortsv1alpha1.CompareFundSnapshotsResponse{}), nil
	}
	key, err := parseFundKey(req.Msg.FundKey)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	for _, d := range []struct{ field, value string }{{"from", req.Msg.From}, {"to", req.Msg.To}} {
		if _, _, err := deskDate(d.field, d.value); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
	}
	book, err := s.readFundBook(ctx, fs)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("compare fund snapshots: %w", err))
	}
	e, ok := book.byKey[key]
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no tracked fund %q", key))
	}
	dates := e.dates()
	out := &shortsv1alpha1.CompareFundSnapshotsResponse{SnapshotDates: dates}
	fromReq, toReq := req.Msg.From, req.Msg.To
	toDefaulted := toReq == ""
	if toDefaulted {
		toReq = dates[len(dates)-1]
	}
	if fromReq > toReq {
		if toDefaulted {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("from must not be after the newest snapshot, %s", toReq))
		}
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("to must not be before from"))
	}
	toUsed := newestSnapshot(dates, toReq)
	if fromReq == "" {
		fromReq = previousSnapshot(dates, toUsed)
	}
	fromUsed := newestSnapshot(dates, fromReq)
	if fromUsed == "" && toUsed != "" {
		fromUsed = dates[0]
	}
	out.From, out.To = fromUsed, toUsed
	if fromUsed == "" || toUsed == "" {
		return connect.NewResponse(out), nil
	}
	ff, _ := e.fileAt(fromUsed)
	tf, _ := e.fileAt(toUsed)
	out.SourceFrom, out.SourceTo = ff.SourceURL, tf.SourceURL
	if fromUsed == toUsed {
		// One file on both sides: every holding would read as continuing with no
		// change, so there is nothing to compare.
		return connect.NewResponse(out), nil
	}
	rows, err := fs.FundCompareRows(ctx, ff.ID, tf.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("compare fund snapshots: %w", err))
	}
	out.Rows = buildFundSnapshotChanges(rows)
	return connect.NewResponse(out), nil
}

// buildFundSnapshotChanges is the comparison's rows: the holdings on both files by
// |delta| (a row with no delta after those with one), then the new holdings and
// then the dropped, each by weight.
func buildFundSnapshotChanges(rows []shortsstore.FundCompareRow) []*shortsv1alpha1.FundSnapshotChange {
	out := make([]*shortsv1alpha1.FundSnapshotChange, 0, len(rows))
	for _, r := range rows {
		c := &shortsv1alpha1.FundSnapshotChange{
			Code: r.StockCode, Name: r.SecurityName, Industry: fundSectorLabel(r.Industry),
		}
		if c.Name == "" {
			c.Name = r.StockCode
		}
		switch {
		case r.InFrom && r.InTo:
			c.Status = "continuing"
		case r.InTo:
			c.Status = "new"
		default:
			c.Status = "dropped"
		}
		if r.FromWeight != nil {
			c.WeightFromPct, c.HasWeightFromPct = *r.FromWeight, true
		}
		if r.ToWeight != nil {
			c.WeightToPct, c.HasWeightToPct = *r.ToWeight, true
		}
		if r.FromWeight != nil && r.ToWeight != nil {
			c.DeltaPp, c.HasDeltaPp = *r.ToWeight-*r.FromWeight, true
		}
		if r.FromValue != nil {
			c.ValueFromAud, c.HasValueFromAud = *r.FromValue, true
		}
		if r.ToValue != nil {
			c.ValueToAud, c.HasValueToAud = *r.ToValue, true
		}
		out = append(out, c)
	}
	rank := map[string]int{"continuing": 0, "new": 1, "dropped": 2}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Status != b.Status {
			return rank[a.Status] < rank[b.Status]
		}
		if a.HasDeltaPp != b.HasDeltaPp {
			return a.HasDeltaPp
		}
		if a.HasDeltaPp && abs(a.DeltaPp) != abs(b.DeltaPp) {
			return abs(a.DeltaPp) > abs(b.DeltaPp)
		}
		wa, wb := fundRowWeight(a), fundRowWeight(b)
		if wa != wb {
			return wa > wb
		}
		return a.Code < b.Code
	})
	return out
}

// fundRowWeight is the weight a comparison row sorts by: the later file's for a
// new holding, the earlier file's for a dropped one, else the later's.
func fundRowWeight(c *shortsv1alpha1.FundSnapshotChange) float64 {
	if c.Status == "dropped" {
		return c.WeightFromPct
	}
	return c.WeightToPct
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
