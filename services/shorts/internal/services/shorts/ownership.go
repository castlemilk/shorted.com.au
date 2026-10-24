package shorts

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// OwnershipService handlers (ownership.proto). The store returns row sets;
// the views are built here, in pure functions, so they are testable without
// a database. Data changes once a day (the `shorted ownership` job), so every
// response is cached for ownershipTTL. The job waits out this TTL before it
// revalidates the web pages (ownership.revalidateWait): change one, change
// the other.

const ownershipTTL = 10 * time.Minute

// Kinds whose substantial holdings are an investment view rather than a
// company's strategic stake or a person's own shares. "Crowded" counts these.
var institutionalKinds = map[string]bool{
	"super_fund": true, "index_manager": true, "hedge_fund": true, "active_manager": true,
	"bank_broker": true, "sovereign_public": true, "insurer": true,
}

// ownershipData is everything a view is built from.
type ownershipData struct {
	institutions []shortsstore.OwnershipInstitutionRow
	holdings     []shortsstore.SubstantialHoldingRow
	notices      []shortsstore.SubstantialNoticeRow
	stats        *shortsstore.NoticeStats
	fundHoldings []shortsstore.FundHoldingRow
	funds        []shortsstore.OwnershipFundRow
	shorts       map[string]shortsstore.ShortPosition
	companies    map[string]shortsstore.OwnershipCompany
}

func (s *ShortsServer) loadOwnership(ctx context.Context, f shortsstore.OwnershipFilter, noticeLimit int, fundsFor string, allFunds bool) (*ownershipData, error) {
	st := s.ownershipStore
	d := &ownershipData{stats: &shortsstore.NoticeStats{PerHolder: map[string]shortsstore.HolderNoticeStats{}}}
	var err error
	if d.institutions, err = st.OwnershipInstitutions(ctx); err != nil {
		return nil, err
	}
	if d.holdings, err = st.CurrentSubstantialHoldings(ctx, f); err != nil {
		return nil, err
	}
	if noticeLimit > 0 {
		if d.notices, err = st.SubstantialNotices(ctx, f, noticeLimit); err != nil {
			return nil, err
		}
	}
	if stats, err := st.NoticeStats(ctx); err != nil {
		return nil, err
	} else if stats != nil {
		d.stats = stats
	}
	if d.fundHoldings, err = st.LatestFundHoldings(ctx, shortsstore.OwnershipFilter{StockCode: f.StockCode, InstitutionSlug: f.InstitutionSlug}); err != nil {
		return nil, err
	}
	if fundsFor != "" || allFunds {
		if d.funds, err = st.OwnershipFunds(ctx, fundsFor); err != nil {
			return nil, err
		}
	}
	if d.shorts, err = st.LatestShortPositions(ctx); err != nil {
		return nil, err
	}
	if d.companies, err = st.OwnershipCompanies(ctx); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *ownershipData) institutionBySlug() map[string]shortsstore.OwnershipInstitutionRow {
	out := make(map[string]shortsstore.OwnershipInstitutionRow, len(d.institutions))
	for _, i := range d.institutions {
		out[i.Slug] = i
	}
	return out
}

// institutionProto is one institution with its counts.
func (d *ownershipData) institutionProto(i shortsstore.OwnershipInstitutionRow, positions map[string]int, funds map[string][2]float64) *shortsv1alpha1.OwnershipInstitution {
	out := &shortsv1alpha1.OwnershipInstitution{
		Slug: i.Slug, Name: i.Name, Kind: i.Kind, Country: i.Country, Website: i.Website, Description: i.Description,
		SubstantialPositions: int32(positions[i.Slug]),
	}
	if i.AUM != nil {
		out.AumAud, out.HasAum, out.AumAsAt = *i.AUM, true, i.AUMAsAt
	}
	if st, ok := d.stats.PerHolder[i.Slug]; ok {
		out.Notices, out.LatestNoticeDate = int32(st.Notices), st.LatestNotice
	}
	if f, ok := funds[i.Slug]; ok {
		out.Funds = int32(f[0])
		if f[1] > 0 {
			out.FundsSizeAud, out.HasFundsSize = f[1], true
		}
	}
	return out
}

func positionsByHolder(holdings []shortsstore.SubstantialHoldingRow) map[string]int {
	out := map[string]int{}
	for _, h := range holdings {
		out[h.HolderKey]++
	}
	return out
}

