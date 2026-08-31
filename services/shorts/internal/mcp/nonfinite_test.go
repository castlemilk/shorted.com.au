package mcp

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Non-finite floats are the one class of value that turns a tool from
// "returns a wrong number" into "does not work at all", and every fixture in
// this package holds sensible numbers, so nothing caught it until a real
// database did.
//
// Two distinct failure modes, both real, both silent in review:
//
//   - Raw float64 projections (market, stock, discovery) marshal with
//     encoding/json, which REFUSES ±Inf and NaN: the whole tools/call fails
//     with `json: unsupported value: +Inf`. Measured on the local database on
//     2026-08-28, mv_screener_data.pe_ratio was Infinity for 23 of 964 rows,
//     two of them inside the DEFAULT top-25, so screen_stocks failed 100% of
//     the time on its default arguments.
//   - Values routed through round2 (housing, economy) convert to int64, which
//     is undefined for a non-finite float and in practice SATURATES:
//     round2(+Inf) returned 9.223372036854776e+16. No error at all — just a
//     median house price of ninety-two quadrillion dollars presented as a
//     measurement. That is the worse of the two.
//
// The website never showed either, because the Connect path marshals the same
// values as protobuf with protojson, which renders Infinity as a string and
// never fails. See finite() in tools_common.go.
//
// This test seeds EVERY float in EVERY canned response and drives EVERY
// registered tool, so a new tool or a new float field is covered without
// anyone remembering to add it here.

// absurdMagnitude is the round2 saturation value's order of magnitude. No real
// field comes close: the largest legitimate number this surface publishes is a
// market capitalisation (~2e11 for BHP) or shares on issue (~5e9), so anything
// past 1e15 is corruption rather than data.
const absurdMagnitude = 1e15

func TestToolOutputsSurviveNonFiniteFloats(t *testing.T) {
	for _, bad := range []struct {
		name  string
		value float64
	}{
		{"positive infinity", math.Inf(1)},
		{"negative infinity", math.Inf(-1)},
		{"NaN", math.NaN()},
	} {
		t.Run(bad.name, func(t *testing.T) {
			src := realisticSource()
			seeded := seedNonFiniteFloats(t, src, bad.value)
			if seeded == 0 {
				t.Fatal("seeded no float fields — the seeder is broken, so this test would pass vacuously")
			}
			t.Logf("seeded %d float fields with %v", seeded, bad.value)

			ctx := context.Background()
			session := connectToolSession(t, src)

			for _, call := range toolCallFixtures() {
				res, err := session.CallTool(ctx, &sdk.CallToolParams{Name: call.name, Arguments: call.args})
				if err != nil {
					// This is exactly the production failure: a non-finite
					// float reaching encoding/json takes the whole call down.
					t.Errorf("%s: tools/call failed on non-finite input: %v", call.name, err)
					continue
				}
				if res.IsError {
					t.Errorf("%s: returned a tool error on non-finite input: %v", call.name, res.Content)
					continue
				}
				if res.StructuredContent == nil {
					t.Errorf("%s: no structured content", call.name)
					continue
				}

				raw, err := json.Marshal(res.StructuredContent)
				if err != nil {
					t.Errorf("%s: structured content does not marshal: %v", call.name, err)
					continue
				}
				// The silent mode: no error, but a saturated int64 conversion
				// left a nonsense number in a field a model will quote.
				for _, n := range absurdNumbers(string(raw)) {
					t.Errorf("%s: emitted %g — a non-finite float was converted rather than replaced (round2 saturation)",
						call.name, n)
				}
			}
		})
	}
}

// The seeder and the fixture table are only trustworthy if they cover
// everything. This asserts the fixture table names every registered tool, so
// adding a tool without a fixture fails here rather than quietly going
// untested by both this file and the payload budget.
func TestToolCallFixturesCoverTheRegistry(t *testing.T) {
	fixtures := map[string]bool{}
	for _, call := range toolCallFixtures() {
		if fixtures[call.name] {
			t.Errorf("duplicate fixture for %q", call.name)
		}
		fixtures[call.name] = true
	}

	for _, tool := range Registry() {
		if !fixtures[tool.Name] {
			t.Errorf("tool %q has no call fixture — it is covered by neither the payload budget nor the non-finite guard", tool.Name)
		}
	}
	for name := range fixtures {
		if !registryHasTool(name) {
			t.Errorf("fixture %q names a tool that is not registered", name)
		}
	}
}

func registryHasTool(name string) bool {
	for _, tool := range Registry() {
		if tool.Name == name {
			return true
		}
	}
	return false
}

// seedNonFiniteFloats sets every float and double field of every canned
// response the fake holds to value, and reports how many it set.
//
// It reaches the responses through the DataSource INTERFACE rather than the
// fake's (unexported) struct fields: calling each method with a zero request
// hands back the very pointer the fake stores, so mutating the returned
// message mutates the canned response. That is what makes this generic — a new
// DataSource method is seeded with no change here, whereas a hand-listed set
// of fixture fields would silently skip it.
func seedNonFiniteFloats(t *testing.T, src *fakeDataSource, value float64) int {
	t.Helper()

	source := reflect.ValueOf(DataSource(src))
	ctx := reflect.ValueOf(context.Background())
	seeded := 0

	for i := 0; i < source.NumMethod(); i++ {
		method := source.Method(i)
		mt := method.Type()
		// Every DataSource method is func(context.Context, *connect.Request[T]).
		if mt.NumIn() != 2 || mt.NumOut() != 2 || mt.In(1).Kind() != reflect.Ptr {
			continue
		}

		out := method.Call([]reflect.Value{ctx, reflect.New(mt.In(1).Elem())})
		if !out[1].IsNil() || out[0].IsNil() {
			continue
		}
		msg := out[0].Elem().FieldByName("Msg")
		if !msg.IsValid() || msg.IsNil() {
			continue
		}
		message, ok := msg.Interface().(proto.Message)
		if !ok {
			continue
		}
		seeded += pokeFloats(message.ProtoReflect(), value)
	}
	return seeded
}

