package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// toolContractCase pins what one tool sends for one set of model arguments: the
// RPC it reaches, the generated request type, the proto field values, and the
// exact JSON keys on the wire.
type toolContractCase struct {
	name     string
	tool     string
	args     map[string]any
	service  string
	method   string
	request  proto.Message  // zero value of the expected request type
	want     map[string]any // proto field name -> value; []string for repeated fields
	wireKeys []string       // JSON keys of the body, exactly
}

// toolContractCases covers every tool in GetToolDefinitions. get_news has two
// routes, so it has one case for each.
var toolContractCases = []toolContractCase{
	{
		name:     "query_short_positions",
		tool:     "query_short_positions",
		args:     map[string]any{"stock_code": " bhp ", "period": "3m"},
		service:  legacyShortsService,
		method:   "GetStockData",
		request:  &shortsv1alpha1.GetStockDataRequest{},
		want:     map[string]any{"product_code": "BHP", "period": "3M", "max_points": 40},
		wireKeys: []string{"maxPoints", "period", "productCode"},
	},
	{
		name:     "query_short_positions without period omits it",
		tool:     "query_short_positions",
		args:     map[string]any{"stock_code": "CBA"},
		service:  legacyShortsService,
		method:   "GetStockData",
		request:  &shortsv1alpha1.GetStockDataRequest{},
		want:     map[string]any{"product_code": "CBA", "max_points": 40},
		wireKeys: []string{"maxPoints", "productCode"},
	},
	{
		// The period is not declared for this tool, so a period a model sends must not
		// reach the request: the sparkline window is fixed at 3 months.
		name:     "get_top_shorts asks for 3M sparklines and ignores period",
		tool:     "get_top_shorts",
		args:     map[string]any{"limit": 5.0, "period": "1m"},
		service:  legacyShortsService,
		method:   "GetTopShorts",
		request:  &shortsv1alpha1.GetTopShortsRequest{},
		want:     map[string]any{"summary_only": false, "period": "3M", "limit": 5},
		wireKeys: []string{"limit", "period"},
	},
	{
		name:     "get_top_shorts defaults to 10 stocks",
		tool:     "get_top_shorts",
		args:     map[string]any{},
		service:  legacyShortsService,
		method:   "GetTopShorts",
		request:  &shortsv1alpha1.GetTopShortsRequest{},
		want:     map[string]any{"summary_only": false, "period": "3M", "limit": 10},
		wireKeys: []string{"limit", "period"},
	},
	{
		name:     "get_stock_details",
		tool:     "get_stock_details",
		args:     map[string]any{"stock_code": "BHP"},
		service:  legacyShortsService,
		method:   "GetStockDetails",
		request:  &shortsv1alpha1.GetStockDetailsRequest{},
		want:     map[string]any{"product_code": "BHP"},
		wireKeys: []string{"productCode"},
	},
	{
		name:     "search_stocks coerces a string limit",
		tool:     "search_stocks",
		args:     map[string]any{"query": " commonwealth bank ", "limit": "3"},
		service:  legacyShortsService,
		method:   "SearchStocks",
		request:  &shortsv1alpha1.SearchStocksRequest{},
		want:     map[string]any{"query": "commonwealth bank", "limit": 3},
		wireKeys: []string{"limit", "query"},
	},
	{
		name:     "get_news with a stock code is stock news",
		tool:     "get_news",
		args:     map[string]any{"stock_code": "BHP", "limit": 3.0},
		service:  legacyShortsService,
		method:   "GetStockNews",
		request:  &shortsv1alpha1.GetStockNewsRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 3},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_news without a stock code is market news",
		tool:     "get_news",
		args:     map[string]any{"limit": 3.0},
		service:  legacyShortsService,
		method:   "GetMarketNews",
		request:  &shortsv1alpha1.GetMarketNewsRequest{},
		want:     map[string]any{"limit": 3},
		wireKeys: []string{"limit"},
	},
	{
		name:     "get_news with a blank stock code is market news",
		tool:     "get_news",
		args:     map[string]any{"stock_code": "   "},
		service:  legacyShortsService,
		method:   "GetMarketNews",
		request:  &shortsv1alpha1.GetMarketNewsRequest{},
		want:     map[string]any{"limit": 5},
		wireKeys: []string{"limit"},
	},
	{
		// The server caps news at 100 and the builder at 50; an over-cap request is
		// clamped here, not sent to the API as is.
		name:     "get_news caps limit at 50 on the stock route",
		tool:     "get_news",
		args:     map[string]any{"stock_code": "BHP", "limit": 500.0},
		service:  legacyShortsService,
		method:   "GetStockNews",
		request:  &shortsv1alpha1.GetStockNewsRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 50},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_news caps limit at 50 on the market route",
		tool:     "get_news",
		args:     map[string]any{"limit": 500.0},
		service:  legacyShortsService,
		method:   "GetMarketNews",
		request:  &shortsv1alpha1.GetMarketNewsRequest{},
		want:     map[string]any{"limit": 50},
		wireKeys: []string{"limit"},
	},
	{
		name:     "get_director_trades",
		tool:     "get_director_trades",
		args:     map[string]any{"stock_code": "CBA", "limit": 5},
		service:  legacyShortsService,
		method:   "GetDirectorTrades",
		request:  &shortsv1alpha1.GetDirectorTradesRequest{},
		want:     map[string]any{"stock_code": "CBA", "limit": 5},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_peer_comparison",
		tool:     "get_peer_comparison",
		args:     map[string]any{"stock_code": "BHP"},
		service:  legacyShortsService,
		method:   "GetPeerComparison",
		request:  &shortsv1alpha1.GetPeerComparisonRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 5},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		// The server rejects a limit above 20 with invalid_argument, so the builder
		// must clamp it.
		name:     "get_peer_comparison caps limit at 20",
		tool:     "get_peer_comparison",
		args:     map[string]any{"stock_code": "BHP", "limit": 25.0},
		service:  legacyShortsService,
		method:   "GetPeerComparison",
		request:  &shortsv1alpha1.GetPeerComparisonRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 20},
		wireKeys: []string{"limit", "stockCode"},
	},
	// get_weekly_report without a week makes two calls (the latest slug is looked up
	// first), so it is covered by TestWeeklyReportWithoutWeekSendsLatestSlug.
	{
		name:     "get_weekly_report normalises the week slug",
		tool:     "get_weekly_report",
		args:     map[string]any{"week": "2026-w08"},
		service:  legacyShortsService,
		method:   "GetWeeklyReport",
		request:  &shortsv1alpha1.GetWeeklyReportRequest{},
		want:     map[string]any{"week_slug": "2026-W08"},
		wireKeys: []string{"weekSlug"},
	},
	{
		name:     "get_related_news",
		tool:     "get_related_news",
		args:     map[string]any{"stock_code": "BHP", "article_id": "a1", "limit": 3},
		service:  legacyShortsService,
		method:   "GetRelatedNews",
		request:  &shortsv1alpha1.GetRelatedNewsRequest{},
		want:     map[string]any{"stock_code": "BHP", "article_id": "a1", "limit": 3},
		wireKeys: []string{"articleId", "limit", "stockCode"},
	},
	{
		// Without an article the call anchors on the stock's latest article, so no
		// article_id reaches the wire.
		name:     "get_related_news without article_id anchors on the stock",
		tool:     "get_related_news",
		args:     map[string]any{"stock_code": "BHP"},
		service:  legacyShortsService,
		method:   "GetRelatedNews",
		request:  &shortsv1alpha1.GetRelatedNewsRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 5},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_stock_graph",
		tool:     "get_stock_graph",
		args:     map[string]any{"stock_code": "BHP", "limit": 5},
		service:  legacyShortsService,
		method:   "GetStockGraph",
		request:  &shortsv1alpha1.GetStockGraphRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 5},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_event_timeline",
		tool:     "get_event_timeline",
		args:     map[string]any{"stock_code": "BHP", "days_back": 30, "limit": 10},
		service:  legacyShortsService,
		method:   "GetEventTimeline",
		request:  &shortsv1alpha1.GetEventTimelineRequest{},
		want:     map[string]any{"stock_code": "BHP", "days_back": 30, "limit": 10},
		wireKeys: []string{"daysBack", "limit", "stockCode"},
	},
	{
		name:     "get_event_timeline defaults",
		tool:     "get_event_timeline",
		args:     map[string]any{"stock_code": "BHP"},
		service:  legacyShortsService,
		method:   "GetEventTimeline",
		request:  &shortsv1alpha1.GetEventTimelineRequest{},
		want:     map[string]any{"stock_code": "BHP", "days_back": 90, "limit": 20},
		wireKeys: []string{"daysBack", "limit", "stockCode"},
	},
	{
		name:     "get_stock_signals",
		tool:     "get_stock_signals",
		args:     map[string]any{"stock_code": "BHP", "limit": 5},
		service:  legacyShortsService,
		method:   "GetStockSignals",
		request:  &shortsv1alpha1.GetStockSignalsRequest{},
		want:     map[string]any{"stock_code": "BHP", "limit": 5},
		wireKeys: []string{"limit", "stockCode"},
	},
	{
		name:     "get_economic_series",
		tool:     "get_economic_series",
		args:     map[string]any{"series_keys": []any{"rates.cash_rate_target.aus"}, "limit": 3.0},
		service:  economyService,
		method:   "GetEconomicSeries",
		request:  &shortsv1alpha1.GetEconomicSeriesRequest{},
		want:     map[string]any{"series_keys": []string{"rates.cash_rate_target.aus"}, "max_observations": 3},
		wireKeys: []string{"maxObservations", "seriesKeys"},
	},
}