func fundsByInstitution(funds []shortsstore.OwnershipFundRow) map[string][2]float64 {
	out := map[string][2]float64{}
	for _, f := range funds {
		if f.InstitutionSlug == "" {
			continue
		}
		v := out[f.InstitutionSlug]
		v[0]++
		if f.Size != nil {
			v[1] += *f.Size
		}
		out[f.InstitutionSlug] = v
	}
	return out
}

func (d *ownershipData) holdingProto(h shortsstore.SubstantialHoldingRow) *shortsv1alpha1.SubstantialHolding {
	c := d.companies[h.StockCode]
	out := &shortsv1alpha1.SubstantialHolding{
		StockCode: h.StockCode, CompanyName: c.Name, Industry: c.Industry, HolderKey: h.HolderKey, HolderName: h.HolderName,
		InstitutionSlug: h.InstitutionSlug, Kind: h.Kind, Form: h.Form, VotingPowerPct: h.PresentPct,
		EventDate: h.EventDate, AnnouncedOn: h.AnnouncedOn, AnnouncementUrl: h.AnnouncementURL,
	}
	if h.PreviousPct != nil {
		out.PreviousPct, out.HasPrevious = *h.PreviousPct, true
	}
	if h.PresentVotes != nil {
		out.Votes, out.HasVotes = *h.PresentVotes, true
	}
	return out
}

func (d *ownershipData) noticeProto(n shortsstore.SubstantialNoticeRow) *shortsv1alpha1.SubstantialNotice {
	out := &shortsv1alpha1.SubstantialNotice{
		StockCode: n.StockCode, CompanyName: d.companies[n.StockCode].Name, HolderKey: n.HolderKey, HolderName: n.HolderName,
		InstitutionSlug: n.InstitutionSlug, Kind: n.Kind, Form: n.Form, Ceased: n.Ceased,
		EventDate: n.EventDate, AnnouncedOn: n.AnnouncedOn, AnnouncementUrl: n.AnnouncementURL,
	}
	if n.PresentPct != nil {
		out.PresentPct, out.HasPresent = *n.PresentPct, true
	}
	if n.PreviousPct != nil {
		out.PreviousPct, out.HasPrevious = *n.PreviousPct, true
	}
	return out
}

func (d *ownershipData) fundHoldingProto(h shortsstore.FundHoldingRow, insts map[string]shortsstore.OwnershipInstitutionRow) *shortsv1alpha1.FundHolding {
	inst := insts[h.InstitutionSlug]
	out := &shortsv1alpha1.FundHolding{
		InstitutionSlug: h.InstitutionSlug, InstitutionName: inst.Name, Kind: inst.Kind, FundName: h.FundName,
		FundCode: h.FundCode, SourceKind: h.SourceKind, AsAt: h.AsAt, StockCode: h.StockCode,
		CompanyName: d.companies[h.StockCode].Name,
	}
	if out.CompanyName == "" {
		out.CompanyName = h.SecurityName
	}
	if h.Units != nil {
		out.Units, out.HasUnits = *h.Units, true
		if sp, ok := d.shorts[h.StockCode]; ok && sp.Issued > 0 {
			out.PctOfIssued, out.HasPctOfIssued = *h.Units/sp.Issued*100, true
		}
	}
	if h.Value != nil {
		out.ValueAud, out.HasValue = *h.Value, true
	}
	if h.Weight != nil {
		out.WeightPct, out.HasWeight = *h.Weight, true
	}
	return out
}

