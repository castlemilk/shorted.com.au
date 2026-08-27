package mcp

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Register-of-interests tools.
//
// Three tools over PoliticiansService, and the whole file is shaped by four
// rules that come from docs/feature/politicians/README.md and
// docs/influence-editorial-standards.md. They are licence and defamation
// constraints, not style, and each has a test.
//
//  1. WHAT IS HELD, NEVER HOW MUCH. The registers record that a member declared
//     an interest; they do not record quantity, value, purchase price or income.
//     No amount column exists anywhere in the subsystem, the proto carries no
//     amount field, and a migration test asserts none appears. A tool must not
//     invent one or derive one — not a count of shares, not a "size", not an
//     ordering that implies one. TestPoliticianToolsPublishNoAmountOrValue.
//
//  2. APH IS CC BY-NC-ND. ND means no derivative works, so a member's declared
//     text is emitted VERBATIM, byte for byte, and is never summarised,
//     normalised, re-cased or truncated. That is why the caps in this file bound
//     the NUMBER of declarations returned and never the length of one: dropping
//     whole rows and saying so is honest, rewriting a row is a licence breach
//     and a misquotation of a named individual.
//     TestDeclaredTextIsEmittedVerbatim.
//
//  3. NO PORTRAITS. `Politician` carries photo_url with three attribution fields
//     that a CC BY / CC BY-SA licence makes mandatory, enforced in four places
//     (DB CHECK, store, proto, component). An MCP result is republication into a
//     client we do not control, which may render any subset of the structured
//     output — so the credit cannot be guaranteed to travel with the image. The
//     obligation is therefore avoided rather than managed: this surface emits no
//     portrait at all. TestPoliticianToolsEmitNoPortrait.
//
//  4. WITHHOLD RATHER THAN GUESS. A name search once matched "Anthony Smith" to
//     Dean Smith. So search_politicians never resolves a name to one person: it
//     returns every match with the division, state and party needed to tell them
//     apart, and says plainly when more than one matched. And an empty interest
//     list is never presented as "declared nothing" — the coverage lists say
//     which parliaments have actually been read.
const (
	// registerAttribution is the licence line the register data carries. It is
	// the string the API itself returns (registerLicence in the shorts service),
	// surfaced here because a tool result travels without our page's footer.
	registerAttribution = "Source: Australian Parliament House Registers of Members' and Senators' Interests."

	// registerNoAmounts is the single most important caveat on this domain and
	// ships with every result: a reader who assumes a declaration implies a
	// holding size has been misled by us, not by the register.
	registerNoAmounts = "The registers record WHAT is declared, never how much — no quantity, value, " +
		"purchase price or income exists in this data."

	defaultPoliticianSearchLimit = 20
	// maxPoliticianSearchLimit sits far inside the handler's own 500. A search
	// is a disambiguation step over 319 members, not an export.
	maxPoliticianSearchLimit = 50

	// maxRegisterInterests bounds one member's declarations. It bounds the
	// COUNT, never the text of any one of them — see rule 2. The overflow is
	// reported, not hidden.
	maxRegisterInterests = 20

	// maxStockDeclarations bounds the declarations returned for one company.
	maxStockDeclarations = 20
)

// ---------------------------------------------------------------------------
// search_politicians
// ---------------------------------------------------------------------------

type SearchPoliticiansInput struct {
	Query   string `json:"query,omitempty" jsonschema:"Name substring. Every match is returned; none is picked for you."`
	Chamber string `json:"chamber,omitempty" jsonschema:"house or senate."`
	State   string `json:"state,omitempty" jsonschema:"NSW, VIC, QLD, SA, WA, TAS, NT or ACT."`
	Party   string `json:"party,omitempty" jsonschema:"AEC abbreviation, e.g. ALP, LP, GRN."`
	Limit   int    `json:"limit,omitempty" jsonschema:"1-50, default 20. Higher values are clamped."`
}