// TestToolContractRequestsMatchGeneratedRPCs checks each case against the generated
// descriptors: (a) the built request round-trips through protojson with unknown
// fields rejected, (b) the identifying and normalised field values are set, and
// (c) the service exists, has the method, and the method takes the request type.
func TestToolContractRequestsMatchGeneratedRPCs(t *testing.T) {
	for _, tc := range toolContractCases {
		t.Run(tc.name, func(t *testing.T) {
			call, err := buildToolCall(tc.tool, tc.args)
			if err != nil {
				t.Fatalf("buildToolCall(%s) error = %v", tc.tool, err)
			}
			if call.service != tc.service || call.method != tc.method {
				t.Fatalf("route = %s/%s, want %s/%s", call.service, call.method, tc.service, tc.method)
			}

			// (c) the rpc exists on the generated service and takes this request type.
			assertRPCTakes(t, call.service, call.method, tc.request.ProtoReflect().Descriptor())
			if got, want := call.request.ProtoReflect().Descriptor().FullName(), tc.request.ProtoReflect().Descriptor().FullName(); got != want {
				t.Fatalf("request type = %s, want %s", got, want)
			}

			// (a) strict round trip: an unknown field fails here.
			body, err := protojson.Marshal(call.request)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			decoded := tc.request.ProtoReflect().New().Interface()
			if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(body, decoded); err != nil {
				t.Fatalf("body %s does not unmarshal strictly into %T: %v", body, tc.request, err)
			}

			// (b) the identifying and normalised values survive the round trip.
			checkFieldValues(t, decoded, tc.want)
			checkWireKeys(t, body, tc.wireKeys)
		})
	}
}

