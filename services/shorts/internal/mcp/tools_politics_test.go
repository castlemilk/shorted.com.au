package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// A Politician fixture with EVERY portrait field populated, so the no-portrait
// assertions have something to catch rather than passing because the fixture
// happened to be empty.
func fixturePolitician(slug, name string) *shortsv1alpha1.Politician {
	return &shortsv1alpha1.Politician{
		Slug: slug, DisplayName: name, Surname: "Smith", GivenNames: "Anthony",
		Chamber: "house", Division: "Casey", StateCode: "VIC",
		Party: "Liberal Party of Australia", PartyAb: "LP",
		FirstParliament: 44, LastParliament: 48, AphMpid: "ABC123",
		DeclaredListedCount: 9, DeclaredPropertyCount: 2,
		PhotoUrl:       "https://upload.wikimedia.org/wikipedia/commons/a/ab/Anthony_Smith.jpg",
		PhotoLicence:   "CC BY-SA 4.0",
		PhotoAuthor:    "A Commons Photographer",
		PhotoSourceUrl: "https://commons.wikimedia.org/wiki/File:Anthony_Smith.jpg",
	}
}

// The register's own words, exactly as APH published them: mixed case, an
// ampersand, a double space, a trailing note in parentheses. CC BY-NC-ND means
// none of that may be tidied up on the way out.
const verbatimDeclaration = "BHP Group Limited  & Rio Tinto Limited (held jointly with spouse)"

func fixtureInterest() *shortsv1alpha1.DeclaredInterest {
	return &shortsv1alpha1.DeclaredInterest{
		ItemNo: 1, ItemLabel: "Shareholdings",
		Holder:       shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER,
		DeclaredText: verbatimDeclaration, SecondaryText: "  Acquired prior to election. ",
		StockCode: "BHP", CompanyName: "BHP GROUP LIMITED", Industry: "Metals & Mining",
		EntityKind: "listed", MatchMethod: "curated_alias",
		DeclaredFrom:      timestamppb.New(time.Date(2022, 6, 1, 0, 0, 0, 0, time.UTC)),
		DeclaredFromKnown: true, CurrentlyDeclared: true,
		SourceUrl:     "https://www.aph.gov.au/-/media/03_Senators_and_Members/register.pdf",
		SourceLicence: "Parliamentary material; (c) Commonwealth of Australia",
	}
}

// ---------------------------------------------------------------------------
// Rule 1 — what is held, never how much
// ---------------------------------------------------------------------------

// amountMarkers are substrings that must never appear in a politician tool's
// output field names.
//
// The register subsystem has NO amount, quantity or value column anywhere: the
// registers do not record one, the proto carries none, and a migration test
// asserts none appears (docs/feature/politicians/README.md rule 1). A tool that
// invented one — or derived one, e.g. by multiplying a declaration by a share
// price — would be publishing a fabricated financial fact about a named
// individual. The banned list is structural rather than a review convention so
// that the field cannot be added without someone deleting this test.
var amountMarkers = []string{
	"amount", "value", "quantity", "price", "worth", "cost", "size",
	"shares", "holding", "portfolio", "exposure", "cents", "dollar", "aud",
	"market_cap", "gain", "loss", "income", "salary", "donation", "funding",
}

// The *_count fields are deliberately not caught by any marker: a count of
// THINGS (how many companies a member declares, how many members declare a
// company) is the strongest characterisation the register supports, and is
// explicitly permitted by the editorial standard.
func TestPoliticianToolsPublishNoAmountOrValue(t *testing.T) {
	types := map[string]reflect.Type{
		"SearchPoliticiansOutput":    reflect.TypeOf(SearchPoliticiansOutput{}),
		"GetPoliticianOutput":        reflect.TypeOf(GetPoliticianOutput{}),
		"ListStockPoliticiansOutput": reflect.TypeOf(ListStockPoliticiansOutput{}),
	}
	for name, typ := range types {
		fields := jsonFieldNames(typ, map[reflect.Type]bool{})
		if len(fields) == 0 {
			t.Fatalf("%s has no fields — this test would pass vacuously", name)
		}
		for _, field := range fields {
			for _, marker := range amountMarkers {
				if strings.Contains(field, marker) {
					t.Errorf("%s emits %q, which matches the banned marker %q. The registers record "+
						"WHAT is declared and never how much; there is no such column in the subsystem, "+
						"so any such field here would be invented.", name, field, marker)
				}
			}
		}
	}
}