// pokeFloats recursively sets every float/double field reachable from m,
// including inside nested messages, repeated messages and repeated scalars.
func pokeFloats(m protoreflect.Message, value float64) int {
	if !m.IsValid() {
		return 0
	}
	set := 0
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		fd := fields.Get(i)

		switch {
		case fd.IsList():
			list := m.Mutable(fd).List()
			for j := 0; j < list.Len(); j++ {
				switch fd.Kind() {
				case protoreflect.DoubleKind:
					list.Set(j, protoreflect.ValueOfFloat64(value))
					set++
				case protoreflect.FloatKind:
					list.Set(j, protoreflect.ValueOfFloat32(float32(value)))
					set++
				case protoreflect.MessageKind, protoreflect.GroupKind:
					set += pokeFloats(list.Get(j).Message(), value)
				}
			}
		case fd.IsMap():
			// No map<_, double> exists on this surface; recurse into message
			// values so one appearing later is still covered.
			if fd.MapValue().Kind() == protoreflect.MessageKind {
				m.Mutable(fd).Map().Range(func(_ protoreflect.MapKey, v protoreflect.Value) bool {
					set += pokeFloats(v.Message(), value)
					return true
				})
			}
		case fd.Kind() == protoreflect.DoubleKind:
			m.Set(fd, protoreflect.ValueOfFloat64(value))
			set++
		case fd.Kind() == protoreflect.FloatKind:
			m.Set(fd, protoreflect.ValueOfFloat32(float32(value)))
			set++
		case fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind:
			if m.Has(fd) {
				set += pokeFloats(m.Get(fd).Message(), value)
			}
		}
	}
	return set
}

// numberPattern finds JSON numeric literals. Applied to the marshalled
// structured content, so strings containing digits can produce a false
// positive only if they exceed absurdMagnitude, which no prose field does.
var numberPattern = regexp.MustCompile(`-?\d+\.?\d*(?:[eE][-+]?\d+)?`)

func absurdNumbers(raw string) []float64 {
	var out []float64
	for _, match := range numberPattern.FindAllString(raw, -1) {
		v, err := strconv.ParseFloat(match, 64)
		if err != nil {
			continue
		}
		if math.Abs(v) > absurdMagnitude {
			out = append(out, v)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Shared call fixtures
// ---------------------------------------------------------------------------

// toolCall is one tool invocation with arguments good enough to reach the
// projection code — every tool's DEFAULT shape, so what gets measured is what
// a client actually gets.
type toolCall struct {
	name string
	args map[string]any
}

// toolCallFixtures is the single call table for the whole package: the payload
// budget and the non-finite guard both drive it, and
// TestToolCallFixturesCoverTheRegistry proves it names every registered tool.
// One list rather than two, because the tool missing from one of two
// hand-maintained lists is precisely the tool nobody measured.
func toolCallFixtures() []toolCall {
	return []toolCall{

		{"get_stock", map[string]any{"code": "BHP"}},
		{"list_top_shorts", map[string]any{}},
		{"get_industry_treemap", map[string]any{}},
		{"get_market_snapshot", map[string]any{"date": "2026-08-01"}},
		{"list_squeeze_candidates", map[string]any{}},
		{"get_stock_history", map[string]any{"code": "PLS", "period": "MAX"}},
		{"get_stock_prices", map[string]any{"code": "PLS", "period": "MAX"}},
		{"get_stock_details", map[string]any{"code": "BHP"}},
		{"get_director_trades", map[string]any{"code": "BHP"}},
		{"get_peer_comparison", map[string]any{"code": "PLS"}},
		{"search_stocks", map[string]any{"query": "minerals"}},
		{"screen_stocks", map[string]any{"min_short_pct": 5.0}},
		{"get_stock_news", map[string]any{"code": "PLS"}},
		{"list_reports", map[string]any{}},
		{"get_report", map[string]any{"slug": "2026-W23"}},
		{"get_housing_overview", map[string]any{}},
		{"get_house_price_series", map[string]any{"region_code": "AUS", "measure": "median_price"}},
		{"get_suburb_profile", map[string]any{"sal_code": "SAL21234"}},
		{"list_suburb_price_drops", map[string]any{}},
		{"list_economic_series", map[string]any{"limit": 500}},
		{"get_economic_series", map[string]any{
			"series_keys": []any{
				"trade.merchandise_exports_value.lng.wa.seasadj.0",
				"trade.merchandise_exports_value.lng.wa.seasadj.1",
				"trade.merchandise_exports_value.lng.wa.seasadj.2",
			},
		}},
		{"get_state_company_aggregates", map[string]any{}},
		{"search_politicians", map[string]any{"limit": 50}},
		{"get_politician", map[string]any{"slug": "anthony-smith"}},
		{"list_stock_politicians", map[string]any{"code": "BHP"}},
	}
}

// connectToolSession wires a client to a server over the SDK's in-memory
// transport and returns the client session, cleaned up with the test.
func connectToolSession(t *testing.T, src DataSource) *sdk.ClientSession {
	t.Helper()
	ctx := context.Background()

	server := NewServer(src)
	client := sdk.NewClient(&sdk.Implementation{Name: "tool-session", Version: "0.0.1"}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	return session
}
