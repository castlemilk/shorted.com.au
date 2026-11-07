package shorts

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// fakeMoves is an in-memory MarketMovesStore with the store's contract: a key
// is one row, a re-post with new content is a revision, the same content is
// unchanged, a retraction is final, the subject cannot change, and the list
// serves published rows newest observation first.
type fakeMoves struct {
	mu      sync.Mutex
	rows    []shortsstore.MarketMoveRecord
	known   map[string]bool
	missing bool
	nextID  int64
}

func newFakeMoves(known ...string) *fakeMoves {
	f := &fakeMoves{known: map[string]bool{}}
	for _, c := range known {
		f.known[c] = true
	}
	return f
}

func (f *fakeMoves) UpsertMarketMove(_ context.Context, rec shortsstore.MarketMoveRecord, limits shortsstore.MarketMoveLimits) (shortsstore.MarketMoveUpsertResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missing {
		return shortsstore.MarketMoveUpsertResult{}, shortsstore.ErrRelationMissing
	}
	now := time.Now().UTC()
	for i, r := range f.rows {
		if r.MoveKey != rec.MoveKey {
			continue
		}
		switch {
		case r.Status == shortsstore.MarketMoveRetracted:
			return shortsstore.MarketMoveUpsertResult{}, shortsstore.ErrMarketMoveRetracted
		case r.Kind != rec.Kind || r.StockCode != rec.StockCode || r.IndexCode != rec.IndexCode || r.Sector != rec.Sector:
			return shortsstore.MarketMoveUpsertResult{}, shortsstore.ErrMarketMoveSubjectChanged
		case r.ContentHash == rec.ContentHash:
			return shortsstore.MarketMoveUpsertResult{Move: r, Outcome: shortsstore.MarketMoveUnchanged}, nil
		}
		rec.ID, rec.Status, rec.Revision, rec.CreatedAt, rec.UpdatedAt = r.ID, r.Status, r.Revision+1, r.CreatedAt, now
		f.rows[i] = rec
		return shortsstore.MarketMoveUpsertResult{Move: rec, Outcome: shortsstore.MarketMoveUpdated}, nil
	}
	max := limits.MaxPerDay
	if max <= 0 {
		max = shortsstore.DefaultMarketMovesPerDay
	}
	n := 0
	for _, r := range f.rows {
		if r.MarketDate == rec.MarketDate {
			n++
		}
	}
	if n >= max {
		return shortsstore.MarketMoveUpsertResult{}, shortsstore.ErrMarketMoveDailyCap
	}
	f.nextID++
	rec.ID, rec.Status, rec.Revision, rec.CreatedAt, rec.UpdatedAt = f.nextID, shortsstore.MarketMovePublished, 1, now, now
	f.rows = append(f.rows, rec)
	return shortsstore.MarketMoveUpsertResult{Move: rec, Outcome: shortsstore.MarketMoveCreated}, nil
}

func (f *fakeMoves) RetractMarketMove(_ context.Context, key, reason, actor string) (shortsstore.MarketMoveRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, r := range f.rows {
		if r.MoveKey == key {
			if r.Status != shortsstore.MarketMoveRetracted {
				now := time.Now().UTC()
				r.Status, r.RetractedAt, r.RetractReason, r.Actor = shortsstore.MarketMoveRetracted, &now, reason, actor
				f.rows[i] = r
			}
			return r, nil
		}
	}
	return shortsstore.MarketMoveRecord{}, shortsstore.ErrMarketMoveNotFound
}

