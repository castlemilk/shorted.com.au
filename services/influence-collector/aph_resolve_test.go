package main

import (
	"strings"
	"testing"
)

func candidateRaws(cs []SecurityCandidate) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Raw)
	}
	return out
}

// The parser preserves one entity per physical line, so declared_lines does most
// of the splitting. These are real cells.
func TestSplitSecurityBlobUsesDeclaredLines(t *testing.T) {
	lines := []string{
		"Manowarriors Pty Ltd",
		"NEXTGEN WEALTH PTY LTD",
		"Betashares Australian High Interest Cash ETF (AAA)",
		"SPDR S&P/ASX 200 ETF (STW)",
		"iShares S&P 500 ETF (IVV)",
	}
	got := splitSecurityBlob(lines, "")
	if len(got) != len(lines) {
		t.Fatalf("got %d candidates, want %d: %v", len(got), len(lines), candidateRaws(got))
	}
	for i, c := range got {
		if c.Ordinal != i {
			t.Errorf("candidate %d has ordinal %d", i, c.Ordinal)
		}
	}
}

// An ASX code the member wrote themselves is the strongest signal available —
// and the ONLY thing that resolves ETFs, whose company_name values in
// "company-metadata" are abbreviated beyond recognition.
func TestInlineTickerIsExtracted(t *testing.T) {
	cases := map[string]string{
		"Betashares Australian High Interest Cash ETF (AAA)":    "AAA",
		"SPDR S&P/ASX 200 ETF (STW)":                            "STW",
		"iShares Core Composite Bond ETF (IAF)":                 "IAF",
		"Russell Investments Australian Select Corporate (RCB)": "RCB",
		"Telstra TLS": "TLS",
	}
	for raw, want := range cases {
		c := makeCandidate(0, raw)
		if c.Ticker != want {
			t.Errorf("makeCandidate(%q).Ticker = %q, want %q", raw, c.Ticker, want)
		}
	}
}

// A private company's name qualifier must never be read as a ticker.
// "Gunnedah Industries (NW) Pty Ltd" is not a listing.
func TestPrivateCompanyVetoesInlineTicker(t *testing.T) {
	for _, raw := range []string{
		"Gunnedah Industries (NW) Pty Ltd",
		"JL & JM Chaffey Investments Pty Ltd",
		"CE & TS Boyce Family Trust",
		"Smith Superannuation Fund (ABC)",
	} {
		if c := makeCandidate(0, raw); c.Ticker != "" {
			t.Errorf("makeCandidate(%q) extracted ticker %q from an unlisted entity", raw, c.Ticker)
		}
	}
}

// Members write sentences into the cell and the parser preserves them
// faithfully. They are not securities and must not enter the curation backlog.
func TestProseIsRejected(t *testing.T) {
	for _, raw := range []string{
		"On the 19th of August 2025 I ceased",
		"to be a shareholder of Gunnedah",
		"All spouse / partner details",
		"Not Applicable",
		"See attached",
	} {
		if c := makeCandidate(0, raw); c.Reject == "" {
			t.Errorf("makeCandidate(%q) was accepted as a security (reject=%q)", raw, c.Reject)
		}
	}
}

func TestRealCompanyNamesAreNotRejected(t *testing.T) {
	for _, raw := range []string{
		"AMP", "Santos", "Telstra", "Suncorp Australia",
		"Hyperpower Pty Ltd", "Far Ltd FPO", "Cochlear",
	} {
		c := makeCandidate(0, raw)
		if c.Reject != "" {
			t.Errorf("makeCandidate(%q) rejected as %q", raw, c.Reject)
		}
		if c.Norm == "" {
			t.Errorf("makeCandidate(%q) normalised to empty", raw)
		}
	}
}