// TestToolExecutorSendsEachToolToItsRPC runs Execute for every case against a fake
// API and checks what arrives: the procedure path, the User-Agent the API
// accepts, a strict decode of the body, and its keys and values.
func TestToolExecutorSendsEachToolToItsRPC(t *testing.T) {
	for _, tc := range toolContractCases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodPost {
					t.Errorf("method = %s, want POST", r.Method)
				}
				if got, want := r.URL.Path, "/shorts.v1alpha1."+tc.service+"/"+tc.method; got != want {
					t.Errorf("path = %q, want %q", got, want)
				}
				if got := r.Header.Get("User-Agent"); got != toolUserAgent {
					t.Errorf("User-Agent = %q, want %q", got, toolUserAgent)
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatalf("read body: %v", err)
				}
				decoded := tc.request.ProtoReflect().New().Interface()
				if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(body, decoded); err != nil {
					t.Errorf("body %s does not unmarshal strictly into %T: %v", body, tc.request, err)
				}
				checkWireKeys(t, body, tc.wireKeys)
				checkFieldValues(t, decoded, tc.want)
				_, _ = w.Write([]byte(`{}`))
			}))

			if _, err := executor.Execute(context.Background(), tc.tool, tc.args); err != nil {
				t.Fatalf("Execute(%s) error = %v", tc.tool, err)
			}
			if calls != 1 {
				t.Fatalf("API calls = %d, want 1", calls)
			}
		})
	}
}

