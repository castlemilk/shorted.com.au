package shorts

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