func (f *fakeMoves) ListMarketMoves(_ context.Context, flt shortsstore.MarketMovesFilter) ([]shortsstore.MarketMoveRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []shortsstore.MarketMoveRecord{}
	for _, r := range f.rows {
		if r.Status != shortsstore.MarketMovePublished {
			continue
		}
		if flt.StockCode != "" && r.StockCode != flt.StockCode && !slices.Contains(r.RelatedCodes, flt.StockCode) {
			continue
		}
		if flt.Kind != "" && r.Kind != flt.Kind {
			continue
		}
		if flt.BeforeObservedAt != nil {
			if r.ObservedAt.After(*flt.BeforeObservedAt) || (r.ObservedAt.Equal(*flt.BeforeObservedAt) && r.ID >= flt.BeforeID) {
				continue
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ObservedAt.Equal(out[j].ObservedAt) {
			return out[i].ObservedAt.After(out[j].ObservedAt)
		}
		return out[i].ID > out[j].ID
	})
	if len(out) > flt.Limit {
		out = out[:flt.Limit]
	}
	return out, nil
}

func (f *fakeMoves) KnownStockCodes(_ context.Context, codes []string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, c := range codes {
		if f.known[c] {
			out[c] = true
		}
	}
	return out, nil
}

func movesServer(t *testing.T, moves shortsstore.MarketMovesStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	logger := mocks.NewMockLogger(ctrl)
	for _, call := range []func(any, ...any) *gomock.Call{logger.EXPECT().Debugf, logger.EXPECT().Infof, logger.EXPECT().Warnf, logger.EXPECT().Errorf} {
		call(gomock.Any(), gomock.Any()).AnyTimes()
	}
	srv.logger = logger
	srv.marketMoves = moves
	tokens := newFakeTokens()
	tokens.seed(t, testMovesToken, "test workflow")
	srv.marketMovesTokenStore = tokens
	srv.marketMovesTokens = newMarketMovesTokenVerifier(tokens, logger)
	return srv
}

func ptr(v float64) *float64 { return &v }

// validMove is a good stock move observed a minute ago.
func validMove() MarketMoveInput {
	return MarketMoveInput{
		MoveKey:      "2026-11-07:bhp:iron-ore",
		Kind:         "stock",
		StockCode:    "bhp",
		RelatedCodes: []string{"RIO", "fmg", "RIO", "BHP"},
		Direction:    "up",
		ChangePct:    ptr(4.2),
		Price:        ptr(45.1),
		Headline:     "BHP jumps 4.2% as iron ore rallies",
		Summary:      "Iron ore futures rose 6% overnight\n\n\n  after China announced new stimulus.",
		Sources:      []MarketMoveSource{{Title: "Iron ore jumps", URL: "https://www.example.com/iron-ore", Publisher: "Example"}},
		Tags:         []string{"Iron-Ore"},
		ObservedAt:   time.Now().Add(-time.Minute).Format(time.RFC3339),
		Model:        "claude-opus-5-5",
		RunID:        "run-1",
	}
}

func fieldsOf(errs []MarketMoveFieldError) []string {
	out := make([]string, 0, len(errs))
	for _, e := range errs {
		out = append(out, e.Field)
	}
	return out
}

func TestValidateMarketMoveNormalisesAGoodMove(t *testing.T) {
	draft, errs := validateMarketMove(validMove(), time.Now())
	require.Empty(t, errs)
	rec := draft.record
	assert.Equal(t, "BHP", rec.StockCode)
	assert.Equal(t, []string{"RIO", "FMG"}, rec.RelatedCodes, "upper-cased, deduplicated, without the move's own code")
	assert.Equal(t, []string{"BHP", "RIO", "FMG"}, draft.codes, "every code it names, primary first")
	assert.Equal(t, "Iron ore futures rose 6% overnight\n\nafter China announced new stimulus.", rec.Summary)
	assert.Equal(t, []string{"iron-ore"}, rec.Tags)
	assert.Equal(t, 3, rec.Significance, "the default")
	assert.Nil(t, rec.VolumeRatio, "a figure not given stays nil, never 0")
	assert.NotEmpty(t, rec.ContentHash)
	assert.Regexp(t, `^\d{4}-\d{2}-\d{2}$`, rec.MarketDate)
}

func TestValidateMarketMoveFilesUnderTheSydneyDate(t *testing.T) {
	in := validMove()
	// 14:30 UTC on 7 November is 01:30 on 8 November in Sydney (AEDT, +11).
	now := time.Date(2026, 11, 7, 14, 31, 0, 0, time.UTC)
	in.ObservedAt = "2026-11-07T14:30:00Z"
	draft, errs := validateMarketMove(in, now)
	require.Empty(t, errs)
	assert.Equal(t, "2026-11-08", draft.record.MarketDate)
}

func TestValidateMarketMoveReportsEveryProblemAtOnce(t *testing.T) {
	in := MarketMoveInput{
		MoveKey:      "Bad Key",
		Kind:         "stock",
		RelatedCodes: []string{"not a code"},
		Direction:    "down",
		ChangePct:    ptr(2.5),
		Headline:     "short",
		Summary:      "too short",
		Sources:      []MarketMoveSource{{Title: "x", URL: "http://example.com"}, {Title: "y", URL: "https://127.0.0.1/a"}},
		Tags:         []string{"Has Space"},
		Significance: 9,
		ObservedAt:   "yesterday",
		Model:        "<script>",
	}
	_, errs := validateMarketMove(in, time.Now())
	assert.ElementsMatch(t, []string{
		"move_key", "stock_code", "related_codes[0]", "direction", "headline", "summary",
		"sources[0].url", "sources[1].url", "tags[0]", "significance", "observed_at", "model",
	}, fieldsOf(errs))
}

func TestValidateMarketMoveRules(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name   string
		mutate func(*MarketMoveInput)
		field  string
	}{
		{"a stock move needs its figure", func(m *MarketMoveInput) { m.ChangePct = nil }, "change_pct"},
		{"up with a fall", func(m *MarketMoveInput) { m.ChangePct = ptr(-1) }, "direction"},
		{"flat beyond half a percent", func(m *MarketMoveInput) { m.Direction = "flat"; m.ChangePct = ptr(0.8) }, "direction"},
		{"a move below -100%", func(m *MarketMoveInput) { m.Direction = "down"; m.ChangePct = ptr(-120) }, "change_pct"},
		{"a non-stock move with a stock code", func(m *MarketMoveInput) { m.Kind = "market" }, "stock_code"},
		{"an index move needs its index", func(m *MarketMoveInput) { m.Kind = "index"; m.StockCode = "" }, "index_code"},
		{"an index code that is not one", func(m *MarketMoveInput) { m.Kind = "index"; m.StockCode = ""; m.IndexCode = "ASX200" }, "index_code"},
		{"a sector move needs its sector", func(m *MarketMoveInput) { m.Kind = "sector"; m.StockCode = "" }, "sector"},
		{"an observation in the future", func(m *MarketMoveInput) { m.ObservedAt = now.Add(time.Hour).Format(time.RFC3339) }, "observed_at"},
		{"an observation four days old", func(m *MarketMoveInput) { m.ObservedAt = now.Add(-96 * time.Hour).Format(time.RFC3339) }, "observed_at"},
		{"a negative price", func(m *MarketMoveInput) { m.Price = ptr(-1) }, "price"},
		{"a headline with a bidi override", func(m *MarketMoveInput) { m.Headline = "BHP jumps \u202e4.2% today" }, "headline"},
		{"a source with credentials", func(m *MarketMoveInput) { m.Sources[0].URL = "https://user:pw@example.com/a" }, "sources[0].url"},
		{"a source on localhost", func(m *MarketMoveInput) { m.Sources[0].URL = "https://localhost/a" }, "sources[0].url"},
		{"eleven related codes", func(m *MarketMoveInput) {
			m.RelatedCodes = []string{"AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ", "KKK"}
		}, "related_codes"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validMove()
			tc.mutate(&in)
			_, errs := validateMarketMove(in, now)
			assert.Contains(t, fieldsOf(errs), tc.field)
		})
	}
}

