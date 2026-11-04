package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/viewerctx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// vdClampLimit is the public depth the viewer tests set on the flag.
const vdClampLimit = 10

// vdUniverse is spUniverse plus twelve more triggered stocks, so the ranked
// list holds more rows than the clamp returns.
//
// RDY carries the largest market cap of the triggered rows. Equal scores keep
// code order, so RDY ranks thirteenth, outside the default top ten, and a sort
// by market cap would reach it if the sort ran before the clamp.
func vdUniverse() []engine.Candidate {
	out := spUniverse()
	for i := range 12 {
		out = append(out, spReady(fmt.Sprintf("RD%02d", i)))
	}
	for i := range out {
		if out[i].StockCode == "RDY" {
			out[i].MarketCap = new(float64(9e9))
		}
	}
	return out
}

// vdServer returns a server over vdUniverse with the public depth flag set to
// limit (0 is off). Its store answers any number of reads, since the caches
// decide how many.
func vdServer(t *testing.T, limit int) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListStrategyCandidates(gomock.Any()).Return(vdUniverse(), nil).AnyTimes()
	store.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).AnyTimes()
	srv := newTestServer(t, store)
	srv.config.StrategyPublicSignalsLimit = limit
	return srv
}

// vdClaims is a context as the interceptor leaves it for a verified caller.
func vdClaims(uid, tier string, tierResolved bool) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{UserID: uid, Tier: tier, TierResolved: tierResolved})
}

// vdWebSession is a context as the interceptor leaves it when the website,
// holding the internal secret, calls for a signed-in user.
func vdWebSession(uid string) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID: uid, Tier: "premium", TierResolved: true,
		AuthMethod: AuthMethodInternal, WebOnBehalf: true, IsBrowserAuth: true,
	})
}

// vdFirebase is a context as the interceptor leaves it for a Firebase ID token.
func vdFirebase(uid, tier string) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID: uid, Tier: tier, TierResolved: true,
		AuthMethod: AuthMethodFirebase, IsBrowserAuth: true,
	})
}

// vdMCP is a context as the MCP server leaves it for a verified MCP viewer.
func vdMCP(uid string) context.Context {
	return viewerctx.WithMCPUser(context.Background(), uid)
}

func vdPicksReq(id string, limit, offset int32) *connect.Request[shortsv1alpha1.GetStrategyPicksRequest] {
	return connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: id, Limit: limit, Offset: offset})
}

func vdCodes(picks []*shortsv1alpha1.StrategyPick) []string {
	out := make([]string, 0, len(picks))
	for _, p := range picks {
		out = append(out, p.StockCode)
	}
	return out
}

func vdBytes(t *testing.T, m proto.Message) []byte {
	t.Helper()
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	require.NoError(t, err)
	return b
}

// vdPublic calls the public rpc as the given context and returns the answer.
func vdPublic(t *testing.T, srv *ShortsServer, ctx context.Context, id string, limit, offset int32) *shortsv1alpha1.GetStrategyPicksResponse {
	t.Helper()
	resp, err := srv.GetStrategyPicks(ctx, vdPicksReq(id, limit, offset))
	require.NoError(t, err)
	return resp.Msg
}

// vdPublicRead is one public strategy read, called as a given context. Depth
// is true for a read whose rows the clamp limits; the others carry no rows and
// must answer the same bytes to every caller, the MCP viewer included.
type vdPublicRead struct {
	name  string
	depth bool
	call  func(t *testing.T, srv *ShortsServer, ctx context.Context) proto.Message
}