// The source mixes comma AND period separators, so "BHP. CBA" is two companies
// while "Pty. Ltd." is not a boundary.
func TestSplitFragmentsHandlesMixedSeparators(t *testing.T) {
	got := splitFragments("ANZ, Arena REIT, Beta shares Asia ETF, BHP. CBA, Cochlear, CSL.")
	want := []string{"ANZ", "Arena REIT", "Beta shares Asia ETF", "BHP.", "CBA", "Cochlear", "CSL."}
	if len(got) != len(want) {
		t.Fatalf("got %d fragments %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if strings.TrimSpace(got[i]) != want[i] {
			t.Errorf("fragment %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// Regression: the period-boundary pattern consumes the following uppercase
// letter (Go's RE2 has no lookahead), so it must be handed back or "BHP. CBA"
// yields "BA".
func TestPeriodBoundaryDoesNotEatTheNextLetter(t *testing.T) {
	got := splitFragments("BHP. CBA")
	if len(got) != 2 || got[1] != "CBA" {
		t.Errorf("splitFragments(\"BHP. CBA\") = %v, want [BHP. CBA]", got)
	}
}

func TestAbbreviationIsNotAFragmentBoundary(t *testing.T) {
	for _, in := range []string{"Acme Pty. Ltd.", "Widget Co. Limited", "Example Inc. Holdings"} {
		if got := splitFragments(in); len(got) != 1 {
			t.Errorf("splitFragments(%q) = %v, want one fragment", in, got)
		}
	}
}

func TestQualifiersAreStrippedBeforeNormalising(t *testing.T) {
	a := makeCandidate(0, "Betashares FAIR (joint)")
	b := makeCandidate(0, "Betashares FAIR")
	if a.Norm != b.Norm {
		t.Errorf("(joint) changed the normalised name: %q vs %q", a.Norm, b.Norm)
	}
	// "Far Ltd FPO" is FAR: FPO is a share class, not part of the name.
	if got := makeCandidate(0, "Far Ltd FPO").Norm; got != "FAR" {
		t.Errorf("Far Ltd FPO normalised to %q, want FAR", got)
	}
}

// ---------------------------------------------------------------------------
// The match ladder
// ---------------------------------------------------------------------------

func testLadder() (map[string]SecurityAlias, map[string]string, map[string]CompanyNameMapping, map[string]int) {
	aliases := map[string]SecurityAlias{
		"CBA":                                   {StockCode: "CBA", AliasKind: "equity", Resolution: "resolved", DisplayName: "Commonwealth Bank"},
		"VANGUARD AUSTRALIAN SHARES INDEX FUND": {AliasKind: "managed_fund", Resolution: "unlisted_fund"},
		"NOT APPLICABLE":                        {AliasKind: "noise", Resolution: "not_a_security"},
	}
	codes := map[string]string{"IVV": "Ishares S&P 500 Etf Etf Units", "TLS": "Telstra Group", "AAA": "Betasharescashetf Etf Units"}
	names := map[string]CompanyNameMapping{
		"AMP":    {StockCode: "AMP", CompanyName: "Amp"},
		"SANTOS": {StockCode: "STO", CompanyName: "Santos"},
	}
	ambiguous := map[string]int{"ACME": 3}
	return aliases, codes, names, ambiguous
}

func TestResolveLadderPrecedence(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()

	// A curated alias outranks everything: a human decision beats a coincidence.
	res := resolveSecurityCandidate(makeCandidate(0, "CBA"), aliases, codes, names, ambiguous)
	if res.Status != "resolved" || res.MatchMethod != "curated_alias" || res.StockCode != "CBA" {
		t.Errorf("curated alias: %+v", res)
	}

	// A member-stated ticker resolves once validated against real listings.
	res = resolveSecurityCandidate(makeCandidate(0, "iShares S&P 500 ETF (IVV)"), aliases, codes, names, ambiguous)
	if res.Status != "resolved" || res.MatchMethod != "ticker_in_text" || res.StockCode != "IVV" {
		t.Errorf("inline ticker: %+v", res)
	}

	// Exact normalised name.
	res = resolveSecurityCandidate(makeCandidate(0, "AMP"), aliases, codes, names, ambiguous)
	if res.Status != "resolved" || res.MatchMethod != "name_exact" || res.StockCode != "AMP" {
		t.Errorf("name exact: %+v", res)
	}
}

// An unlisted managed fund resolves with NO stock code, so it renders as
// declared text with no ticker link. "Vanguard Australian Shares Index Fund"
// (unlisted) differs from VAS (listed) by one word — only the alias table may
// bridge that gap.
func TestUnlistedFundNeverGetsATicker(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()
	res := resolveSecurityCandidate(
		makeCandidate(0, "Vanguard Australian Shares Index Fund"), aliases, codes, names, ambiguous)
	if res.Status != "unlisted_fund" {
		t.Errorf("status = %q, want unlisted_fund", res.Status)
	}
	if res.StockCode != "" {
		t.Errorf("an unlisted fund resolved to %q; it must carry no code", res.StockCode)
	}
}

// A ticker the member wrote that is NOT a real listing must not resolve.
func TestUnknownTickerDoesNotResolve(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()
	res := resolveSecurityCandidate(makeCandidate(0, "Something Fund (ZZZ)"), aliases, codes, names, ambiguous)
	if res.Status == "resolved" {
		t.Errorf("an unvalidated ticker resolved: %+v", res)
	}
}

// A same-name trap must be recorded as ambiguous, not as a plain miss: it needs
// a human decision, not an alias guess.
func TestAmbiguousNameIsDistinguishedFromUnmatched(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()

	res := resolveSecurityCandidate(makeCandidate(0, "Acme"), aliases, codes, names, ambiguous)
	if res.Status != "ambiguous" || res.CandidateCount != 3 {
		t.Errorf("ambiguous: %+v", res)
	}

	res = resolveSecurityCandidate(makeCandidate(0, "Totally Unknown Holdings"), aliases, codes, names, ambiguous)
	if res.Status != "unmatched" {
		t.Errorf("unmatched: %+v", res)
	}
}

// Nothing that is not one of the three publishable methods may ever be
// 'resolved' — the DB CHECK enforces this too, but the resolver must not even
// try.
func TestOnlyPublishableMethodsResolve(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()
	publishable := map[string]bool{"curated_alias": true, "ticker_in_text": true, "name_exact": true}

	for _, raw := range []string{
		"CBA", "iShares S&P 500 ETF (IVV)", "AMP", "Santos", "Telstra TLS",
		"Acme", "Totally Unknown Holdings", "Vanguard Australian Shares Index Fund",
		"On the 19th of August 2025 I ceased", "Not Applicable",
	} {
		res := resolveSecurityCandidate(makeCandidate(0, raw), aliases, codes, names, ambiguous)
		if res.Status == "resolved" {
			if !publishable[res.MatchMethod] {
				t.Errorf("%q resolved via unpublishable method %q", raw, res.MatchMethod)
			}
			if res.StockCode == "" {
				t.Errorf("%q resolved with no stock code", raw)
			}
		}
	}
}

func TestRejectedCandidatesAreNotSecurities(t *testing.T) {
	aliases, codes, names, ambiguous := testLadder()
	res := resolveSecurityCandidate(makeCandidate(0, "All spouse / partner details"), aliases, codes, names, ambiguous)
	if res.Status != "not_a_security" {
		t.Errorf("status = %q, want not_a_security", res.Status)
	}
}

// Generic security-type words that happen to be real ASX codes must never be
// read as tickers. This was a live wrong-attribution bug: every fund name ending
// in "ETF" resolved to UBS IQ MSCI Australia ETF (code ETF), showing ten members
// as holding a fund none of them declared.
func TestGenericSecurityWordsAreNotTickers(t *testing.T) {
	for _, raw := range []string{
		"Betashares Global Sustainability Leaders ETF",
		"Australian Shares ETF",
		"Betashares S&P/ASX 200 Financial Sector ETF",
		"VanEck International REIT",
		"Some Managed FUND",
		"Westpac Bank",
	} {
		if c := makeCandidate(0, raw); c.Ticker != "" {
			t.Errorf("makeCandidate(%q) read %q as a ticker", raw, c.Ticker)
		}
	}
	// A real ticker still works.
	if c := makeCandidate(0, "Telstra TLS"); c.Ticker != "TLS" {
		t.Errorf("Telstra TLS lost its ticker: %q", c.Ticker)
	}
	if c := makeCandidate(0, "iShares S&P 500 ETF (IVV)"); c.Ticker != "IVV" {
		t.Errorf("parenthesised ticker lost: %q", c.Ticker)
	}
}

func TestNonSecurityTermsRejected(t *testing.T) {
	// Items 11-12 (gifts, sponsored travel) share the item-1 splitter, so their
	// content reaches the candidate pool. After the 44P/45P backfill these were
	// the TOP "unmatched" names — all sitting in the resolution denominator.
	for _, raw := range []string{
		"Gift", "GIFT", "Membership", "Flight upgrade", "2017", "2019",
		"Tickets", "Lounge access", "Hospitality", "Not Applicable", "Same as above",
	} {
		if c := makeCandidate(0, raw); c.Reject == "" {
			t.Errorf("%q should be rejected as a non-security, got Reject=%q Norm=%q", raw, c.Reject, c.Norm)
		}
	}
}

func TestRealCompaniesSurviveTheNonSecurityFilter(t *testing.T) {
	// Anchored whole-string, so a listing whose name merely CONTAINS one of those
	// words must be untouched. Over-rejecting here would silently delete real
	// declared holdings from a named person's profile.
	for _, raw := range []string{
		"Gift Holdings Ltd", "Travel Corporation Ltd", "Flight Centre Travel Group",
		"CBA", "BHP Billiton", "Insurance Australia Group",
	} {
		if c := makeCandidate(0, raw); c.Reject == "not_a_security_term" {
			t.Errorf("%q must NOT be rejected as a non-security term", raw)
		}
	}
}