func TestValidateMarketMoveAcceptsAMarketMoveWithoutAFigure(t *testing.T) {
	in := validMove()
	in.Kind, in.StockCode, in.Direction, in.ChangePct = "market", "", "mixed", nil
	draft, errs := validateMarketMove(in, time.Now())
	require.Empty(t, errs)
	assert.Nil(t, draft.record.ChangePct)
	assert.Equal(t, []string{"RIO", "FMG", "BHP"}, draft.record.RelatedCodes)
}

func TestMarketMoveContentHashIgnoresTheRunOnly(t *testing.T) {
	a, _ := validateMarketMove(validMove(), time.Now())
	in := validMove()
	in.RunID = "run-2"
	b, _ := validateMarketMove(in, time.Now())
	assert.Equal(t, a.record.ContentHash, b.record.ContentHash, "the same move posted by the next run is the same move")
	in.ChangePct = ptr(4.3)
	c, _ := validateMarketMove(in, time.Now())
	assert.NotEqual(t, a.record.ContentHash, c.record.ContentHash)
}

// --- the HTTP door -----------------------------------------------------------

func postJSON(t *testing.T, h http.Handler, path, auth string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	switch b := body.(type) {
	case string:
		buf.WriteString(b)
	default:
		require.NoError(t, json.NewEncoder(&buf).Encode(b))
	}
	req := httptest.NewRequest(http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeMoveBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out
}

func TestMarketMovesEndpointAuth(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "internal-secret")
	srv := movesServer(t, newFakeMoves("BHP", "RIO", "FMG"))
	h := srv.MarketMovesPublishHandler()

	assert.Equal(t, http.StatusUnauthorized, postJSON(t, h, MarketMovesPath, "", validMove()).Code, "no credential")
	assert.Equal(t, http.StatusUnauthorized, postJSON(t, h, MarketMovesPath, "wrong", validMove()).Code, "a wrong token")

	rec := postJSON(t, h, MarketMovesPath, testMovesToken, validMove())
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, "token:1", srv.marketMoves.(*fakeMoves).rows[0].Actor, "a post names the token that made it")
	body := decodeMoveBody(t, rec)
	assert.Equal(t, "created", body["outcome"])
	assert.Equal(t, "https://shorted.com.au/market-moves#move-2026-11-07:bhp:iron-ore", body["url"])
	move := body["move"].(map[string]any)
	assert.Equal(t, "BHP", move["stock_code"], "the move is the proto's shape, in its field names")
	assert.Equal(t, false, move["has_volume_ratio"])

	again := postJSON(t, h, MarketMovesPath, "internal-secret", validMove())
	require.Equal(t, http.StatusOK, again.Code, "the internal secret is a superset")
	assert.Equal(t, "unchanged", decodeMoveBody(t, again)["outcome"])
}