func vdPublicReads() []vdPublicRead {
	const id = engine.IDZangerBreakout
	return []vdPublicRead{
		{"GetStrategyPicks", true, func(t *testing.T, srv *ShortsServer, ctx context.Context) proto.Message {
			return vdPublic(t, srv, ctx, id, 0, 0)
		}},
		{"ListStrategies", false, func(t *testing.T, srv *ShortsServer, ctx context.Context) proto.Message {
			resp, err := srv.ListStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
			require.NoError(t, err)
			return resp.Msg
		}},
		{"GetStockStrategyFit", false, func(t *testing.T, srv *ShortsServer, ctx context.Context) proto.Message {
			resp, err := srv.GetStockStrategyFit(ctx, connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "RDY"}))
			require.NoError(t, err)
			return resp.Msg
		}},
	}
}

// vdHTTPCallers are the caller kinds that reach a public rpc over HTTP. None of
// them can set the in-process MCP viewer.
func vdHTTPCallers() []struct {
	name string
	ctx  func() context.Context
} {
	return []struct {
		name string
		ctx  func() context.Context
	}{
		{"anonymous", func() context.Context { return context.Background() }},
		{"free claims", func() context.Context { return vdClaims("free-user", "free", true) }},
		{"premium claims", func() context.Context { return vdClaims("premium-user", "premium", true) }},
		{"bearer identity with an unresolved tier", func() context.Context { return vdClaims("api-user", "premium", false) }},
		{"web session", func() context.Context { return vdWebSession("web-user") }},
		{"firebase premium", func() context.Context { return vdFirebase("fb-premium", "premium") }},
		{"firebase free", func() context.Context { return vdFirebase("fb-free", "free") }},
	}
}

// The public answer is the same bytes to every HTTP caller, whatever caller
// warmed the caches first. For each public read, each kind starts a cold
// server and is served first: its own answer must match the cold anonymous
// answer, and so must the anonymous HTTP call that follows. The MCP viewer
// is checked the same way on the reads that carry no rows, and its own answer
// on the picks read is the one place depth may differ.
func TestPublicStrategyRPCsAreCallerInvariant(t *testing.T) {
	for _, read := range vdPublicReads() {
		cold := read.call(t, vdServer(t, vdClampLimit), context.Background())
		want := vdBytes(t, cold)
		if read.depth {
			require.Len(t, cold.(*shortsv1alpha1.GetStrategyPicksResponse).Picks, vdClampLimit, "the anonymous answer is clamped to the public depth")
		}

		kinds := vdHTTPCallers()
		kinds = append(kinds, struct {
			name string
			ctx  func() context.Context
		}{"mcp viewer", func() context.Context { return vdMCP("mcp-user") }})
		for _, k := range kinds {
			t.Run(read.name+"/"+k.name, func(t *testing.T) {
				srv := vdServer(t, vdClampLimit)
				first := read.call(t, srv, k.ctx())
				isMCP := k.name == "mcp viewer"
				if !(isMCP && read.depth) {
					assert.Equal(t, want, vdBytes(t, first), "the caller's own answer")
				}
				if picks, ok := first.(*shortsv1alpha1.GetStrategyPicksResponse); ok && !isMCP {
					assert.LessOrEqual(t, len(picks.Picks), vdClampLimit)
					assert.Equal(t, "anonymous", picks.Viewer.Access)
				}

				got := read.call(t, srv, context.Background())
				assert.Equal(t, want, vdBytes(t, got), "anonymous HTTP answer after this caller kind")
			})
		}
	}
}

// A verified MCP viewer gets the full list from the same cache an HTTP caller
// reads, and no HTTP caller ever receives that depth.
func TestMCPDepthNeverReachesHTTP(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	const id = engine.IDZangerBreakout

	mcp := vdPublic(t, srv, vdMCP("mcp-user"), id, 100, 0)
	assert.Greater(t, len(mcp.Picks), vdClampLimit, "a verified MCP viewer has the full list")
	assert.Equal(t, "free", mcp.Viewer.Access)
	assert.False(t, mcp.Viewer.Clamped)

	anon := vdPublic(t, srv, context.Background(), id, 100, 0)
	assert.Len(t, anon.Picks, vdClampLimit, "the next HTTP caller is clamped")
	assert.True(t, anon.Viewer.Clamped)

	_, err := srv.GetStrategyPicks(context.Background(), vdPicksReq(id, 10, 1))
	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "an offset other than 0 is refused over HTTP")
}