// TestToolContractCoversEveryRegisteredTool fails when tools.go registers a tool
// that Execute cannot route, or a contract case names a tool that is not
// registered.
func TestToolContractCoversEveryRegisteredTool(t *testing.T) {
	covered := make(map[string]bool)
	for _, tc := range toolContractCases {
		covered[tc.tool] = true
	}

	registered := make(map[string]bool)
	for _, def := range GetToolDefinitions() {
		registered[def.Name] = true
		if !covered[def.Name] {
			t.Errorf("tool %q is registered in tools.go but has no contract case", def.Name)
		}
		if _, err := buildToolCall(def.Name, nil); err != nil && strings.Contains(err.Error(), "unknown tool") {
			t.Errorf("tool %q is registered in tools.go but Execute does not handle it: %v", def.Name, err)
		}
	}
	for tool := range covered {
		if !registered[tool] {
			t.Errorf("contract case for %q, which tools.go does not register", tool)
		}
	}

	if _, err := buildToolCall("no_such_tool", nil); err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Errorf("unregistered tool error = %v, want unknown tool", err)
	}
}

// sampleParameterValues returns two different values for one declared parameter. A
// builder that ignores the parameter produces the same request for both.
func sampleParameterValues(name string, p ToolParameter) (any, any) {
	switch {
	case p.Type == "array":
		return []any{"rates.cash_rate_target.aus"}, []any{"cpi.annual_change.all_groups.aus"}
	case p.Type == "integer":
		return 3.0, 7.0
	case len(p.Enum) > 0:
		return p.Enum[0], p.Enum[len(p.Enum)-1]
	}
	switch name {
	case "stock_code":
		return "BHP", "CBA"
	case "week":
		return "2026-W08", "2026-W09"
	case "article_id":
		return "a1", "a2"
	default:
		return "commonwealth bank", "westpac"
	}
}

// withArg returns a copy of args with one more argument set.
func withArg(args map[string]any, name string, value any) map[string]any {
	out := make(map[string]any, len(args)+1)
	maps.Copy(out, args)
	out[name] = value
	return out
}

// TestEveryDeclaredParameterChangesTheRequest fails when a parameter declared in
// tools.go does not reach the request. Each parameter is set to two values with the
// other required arguments fixed, and the built request must differ. This catches a
// builder that reads the wrong key, drops the value, or ignores the parameter.
func TestEveryDeclaredParameterChangesTheRequest(t *testing.T) {
	for _, def := range GetToolDefinitions() {
		base := make(map[string]any, len(def.Required))
		for _, name := range def.Required {
			first, _ := sampleParameterValues(name, def.Parameters[name])
			base[name] = first
		}
		for name, param := range def.Parameters {
			t.Run(def.Name+" "+name, func(t *testing.T) {
				first, second := sampleParameterValues(name, param)
				a, errA := buildToolCall(def.Name, withArg(base, name, first))
				b, errB := buildToolCall(def.Name, withArg(base, name, second))
				if errA != nil || errB != nil {
					t.Fatalf("build errors: %v, %v", errA, errB)
				}
				if a.service == b.service && a.method == b.method && proto.Equal(a.request, b.request) {
					t.Errorf("parameter %q does not change the request: both calls send %s/%s %v", name, a.service, a.method, a.request)
				}
			})
		}
	}
}

// TestBuilderReadsOnlyDeclaredArguments fails when a builder reads an undeclared argument
// that a contract case sends. The model can send only declared parameters, so a read of
// any other name is dead code: the request never changes for the model. Each contract
// case's undeclared arguments are removed in turn, and the request must stay the same.
// A read of an undeclared name that no case sends is not caught here.
func TestBuilderReadsOnlyDeclaredArguments(t *testing.T) {
	declared := make(map[string]map[string]bool)
	for _, def := range GetToolDefinitions() {
		names := make(map[string]bool, len(def.Parameters))
		for name := range def.Parameters {
			names[name] = true
		}
		declared[def.Name] = names
	}

	for _, tc := range toolContractCases {
		for key := range tc.args {
			if declared[tc.tool][key] {
				continue
			}
			t.Run(tc.name+" "+key, func(t *testing.T) {
				with, err := buildToolCall(tc.tool, tc.args)
				if err != nil {
					t.Fatalf("buildToolCall(%s) error = %v", tc.tool, err)
				}
				without := make(map[string]any, len(tc.args))
				for k, v := range tc.args {
					if k != key {
						without[k] = v
					}
				}
				bare, err := buildToolCall(tc.tool, without)
				if err != nil {
					t.Fatalf("buildToolCall(%s) without %s error = %v", tc.tool, key, err)
				}
				if !proto.Equal(with.request, bare.request) {
					t.Errorf("%s reads %q, which tools.go does not declare, so the model cannot send it", tc.tool, key)
				}
			})
		}
	}
}