func TestMarketMovesEmptyCredentialIsRefused(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "internal-secret")
	srv := movesServer(t, newFakeMoves("BHP"))
	req := httptest.NewRequest(http.MethodPost, MarketMovesPath, strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer ")
	req.Header.Set(marketMovesTokenHeader, "")
	rec := httptest.NewRecorder()
	srv.MarketMovesPublishHandler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestMarketMovesEndpointRefusals(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "internal-secret")
	moves := newFakeMoves("BHP", "RIO", "FMG")
	srv := movesServer(t, moves)
	h := srv.MarketMovesPublishHandler()

	t.Run("an unknown field is refused, not dropped", func(t *testing.T) {
		rec := postJSON(t, h, MarketMovesPath, testMovesToken, `{"move_key":"k-1","changePct":3}`)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "changePct")
	})

	t.Run("an unknown code is refused with its field", func(t *testing.T) {
		in := validMove()
		in.MoveKey = "2026-11-07:xyz"
		in.RelatedCodes = []string{"ZZZ"}
		rec := postJSON(t, h, MarketMovesPath, testMovesToken, in)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		body := decodeMoveBody(t, rec)
		assert.Equal(t, "invalid_move", body["error"])
		fields := body["fields"].([]any)
		require.Len(t, fields, 1)
		assert.Equal(t, "related_codes[0]", fields[0].(map[string]any)["field"])
	})

	t.Run("an unknown code is named in the same answer as the other problems", func(t *testing.T) {
		in := validMove()
		in.MoveKey = "2026-11-07:both"
		in.StockCode = "ZZZ"
		in.Headline = "x"
		rec := postJSON(t, h, MarketMovesPath, testMovesToken, in)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		names := []string{}
		for _, f := range decodeMoveBody(t, rec)["fields"].([]any) {
			names = append(names, f.(map[string]any)["field"].(string))
		}
		assert.ElementsMatch(t, []string{"headline", "stock_code"}, names)
	})

	t.Run("a revision, then a retraction, then a refused re-post", func(t *testing.T) {
		in := validMove()
		in.MoveKey = "2026-11-07:bhp:close"
		require.Equal(t, http.StatusCreated, postJSON(t, h, MarketMovesPath, testMovesToken, in).Code)
		in.ChangePct = ptr(5.1)
		in.Headline = "BHP closes up 5.1% as iron ore rallies"
		rec := postJSON(t, h, MarketMovesPath, testMovesToken, in)
		require.Equal(t, http.StatusOK, rec.Code)
		body := decodeMoveBody(t, rec)
		assert.Equal(t, "updated", body["outcome"])
		assert.EqualValues(t, 2, body["move"].(map[string]any)["revision"])

		retract := postJSON(t, srv.MarketMovesRetractHandler(), MarketMovesRetractPath, testMovesToken,
			MarketMovesRetractRequest{MoveKey: in.MoveKey, Reason: "wrong close"})
		require.Equal(t, http.StatusOK, retract.Code, retract.Body.String())
		assert.Equal(t, "retracted", decodeMoveBody(t, retract)["status"])

		repost := postJSON(t, h, MarketMovesPath, testMovesToken, in)
		assert.Equal(t, http.StatusConflict, repost.Code)
		assert.Equal(t, "retracted", decodeMoveBody(t, repost)["error"])
	})

	t.Run("a re-post cannot change the subject", func(t *testing.T) {
		in := validMove()
		in.MoveKey = "2026-11-07:subject"
		require.Equal(t, http.StatusCreated, postJSON(t, h, MarketMovesPath, testMovesToken, in).Code)
		in.StockCode, in.RelatedCodes = "RIO", nil
		rec := postJSON(t, h, MarketMovesPath, testMovesToken, in)
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Equal(t, "subject_changed", decodeMoveBody(t, rec)["error"])
	})

	t.Run("retracting an unknown key is not found", func(t *testing.T) {
		rec := postJSON(t, srv.MarketMovesRetractHandler(), MarketMovesRetractPath, testMovesToken, MarketMovesRetractRequest{MoveKey: "no-such-key"})
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("GET is not a read", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, MarketMovesPath, nil)
		req.Header.Set("Authorization", "Bearer "+testMovesToken)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
		assert.Equal(t, "POST", rec.Header().Get("Allow"))
	})

	t.Run("a missing table answers 503 and says nothing was written", func(t *testing.T) {
		missing := newFakeMoves("BHP", "RIO", "FMG")
		missing.missing = true
		rec := postJSON(t, movesServer(t, missing).MarketMovesPublishHandler(), MarketMovesPath, testMovesToken, validMove())
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
		assert.Equal(t, "5", rec.Header().Get("Retry-After"))
	})

	t.Run("no store answers 503", func(t *testing.T) {
		rec := postJSON(t, movesServer(t, nil).MarketMovesPublishHandler(), MarketMovesPath, testMovesToken, validMove())
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	})
}