// stockViews builds every stock's OwnershipStock from the three sources.
func (d *ownershipData) stockViews() map[string]*shortsv1alpha1.OwnershipStock {
	out := map[string]*shortsv1alpha1.OwnershipStock{}
	get := func(code string) *shortsv1alpha1.OwnershipStock {
		if v, ok := out[code]; ok {
			return v
		}
		c := d.companies[code]
		v := &shortsv1alpha1.OwnershipStock{StockCode: code, CompanyName: c.Name, Industry: c.Industry}
		if c.MarketCap != nil && *c.MarketCap > 0 {
			v.MarketCap, v.HasMarketCap = *c.MarketCap, true
		}
		if sp, ok := d.shorts[code]; ok {
			v.ShortPct, v.HasShortPct = sp.Pct, true
		}
		out[code] = v
		return v
	}
	byKind := map[string]map[string]*shortsv1alpha1.KindShare{}
	for _, h := range d.holdings {
		get(h.StockCode).Holders++
	}
	for _, h := range countedHoldings(d.holdings, d.groups()) {
		v := get(h.StockCode)
		v.DisclosedPct += h.PresentPct
		if byKind[h.StockCode] == nil {
			byKind[h.StockCode] = map[string]*shortsv1alpha1.KindShare{}
		}
		ks := byKind[h.StockCode][h.Kind]
		if ks == nil {
			ks = &shortsv1alpha1.KindShare{Kind: h.Kind}
			byKind[h.StockCode][h.Kind] = ks
		}
		ks.Pct += h.PresentPct
		ks.Holders++
	}
	for code, kinds := range byKind {
		v := out[code]
		for _, ks := range kinds {
			v.ByKind = append(v.ByKind, ks)
		}
		sort.Slice(v.ByKind, func(i, j int) bool {
			if v.ByKind[i].Pct != v.ByKind[j].Pct {
				return v.ByKind[i].Pct > v.ByKind[j].Pct
			}
			return v.ByKind[i].Kind < v.ByKind[j].Kind
		})
	}
	indexUnits := map[string]float64{}
	for _, h := range d.fundHoldings {
		switch h.SourceKind {
		case "etf":
			if h.Units != nil {
				indexUnits[h.StockCode] += *h.Units
			}
		case "super_phd":
			v := get(h.StockCode)
			v.SuperOptions++
			if h.Value != nil {
				v.SuperValueAud += *h.Value
				v.HasSuperValue = true
			}
		}
	}
	for code, units := range indexUnits {
		if sp, ok := d.shorts[code]; ok && sp.Issued > 0 {
			v := get(code)
			v.IndexPct, v.HasIndexPct = units/sp.Issued*100, true
		}
	}
	return out
}

// groups maps an institution to the one whose notices include its interests.
func (d *ownershipData) groups() map[string]string {
	out := map[string]string{}
	for _, i := range d.institutions {
		if i.Group != "" {
			out[i.Slug] = i.Group
		}
	}
	return out
}

// attributionOrder ranks kinds for attributing an interest two holders
// disclose: the investor before a bank or broker (which files for a group, a
// lending book or a client) and before a holder off the map.
var attributionOrder = map[string]int{
	"super_fund": 0, "index_manager": 1, "active_manager": 2, "hedge_fund": 3, "sovereign_public": 4,
	"insurer": 5, "private_equity": 6, "corporate": 7, "other": 8, "bank_broker": 9, "unclassified": 10,
}

// countedHoldings is the holdings a stock's sums count: each interest once.
// A group (MUFG, which files for First Sentier and Morgan Stanley) counts its
// largest figure, because its notice and its member's report the same shares;
// and two holders disclosing the same voting power as at the same date (a
// parent and its fund, a buyer and a seller's associate) are one interest. The
// member, then the earlier kind in attributionOrder, takes the figure: it is the
// investor. Every holder is still listed; only the sums change.
func countedHoldings(holdings []shortsstore.SubstantialHoldingRow, groups map[string]string) []shortsstore.SubstantialHoldingRow {
	family := func(h shortsstore.SubstantialHoldingRow) string {
		if g := groups[h.InstitutionSlug]; g != "" {
			return "inst:" + g
		}
		if h.InstitutionSlug != "" {
			return "inst:" + h.InstitutionSlug
		}
		return "key:" + h.HolderKey
	}
	rank := func(h shortsstore.SubstantialHoldingRow) int {
		if r, ok := attributionOrder[h.Kind]; ok {
			return r
		}
		return len(attributionOrder)
	}
	// better reports whether a should take the figure over b.
	better := func(a, b shortsstore.SubstantialHoldingRow) bool {
		if a.PresentPct != b.PresentPct {
			return a.PresentPct > b.PresentPct
		}
		aMember, bMember := groups[a.InstitutionSlug] != "", groups[b.InstitutionSlug] != ""
		if aMember != bMember {
			return aMember
		}
		if rank(a) != rank(b) {
			return rank(a) < rank(b)
		}
		return a.HolderKey < b.HolderKey
	}
	type familyKey struct{ stock, family string }
	byFamily := map[familyKey]shortsstore.SubstantialHoldingRow{}
	for _, h := range holdings {
		k := familyKey{h.StockCode, family(h)}
		if cur, ok := byFamily[k]; !ok || better(h, cur) {
			byFamily[k] = h
		}
	}
	type interestKey struct {
		stock, asAt string
		pct         int64
	}
	byInterest := map[interestKey]shortsstore.SubstantialHoldingRow{}
	for _, h := range byFamily {
		asAt := h.EventDate
		if asAt == "" {
			asAt = h.AnnouncedOn
		}
		k := interestKey{h.StockCode, asAt, int64(math.Round(h.PresentPct * 10000))}
		if cur, ok := byInterest[k]; !ok || better(h, cur) {
			byInterest[k] = h
		}
	}
	out := make([]shortsstore.SubstantialHoldingRow, 0, len(byInterest))
	for _, h := range byInterest {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StockCode != out[j].StockCode {
			return out[i].StockCode < out[j].StockCode
		}
		return out[i].HolderKey < out[j].HolderKey
	})
	return out
}