type PoliticianRow struct {
	Slug                  string `json:"slug" jsonschema:"Pass to get_politician."`
	Name                  string `json:"name"`
	Chamber               string `json:"chamber"`
	Division              string `json:"division,omitempty" jsonschema:"House seat; empty for senators."`
	State                 string `json:"state,omitempty"`
	Party                 string `json:"party,omitempty" jsonschema:"Empty means not recorded, never independent."`
	DeclaredListedCount   int32  `json:"declared_listed_count" jsonschema:"ASX-listed companies declared. A count of things, not a size."`
	DeclaredPropertyCount int32  `json:"declared_property_count"`
}

type SearchPoliticiansOutput struct {
	Count       int             `json:"count"`
	Total       int32           `json:"total" jsonschema:"Matches before the limit."`
	Politicians []PoliticianRow `json:"politicians"`
	Source      string          `json:"source"`
	Note        string          `json:"note"`
}

const searchPoliticiansDescription = "Find Australian federal parliamentarians in the Registers of Members' and " +
	"Senators' Interests, by name substring, chamber, state or party. Returns each member's slug (for " +
	"get_politician), name, chamber, division, state, party, and COUNTS of the listed companies and properties " +
	"they declare. " +
	"The registers record what is declared, never how much: there is no amount, value, share count or portfolio " +
	"size in this data and none can be derived from it. " +
	"A name search returns EVERY match and never picks one — two members can share a surname, so disambiguate on " +
	"division, state and party before calling get_politician. Covers 319 members across parliaments 44-48. " +
	"Default 20, maximum 50."

func searchPoliticiansTool() Tool {
	tool := Tool{
		Name:        "search_politicians",
		Title:       "Find a federal parliamentarian",
		Description: searchPoliticiansDescription,
		RPC:         "shorts.v1alpha1.PoliticiansService.ListPoliticians",
		Domain:      "politicians",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), searchPoliticiansHandler(src))
	}
	return tool
}