// --- the read ----------------------------------------------------------------

func TestListMarketMovesPagesNewestFirst(t *testing.T) {
	moves := newFakeMoves("BHP", "RIO", "FMG")
	srv := movesServer(t, moves)
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	for i := range 5 {
		in := validMove()
		in.MoveKey = "page-" + string(rune('a'+i))
		in.ObservedAt = base.Add(time.Duration(i) * time.Minute).Format(time.RFC3339)
		_, err := srv.PublishMarketMove(ctx, "test", in)
		require.NoError(t, err)
	}
	_, err := srv.RetractMarketMove(ctx, "test", "page-e", "")
	require.NoError(t, err)

	first, err := srv.ListMarketMoves(ctx, connect.NewRequest(&shortsv1alpha1.ListMarketMovesRequest{Limit: 2}))
	require.NoError(t, err)
	require.Len(t, first.Msg.Moves, 2)
	assert.Equal(t, "page-d", first.Msg.Moves[0].MoveKey, "the retracted newest move is not served")
	assert.Equal(t, "page-c", first.Msg.Moves[1].MoveKey)
	require.NotEmpty(t, first.Msg.NextCursor)

	second, err := srv.ListMarketMoves(ctx, connect.NewRequest(&shortsv1alpha1.ListMarketMovesRequest{Limit: 2, Cursor: first.Msg.NextCursor}))
	require.NoError(t, err)
	require.Len(t, second.Msg.Moves, 2)
	assert.Equal(t, "page-b", second.Msg.Moves[0].MoveKey)
	assert.Equal(t, "page-a", second.Msg.Moves[1].MoveKey)
	assert.Empty(t, second.Msg.NextCursor, "four published moves fill two pages; the last page has no cursor")

	related, err := srv.ListMarketMoves(ctx, connect.NewRequest(&shortsv1alpha1.ListMarketMovesRequest{StockCode: "fmg"}))
	require.NoError(t, err)
	assert.Len(t, related.Msg.Moves, 4, "a stock's moves include the moves naming it")
}

func TestListMarketMovesRefusesABadRequest(t *testing.T) {
	srv := movesServer(t, newFakeMoves())
	for _, req := range []*shortsv1alpha1.ListMarketMovesRequest{
		{StockCode: "not a code"},
		{Kind: "crypto"},
		{MarketDate: "07/11/2026"},
		{MinSignificance: 6},
		{Cursor: "forged"},
	} {
		_, err := srv.ListMarketMoves(context.Background(), connect.NewRequest(req))
		assert.Equal(t, connect.CodeInvalidArgument, connectCode(err), "%v", req)
	}
}

