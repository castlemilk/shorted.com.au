package stocklist

import "testing"

// Mirrors web/src/@/lib/__tests__/company-name.test.ts — the two layers must
// agree on what a display-ready company name looks like.
func TestCleanCompanyName(t *testing.T) {
	cases := []struct {
		name, code, want string
	}{
		// The live /shorts/BHP bug: old code produced "Bhp Group".
		{"BHP GROUP LIMITED", "BHP", "BHP Group"},
		{"CSL LIMITED", "CSL", "CSL"},
		{"COMMONWEALTH BANK OF AUSTRALIA", "CBA", "Commonwealth Bank of Australia"},
		// Short all-caps acronyms stay uppercase even when != code.
		{"NIB HOLDINGS LIMITED", "NHF", "NIB Holdings"},
		{"AGL ENERGY LIMITED", "AGL", "AGL Energy"},
		// Minor words lowercase (never as first word).
		{"BANK OF QUEENSLAND LIMITED", "BOQ", "Bank of Queensland"},
		// Numbers pass through; word counting skips them.
		{"360 CAPITAL GROUP LIMITED", "TGP", "360 Capital Group"},
		// Code-match in a shouted source renders as the code.
		{"RIO TINTO LIMITED", "RIO", "RIO Tinto"},
		// ASIC PRODUCT security descriptors strip, and suffixes stack.
		{"SANTOS LIMITED ORDINARY", "STO", "Santos"},
		{"BLOCK INC CDI 1:1", "SQ2", "Block"},
		// Digit-leading tokens capitalise their first LETTER, not char 0.
		{"4DMEDICAL LIMITED ORDINARY", "4DX", "4Dmedical"},
		// Instrument metadata is cut at the FIRST security-type token, which
		// removes trailing qualifiers and venue codes without enumerating them.
		{"FIDUCIAN GROUP LTD ORDINARY FULLY PAID", "FID", "Fiducian Group"},
		{"LENDLEASE GROUP FPO/UNITS STAPLED", "LLC", "Lendlease Group"},
		{"FLETCHER BUILDING ORD FOR. EXEMPT NZX", "FBU", "Fletcher Building"},
		{"GRAINCORP LIMITED A CLASS ORDINARY", "GNC", "Graincorp"},
		{"NEWMONT CORPORATION CDI1:1FOREXEMPT NYSE", "NEM", "Newmont"},
		{"OMNI BRIDGEWAY LTD ORD US PROHIBITED", "OBL", "Omni Bridgeway"},
		{"RURAL FUNDS GROUP UNITS STAPLED", "RFF", "Rural Funds Group"},
		// An all-lower-case source carries no case information either: the old
		// title-caser stored "4dmedical" for digit-leading names.
		{"4dmedical", "4DX", "4Dmedical"},
		{"29metals", "29M", "29Metals"},
		// A trailing parenthetical blocks the suffix match, so it is dropped.
		{"Environmental Group Limited (The)", "EGL", "Environmental Group"},
		// A genuinely mixed-case name is still left alone.
		{"Woolworths Group", "WOW", "Woolworths Group"},
		// A mid-name minor word is lower-cased even in a mixed-case source.
		{"Commonwealth Bank Of Australia.", "CBA", "Commonwealth Bank of Australia"},
		{"Bank Of Queensland Limited.", "BOQ", "Bank of Queensland"},
		{"Bendigo And Adelaide Bank", "BEN", "Bendigo and Adelaide Bank"},
		// A LEADING minor word keeps its capital.
		{"The Star Entertainment Group", "SGR", "The Star Entertainment Group"},
		// A lone letter after an apostrophe is possessive, not an acronym.
		{"DOMINO'S PIZZA ENTERPRISES LIMITED", "DMP", "Domino's Pizza Enterprises"},
		{"Domino'S Pizza Enterprises", "DMP", "Domino's Pizza Enterprises"},
		{"O'REILLY GROUP LTD", "ORG", "O'Reilly Group"},
		// A leading minor word is title-cased, not shouted or lowercased.
		{"THE A2 MILK COMPANY ORDINARY", "A2M", "The A2 Milk Company"},
		// A trailing full stop must not block the anchored suffix match.
		{"AGL Energy Limited.", "AGL", "AGL Energy"},
		// Mixed-case input keeps its casing (only suffixes strip).
		{"Woolworths Group", "WOW", "Woolworths Group"},
		{"Macquarie Group Limited", "MQG", "Macquarie Group"},
		// A backend-mangled acronym still repairs on code match.
		{"Bhp Group", "BHP", "BHP Group"},
		// Never strips a suffix that is the whole name.
		{"LIMITED", "LTD", "Limited"},
		// Empty stays empty (stocklist upsert relies on NULLIF(name, '')).
		{"", "BHP", ""},
	}
	for _, tc := range cases {
		if got := cleanCompanyName(tc.name, tc.code); got != tc.want {
			t.Errorf("cleanCompanyName(%q, %q) = %q, want %q", tc.name, tc.code, got, tc.want)
		}
	}
}