// kindPct is a stock's disclosed voting power held by holders of the kinds.
func kindPct(v *shortsv1alpha1.OwnershipStock, kinds ...string) float64 {
	total := 0.0
	for _, ks := range v.ByKind {
		for _, k := range kinds {
			if ks.Kind == k {
				total += ks.Pct
			}
		}
	}
	return total
}

func institutionalPct(v *shortsv1alpha1.OwnershipStock) float64 {
	total := 0.0
	for _, ks := range v.ByKind {
		if institutionalKinds[ks.Kind] {
			total += ks.Pct
		}
	}
	return total
}

// topStocks is the n stocks with the highest score among those keep accepts,
// ties broken by code.
func topStocks(views map[string]*shortsv1alpha1.OwnershipStock, n int, keep func(*shortsv1alpha1.OwnershipStock) bool, score func(*shortsv1alpha1.OwnershipStock) float64) []*shortsv1alpha1.OwnershipStock {
	var picked []*shortsv1alpha1.OwnershipStock
	for _, v := range views {
		if keep(v) {
			picked = append(picked, v)
		}
	}
	sort.Slice(picked, func(i, j int) bool {
		si, sj := score(picked[i]), score(picked[j])
		if si != sj {
			return si > sj
		}
		return picked[i].StockCode < picked[j].StockCode
	})
	if len(picked) > n {
		picked = picked[:n]
	}
	return picked
}

// Thresholds of the overview's lists.
const (
	overviewListSize = 25
	// Crowded both ways: hedge funds and active managers together hold at
	// least this much, and short interest is at least crowdedShortPct.
	crowdedLongPct  = 5.0
	crowdedShortPct = 3.0
)

