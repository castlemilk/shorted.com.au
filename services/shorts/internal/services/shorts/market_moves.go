package shorts

// market_moves.go is the market-moves core: one publish path and one retract
// path, shared by the HTTP endpoint (market_moves_http.go, a scoped token) and
// the admin MCP tools (mcp_admin_market_moves.go, an admin's OAuth grant), and
// the public ListMarketMoves rpc. docs/feature/market-moves/README.md is the
// contract a poster follows.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// MarketMovesPageURL is where a published move is drawn. Each move is the
// element whose id is "move-<move_key>".
const MarketMovesPageURL = "https://shorted.com.au/market-moves"

// The public read's paging bounds.
const (
	marketMovesDefaultLimit = 20
	marketMovesMaxLimit     = 100
)

var marketDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// MarketMoveError is a refused post or retraction: the HTTP status, a stable
// code, a message for the poster and, for a refused post, every field at fault.
type MarketMoveError struct {
	Status  int                    `json:"-"`
	Code    string                 `json:"error"`
	Message string                 `json:"message"`
	Fields  []MarketMoveFieldError `json:"fields,omitempty"`
	// Retryable says the same request may succeed if sent again.
	Retryable bool `json:"retryable"`
}

func (e *MarketMoveError) Error() string {
	if len(e.Fields) == 0 {
		return e.Code + ": " + e.Message
	}
	parts := make([]string, 0, len(e.Fields))
	for _, f := range e.Fields {
		parts = append(parts, f.Field+": "+f.Message)
	}
	return e.Code + ": " + e.Message + " " + strings.Join(parts, "; ")
}

// MarketMoveResult is a post or retraction that went through.
type MarketMoveResult struct {
	// Outcome is created, updated, unchanged or retracted.
	Outcome string
	Move    *shortsv1alpha1.MarketMove
	// Status is the move's status after the call: published or retracted.
	Status string
	URL    string
}

func marketMovesUnavailable() *MarketMoveError {
	return &MarketMoveError{Status: http.StatusServiceUnavailable, Code: "unavailable",
		Message: "market moves are not available on this deployment right now; nothing was written", Retryable: true}
}

// marketMoveLimits reads the poster limits. MARKET_MOVES_MAX_PER_DAY and
// MARKET_MOVES_MAX_REVISIONS override the defaults.
func marketMoveLimits() shortsstore.MarketMoveLimits {
	atoi := func(name string) int {
		n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
		if err != nil || n <= 0 {
			return 0
		}
		return n
	}
	return shortsstore.MarketMoveLimits{MaxPerDay: atoi("MARKET_MOVES_MAX_PER_DAY"), MaxRevisions: atoi("MARKET_MOVES_MAX_REVISIONS")}
}

// PublishMarketMove validates and posts one move. actor is the audit identity
// (market-moves-token, internal, oauth:<uid>); the poster never chooses it.
func (s *ShortsServer) PublishMarketMove(ctx context.Context, actor string, in MarketMoveInput) (*MarketMoveResult, error) {
	draft, fieldErrs := validateMarketMove(in, time.Now())
	if s.marketMoves == nil {
		if len(fieldErrs) > 0 {
			return nil, invalidMarketMove(fieldErrs)
		}
		return nil, marketMovesUnavailable()
	}
	// The codes are checked even when other fields failed, so one answer names
	// every problem, an unknown code included.
	if len(draft.codes) > 0 {
		known, err := s.marketMoves.KnownStockCodes(ctx, draft.codes)
		if err != nil {
			s.logger.Errorf("market moves: check codes: %v", err)
			return nil, marketMovesUnavailable()
		}
		fieldErrs = append(fieldErrs, checkMarketMoveCodes(draft, known)...)
	}
	if len(fieldErrs) > 0 {
		return nil, invalidMarketMove(fieldErrs)
	}

	rec := draft.record
	rec.Actor = actor
	res, err := s.marketMoves.UpsertMarketMove(ctx, rec, marketMoveLimits())
	if err != nil {
		return nil, s.marketMoveStoreError("post", rec.MoveKey, err)
	}
	s.logger.Infof("market move %s: key=%s kind=%s subject=%s revision=%d actor=%s run=%s",
		res.Outcome, res.Move.MoveKey, res.Move.Kind, marketMoveSubject(res.Move), res.Move.Revision, actor, res.Move.RunID)
	if res.Outcome != shortsstore.MarketMoveUnchanged {
		s.marketMovesRevalidator.notify(marketMoveCodes(res.Move))
	}
	return &MarketMoveResult{
		Outcome: res.Outcome,
		Move:    marketMoveProto(res.Move),
		Status:  res.Move.Status,
		URL:     marketMoveURL(res.Move.MoveKey),
	}, nil
}