// The schema check above bounds the field NAMES. This bounds the payload: a
// value smuggled into a note, a summary or a text fallback is the same
// fabrication with better manners.
func TestPoliticianToolResultsMentionNoQuantityOrValue(t *testing.T) {
	src := politicianSource()
	ctx := context.Background()

	results := []any{}
	for _, call := range []func() (any, error){
		func() (any, error) {
			res, out, err := searchPoliticiansHandler(src)(ctx, nil, SearchPoliticiansInput{})
			return []any{res, out}, err
		},
		func() (any, error) {
			res, out, err := getPoliticianHandler(src)(ctx, nil, GetPoliticianInput{Slug: "anthony-smith"})
			return []any{res, out}, err
		},
		func() (any, error) {
			res, out, err := listStockPoliticiansHandler(src)(ctx, nil, ListStockPoliticiansInput{Code: "BHP"})
			return []any{res, out}, err
		},
	} {
		got, err := call()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		results = append(results, got)
	}

	encoded, err := json.Marshal(results)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range collectJSONKeys(decoded) {
		for _, marker := range amountMarkers {
			if strings.Contains(strings.ToLower(key), marker) {
				t.Errorf("a politician tool result carries the key %q, matching banned marker %q", key, marker)
			}
		}
	}
}

func collectJSONKeys(v any) []string {
	var out []string
	switch t := v.(type) {
	case map[string]any:
		for k, sub := range t {
			out = append(out, k)
			out = append(out, collectJSONKeys(sub)...)
		}
	case []any:
		for _, sub := range t {
			out = append(out, collectJSONKeys(sub)...)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Rule 2 — APH is CC BY-NC-ND, so its prose is emitted verbatim
// ---------------------------------------------------------------------------

// ND forbids a derivative work. A summary, a normalisation, a re-casing or a
// truncation of a member's declared text is a derivative — and separately, it
// misquotes a named individual. This asserts the bytes survive intact on both
// tools that carry declared text, including the whitespace we would otherwise
// be tempted to tidy.
func TestDeclaredTextIsEmittedVerbatim(t *testing.T) {
	src := politicianSource()
	ctx := context.Background()

	_, profile, err := getPoliticianHandler(src)(ctx, nil, GetPoliticianInput{Slug: "anthony-smith"})
	if err != nil {
		t.Fatalf("get_politician: %v", err)
	}
	if got := profile.Interests[0].DeclaredText; got != verbatimDeclaration {
		t.Errorf("get_politician altered declared text.\n got: %q\nwant: %q", got, verbatimDeclaration)
	}
	if got := profile.Interests[0].SecondaryText; got != "  Acquired prior to election. " {
		t.Errorf("get_politician altered secondary text: %q", got)
	}

	_, stock, err := listStockPoliticiansHandler(src)(ctx, nil, ListStockPoliticiansInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("list_stock_politicians: %v", err)
	}
	if got := stock.Declarations[0].DeclaredText; got != verbatimDeclaration {
		t.Errorf("list_stock_politicians altered declared text.\n got: %q\nwant: %q", got, verbatimDeclaration)
	}
}

// The caps in this file bound the NUMBER of declarations, never the length of
// one — dropping whole rows and saying so is honest, shortening a quotation is
// not. This drives a member well past the cap and asserts both halves.
func TestRegisterCapsDropWholeRowsAndNeverTruncateText(t *testing.T) {
	long := strings.Repeat("Australian Foundation Investment Company Limited, ordinary shares. ", 60)
	interests := make([]*shortsv1alpha1.DeclaredInterest, 0, maxRegisterInterests+7)
	for i := 0; i < maxRegisterInterests+7; i++ {
		in := fixtureInterest()
		in.DeclaredText = long
		interests = append(interests, in)
	}
	src := &fakeDataSource{politician: &shortsv1alpha1.GetPoliticianResponse{
		Politician: fixturePolitician("anthony-smith", "Anthony Smith"),
		Interests:  interests,
	}}

	_, out, err := getPoliticianHandler(src)(context.Background(), nil,
		GetPoliticianInput{Slug: "anthony-smith"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != maxRegisterInterests {
		t.Errorf("returned %d declarations, want the %d cap", out.Count, maxRegisterInterests)
	}
	if out.InterestsOmitted != 7 {
		t.Errorf("omitted = %d, want 7 reported rather than silently dropped", out.InterestsOmitted)
	}
	for _, d := range out.Interests {
		if d.DeclaredText != long {
			t.Fatal("a declaration's text was shortened — CC BY-NC-ND forbids a derivative of APH prose")
		}
		if strings.Contains(d.DeclaredText, truncationMarker) {
			t.Fatal("a declaration carries the truncation marker")
		}
	}
}

// ---------------------------------------------------------------------------
// Rule 3 — no portraits, and therefore no attribution obligation to breach
// ---------------------------------------------------------------------------

// Portrait attribution is a licence CONDITION enforced in four places (DB
// CHECK, store, proto, component): photo_url may not be rendered without
// photo_licence, photo_author and photo_source_url. An MCP client can render
// any subset of a structured result, so the credit cannot be guaranteed to
// travel with the image — the obligation is avoided rather than managed, and
// this surface emits no portrait at all.
//
// The fixture populates every portrait field, so this fails if a projection
// ever starts reading them.
func TestPoliticianToolsEmitNoPortrait(t *testing.T) {
	portraitMarkers := []string{"photo", "portrait", "image", "avatar", "picture", "thumbnail"}
	types := map[string]reflect.Type{
		"SearchPoliticiansOutput":    reflect.TypeOf(SearchPoliticiansOutput{}),
		"GetPoliticianOutput":        reflect.TypeOf(GetPoliticianOutput{}),
		"ListStockPoliticiansOutput": reflect.TypeOf(ListStockPoliticiansOutput{}),
	}
	for name, typ := range types {
		for _, field := range jsonFieldNames(typ, map[reflect.Type]bool{}) {
			for _, marker := range portraitMarkers {
				if strings.Contains(field, marker) {
					t.Errorf("%s emits %q. A portrait carries a mandatory attribution that an MCP client "+
						"cannot be relied on to render, so this surface publishes none — if that changes, "+
						"the licence, author and source URL must travel with the URL in the same object.",
						name, field)
				}
			}
		}
	}

	src := politicianSource()
	ctx := context.Background()
	res, out, err := getPoliticianHandler(src)(ctx, nil, GetPoliticianInput{Slug: "anthony-smith"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	payload := textOf(t, res) + mustJSON(t, out)
	for _, forbidden := range []string{
		"upload.wikimedia.org", "commons.wikimedia.org", "CC BY-SA 4.0", "A Commons Photographer",
	} {
		if strings.Contains(payload, forbidden) {
			t.Errorf("get_politician leaked portrait data %q", forbidden)
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Rule 4 — withhold rather than guess
// ---------------------------------------------------------------------------

// A name search once matched "Anthony Smith" to Dean Smith. So a search that
// matches more than one member must return them all and SAY that more than one
// matched, rather than resolving to whichever sorted first.
func TestSearchPoliticiansMakesAmbiguityVisibleRatherThanPicking(t *testing.T) {
	src := &fakeDataSource{listPoliticians: &shortsv1alpha1.ListPoliticiansResponse{
		Politicians: []*shortsv1alpha1.Politician{
			fixturePolitician("anthony-smith", "Anthony Smith"),
			fixturePolitician("dean-smith", "Dean Smith"),
		},
		Total: 2,
	}}

	res, out, err := searchPoliticiansHandler(src)(context.Background(), nil,
		SearchPoliticiansInput{Query: "Smith"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 2 {
		t.Fatalf("count = %d, want both matches returned", out.Count)
	}
	if !strings.Contains(out.Note, "Smith") || !strings.Contains(out.Note, "none has been chosen") {
		t.Errorf("the note does not surface the ambiguity: %q", out.Note)
	}
	if !strings.Contains(textOf(t, res), "More than one") {
		t.Errorf("the text does not surface the ambiguity: %q", textOf(t, res))
	}
}

// get_politician takes a slug and not a name, precisely because a name is
// ambiguous and choosing between two members is the failure this subsystem is
// built to avoid.
func TestGetPoliticianRefusesAnEmptySlugAndPointsAtSearch(t *testing.T) {
	src := &fakeDataSource{}
	_, _, err := getPoliticianHandler(src)(context.Background(), nil, GetPoliticianInput{Slug: "  "})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "search_politicians") {
		t.Errorf("error does not name the discovery tool: %v", err)
	}
	if src.gotPolitician != nil {
		t.Error("the RPC was called despite invalid input")
	}
}

// An empty interest list must never read as "this member declared nothing":
// parliaments 44 and 45 and the Senate volumes are largely unread, so absence
// of a row is absence of evidence. The coverage lists have to be in the answer.
func TestGetPoliticianNeverPresentsAnEmptyListAsDeclaringNothing(t *testing.T) {
	src := &fakeDataSource{politician: &shortsv1alpha1.GetPoliticianResponse{
		Politician:           fixturePolitician("anthony-smith", "Anthony Smith"),
		ExtractedParliaments: []int32{47, 48},
		PartialParliaments:   []int32{46},
		PendingParliaments:   []int32{44, 45},
	}}

	res, out, err := getPoliticianHandler(src)(context.Background(), nil,
		GetPoliticianInput{Slug: "anthony-smith"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Fatalf("count = %d, want 0", out.Count)
	}
	if len(out.ParliamentsTodo) != 2 || len(out.ParliamentsPart) != 1 {
		t.Errorf("coverage lists dropped: %+v", out)
	}
	text := textOf(t, res)
	if strings.Contains(strings.ToLower(text), "declared nothing") ||
		strings.Contains(strings.ToLower(text), "no interests") {
		t.Errorf("the text makes an absence claim: %q", text)
	}
	if !strings.Contains(text, "44, 45") {
		t.Errorf("the text does not state what has not been read: %q", text)
	}
}

// The register kill switch (POLITICIAN_INTERESTS_ENABLED) makes the handler
// return an EMPTY response rather than an error. Reporting that as "declared
// nothing" would be a false absence claim about a named individual, so it must
// surface as an error the model can act on.
func TestGetPoliticianDistinguishesAnUnavailableRegisterFromAnAbsentMember(t *testing.T) {
	off := &fakeDataSource{politician: &shortsv1alpha1.GetPoliticianResponse{}}
	_, _, err := getPoliticianHandler(off)(context.Background(), nil,
		GetPoliticianInput{Slug: "anthony-smith"})
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("kill-switch response = %v, want an explicit unavailability error", err)
	}

	missing := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("no rows"))}
	_, _, err = getPoliticianHandler(missing)(context.Background(), nil,
		GetPoliticianInput{Slug: "nobody-here"})
	if err == nil || !strings.Contains(err.Error(), "no parliamentarian has the slug") {
		t.Fatalf("not-found = %v, want a distinct, actionable message", err)
	}
}

func TestListStockPoliticiansDistinguishesUnavailableFromNoDeclarers(t *testing.T) {
	off := &fakeDataSource{stockPoliticians: &shortsv1alpha1.ListStockPoliticiansResponse{}}
	if _, _, err := listStockPoliticiansHandler(off)(context.Background(), nil,
		ListStockPoliticiansInput{Code: "BHP"}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("kill-switch response = %v, want an explicit unavailability error", err)
	}

	none := &fakeDataSource{stockPoliticians: &shortsv1alpha1.ListStockPoliticiansResponse{StockCode: "XYZ"}}
	res, out, err := listStockPoliticiansHandler(none)(context.Background(), nil,
		ListStockPoliticiansInput{Code: "XYZ"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Fatalf("count = %d, want 0", out.Count)
	}
	if !strings.Contains(textOf(t, res), "not evidence of absence") {
		t.Errorf("an empty result is presented as proof of absence: %q", textOf(t, res))
	}
}

// ---------------------------------------------------------------------------
// Projection details
// ---------------------------------------------------------------------------

func TestGetPoliticianProjectsHolderAndDateHonestly(t *testing.T) {
	undated := fixtureInterest()
	undated.DeclaredFromKnown = false
	undated.Holder = shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_UNSPECIFIED

	src := &fakeDataSource{politician: &shortsv1alpha1.GetPoliticianResponse{
		Politician: fixturePolitician("anthony-smith", "Anthony Smith"),
		Interests:  []*shortsv1alpha1.DeclaredInterest{fixtureInterest(), undated},
	}}

	_, out, err := getPoliticianHandler(src)(context.Background(), nil,
		GetPoliticianInput{Slug: " Anthony-Smith "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotPolitician.GetSlug() != "anthony-smith" {
		t.Errorf("slug not normalised: %q", src.gotPolitician.GetSlug())
	}
	if out.Interests[0].Holder != "spouse or partner" {
		t.Errorf("holder = %q, want the register's own attribution", out.Interests[0].Holder)
	}
	if out.Interests[0].DeclaredFrom != "2022-06-01" {
		t.Errorf("declared_from = %q", out.Interests[0].DeclaredFrom)
	}
	// declared_from is populated with a placeholder when the register gave no
	// date; publishing it would invent a fact about when someone acquired
	// something.
	if out.Interests[1].DeclaredFrom != "" {
		t.Errorf("an undated declaration published a date: %q", out.Interests[1].DeclaredFrom)
	}
	if out.Interests[1].Holder != "not stated" {
		t.Errorf("an unattributed row claims a holder: %q", out.Interests[1].Holder)
	}
}

func TestSearchPoliticiansNormalisesFiltersAndClampsLimit(t *testing.T) {
	src := &fakeDataSource{listPoliticians: &shortsv1alpha1.ListPoliticiansResponse{}}
	if _, _, err := searchPoliticiansHandler(src)(context.Background(), nil, SearchPoliticiansInput{
		Chamber: "Senate", State: " vic ", Party: "alp", Limit: 900,
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := src.gotListPoliticians
	if got.GetChamber() != "senate" || got.GetStateCode() != "VIC" || got.GetPartyAb() != "ALP" {
		t.Errorf("filters not normalised: %+v", got)
	}
	if got.GetLimit() != maxPoliticianSearchLimit {
		t.Errorf("limit = %d, want it clamped to %d", got.GetLimit(), maxPoliticianSearchLimit)
	}
}

func TestListStockPoliticiansValidatesTheTicker(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := listStockPoliticiansHandler(src)(context.Background(), nil,
		ListStockPoliticiansInput{Code: "not-a-ticker"}); err == nil {
		t.Fatal("expected an error")
	}
	if src.gotStockPoliticians != nil {
		t.Error("the RPC was called despite invalid input")
	}
}

func TestPoliticianToolsFailWhenTheBackendDoes(t *testing.T) {
	src := &fakeDataSource{err: errors.New("boom")}
	ctx := context.Background()
	if _, _, err := searchPoliticiansHandler(src)(ctx, nil, SearchPoliticiansInput{}); err == nil {
		t.Error("search_politicians swallowed a backend failure")
	}
	if _, _, err := getPoliticianHandler(src)(ctx, nil, GetPoliticianInput{Slug: "a-b"}); err == nil {
		t.Error("get_politician swallowed a backend failure")
	}
	if _, _, err := listStockPoliticiansHandler(src)(ctx, nil,
		ListStockPoliticiansInput{Code: "BHP"}); err == nil {
		t.Error("list_stock_politicians swallowed a backend failure")
	}
}

func TestPoliticianToolsErrorOnANilBody(t *testing.T) {
	src := &fakeDataSource{}
	ctx := context.Background()
	if _, _, err := searchPoliticiansHandler(src)(ctx, nil, SearchPoliticiansInput{}); err == nil {
		t.Error("search_politicians accepted a nil body")
	}
	if _, _, err := getPoliticianHandler(src)(ctx, nil, GetPoliticianInput{Slug: "a-b"}); err == nil {
		t.Error("get_politician accepted a nil body")
	}
	if _, _, err := listStockPoliticiansHandler(src)(ctx, nil,
		ListStockPoliticiansInput{Code: "BHP"}); err == nil {
		t.Error("list_stock_politicians accepted a nil body")
	}
}

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

func TestPoliticianToolsAreRegisteredAgainstTheirRPCs(t *testing.T) {
	want := map[string]string{
		"search_politicians":     "shorts.v1alpha1.PoliticiansService.ListPoliticians",
		"get_politician":         "shorts.v1alpha1.PoliticiansService.GetPolitician",
		"list_stock_politicians": "shorts.v1alpha1.PoliticiansService.ListStockPoliticians",
	}
	got := map[string]string{}
	for _, tool := range Registry() {
		if tool.Domain == "politicians" {
			got[tool.Name] = tool.RPC
		}
	}
	if len(got) != len(want) {
		t.Fatalf("registered politician tools = %v, want %v", got, want)
	}
	for name, rpc := range want {
		if got[name] != rpc {
			t.Errorf("%s declares RPC %q, want %q", name, got[name], rpc)
		}
	}
}

// Every politician tool description must carry the no-amounts rule. It is the
// single most likely misreading of this data, and a description is the only
// thing a model reads before deciding what the tool means.
func TestPoliticianToolDescriptionsStateTheNoAmountsRule(t *testing.T) {
	for _, tool := range Registry() {
		if tool.Domain != "politicians" {
			continue
		}
		lowered := strings.ToLower(tool.Description)
		if !strings.Contains(lowered, "never how much") {
			t.Errorf("%s does not state that the registers record no amounts", tool.Name)
		}
	}
}

func politicianSource() *fakeDataSource {
	return &fakeDataSource{
		listPoliticians: &shortsv1alpha1.ListPoliticiansResponse{
			Politicians: []*shortsv1alpha1.Politician{fixturePolitician("anthony-smith", "Anthony Smith")},
			Total:       1,
		},
		politician: &shortsv1alpha1.GetPoliticianResponse{
			Politician:           fixturePolitician("anthony-smith", "Anthony Smith"),
			Interests:            []*shortsv1alpha1.DeclaredInterest{fixtureInterest()},
			ExtractedParliaments: []int32{47, 48},
			PendingParliaments:   []int32{44, 45},
		},
		stockPoliticians: &shortsv1alpha1.ListStockPoliticiansResponse{
			StockCode: "BHP", CompanyName: "BHP GROUP LIMITED", PoliticianCount: 1,
			PartyCounts: []*shortsv1alpha1.PartyCount{
				{PartyAb: "LP", Party: "Liberal Party of Australia", PoliticianCount: 1},
			},
			Interests: []*shortsv1alpha1.StockPoliticianInterest{{
				Politician: fixturePolitician("anthony-smith", "Anthony Smith"),
				Interest:   fixtureInterest(),
			}},
		},
	}
}