// Under the clamp every public page comes from the top of the default
// ranking, for every status, sort, fundamentals filter, limit and offset.
func TestPublicPicksAreSubsetOfTopTen(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	const id = engine.IDZangerBreakout

	full := vdPublicFull(t, srv, id)
	require.Greater(t, len(full), vdClampLimit, "the fixture must exceed the public depth")
	topTen := make(map[string]bool, vdClampLimit)
	for _, code := range full[:vdClampLimit] {
		topTen[code] = true
	}

	sorts := append([]string{""}, engine.SortKeys()...)
	for _, status := range []string{"", string(engine.StatusTriggered), string(engine.StatusSetup), string(engine.StatusWatch)} {
		for _, sortBy := range sorts {
			for _, requireFund := range []bool{false, true} {
				for _, limit := range []int32{0, 1, 5, 10, 25, 100} {
					for _, offset := range []int32{0, 1, 10} {
						resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
							StrategyId:          id,
							Status:              status,
							SortBy:              sortBy,
							RequireFundamentals: requireFund,
							Limit:               limit,
							Offset:              offset,
						}))
						if offset != 0 {
							require.Error(t, err, "status=%q sort=%q limit=%d offset=%d", status, sortBy, limit, offset)
							assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
							continue
						}
						require.NoError(t, err)
						assert.LessOrEqual(t, len(resp.Msg.Picks), vdClampLimit)
						for _, code := range vdCodes(resp.Msg.Picks) {
							assert.True(t, topTen[code], "%s is outside the top %d (status=%q sort=%q)", code, vdClampLimit, status, sortBy)
						}
					}
				}
			}
		}
	}
}

// vdPublicFull is the default ranking's codes at full depth.
func vdPublicFull(t *testing.T, srv *ShortsServer, id string) []string {
	t.Helper()
	resp, err := srv.GetViewerStrategyPicks(vdClaims("full-user", "free", true), vdPicksReq(id, 100, 0))
	require.NoError(t, err)
	return vdCodes(resp.Msg.Picks)
}

// The private rpc refuses an anonymous caller and gives every signed-in caller
// the full list, unclamped, whatever the public flag is.
func TestGetViewerStrategyPicks_ThreeAccessTable(t *testing.T) {
	const id = engine.IDZangerBreakout
	tests := []struct {
		name       string
		ctx        context.Context
		wantErr    connect.Code
		wantAccess string
	}{
		{"no identity", context.Background(), connect.CodeUnauthenticated, ""},
		{"identity without a user id", vdClaims("", "premium", true), connect.CodeUnauthenticated, ""},
		{"free claims", vdClaims("free-user", "free", true), 0, "free"},
		{"premium claims", vdClaims("premium-user", "premium", true), 0, "premium"},
		{"premium tier not resolved by the store", vdClaims("api-user", "premium", false), 0, "free"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := vdServer(t, vdClampLimit)
			resp, err := srv.GetViewerStrategyPicks(tt.ctx, vdPicksReq(id, 100, 0))
			if tt.wantErr != 0 {
				require.Error(t, err)
				assert.Equal(t, tt.wantErr, connect.CodeOf(err))
				return
			}
			require.NoError(t, err)
			assert.Len(t, resp.Msg.Picks, len(vdPublicFull(t, srv, id)), "full depth, not clamped")
			assert.Equal(t, tt.wantAccess, resp.Msg.Viewer.Access)
			assert.False(t, resp.Msg.Viewer.Clamped)
			assert.Equal(t, int32(0), resp.Msg.Viewer.Limit)
		})
	}
}

