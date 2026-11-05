package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The daily snapshot as the API reads it (migration 000156). With
// STRATEGY_SOURCE=snapshot the stock picker evaluates the newest completed
// session's feature rows through the engine, instead of the SQL views; a
// database without the snapshot tables, or without a completed session, serves
// the views and logs why. The two paths share the universe builder, so the
// engine sees the same inputs either way.

// snapshotUniverse builds the shared universe from the newest completed session.
// ok is false when the views should answer: the source is views, the tables are
// not migrated, or no session has completed. Any other failure is an error.
func (s *ShortsServer) snapshotUniverse(ctx context.Context) (*strategyUniverse, bool, error) {
	if s.config.StrategySource != StrategySourceSnapshot {
		return nil, false, nil
	}
	reader, ok := s.store.(strategySnapshotStore)
	if !ok {
		s.logger.Warnf("strategy source is snapshot but the store has no snapshot reader; serving the views")
		return nil, false, nil
	}
	snap, err := reader.ReadStrategySnapshot(ctx)
	switch {
	case errors.Is(err, shortsstore.ErrStrategySnapshotUnavailable):
		s.logger.Warnf("strategy source is snapshot but the snapshot tables are not migrated, serving the views: %v", err)
		return nil, false, nil
	case errors.Is(err, shortsstore.ErrNoStrategySnapshot):
		// Not expected once the daily job runs: a session that has no completed phases,
		// or a completed one with no rows or no regime. Loud, because the views are not the cutover.
		s.logger.Errorf("strategy source is snapshot but no whole snapshot session is readable, serving the views: %v", err)
		return nil, false, nil
	case err != nil:
		return nil, false, err
	}
	live, err := s.readLiveVersions(ctx)
	if err != nil {
		return nil, false, err
	}
	live, err = s.sessionLiveVersions(ctx, snap.AsOf.String(), live)
	if err != nil {
		return nil, false, err
	}
	// The snapshot's eligibility is the version the table marks live for Zanger,
	// the strategy whose universe policy every live version shares.
	zanger := resolveServedOne(spec.StrategyZangerBreakout, StrategySourceSnapshot, live)
	cands, err := snapshotCandidatesUnder(snap, zanger.reg)
	if err != nil {
		return nil, false, err
	}
	u := newStrategyUniverse(cands, snap.Regime, snap.AsOf.String(), StrategySourceSnapshot, live)
	u.ineligible = map[string]string{}
	for i := range snap.Rows {
		if ok, reason := snapshot.Eligible(snap.Rows[i], zanger.reg.Spec); !ok {
			u.ineligible[strings.ToUpper(snap.Rows[i].StockCode)] = reason
		}
	}
	return u, true, nil
}

// snapshotCandidates rebuilds a session's stored rows as the universe's
// candidates. The universe is the instruments-all policy every live version
// names (v0): a row is a candidate when snapshot.Eligible accepts it under the
// live spec. The short reading and the fundamentals come from the row and its
// blob (snapshot.ToCandidate). The live specs share one universe policy, which
// the tests pin.
func snapshotCandidates(snap shortsstore.StrategySnapshot) ([]engine.Candidate, error) {
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		return nil, errors.New("no live strategy spec for the snapshot universe")
	}
	return snapshotCandidatesUnder(snap, live)
}

// snapshotCandidatesUnder is snapshotCandidates under the given registered version.
func snapshotCandidatesUnder(snap shortsstore.StrategySnapshot, live spec.Registered) ([]engine.Candidate, error) {
	cands := make([]engine.Candidate, 0, len(snap.Rows))
	for i := range snap.Rows {
		row := snap.Rows[i]
		if eligible, _ := snapshot.Eligible(row, live.Spec); !eligible {
			continue
		}
		c, err := snapshot.ToCandidate(row, live.Spec, snap.Blobs[row.FundamentalsHash])
		if err != nil {
			return nil, fmt.Errorf("snapshot candidate %s: %w", row.StockCode, err)
		}
		cands = append(cands, c)
	}
	return cands, nil
}