func TestListMarketMovesWithoutAStoreIsEmpty(t *testing.T) {
	res, err := movesServer(t, nil).ListMarketMoves(context.Background(), connect.NewRequest(&shortsv1alpha1.ListMarketMovesRequest{}))
	require.NoError(t, err)
	assert.Empty(t, res.Msg.Moves)
}

func TestMarketMovesCursorRoundTrips(t *testing.T) {
	at := time.Date(2026, 11, 7, 3, 4, 5, 123456000, time.UTC)
	got, id, ok := decodeMarketMovesCursor(encodeMarketMovesCursor(at, 42))
	require.True(t, ok)
	assert.True(t, at.Equal(got))
	assert.EqualValues(t, 42, id)
}

// --- the MCP tool's input is the HTTP body -----------------------------------

func jsonNames(t reflect.Type) []string {
	var out []string
	for i := range t.NumField() {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func TestMarketMoveToolInputMatchesTheHTTPBody(t *testing.T) {
	assert.Equal(t, jsonNames(reflect.TypeOf(MarketMoveInput{})), jsonNames(reflect.TypeOf(mcp.PostMarketMoveInput{})))
	assert.Equal(t, jsonNames(reflect.TypeOf(MarketMoveSource{})), jsonNames(reflect.TypeOf(mcp.MarketMoveSourceInput{})))
	assert.Equal(t, jsonNames(reflect.TypeOf(MarketMovesRetractRequest{})), jsonNames(reflect.TypeOf(mcp.RetractMarketMoveInput{})))

	// Every field the tool takes reaches the core: a fully populated input
	// survives the copy.
	in := mcp.PostMarketMoveInput{
		MoveKey: "k", Kind: "stock", StockCode: "BHP", IndexCode: "XJO", Sector: "S", RelatedCodes: []string{"RIO"},
		Direction: "up", ChangePct: ptr(1), Price: ptr(2), VolumeRatio: ptr(3), Headline: "h", Summary: "s",
		Sources: []mcp.MarketMoveSourceInput{{Title: "t", URL: "u", Publisher: "p"}}, Tags: []string{"t"},
		Significance: 4, ObservedAt: "o", Model: "m", RunID: "r",
	}
	got := marketMoveInputFromTool(in)
	v := reflect.ValueOf(got)
	for i := range v.NumField() {
		assert.False(t, v.Field(i).IsZero(), "field %s was not copied", v.Type().Field(i).Name)
	}
}

func TestMarketMoveToolRefusalListsEveryField(t *testing.T) {
	srv := movesServer(t, newFakeMoves("BHP"))
	adapter := marketMovesToolAdapter{server: srv}
	_, err := adapter.PostMarketMove(context.Background(), "oauth:uid", mcp.PostMarketMoveInput{MoveKey: "k-1", Kind: "stock"})
	require.Error(t, err)
	var refusal *mcp.MarketMoveRefusal
	require.ErrorAs(t, err, &refusal)
	assert.Equal(t, "invalid_move", refusal.Code)
	assert.Contains(t, err.Error(), "- stock_code:")
	assert.Contains(t, err.Error(), "- headline:")
}

// --- revalidation --------------------------------------------------------------

func TestMarketMovesRevalidatorCoalescesABurst(t *testing.T) {
	var mu sync.Mutex
	var calls []*http.Request
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, r)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()
	t.Setenv("REVALIDATION_URL", ts.URL+"/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "reval")

	r := newMarketMovesRevalidator(nil)
	require.NotNil(t, r)
	r.delay = 20 * time.Millisecond
	r.notify([]string{"BHP"})
	r.notify([]string{"RIO", "BHP"})
	assert.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(calls) == 1
	}, time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, calls, 1, "one ping for the burst")
	q := calls[0].URL.Query()
	assert.Equal(t, "market-moves,market-moves:home,market-moves:stock:BHP,market-moves:stock:RIO", q.Get("tag"))
	assert.Equal(t, "/,/market-moves,/shorts/BHP,/shorts/RIO", q.Get("path"))
	assert.Equal(t, "reval", calls[0].Header.Get("X-Revalidate-Secret"))
}

func TestMarketMovesRevalidatorIsOffWithoutItsEndpoint(t *testing.T) {
	t.Setenv("REVALIDATION_URL", "")
	t.Setenv("REVALIDATION_SECRET", "reval")
	r := newMarketMovesRevalidator(nil)
	assert.Nil(t, r)
	r.notify([]string{"BHP"}) // a nil revalidator is a no-op, never a panic
}