// A signed-in caller's bearer token does not lift the public clamp: the public
// rpc answers the top ten to it, and refuses any offset other than 0, while the
// private rpc gives it the rest.
func TestBearerTokenOnThePublicRPCIsClamped(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	const id = engine.IDZangerBreakout
	token := vdClaims("paying-api-user", "premium", true)

	resp := vdPublic(t, srv, token, id, 100, 0)
	assert.Len(t, resp.Picks, vdClampLimit)
	assert.True(t, resp.Viewer.Clamped)
	assert.Equal(t, "anonymous", resp.Viewer.Access, "the public answer ignores the claims")

	_, err := srv.GetStrategyPicks(token, vdPicksReq(id, 10, vdClampLimit))
	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))

	full, err := srv.GetViewerStrategyPicks(token, vdPicksReq(id, 100, vdClampLimit))
	require.NoError(t, err)
	assert.Len(t, full.Msg.Picks, len(vdPublicFull(t, srv, id))-vdClampLimit, "the same token on the private rpc gets the rows beyond the public depth")
}

// The refusal for an offset under the clamp names the private rpc in
// X-Entitlement-Detail, and the detail parses as the documented JSON.
func TestOffsetRefusalCarriesTheEntitlementDetail(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	_, err := srv.GetStrategyPicks(context.Background(), vdPicksReq(engine.IDZangerBreakout, 10, 1))
	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))

	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	raw := connectErr.Meta().Get(entitlementDetailHeader)
	require.NotEmpty(t, raw)

	var detail map[string]any
	require.NoError(t, json.Unmarshal([]byte(raw), &detail))
	assert.Equal(t, "full_signal_list", detail["capability"])
	assert.Equal(t, "free", detail["required"])
	assert.Equal(t, "anonymous", detail["current"])
	assert.Equal(t, "GetViewerStrategyPicks", detail["rpc"])
	assert.Equal(t, float64(vdClampLimit), detail["limit"])
	assert.Equal(t, defaultUpgradeURL, detail["upgrade_url"])
	assert.NotEmpty(t, detail["message"])
}

// With the flag at 0 (the deploy default) the public answer is today's: every
// row, no clamp, and the viewer block says the depth is unlimited.
func TestClampIsOffByDefault(t *testing.T) {
	srv := vdServer(t, 0)
	const id = engine.IDZangerBreakout

	resp := vdPublic(t, srv, context.Background(), id, 100, 0)
	assert.Len(t, resp.Picks, len(vdPublicFull(t, srv, id)))
	assert.False(t, resp.Viewer.Clamped)
	assert.Equal(t, int32(0), resp.Viewer.Limit)
	assert.Equal(t, "anonymous", resp.Viewer.Access)
	assert.Equal(t, "free", resp.Viewer.RequiredAccess)

	_, err := srv.GetStrategyPicks(context.Background(), vdPicksReq(id, 10, 5))
	require.NoError(t, err, "no offset refusal without the clamp")
}

// viewer.clamped says a matching row was withheld, not merely that the list is
// longer than the depth: a filter the top of the list answers in full reads
// false, and a filter whose matching row ranks beyond the depth reads true.
func TestClampedFollowsTheFilter(t *testing.T) {
	const id = engine.IDZangerBreakout
	tests := []struct {
		name        string
		limit       int
		status      string
		wantCount   int32
		wantPicks   int
		wantClamped bool
	}{
		// Thirteen triggered rows, the first ten inside the depth.
		{"no filter, rows beyond the depth", vdClampLimit, "", 15, vdClampLimit, true},
		{"triggered, rows beyond the depth", vdClampLimit, string(engine.StatusTriggered), 13, vdClampLimit, true},
		// The setup row ranks fourteenth: outside the depth, so none is served
		// and the one that exists is withheld.
		{"setup, its only row beyond the depth", vdClampLimit, string(engine.StatusSetup), 1, 0, true},
		// A depth that holds every triggered row answers the filter in full.
		{"triggered, every matching row inside the depth", 13, string(engine.StatusTriggered), 13, 13, false},
		{"flag off", 0, "", 15, 15, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := vdServer(t, tt.limit)
			resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
				StrategyId: id, Status: tt.status, Limit: 100,
			}))
			require.NoError(t, err)
			assert.Equal(t, tt.wantCount, resp.Msg.TotalCount, "total_count is global")
			assert.Len(t, resp.Msg.Picks, tt.wantPicks)
			assert.Equal(t, tt.wantClamped, resp.Msg.Viewer.Clamped)
		})
	}
}