func searchPoliticiansHandler(src DataSource) sdk.ToolHandlerFor[SearchPoliticiansInput, SearchPoliticiansOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in SearchPoliticiansInput) (*sdk.CallToolResult, SearchPoliticiansOutput, error) {
		query := strings.TrimSpace(in.Query)
		res, err := src.ListPoliticians(ctx, connect.NewRequest(&shortsv1alpha1.ListPoliticiansRequest{
			Query:     query,
			Chamber:   lower(in.Chamber),
			StateCode: strings.ToUpper(strings.TrimSpace(in.State)),
			PartyAb:   strings.ToUpper(strings.TrimSpace(in.Party)),
			Limit:     clampLimit(in.Limit, defaultPoliticianSearchLimit, maxPoliticianSearchLimit),
		}))
		if err != nil {
			return nil, SearchPoliticiansOutput{}, fmt.Errorf("could not search the register: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, SearchPoliticiansOutput{}, fmt.Errorf("no response from the register")
		}

		out := SearchPoliticiansOutput{
			Politicians: []PoliticianRow{},
			Total:       res.Msg.GetTotal(),
			Source:      registerAttribution,
			Note:        registerNoAmounts,
		}
		for _, p := range res.Msg.GetPoliticians() {
			if p == nil {
				continue
			}
			out.Politicians = append(out.Politicians, politicianRow(p))
		}
		out.Count = len(out.Politicians)

		var text string
		switch {
		case out.Count == 0:
			// Deliberately not "this person declared nothing" and not "no such
			// member": the same empty response is returned when the register is
			// switched off, and an absence claim about a named individual is the
			// one thing this subsystem must never make by accident.
			text = "No parliamentarians match those filters, or the register is currently unavailable."
		case out.Count == 1:
			p := out.Politicians[0]
			text = fmt.Sprintf("%s (%s), slug %s. %s", p.Name, describeSeat(p), p.Slug, registerNoAmounts)
		default:
			text = fmt.Sprintf("%d parliamentarians match. More than one — pick by division, state and party "+
				"rather than by name, then call get_politician with that member's slug. %s",
				out.Count, registerNoAmounts)
			if query != "" {
				out.Note = fmt.Sprintf("%d members match %q; none has been chosen for you. %s",
					out.Count, query, registerNoAmounts)
			}
		}
		if int32(out.Count) < out.Total {
			out.Note += fmt.Sprintf(" Showing %d of %d matches.", out.Count, out.Total)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

// politicianRow projects the identity fields. It exists so that the ONE place
// this surface reads a Politician is the one place that could ever leak a
// portrait — and it does not read photo_url at all (rule 3).
func politicianRow(p *shortsv1alpha1.Politician) PoliticianRow {
	return PoliticianRow{
		Slug:                  p.GetSlug(),
		Name:                  p.GetDisplayName(),
		Chamber:               p.GetChamber(),
		Division:              p.GetDivision(),
		State:                 p.GetStateCode(),
		Party:                 firstNonEmpty(p.GetPartyAb(), p.GetParty()),
		DeclaredListedCount:   p.GetDeclaredListedCount(),
		DeclaredPropertyCount: p.GetDeclaredPropertyCount(),
	}
}

func describeSeat(p PoliticianRow) string {
	parts := []string{}
	for _, v := range []string{p.Party, p.Division, p.State, p.Chamber} {
		if v != "" {
			parts = append(parts, v)
		}
	}
	if len(parts) == 0 {
		return "seat not recorded"
	}
	return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------------------
// get_politician
// ---------------------------------------------------------------------------

type GetPoliticianInput struct {
	Slug string `json:"slug" jsonschema:"From search_politicians. Required; a name is not accepted, being ambiguous."`
}

// RegisterDeclaration is one row of the register.
//
// declared_text and secondary_text are the member's own words as APH published
// them, carried VERBATIM. CC BY-NC-ND forbids a derivative, so nothing here
// summarises, normalises or truncates them (rule 2).
type RegisterDeclaration struct {
	ItemLabel         string `json:"item_label" jsonschema:"e.g. Shareholdings, Real estate, Gifts."`
	Holder            string `json:"holder" jsonschema:"Whose interest it is: member, spouse or partner, or dependent children."`
	EntityKind        string `json:"entity_kind,omitempty" jsonschema:"listed, private_company, family_trust, smsf, managed_fund, foreign or not_an_entity. Only a listed row lacking stock_code is an unresolved match."`
	DeclaredText      string `json:"declared_text" jsonschema:"Verbatim, as declared."`
	SecondaryText     string `json:"secondary_text,omitempty" jsonschema:"Verbatim."`
	StockCode         string `json:"stock_code,omitempty" jsonschema:"Only where the match was unambiguous."`
	CompanyName       string `json:"company_name,omitempty"`
	Industry          string `json:"industry,omitempty"`
	Suburb            string `json:"suburb,omitempty" jsonschema:"Where resolved to an ABS suburb."`
	DeclaredFrom      string `json:"declared_from,omitempty" jsonschema:"YYYY-MM-DD; absent when undated."`
	CurrentlyDeclared bool   `json:"currently_declared"`
	SourceURL         string `json:"source_url,omitempty"`
}

type GetPoliticianOutput struct {
	Politician       PoliticianRow         `json:"politician"`
	CanonicalSlug    string                `json:"canonical_slug,omitempty" jsonschema:"Set when merged; re-query with this."`
	Count            int                   `json:"count"`
	Interests        []RegisterDeclaration `json:"interests"`
	InterestsOmitted int                   `json:"interests_omitted,omitempty"`
	ParliamentsRead  []int32               `json:"parliaments_read" jsonschema:"Read in full."`
	ParliamentsPart  []int32               `json:"parliaments_partial" jsonschema:"Read only in part — an absence here proves nothing."`
	ParliamentsTodo  []int32               `json:"parliaments_pending" jsonschema:"Documents exist but have not been read."`
	Source           string                `json:"source"`
	Note             string                `json:"note" jsonschema:"Coverage. Read before concluding anything from an empty list."`
}

const getPoliticianDescription = "One Australian federal parliamentarian's declared interests, from the APH " +
	"Registers of Members' and Senators' Interests: each declaration's register item, whose interest it is (member, " +
	"spouse or partner, or dependent children), the member's own words VERBATIM, any ASX code or ABS suburb it resolved to, " +
	"whether it is still declared, and the aph.gov.au source document. Takes a slug from search_politicians. " +
	"WHAT IS DECLARED, NEVER HOW MUCH: the registers record no quantity, value, purchase price, income or " +
	"portfolio size, so no such figure exists here or can be derived. " +
	"An empty list does NOT mean the member declared nothing — check parliaments_read, parliaments_partial and " +
	"parliaments_pending, because parliaments 44 and 45 and the Senate volumes are largely unread. " +
	"A declared company with no stock_code was withheld rather than guessed. At most 20 declarations; the " +
	"remainder is counted, and no declaration's text is ever shortened or reworded."

func getPoliticianTool() Tool {
	tool := Tool{
		Name:        "get_politician",
		Title:       "A parliamentarian's declared interests",
		Description: getPoliticianDescription,
		RPC:         "shorts.v1alpha1.PoliticiansService.GetPolitician",
		Domain:      "politicians",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getPoliticianHandler(src))
	}
	return tool
}

func getPoliticianHandler(src DataSource) sdk.ToolHandlerFor[GetPoliticianInput, GetPoliticianOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetPoliticianInput) (*sdk.CallToolResult, GetPoliticianOutput, error) {
		slug := strings.ToLower(strings.TrimSpace(in.Slug))
		if slug == "" {
			return nil, GetPoliticianOutput{}, fmt.Errorf(
				"slug is required: call search_politicians first — a name is not accepted because two members " +
					"can share one, and picking between them is exactly what this data must not do")
		}

		res, err := src.GetPolitician(ctx, connect.NewRequest(&shortsv1alpha1.GetPoliticianRequest{Slug: slug}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetPoliticianOutput{}, fmt.Errorf(
					"no parliamentarian has the slug %q; call search_politicians to find the right one", slug)
			}
			return nil, GetPoliticianOutput{}, fmt.Errorf("could not read the register for %s: %w", slug, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetPoliticianOutput{}, fmt.Errorf("no response from the register for %s", slug)
		}
		// An empty body is how the kill switch reads. Saying "declared nothing"
		// here would be a false absence claim about a named individual.
		if res.Msg.GetPolitician() == nil {
			return nil, GetPoliticianOutput{}, fmt.Errorf(
				"the register of interests is currently unavailable, so nothing can be said about %s", slug)
		}
		msg := res.Msg

		out := GetPoliticianOutput{
			Politician:      politicianRow(msg.GetPolitician()),
			CanonicalSlug:   msg.GetCanonicalSlug(),
			Interests:       []RegisterDeclaration{},
			ParliamentsRead: msg.GetExtractedParliaments(),
			ParliamentsPart: msg.GetPartialParliaments(),
			ParliamentsTodo: msg.GetPendingParliaments(),
			Source:          registerAttribution,
		}

		interests := msg.GetInterests()
		if len(interests) > maxRegisterInterests {
			out.InterestsOmitted = len(interests) - maxRegisterInterests
			interests = interests[:maxRegisterInterests]
		}
		for _, i := range interests {
			if i == nil {
				continue
			}
			out.Interests = append(out.Interests, RegisterDeclaration{
				ItemLabel:  i.GetItemLabel(),
				Holder:     holderLabel(i.GetHolder()),
				EntityKind: i.GetEntityKind(),
				// Verbatim. No truncate(), no capitalise(), no normalisation:
				// CC BY-NC-ND forbids a derivative of APH prose.
				DeclaredText:      i.GetDeclaredText(),
				SecondaryText:     i.GetSecondaryText(),
				StockCode:         i.GetStockCode(),
				CompanyName:       i.GetCompanyName(),
				Industry:          i.GetIndustry(),
				Suburb:            i.GetSuburbName(),
				DeclaredFrom:      declaredFrom(i),
				CurrentlyDeclared: i.GetCurrentlyDeclared(),
				SourceURL:         i.GetSourceUrl(),
			})
		}
		out.Count = len(out.Interests)
		out.Note = coverageNote(out) + " " + registerNoAmounts

		text := fmt.Sprintf("%s (%s): %d declared interests on record. %s",
			nonEmpty(out.Politician.Name, slug), describeSeat(out.Politician), out.Count, registerNoAmounts)
		if out.Count == 0 {
			text = fmt.Sprintf("No declarations have been read for %s. %s",
				nonEmpty(out.Politician.Name, slug), coverageNote(out))
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

// coverageNote states what has actually been read, so an empty or short list is
// never mistaken for a claim that a named person declared nothing.
func coverageNote(out GetPoliticianOutput) string {
	note := fmt.Sprintf("Parliaments read in full: %s; read in part: %s; not yet read: %s. "+
		"An interest absent here may simply be in a document we have not read.",
		parliamentList(out.ParliamentsRead), parliamentList(out.ParliamentsPart),
		parliamentList(out.ParliamentsTodo))
	if out.InterestsOmitted > 0 {
		note += fmt.Sprintf(" %d further declarations were not returned; none was shortened or reworded.",
			out.InterestsOmitted)
	}
	return note
}

func parliamentList(in []int32) string {
	if len(in) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(in))
	for _, p := range in {
		parts = append(parts, fmt.Sprint(p))
	}
	return strings.Join(parts, ", ")
}

// holderLabel renders the proto enum as the register's own words. The register
// attributes every row to one of these and a surface must label which, because
// "the member holds X" and "the member's spouse holds X" are different claims
// about different people.
func holderLabel(h shortsv1alpha1.RegisterHolder) string {
	switch h {
	case shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SELF:
		return "member"
	case shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER:
		return "spouse or partner"
	case shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_DEPENDENT_CHILDREN:
		return "dependent children"
	default:
		return "not stated"
	}
}

// declaredFrom returns the date only when the register actually gave one.
// declared_from is populated with a placeholder otherwise, and publishing that
// as a date would invent a fact about when someone acquired something.
func declaredFrom(i *shortsv1alpha1.DeclaredInterest) string {
	if !i.GetDeclaredFromKnown() {
		return ""
	}
	return isoDay(i.GetDeclaredFrom())
}

// ---------------------------------------------------------------------------
// list_stock_politicians
// ---------------------------------------------------------------------------

type ListStockPoliticiansInput struct {
	Code        string `json:"code" jsonschema:"ASX ticker, e.g. BHP. Required."`
	CurrentOnly bool   `json:"current_only,omitempty" jsonschema:"Only interests declared as current. Default false: all history."`
}

type StockDeclarationRow struct {
	Name              string `json:"name"`
	Slug              string `json:"slug" jsonschema:"Pass to get_politician."`
	Chamber           string `json:"chamber,omitempty"`
	State             string `json:"state,omitempty"`
	Party             string `json:"party,omitempty"`
	ItemLabel         string `json:"item_label"`
	Holder            string `json:"holder" jsonschema:"member, spouse or partner, or dependent children."`
	DeclaredText      string `json:"declared_text" jsonschema:"Verbatim, as declared."`
	DeclaredFrom      string `json:"declared_from,omitempty" jsonschema:"YYYY-MM-DD; absent when undated."`
	CurrentlyDeclared bool   `json:"currently_declared"`
	SourceURL         string `json:"source_url,omitempty"`
}

type PartyDeclarerCount struct {
	Party           string `json:"party"`
	PoliticianCount int32  `json:"politician_count" jsonschema:"Distinct members, not declarations."`
}

type ListStockPoliticiansOutput struct {
	StockCode       string                `json:"stock_code"`
	CompanyName     string                `json:"company_name,omitempty"`
	PoliticianCount int32                 `json:"politician_count" jsonschema:"Distinct members declaring this company."`
	PartyCounts     []PartyDeclarerCount  `json:"party_counts"`
	Count           int                   `json:"count"`
	Declarations    []StockDeclarationRow `json:"declarations"`
	Source          string                `json:"source"`
	Note            string                `json:"note"`
}

const listStockPoliticiansDescription = "Which Australian federal parliamentarians declare an interest in one " +
	"ASX-listed company, from the APH Registers of Members' and Senators' Interests: who they are, whose interest " +
	"it is (member, spouse or partner, or dependent children), their own words VERBATIM, whether it is still declared, and the " +
	"aph.gov.au source document, plus a count of distinct declaring members by party. " +
	"WHAT IS DECLARED, NEVER HOW MUCH. The registers record no quantity, value, purchase price or gain, so this " +
	"says nothing about the size of anyone's holding and cannot be combined with a share price to imply one. " +
	"A member is matched to a company only where the match was unambiguous; ambiguous ones are withheld, so an " +
	"absent member is not evidence they declared nothing. At most 20 declarations. " +
	"Use get_politician for one member's full register entry."

func listStockPoliticiansTool() Tool {
	tool := Tool{
		Name:        "list_stock_politicians",
		Title:       "Parliamentarians declaring one ASX company",
		Description: listStockPoliticiansDescription,
		RPC:         "shorts.v1alpha1.PoliticiansService.ListStockPoliticians",
		Domain:      "politicians",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listStockPoliticiansHandler(src))
	}
	return tool
}

func listStockPoliticiansHandler(src DataSource) sdk.ToolHandlerFor[ListStockPoliticiansInput, ListStockPoliticiansOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListStockPoliticiansInput) (*sdk.CallToolResult, ListStockPoliticiansOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, ListStockPoliticiansOutput{}, err
		}

		res, err := src.ListStockPoliticians(ctx, connect.NewRequest(&shortsv1alpha1.ListStockPoliticiansRequest{
			StockCode: code, CurrentOnly: in.CurrentOnly,
		}))
		if err != nil {
			return nil, ListStockPoliticiansOutput{}, fmt.Errorf(
				"could not read register declarations for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListStockPoliticiansOutput{}, fmt.Errorf("no response from the register for %s", code)
		}
		// The kill switch returns an empty body with no stock code echoed back.
		// Reporting that as "no member declares this company" would be a false
		// absence claim about every member of parliament at once.
		if res.Msg.GetStockCode() == "" {
			return nil, ListStockPoliticiansOutput{}, fmt.Errorf(
				"the register of interests is currently unavailable, so nothing can be said about %s", code)
		}
		msg := res.Msg

		out := ListStockPoliticiansOutput{
			StockCode:       msg.GetStockCode(),
			CompanyName:     msg.GetCompanyName(),
			PoliticianCount: msg.GetPoliticianCount(),
			PartyCounts:     []PartyDeclarerCount{},
			Declarations:    []StockDeclarationRow{},
			Source:          registerAttribution,
			Note:            registerNoAmounts,
		}
		for _, pc := range msg.GetPartyCounts() {
			if pc == nil {
				continue
			}
			out.PartyCounts = append(out.PartyCounts, PartyDeclarerCount{
				// An empty party_ab means NOT RECORDED, never independent.
				Party:           nonEmpty(firstNonEmpty(pc.GetPartyAb(), pc.GetParty()), "not recorded"),
				PoliticianCount: pc.GetPoliticianCount(),
			})
		}
		for _, item := range capItems(msg.GetInterests(), maxStockDeclarations) {
			if item == nil || item.GetPolitician() == nil || item.GetInterest() == nil {
				continue
			}
			p, i := item.GetPolitician(), item.GetInterest()
			out.Declarations = append(out.Declarations, StockDeclarationRow{
				Name:      p.GetDisplayName(),
				Slug:      p.GetSlug(),
				Chamber:   p.GetChamber(),
				State:     p.GetStateCode(),
				Party:     firstNonEmpty(p.GetPartyAb(), p.GetParty()),
				ItemLabel: i.GetItemLabel(),
				Holder:    holderLabel(i.GetHolder()),
				// Verbatim — see rule 2 at the top of this file.
				DeclaredText:      i.GetDeclaredText(),
				DeclaredFrom:      declaredFrom(i),
				CurrentlyDeclared: i.GetCurrentlyDeclared(),
				SourceURL:         i.GetSourceUrl(),
			})
		}
		out.Count = len(out.Declarations)
		if omitted := len(msg.GetInterests()) - out.Count; omitted > 0 {
			out.Note += fmt.Sprintf(" %d further declarations were not returned; none was shortened or reworded.",
				omitted)
		}

		text := fmt.Sprintf("No parliamentarian is recorded as declaring an interest in %s. %s", code,
			"An unambiguous match is required, so a withheld match is not evidence of absence.")
		if out.PoliticianCount > 0 {
			text = fmt.Sprintf("%d parliamentarians declare an interest in %s%s. %s",
				out.PoliticianCount, code, companySuffix(out.CompanyName), registerNoAmounts)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

func companySuffix(name string) string {
	if name == "" {
		return ""
	}
	return " (" + name + ")"
}