// buildOwnershipOverview is GetOwnershipOverview's response.
func buildOwnershipOverview(d *ownershipData) *shortsv1alpha1.GetOwnershipOverviewResponse {
	views := d.stockViews()
	positions := positionsByHolder(d.holdings)
	funds := fundsByInstitution(d.funds)
	out := &shortsv1alpha1.GetOwnershipOverviewResponse{
		NoticesParsed: int32(d.stats.Parsed), NoticesWithheld: int32(d.stats.Withheld), AsOf: d.stats.LatestAnnounced,
	}

	// The map: registry institutions by kind, and who holds what by kind.
	kinds := map[string]*shortsv1alpha1.OwnershipKindSummary{}
	kind := func(k string) *shortsv1alpha1.OwnershipKindSummary {
		if v, ok := kinds[k]; ok {
			return v
		}
		v := &shortsv1alpha1.OwnershipKindSummary{Kind: k}
		kinds[k] = v
		return v
	}
	for _, i := range d.institutions {
		ks := kind(i.Kind)
		ks.Institutions++
		if i.AUM != nil {
			ks.AumAud += *i.AUM
			ks.HasAum = true
		}
	}
	holdersByKind := map[string]map[string]bool{}
	stocksByKind := map[string]map[string]bool{}
	for _, h := range d.holdings {
		ks := kind(h.Kind)
		ks.Positions++
		if holdersByKind[h.Kind] == nil {
			holdersByKind[h.Kind], stocksByKind[h.Kind] = map[string]bool{}, map[string]bool{}
		}
		holdersByKind[h.Kind][h.HolderKey] = true
		stocksByKind[h.Kind][h.StockCode] = true
	}
	for k, ks := range kinds {
		ks.Holders, ks.Stocks = int32(len(holdersByKind[k])), int32(len(stocksByKind[k]))
		out.Kinds = append(out.Kinds, ks)
	}
	sort.Slice(out.Kinds, func(i, j int) bool {
		if out.Kinds[i].Positions != out.Kinds[j].Positions {
			return out.Kinds[i].Positions > out.Kinds[j].Positions
		}
		return out.Kinds[i].Kind < out.Kinds[j].Kind
	})

	for _, i := range d.institutions {
		if positions[i.Slug] > 0 {
			out.TopHolders = append(out.TopHolders, d.institutionProto(i, positions, funds))
		}
	}
	sort.Slice(out.TopHolders, func(i, j int) bool {
		a, b := out.TopHolders[i], out.TopHolders[j]
		if a.SubstantialPositions != b.SubstantialPositions {
			return a.SubstantialPositions > b.SubstantialPositions
		}
		return a.Slug < b.Slug
	})
	if len(out.TopHolders) > overviewListSize {
		out.TopHolders = out.TopHolders[:overviewListSize]
	}

	out.Crowded = topStocks(views, overviewListSize,
		func(v *shortsv1alpha1.OwnershipStock) bool { return institutionalPct(v) > 0 },
		institutionalPct)
	out.CrowdedBothWays = topStocks(views, overviewListSize,
		func(v *shortsv1alpha1.OwnershipStock) bool {
			return v.HasShortPct && v.ShortPct >= crowdedShortPct && kindPct(v, "hedge_fund", "active_manager") >= crowdedLongPct
		},
		func(v *shortsv1alpha1.OwnershipStock) float64 { return v.ShortPct })
	out.Lending = topStocks(views, overviewListSize,
		func(v *shortsv1alpha1.OwnershipStock) bool { return v.HasShortPct && kindPct(v, "bank_broker") > 0 },
		func(v *shortsv1alpha1.OwnershipStock) float64 { return v.ShortPct })
	out.SuperConsensus = topStocks(views, overviewListSize,
		func(v *shortsv1alpha1.OwnershipStock) bool { return v.HasSuperValue },
		func(v *shortsv1alpha1.OwnershipStock) float64 { return v.SuperValueAud })
	out.Passive = topStocks(views, overviewListSize,
		func(v *shortsv1alpha1.OwnershipStock) bool { return v.HasIndexPct },
		func(v *shortsv1alpha1.OwnershipStock) float64 { return v.IndexPct })

	for _, n := range d.notices {
		out.Recent = append(out.Recent, d.noticeProto(n))
	}

	for _, f := range d.funds {
		size := 0.0
		if f.Size != nil {
			size = *f.Size
		}
		switch f.FundType {
		case "super_fund":
			out.SuperFunds++
			out.SuperAssetsAud += size
		case "etf":
			out.Etfs++
			out.EtfFumAud += size
		case "lic":
			out.Lics++
			out.LicMarketCapAud += size
		}
	}
	out.Sources = ownershipSources(d)
	return out
}

// ownershipSources reports each source's coverage and as-at date.
func ownershipSources(d *ownershipData) []*shortsv1alpha1.OwnershipSource {
	type agg struct {
		asAt  string
		count int
		funds map[string]bool
	}
	by := map[string]*agg{}
	for _, h := range d.fundHoldings {
		a := by[h.SourceKind]
		if a == nil {
			a = &agg{funds: map[string]bool{}}
			by[h.SourceKind] = a
		}
		a.count++
		a.funds[h.InstitutionSlug+"|"+h.FundName] = true
		if h.AsAt > a.asAt {
			a.asAt = h.AsAt
		}
	}
	out := []*shortsv1alpha1.OwnershipSource{{
		Source:      "substantial_notices",
		Description: "ASX substantial holding notices (Forms 603, 604, 605) read from their PDFs",
		AsAt:        d.stats.LatestAnnounced, Records: int32(d.stats.Parsed),
	}}
	if a := by["etf"]; a != nil {
		out = append(out, &shortsv1alpha1.OwnershipSource{Source: "etf",
			Description: fmt.Sprintf("Holdings files of %d index ETFs (iShares, Vanguard, SPDR, Betashares)", len(a.funds)),
			AsAt:        a.asAt, Records: int32(a.count)})
	}
	if a := by["super_phd"]; a != nil {
		out = append(out, &shortsv1alpha1.OwnershipSource{Source: "super_phd",
			Description: fmt.Sprintf("Portfolio holdings disclosures of %d super fund options (each fund's default or balanced option)", len(a.funds)),
			AsAt:        a.asAt, Records: int32(a.count)})
	}
	return out
}