// The sort runs after the clamp, so no sort key reaches past the depth. RDY has
// the largest market cap but ranks outside the top ten, so a market cap sort
// serves the top ten by rank, never RDY.
func TestPublicSortCannotReachPastTheDepth(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	const id = engine.IDZangerBreakout

	viewer, err := srv.GetViewerStrategyPicks(vdClaims("full-user", "free", true), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
		StrategyId: id, SortBy: "market_cap", Limit: 100,
	}))
	require.NoError(t, err)
	require.Equal(t, "RDY", vdCodes(viewer.Msg.Picks)[0], "the fixture sorts RDY first by market cap at full depth")

	public, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
		StrategyId: id, SortBy: "market_cap", Limit: 100,
	}))
	require.NoError(t, err)
	assert.NotContains(t, vdCodes(public.Msg.Picks), "RDY")
	assert.Len(t, public.Msg.Picks, vdClampLimit)
	assert.True(t, public.Msg.Viewer.Clamped)
}

// The status counts and the totals are the whole list, whatever the depth, so
// they reveal no names beyond the public rows.
func TestClampLeavesCountsGlobal(t *testing.T) {
	const id = engine.IDZangerBreakout
	open := vdPublic(t, vdServer(t, 0), context.Background(), id, 100, 0)
	clamped := vdPublic(t, vdServer(t, vdClampLimit), context.Background(), id, 100, 0)

	assert.Equal(t, open.TotalCount, clamped.TotalCount)
	assert.Equal(t, open.StatusCounts.String(), clamped.StatusCounts.String())
	assert.Equal(t, open.UniverseCount, clamped.UniverseCount)
	assert.True(t, clamped.Viewer.Clamped)
}

// Every method on StrategyService is either public or private, and only the
// three public reads are public. GetViewerStrategyPicks is private, so a
// signed-in caller can read it and an anonymous caller cannot.
func TestStrategyMethodsVisibility(t *testing.T) {
	desc, err := protoregistry.GlobalFiles.FindDescriptorByName("shorts.v1alpha1.StrategyService")
	require.NoError(t, err)
	service := desc.(protoreflect.ServiceDescriptor)

	wantPublic := map[string]bool{
		"ListStrategies":      true,
		"GetStrategyPicks":    true,
		"GetStockStrategyFit": true,
	}
	methods := service.Methods()
	seen := map[string]bool{}
	for i := 0; i < methods.Len(); i++ {
		m := methods.Get(i)
		vis := proto.GetExtension(m.Options(), optionsv1.E_Visibility).(optionsv1.Visibility)
		name := string(m.Name())
		seen[name] = true
		if wantPublic[name] {
			assert.Equal(t, optionsv1.Visibility_VISIBILITY_PUBLIC, vis, "%s must be public", name)
			continue
		}
		assert.Equal(t, optionsv1.Visibility_VISIBILITY_PRIVATE, vis, "%s must be private", name)
	}
	assert.True(t, seen["GetViewerStrategyPicks"])
}

// The shared request validation refuses a bad request before any depth is read.
func TestParsePicksQueryRefusesBadRequestsForEveryCaller(t *testing.T) {
	srv := vdServer(t, vdClampLimit)
	_, err := srv.GetStrategyPicks(context.Background(), vdPicksReq("nope", 10, 0))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = srv.GetViewerStrategyPicks(vdClaims("u", "free", true), vdPicksReq("nope", 10, 0))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = srv.GetViewerStrategyPicks(context.Background(), vdPicksReq(engine.IDZangerBreakout, 10, 0))
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
}
