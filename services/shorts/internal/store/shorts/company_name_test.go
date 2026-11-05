package shorts

import "testing"

// Mirrors web/src/@/lib/__tests__/company-name.test.ts - the two layers must
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
		// Tickers in companyTickerWords stay capitals in a mixed-case name too.
		{"Bhp Group Limited", "BHP", "BHP Group"},
		{"Rea Group Ltd", "REA", "REA Group"},
		{"Qbe Insurance Group Limited", "QBE", "QBE Insurance Group"},
		{"Amp Limited", "AMP", "AMP"},
		{"Csl Limited", "CSL", "CSL"},
		{"ASX LIMITED", "ASX", "ASX"},
		// RIO is deliberately not a ticker word: "Rio Tinto" is a word.
		{"Rio Tinto Limited", "RIO", "Rio Tinto"},
		{"National Australia Bank Limited", "NAB", "National Australia Bank"},
		{"South32 Limited", "S32", "South32"},
		{"Commonwealth Bank of Australia", "CBA", "Commonwealth Bank of Australia"},
		// A short shouted English word is title-cased, not read as an acronym.
		{"RED METAL LIMITED", "RDM", "Red Metal"},
		{"OIL SEARCH LIMITED", "OSH", "Oil Search"},
		// A short shouted acronym that is not a plain word stays capitals.
		{"NIB HOLDINGS LIMITED", "NHF", "NIB Holdings"},
		// Every plainShortWords entry the register uses reads as a word.
		{"AIR NEW ZEALAND LIMITED", "AIZ", "Air New Zealand"},
		{"ARK MINES LIMITED", "AHK", "Ark Mines"},
		{"HOT CHILI LIMITED", "HCH", "Hot Chili"},
		{"BAY RESOURCES LIMITED", "BYR", "Bay Resources"},
		{"SEA CHANGE LIMITED", "SCL", "Sea Change"},
		{"FOX MAX HOLDINGS LIMITED", "FXM", "Fox Max Holdings"},
	}
	for _, tc := range cases {
		if got := cleanCompanyName(tc.name, tc.code); got != tc.want {
			t.Errorf("cleanCompanyName(%q, %q) = %q, want %q", tc.name, tc.code, got, tc.want)
		}
	}
}

// servedOwnershipName is what the ownership rpcs serve for a stock's company
// or security name: the register page's name, whatever the row stores.
func TestServedOwnershipNameIsTheRegisterName(t *testing.T) {
	cases := []struct {
		code, name, want string
	}{
		{"BHP", "Bhp Group Limited", "BHP Group"},
		{"BHP", "BHP GROUP LIMITED", "BHP Group"},
		{"RDM", "RED METAL LIMITED", "Red Metal"},
		{"BHP", "", ""},
	}
	for _, tc := range cases {
		if got := servedOwnershipName(tc.code, tc.name); got != tc.want {
			t.Errorf("servedOwnershipName(%q, %q) = %q, want %q", tc.code, tc.name, got, tc.want)
		}
	}
}