func (s *ShortsServer) GetOwnershipOverview(
	ctx context.Context,
	_ *connect.Request[shortsv1alpha1.GetOwnershipOverviewRequest],
) (*connect.Response[shortsv1alpha1.GetOwnershipOverviewResponse], error) {
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.GetOwnershipOverviewResponse{}), nil
	}
	cached, err := s.cache.GetOrSetWithTTL(s.cache.GetOwnershipOverviewKey(), ownershipTTL, func() (any, error) {
		d, err := s.loadOwnership(ctx, shortsstore.OwnershipFilter{}, 30, "", true)
		if err != nil {
			return nil, err
		}
		return buildOwnershipOverview(d), nil
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership overview: %w", err))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetOwnershipOverviewResponse)), nil
}

func (s *ShortsServer) ListInstitutions(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListInstitutionsRequest],
) (*connect.Response[shortsv1alpha1.ListInstitutionsResponse], error) {
	kind := strings.ToLower(strings.TrimSpace(req.Msg.Kind))
	query := strings.ToLower(strings.TrimSpace(req.Msg.Query))
	limit, offset := req.Msg.Limit, req.Msg.Offset
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.ListInstitutionsResponse{}), nil
	}
	cached, err := s.cache.GetOrSetWithTTL(s.cache.ListInstitutionsKey(kind, query, limit, offset), ownershipTTL, func() (any, error) {
		d, err := s.loadOwnership(ctx, shortsstore.OwnershipFilter{}, 0, "", true)
		if err != nil {
			return nil, err
		}
		return buildInstitutionList(d, kind, query, limit, offset), nil
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list institutions: %w", err))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListInstitutionsResponse)), nil
}

// buildInstitutionList filters and pages the institutions: most current
// substantial holdings first, then largest assets, then name.
func buildInstitutionList(d *ownershipData, kind, query string, limit, offset int32) *shortsv1alpha1.ListInstitutionsResponse {
	positions := positionsByHolder(d.holdings)
	funds := fundsByInstitution(d.funds)
	var all []*shortsv1alpha1.OwnershipInstitution
	for _, i := range d.institutions {
		if kind != "" && i.Kind != kind {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(i.Name), query) && !strings.Contains(i.Slug, query) {
			continue
		}
		all = append(all, d.institutionProto(i, positions, funds))
	}
	sort.Slice(all, func(a, b int) bool {
		x, y := all[a], all[b]
		if x.SubstantialPositions != y.SubstantialPositions {
			return x.SubstantialPositions > y.SubstantialPositions
		}
		if x.AumAud != y.AumAud {
			return x.AumAud > y.AumAud
		}
		return x.Name < y.Name
	})
	out := &shortsv1alpha1.ListInstitutionsResponse{Total: int32(len(all))}
	if int(offset) < len(all) {
		end := min(int(offset+limit), len(all))
		out.Institutions = all[offset:end]
	}
	return out
}

func (s *ShortsServer) GetInstitution(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetInstitutionRequest],
) (*connect.Response[shortsv1alpha1.GetInstitutionResponse], error) {
	slug := strings.ToLower(strings.TrimSpace(req.Msg.Slug))
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	if s.ownershipStore == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("institution not found"))
	}
	cached, err := s.cache.GetOrSetWithTTL(s.cache.GetInstitutionKey(slug), ownershipTTL, func() (any, error) {
		d, err := s.loadOwnership(ctx, shortsstore.OwnershipFilter{HolderKey: slug, InstitutionSlug: slug}, 100, slug, false)
		if err != nil {
			return nil, err
		}
		return buildInstitution(d, slug), nil
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("get institution: %w", err))
	}
	resp := cached.(*shortsv1alpha1.GetInstitutionResponse)
	if resp.Institution == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("institution not found"))
	}
	return connect.NewResponse(resp), nil
}

// institutionFundHoldings is how many of an institution's file holdings are
// served: its largest, by value.
const institutionFundHoldings = 100