// TestEconomicSeriesResponseJSONNamesMatchProto pins the JSON names that
// summarizeEconomicSeries decodes against the generated response descriptors.
func TestEconomicSeriesResponseJSONNamesMatchProto(t *testing.T) {
	response := (&shortsv1alpha1.GetEconomicSeriesResponse{}).ProtoReflect().Descriptor()
	series := jsonFieldMessage(t, response, "series")
	assertJSONNames(t, series, "info", "observations")
	assertJSONNames(t, jsonFieldMessage(t, series, "info"), "seriesKey", "regionName", "unit", "frequency")
	assertJSONNames(t, jsonFieldMessage(t, series, "observations"), "period", "value")
}

// assertRPCTakes fails unless service (in shorts.v1alpha1) has method and the method
// takes the input message type.
func assertRPCTakes(t *testing.T, service, method string, input protoreflect.MessageDescriptor) {
	t.Helper()
	fullName := protoreflect.FullName("shorts.v1alpha1." + service)
	desc, err := protoregistry.GlobalFiles.FindDescriptorByName(fullName)
	if err != nil {
		t.Fatalf("service %s is not in the generated descriptors: %v", fullName, err)
	}
	serviceDesc, ok := desc.(protoreflect.ServiceDescriptor)
	if !ok {
		t.Fatalf("%s is a %T, not a service", fullName, desc)
	}
	rpc := serviceDesc.Methods().ByName(protoreflect.Name(method))
	if rpc == nil {
		t.Fatalf("%s has no rpc %s", fullName, method)
	}
	if got, want := rpc.Input().FullName(), input.FullName(); got != want {
		t.Fatalf("%s.%s takes %s, the call sends %s", fullName, method, got, want)
	}
}

// checkFieldValues fails unless each named field holds the wanted value. Scalars
// compare by their printed form, so int32(5) matches 5. A repeated field compares
// element by element with a []string.
func checkFieldValues(t *testing.T, msg proto.Message, want map[string]any) {
	t.Helper()
	m := msg.ProtoReflect()
	for name, expected := range want {
		fd := m.Descriptor().Fields().ByName(protoreflect.Name(name))
		if fd == nil {
			t.Errorf("%s has no field %q", m.Descriptor().FullName(), name)
			continue
		}
		value := m.Get(fd)
		if fd.IsList() {
			var got []string
			for i := 0; i < value.List().Len(); i++ {
				got = append(got, fmt.Sprint(value.List().Get(i).Interface()))
			}
			if !reflect.DeepEqual(got, expected) {
				t.Errorf("field %s = %v, want %v", name, got, expected)
			}
			continue
		}
		if got := fmt.Sprint(value.Interface()); got != fmt.Sprint(expected) {
			t.Errorf("field %s = %q, want %v", name, got, expected)
		}
	}
}

// checkWireKeys fails unless the body's top-level JSON keys are exactly want.
func checkWireKeys(t *testing.T, body []byte, want []string) {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Errorf("body %s is not a JSON object: %v", body, err)
		return
	}
	got := make([]string, 0, len(raw))
	for key := range raw {
		got = append(got, key)
	}
	sort.Strings(got)
	wantSorted := append([]string(nil), want...)
	sort.Strings(wantSorted)
	if len(got) == 0 && len(wantSorted) == 0 {
		return
	}
	if !reflect.DeepEqual(got, wantSorted) {
		t.Errorf("wire keys = %v, want %v (body %s)", got, wantSorted, body)
	}
}

func jsonFieldMessage(t *testing.T, parent protoreflect.MessageDescriptor, jsonName string) protoreflect.MessageDescriptor {
	t.Helper()
	fields := parent.Fields()
	for i := 0; i < fields.Len(); i++ {
		if fd := fields.Get(i); fd.JSONName() == jsonName {
			if fd.Message() == nil {
				t.Fatalf("%s.%s is not a message", parent.FullName(), jsonName)
			}
			return fd.Message()
		}
	}
	t.Fatalf("%s has no JSON field %q", parent.FullName(), jsonName)
	return nil
}

func assertJSONNames(t *testing.T, msg protoreflect.MessageDescriptor, names ...string) {
	t.Helper()
	for _, name := range names {
		found := false
		fields := msg.Fields()
		for i := 0; i < fields.Len(); i++ {
			if fields.Get(i).JSONName() == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s has no JSON field %q", msg.FullName(), name)
		}
	}
}