// RetractMarketMove retracts one move. Retracting a retracted move succeeds and
// changes nothing.
func (s *ShortsServer) RetractMarketMove(ctx context.Context, actor, moveKey, reason string) (*MarketMoveResult, error) {
	key := strings.TrimSpace(moveKey)
	var fieldErrs []MarketMoveFieldError
	if !marketMoveKeyPattern.MatchString(key) {
		fieldErrs = append(fieldErrs, MarketMoveFieldError{Field: "move_key", Message: "required: the key the move was posted with"})
	}
	reason, reasonErrs := validateRetractReason(reason)
	fieldErrs = append(fieldErrs, reasonErrs...)
	if len(fieldErrs) > 0 {
		return nil, invalidMarketMove(fieldErrs)
	}
	if s.marketMoves == nil {
		return nil, marketMovesUnavailable()
	}
	move, err := s.marketMoves.RetractMarketMove(ctx, key, reason, actor)
	if err != nil {
		return nil, s.marketMoveStoreError("retract", key, err)
	}
	s.logger.Infof("market move retracted: key=%s subject=%s actor=%s", move.MoveKey, marketMoveSubject(move), actor)
	s.marketMovesRevalidator.notify(marketMoveCodes(move))
	return &MarketMoveResult{
		Outcome: shortsstore.MarketMoveRetracted,
		Move:    marketMoveProto(move),
		Status:  move.Status,
		URL:     marketMoveURL(move.MoveKey),
	}, nil
}

func invalidMarketMove(fields []MarketMoveFieldError) *MarketMoveError {
	return &MarketMoveError{Status: http.StatusUnprocessableEntity, Code: "invalid_move",
		Message: "the move was not posted; fix every field listed and post it again", Fields: fields}
}

// marketMoveStoreError maps a store error to the poster's answer.
func (s *ShortsServer) marketMoveStoreError(op, key string, err error) *MarketMoveError {
	switch {
	case errors.Is(err, shortsstore.ErrMarketMoveRetracted):
		return &MarketMoveError{Status: http.StatusConflict, Code: "retracted",
			Message: fmt.Sprintf("%s was retracted, and a retraction is final; post the corrected move under a new move_key", key)}
	case errors.Is(err, shortsstore.ErrMarketMoveSubjectChanged):
		return &MarketMoveError{Status: http.StatusConflict, Code: "subject_changed", Message: storeReason(err, shortsstore.ErrMarketMoveSubjectChanged)}
	case errors.Is(err, shortsstore.ErrMarketMoveBusy):
		return &MarketMoveError{Status: http.StatusConflict, Code: "busy",
			Message: fmt.Sprintf("another post of %s landed at the same moment; send this one again", key), Retryable: true}
	case errors.Is(err, shortsstore.ErrMarketMoveDailyCap):
		return &MarketMoveError{Status: http.StatusTooManyRequests, Code: "daily_cap", Message: storeReason(err, shortsstore.ErrMarketMoveDailyCap) +
			"; revise an existing move (re-post its move_key) instead of adding one"}
	case errors.Is(err, shortsstore.ErrMarketMoveRevisionCap):
		return &MarketMoveError{Status: http.StatusTooManyRequests, Code: "revision_cap", Message: storeReason(err, shortsstore.ErrMarketMoveRevisionCap)}
	case errors.Is(err, shortsstore.ErrMarketMoveNotFound):
		return &MarketMoveError{Status: http.StatusNotFound, Code: "not_found", Message: fmt.Sprintf("no move was posted with move_key %s", key)}
	case errors.Is(err, shortsstore.ErrRelationMissing):
		s.logger.Errorf("market moves: %s %s: the market_moves table is missing (migration 000160): %v", op, key, err)
		return marketMovesUnavailable()
	default:
		s.logger.Errorf("market moves: %s %s: %v", op, key, err)
		return marketMovesUnavailable()
	}
}

// storeReason is the store's detail after its sentinel ("<sentinel>: <detail>").
func storeReason(err, sentinel error) string {
	return strings.TrimPrefix(err.Error(), sentinel.Error()+": ")
}

// marketMoveCodes are the stock codes a move names, primary first.
func marketMoveCodes(m shortsstore.MarketMoveRecord) []string {
	codes := []string{}
	if m.StockCode != "" {
		codes = append(codes, m.StockCode)
	}
	return append(codes, m.RelatedCodes...)
}