// GetStrategyDataStatus reports where the readings come from: the latest
// session, the price sweep, the snapshot session, the newest ASIC reports and
// the next refresh. It is public, like the readings it describes.
func (s *ShortsServer) GetStrategyDataStatus(ctx context.Context, _ *connect.Request[shortsv1alpha1.GetStrategyDataStatusRequest]) (*connect.Response[shortsv1alpha1.GetStrategyDataStatusResponse], error) {
	reader, ok := s.store.(strategySnapshotStore)
	if !ok {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("strategy data status is not available"))
	}
	// Public and the same for every caller, so it is cached per instance like the
	// other public reads; the fill is detached from the caller's cancellation.
	v, err := s.cache.GetOrSetWithTTL(strategyDataStatusCacheKey, strategyDataStatusTTL, func() (any, error) {
		return reader.ReadStrategyDataStatus(context.WithoutCancel(ctx))
	})
	if err != nil {
		s.logger.Errorf("database error in GetStrategyDataStatus: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to read strategy data status"))
	}
	next := nextPicksRefresh(time.Now())
	if s.config.StrategySource == StrategySourceSnapshot {
		next = nextSnapshotRun(time.Now())
	}
	return connect.NewResponse(strategyDataStatusProto(v.(shortsstore.StrategyDataStatus), next)), nil
}

// The data status is read once per instance per this long; the sources move at
// most a few times a day.
const (
	strategyDataStatusCacheKey = "strategy_data_status"
	strategyDataStatusTTL      = 5 * time.Minute
)

// strategyDataStatusProto is the wire form of the source dates. It reports at
// most the newest ten ASIC reports, each with the date it became public on the
// snapshot's calendar (the store derives it, as the stored readings do).
func strategyDataStatusProto(st shortsstore.StrategyDataStatus, next time.Time) *shortsv1alpha1.GetStrategyDataStatusResponse {
	out := &shortsv1alpha1.GetStrategyDataStatusResponse{
		LatestSession:       st.LatestSession,
		PricesCompletedAt:   snapshotTimeOrEmpty(st.PricesCompletedAt),
		SnapshotAsOf:        st.SnapshotAsOf,
		SnapshotCompletedAt: snapshotTimeOrEmpty(st.SnapshotCompletedAt),
		NextUpdateUtc:       next.UTC().Format(time.RFC3339),
		PricedCodes:         int32(st.PricedCodes),
		AsicReports:         []*shortsv1alpha1.AsicReportStatus{},
	}
	for i, r := range st.AsicReports {
		if i == 10 {
			break
		}
		entry := &shortsv1alpha1.AsicReportStatus{
			ReportDate:      r.ReportDate.String(),
			FirstIngestedAt: snapshotTimeOrEmpty(&r.FirstIngestedAt),
			Rows:            int32(r.LoadedRows),
			Complete:        asicReportComplete(st.AsicReports, i),
		}
		// The date the stored short reading used, from the same calendar (the
		// store derives it); empty for a report the holiday table does not cover.
		if r.AvailableDate != nil {
			entry.AvailableDate = r.AvailableDate.String()
		}
		out.AsicReports = append(out.AsicReports, entry)
	}
	return out
}

// nextPicksRefresh is the next trading day 13:30 UTC strictly after now: the
// views' refresh (shorted picks -mode refresh). The ASX holiday table skips a
// day with no session, so the field never names a refresh that brings no data.
func nextPicksRefresh(now time.Time) time.Time {
	return nextTradingDayAt(now, 13, 30)
}

// nextSnapshotRun is the next trading day 13:00 UTC strictly after now: the
// first run of the daily snapshot job, which is what the picks wait on once the
// source is the snapshot (its runs go on until 16:40 UTC).
func nextSnapshotRun(now time.Time) time.Time {
	return nextTradingDayAt(now, 13, 0)
}

func nextTradingDayAt(now time.Time, hour, minute int) time.Time {
	t := now.UTC()
	day := time.Date(t.Year(), t.Month(), t.Day(), hour, minute, 0, 0, time.UTC)
	for !day.After(t) || !asxcalendar.IsTradingDay(day) {
		day = day.AddDate(0, 0, 1)
	}
	return day
}