func buildInstitution(d *ownershipData, slug string) *shortsv1alpha1.GetInstitutionResponse {
	out := &shortsv1alpha1.GetInstitutionResponse{}
	insts := d.institutionBySlug()
	inst, ok := insts[slug]
	if !ok {
		return out
	}
	out.Institution = d.institutionProto(inst, positionsByHolder(d.holdings), fundsByInstitution(d.funds))
	for _, h := range d.holdings {
		if h.HolderKey == slug {
			out.Positions = append(out.Positions, d.holdingProto(h))
		}
	}
	sort.Slice(out.Positions, func(i, j int) bool {
		if out.Positions[i].VotingPowerPct != out.Positions[j].VotingPowerPct {
			return out.Positions[i].VotingPowerPct > out.Positions[j].VotingPowerPct
		}
		return out.Positions[i].StockCode < out.Positions[j].StockCode
	})
	for _, n := range d.notices {
		if n.HolderKey == slug {
			out.Notices = append(out.Notices, d.noticeProto(n))
		}
	}
	for _, h := range d.fundHoldings {
		if len(out.FundHoldings) >= institutionFundHoldings {
			break
		}
		if h.InstitutionSlug == slug {
			out.FundHoldings = append(out.FundHoldings, d.fundHoldingProto(h, insts))
		}
	}
	for _, f := range d.funds {
		if f.InstitutionSlug == slug {
			out.Funds = append(out.Funds, fundProto(f))
		}
	}
	return out
}

func fundProto(f shortsstore.OwnershipFundRow) *shortsv1alpha1.OwnershipFund {
	out := &shortsv1alpha1.OwnershipFund{FundKey: f.FundKey, Name: f.Name, FundType: f.FundType, AsxCode: f.ASXCode,
		ManagerName: f.Manager, Category: f.Category, AsAt: f.AsAt}
	if f.Size != nil {
		out.SizeAud, out.HasSize = *f.Size, true
	}
	return out
}

func (s *ShortsServer) GetStockOwnership(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetStockOwnershipRequest],
) (*connect.Response[shortsv1alpha1.GetStockOwnershipResponse], error) {
	code := strings.ToUpper(strings.TrimSpace(req.Msg.StockCode))
	if code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.GetStockOwnershipResponse{}), nil
	}
	cached, err := s.cache.GetOrSetWithTTL(s.cache.GetStockOwnershipKey(code), ownershipTTL, func() (any, error) {
		d, err := s.loadOwnership(ctx, shortsstore.OwnershipFilter{StockCode: code}, 100, "", false)
		if err != nil {
			return nil, err
		}
		return buildStockOwnership(d, code), nil
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stock ownership: %w", err))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetStockOwnershipResponse)), nil
}

func buildStockOwnership(d *ownershipData, code string) *shortsv1alpha1.GetStockOwnershipResponse {
	views := d.stockViews()
	out := &shortsv1alpha1.GetStockOwnershipResponse{Summary: views[code]}
	if out.Summary == nil {
		c := d.companies[code]
		out.Summary = &shortsv1alpha1.OwnershipStock{StockCode: code, CompanyName: c.Name, Industry: c.Industry}
		if sp, ok := d.shorts[code]; ok {
			out.Summary.ShortPct, out.Summary.HasShortPct = sp.Pct, true
		}
	}
	if sp, ok := d.shorts[code]; ok && sp.Issued > 0 {
		out.SharesOnIssue, out.HasSharesOnIssue = sp.Issued, true
	}
	for _, h := range d.holdings {
		if h.StockCode == code {
			out.Holders = append(out.Holders, d.holdingProto(h))
		}
	}
	sort.Slice(out.Holders, func(i, j int) bool {
		if out.Holders[i].VotingPowerPct != out.Holders[j].VotingPowerPct {
			return out.Holders[i].VotingPowerPct > out.Holders[j].VotingPowerPct
		}
		return out.Holders[i].HolderKey < out.Holders[j].HolderKey
	})
	for _, n := range d.notices {
		if n.StockCode == code {
			out.History = append(out.History, d.noticeProto(n))
		}
	}
	insts := d.institutionBySlug()
	for _, h := range d.fundHoldings {
		if h.StockCode == code {
			out.FundHoldings = append(out.FundHoldings, d.fundHoldingProto(h, insts))
		}
	}
	return out
}