func marketMoveSubject(m shortsstore.MarketMoveRecord) string {
	return firstNonEmptyString(m.StockCode, m.IndexCode, m.Sector, "market")
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func marketMoveURL(key string) string {
	return MarketMovesPageURL + "#move-" + key
}

// marketMoveProto is the public shape of a move. The audit fields (actor,
// run id, content hash, the retraction reason) are not part of it.
func marketMoveProto(m shortsstore.MarketMoveRecord) *shortsv1alpha1.MarketMove {
	out := &shortsv1alpha1.MarketMove{
		MoveKey:      m.MoveKey,
		Kind:         m.Kind,
		StockCode:    m.StockCode,
		CompanyName:  m.CompanyName,
		IndexCode:    m.IndexCode,
		Sector:       m.Sector,
		RelatedCodes: append([]string{}, m.RelatedCodes...),
		Direction:    m.Direction,
		Headline:     m.Headline,
		Summary:      m.Summary,
		Tags:         append([]string{}, m.Tags...),
		Significance: int32(m.Significance),
		ObservedAt:   m.ObservedAt.UTC().Format(time.RFC3339),
		MarketDate:   m.MarketDate,
		Revision:     int32(m.Revision),
		PublishedAt:  m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:    m.UpdatedAt.UTC().Format(time.RFC3339),
		Model:        m.Model,
	}
	if m.ChangePct != nil {
		out.ChangePct, out.HasChangePct = *m.ChangePct, true
	}
	if m.Price != nil {
		out.Price, out.HasPrice = *m.Price, true
	}
	if m.VolumeRatio != nil {
		out.VolumeRatio, out.HasVolumeRatio = *m.VolumeRatio, true
	}
	for _, src := range m.Sources {
		out.Sources = append(out.Sources, &shortsv1alpha1.MarketMoveSource{Title: src.Title, Url: src.URL, Publisher: src.Publisher})
	}
	return out
}

// ListMarketMoves serves published moves, newest observation first.
func (s *ShortsServer) ListMarketMoves(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListMarketMovesRequest],
) (*connect.Response[shortsv1alpha1.ListMarketMovesResponse], error) {
	f, limit, err := marketMovesFilter(req.Msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if s.marketMoves == nil {
		return connect.NewResponse(&shortsv1alpha1.ListMarketMovesResponse{}), nil
	}
	rows, err := s.marketMoves.ListMarketMoves(ctx, f)
	if err != nil {
		s.logger.Errorf("ListMarketMoves: %v", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list market moves"))
	}
	resp := &shortsv1alpha1.ListMarketMovesResponse{Moves: []*shortsv1alpha1.MarketMove{}}
	if len(rows) > limit {
		last := rows[limit-1]
		resp.NextCursor = encodeMarketMovesCursor(last.ObservedAt, last.ID)
		rows = rows[:limit]
	}
	for _, r := range rows {
		resp.Moves = append(resp.Moves, marketMoveProto(r))
	}
	return connect.NewResponse(resp), nil
}

// marketMovesFilter parses a list request. It reads one row more than it
// serves, to learn whether a next page exists.
func marketMovesFilter(req *shortsv1alpha1.ListMarketMovesRequest) (shortsstore.MarketMovesFilter, int, error) {
	f := shortsstore.MarketMovesFilter{}
	if code := strings.ToUpper(strings.TrimSpace(req.GetStockCode())); code != "" {
		if !marketMoveCodePattern.MatchString(code) {
			return f, 0, fmt.Errorf("stock_code %q is not an ASX code", req.GetStockCode())
		}
		f.StockCode = code
	}
	if kind := strings.TrimSpace(req.GetKind()); kind != "" {
		if !slices.Contains(marketMoveKinds, kind) {
			return f, 0, fmt.Errorf("kind must be one of %s", strings.Join(marketMoveKinds, ", "))
		}
		f.Kind = kind
	}
	if date := strings.TrimSpace(req.GetMarketDate()); date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil || !marketDatePattern.MatchString(date) {
			return f, 0, fmt.Errorf("market_date must be YYYY-MM-DD")
		}
		f.MarketDate = date
	}
	if n := req.GetMinSignificance(); n != 0 {
		if n < 1 || n > 5 {
			return f, 0, fmt.Errorf("min_significance must be 1 to 5")
		}
		f.MinSignificance = int(n)
	}
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = marketMovesDefaultLimit
	}
	if limit > marketMovesMaxLimit {
		limit = marketMovesMaxLimit
	}
	if c := strings.TrimSpace(req.GetCursor()); c != "" {
		at, id, ok := decodeMarketMovesCursor(c)
		if !ok {
			return f, 0, fmt.Errorf("cursor is not one this API issued")
		}
		f.BeforeObservedAt, f.BeforeID = &at, id
	}
	f.Limit = limit + 1
	return f, limit, nil
}

// The cursor is the last served row's (observed_at, id), opaque to callers.
func encodeMarketMovesCursor(at time.Time, id int64) string {
	raw := strconv.FormatInt(at.UTC().UnixMicro(), 10) + "." + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeMarketMovesCursor(c string) (time.Time, int64, bool) {
	if len(c) > 64 {
		return time.Time{}, 0, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, 0, false
	}
	micros, id, ok := strings.Cut(string(raw), ".")
	if !ok {
		return time.Time{}, 0, false
	}
	us, err1 := strconv.ParseInt(micros, 10, 64)
	n, err2 := strconv.ParseInt(id, 10, 64)
	if err1 != nil || err2 != nil || n <= 0 || us <= 0 {
		return time.Time{}, 0, false
	}
	return time.UnixMicro(us).UTC(), n, true
}