// asicReportComplete is the features package's rule (Reports.Complete) over the
// newest-first list: the ingest's file row count when the ingest recorded it;
// otherwise at least half the row count of the report before it. A report with
// neither (the oldest of the list when no file count is recorded) is not shown
// as complete.
func asicReportComplete(reports []shortsstore.AsicReportRow, i int) bool {
	r := reports[i]
	if r.FileRows != nil {
		return r.LoadedRows >= *r.FileRows
	}
	if i+1 < len(reports) {
		return 2*r.LoadedRows >= reports[i+1].LoadedRows
	}
	return false
}

// snapshotTimeOrEmpty is a UTC instant as RFC 3339, "" for nil or the zero time.
func snapshotTimeOrEmpty(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// ListStrategySignalEvents returns the status changes of one strategy's
// canonical rules version, newest first, with cursor paging. A signed-in caller
// of any access level may read them; an anonymous caller is refused. The version
// is the live one unless a canonical hash is named (NotFound otherwise, so a
// variant hash is never served here).
func (s *ShortsServer) ListStrategySignalEvents(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStrategySignalEventsRequest]) (*connect.Response[shortsv1alpha1.ListStrategySignalEventsResponse], error) {
	if _, _, err := privateAccess(ctx); err != nil {
		return nil, err
	}
	msg := req.Msg
	id := strings.ToLower(strings.TrimSpace(msg.StrategyId))
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy_id is required (one of %s)", strategyIDList()))
	}
	if _, ok := engine.Lookup(id); !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", msg.StrategyId, strategyIDList()))
	}
	table, err := s.readVersionTable(ctx)
	if err != nil {
		s.logger.Errorf("ListStrategySignalEvents: reading the version table for %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("strategy signal events are not available"))
	}
	version, err := signalEventsVersion(id, msg.VersionHash, table.liveRulesHash(id))
	if err != nil {
		return nil, err
	}
	stock := ""
	if msg.StockCode != "" {
		if err := validateStockCode(msg.StockCode, "stock_code"); err != nil {
			return nil, err
		}
		stock = NormalizeStockCode(msg.StockCode)
	}
	var since *civil.Date
	if msg.Since != "" {
		t, err := time.Parse("2006-01-02", msg.Since)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("since must be a YYYY-MM-DD date"))
		}
		d := civil.DateOf(t)
		since = &d
	}
	pageSize := int(msg.PageSize)
	switch {
	case pageSize == 0:
		pageSize = strategySignalEventsDefaultPage
	case pageSize < 0 || pageSize > strategySignalEventsMaxPage:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("page_size must be between 1 and %d", strategySignalEventsMaxPage))
	}
	var after int64
	if msg.PageToken != "" {
		after, err = strconv.ParseInt(msg.PageToken, 10, 64)
		if err != nil || after <= 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("page_token is not valid"))
		}
	}

	resp := &shortsv1alpha1.ListStrategySignalEventsResponse{
		Events:  []*shortsv1alpha1.StrategySignalEvent{},
		Version: versionRefOrNil(version, table),
	}
	reader, ok := s.store.(strategySnapshotStore)
	if !ok {
		return connect.NewResponse(resp), nil
	}
	rows, err := reader.ListStrategySignalEvents(ctx, shortsstore.StrategySignalEventsFilter{
		StrategyID: id,
		RulesHash:  version.hash,
		StockCode:  stock,
		Since:      since,
		AfterID:    after,
		Limit:      pageSize + 1,
	})
	switch {
	case errors.Is(err, shortsstore.ErrStrategySnapshotUnavailable):
		return connect.NewResponse(resp), nil
	case err != nil:
		s.logger.Errorf("database error in ListStrategySignalEvents: strategy_id=%s err=%v", id, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to read signal events"))
	}
	// The store reads the version's canonical rows only; a row under any other
	// hash is dropped here too, so a store that drifted cannot serve a variant.
	kept := rows[:0]
	for _, r := range rows {
		if r.RulesHash == version.hash {
			kept = append(kept, r)
		}
	}
	rows = kept
	if len(rows) > pageSize {
		rows = rows[:pageSize]
		resp.NextPageToken = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	for i := range rows {
		ev, err := signalEventProto(rows[i])
		if err != nil {
			s.logger.Errorf("strategy signal event %d: evidence rules are unreadable, served without rule results: %v", rows[i].ID, err)
		}
		resp.Events = append(resp.Events, ev)
	}
	return connect.NewResponse(resp), nil
}

const (
	strategySignalEventsDefaultPage = 50
	strategySignalEventsMaxPage     = 200
)

// signalVersion is the rules version a signal-events request names.
type signalVersion struct {
	hash string
	reg  spec.Registered
	ok   bool
}

// signalEventsVersion resolves the requested version: the live one when hash is
// empty, else the canonical registered version with that hash (NotFound for an
// unknown hash, a variant's included, or one of another strategy).
func signalEventsVersion(strategyID, hash, liveHash string) (signalVersion, error) {
	hash = strings.ToLower(strings.TrimSpace(hash))
	if hash == "" {
		reg, ok := spec.ByHash(liveHash)
		if liveHash == "" || !ok || reg.Spec.StrategyID != strategyID {
			return signalVersion{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("no live version for strategy %q", strategyID))
		}
		return signalVersion{hash: liveHash, reg: reg, ok: true}, nil
	}
	reg, ok := spec.ByHash(hash)
	if !ok || reg.Spec.StrategyID != strategyID {
		return signalVersion{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown version_hash for strategy %q", strategyID))
	}
	return signalVersion{hash: hash, reg: reg, ok: true}, nil
}

// versionRefOrNil is the wire reference of a resolved version, nil when
// unresolved. Its status and dates are the table's, as the version RPCs state them.
func versionRefOrNil(v signalVersion, t versionTable) *shortsv1alpha1.StrategyVersionRef {
	if !v.ok {
		return nil
	}
	return versionRefWith(v.reg, v.hash, t.stateOf(v.reg, v.hash))
}

// signalEvidence is a status change's stored evidence (the daily job's compact
// JSON). R has one character per rule of the rules version the event's
// rules_hash names, in that version's rule order: P pass, F fail, U unknown. V
// and P are each rule's value and proximity in the same order (null where the
// rule has none). An exit has no pick: R is "", V and P are [].
type signalEvidence struct {
	R              string     `json:"r"`
	V              []*float64 `json:"v"`
	P              []*float64 `json:"p"`
	Close          *float64   `json:"close"`
	Pivot          *float64   `json:"pivot"`
	ShortReport    *string    `json:"short_report"`
	ShortAvailable *string    `json:"short_available"`
	Regime         *string    `json:"regime"`
}

// registeredRulesByHash maps each canonical registered version's rules hash to
// its rules in the version's rule order. It is built once, because every event
// of a page is read against it.
var registeredRulesByHash = sync.OnceValue(func() map[string][]spec.RuleSpec {
	out := make(map[string][]spec.RuleSpec)
	for _, reg := range spec.Registry() {
		h, err := spec.RulesHash(reg.Spec)
		if err != nil {
			continue
		}
		out[h] = reg.Spec.Rules
	}
	return out
})

// ruleStatusOf is the rule status one character of an event's r stands for.
func ruleStatusOf(c byte) (engine.RuleStatus, bool) {
	switch c {
	case 'P':
		return engine.RulePass, true
	case 'F':
		return engine.RuleFail, true
	case 'U':
		return engine.RuleUnknown, true
	}
	return "", false
}

// decodeSignalRules is an event's rule results: the rules version's rule ids in
// order, each with the status, value and proximity its evidence stores. An exit
// has none. Evidence that does not fit the version (an unknown rules_hash, a
// length mismatch, an unknown status character, rule results on an exit) is an
// error and returns no rules, never rules taken from the wrong version.
func decodeSignalRules(r shortsstore.StrategySignalEventRow, ev signalEvidence) ([]*shortsv1alpha1.RuleResult, error) {
	rules, ok := registeredRulesByHash()[r.RulesHash]
	if !ok {
		return nil, fmt.Errorf("rules_hash %q is not a registered version", r.RulesHash)
	}
	if r.ToStatus == string(engine.StatusNone) {
		if ev.R != "" || len(ev.V) != 0 || len(ev.P) != 0 {
			return nil, errors.New("an exit carries rule results")
		}
		return []*shortsv1alpha1.RuleResult{}, nil
	}
	if len(ev.R) != len(rules) || len(ev.V) != len(rules) || len(ev.P) != len(rules) {
		return nil, fmt.Errorf("evidence has %d statuses, %d values and %d proximities for a version of %d rules",
			len(ev.R), len(ev.V), len(ev.P), len(rules))
	}
	out := make([]*shortsv1alpha1.RuleResult, 0, len(rules))
	for i, rule := range rules {
		status, ok := ruleStatusOf(ev.R[i])
		if !ok {
			return nil, fmt.Errorf("evidence status %q at rule %d is not P, F or U", ev.R[i], i)
		}
		rr := &shortsv1alpha1.RuleResult{RuleId: rule.ID, Status: string(status)}
		// As the picks rows set it: a failing trigger on a setup row is what the
		// stock is waiting for.
		rr.Waiting = r.ToStatus == string(engine.StatusSetup) && status == engine.RuleFail && rule.Trigger
		if ev.V[i] != nil {
			rr.Value, rr.HasValue = *ev.V[i], true
		}
		if ev.P[i] != nil {
			rr.Proximity, rr.HasProximity = *ev.P[i], true
		}
		out = append(out, rr)
	}
	return out, nil
}

// evidenceClosePivot reads the two numbers of an event's evidence on their own,
// so a mistyped rule field cannot take them with it.
type evidenceClosePivot struct {
	Close json.RawMessage `json:"close"`
	Pivot json.RawMessage `json:"pivot"`
}

// evidenceNumber is a JSON number as a float64. null, an absent field and any
// other type (a string, an array) are not a number.
func evidenceNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	return f, true
}

// signalEventProto is one stored status change on the wire. Its rules come from
// the evidence read against the rules version its rules_hash names. When that
// fails the event is still returned with its close and pivot, and no rules, and
// the error says why.
func signalEventProto(r shortsstore.StrategySignalEventRow) (*shortsv1alpha1.StrategySignalEvent, error) {
	out := &shortsv1alpha1.StrategySignalEvent{
		StockCode:       r.StockCode,
		CompanyName:     r.CompanyName,
		SessionDate:     r.AsOf,
		PrevSessionDate: r.PrevAsOf,
		FromStatus:      r.FromStatus,
		ToStatus:        r.ToStatus,
		RulesHash:       r.RulesHash,
		Rules:           []*shortsv1alpha1.RuleResult{},
	}
	if r.Score != nil {
		out.Score = *r.Score
	}
	var ev signalEvidence
	if decodeErr := json.Unmarshal([]byte(r.Evidence), &ev); decodeErr != nil {
		// encoding/json skips a mistyped field, finishes the document and returns
		// the first type error at the end, and a mistyped field may still have
		// left a value behind. So close and pivot are read one at a time, and each
		// is kept only when it is a number.
		var cp evidenceClosePivot
		if json.Unmarshal([]byte(r.Evidence), &cp) == nil {
			if c, ok := evidenceNumber(cp.Close); ok {
				out.Close = c
			}
			if p, ok := evidenceNumber(cp.Pivot); ok {
				out.Pivot, out.HasPivot = p, true
			}
		}
		return out, fmt.Errorf("decode signal evidence: %w", decodeErr)
	}
	if ev.Close != nil {
		out.Close = *ev.Close
	}
	if ev.Pivot != nil {
		out.Pivot, out.HasPivot = *ev.Pivot, true
	}
	rules, err := decodeSignalRules(r, ev)
	if err != nil {
		return out, fmt.Errorf("signal evidence rules: %w", err)
	}
	out.Rules = rules
	return out, nil
}
