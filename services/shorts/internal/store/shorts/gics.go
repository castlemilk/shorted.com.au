package shorts

// GICS sector, derived from the industry group we already hold (#557).
//
// The standing answer on #557 was that we hold "a single free-text industry
// string, not a GICS hierarchy, and GICS is a licensed classification". Half of
// that is right and half is not, and the difference is worth a caller's time.
//
// The values in `company-metadata.industry` are not arbitrary text. They are
// the 25 real GICS INDUSTRY GROUP names — level 2 of the four-level GICS
// hierarchy — pinned and verified against the database by the 2026-07-22 probe
// behind `industrySlugs` in jobs/internal/jobs/economy/markets.go, which the
// economy pipeline already relies on as a fixed vocabulary.
//
// Industry group → sector is fixed published STRUCTURE, not licensed data. What
// is licensed is the per-company assignment, and we already hold and serve
// that. So the caller's request — "the GICS level, so I can pick the
// neutralisation granularity" — is answerable at two levels today: group, which
// we store, and sector, which follows from it deterministically.
//
// What this does NOT give them is industry (level 3) or sub-industry (level 4).
// Those are genuinely below the resolution of what we hold, and no mapping can
// invent them from a group.
//
// Structure is the post-2023 GICS revision, matching the vocabulary observed in
// the database: "Financial Services" as a group under Financials, and the
// Consumer Discretionary / Consumer Staples "Distribution & Retail" renames.
var gicsIndustryGroupToSector = map[string]string{
	"Energy": "Energy",

	"Materials": "Materials",

	"Capital Goods":                      "Industrials",
	"Commercial & Professional Services": "Industrials",
	"Transportation":                     "Industrials",

	"Automobiles & Components":                     "Consumer Discretionary",
	"Consumer Durables & Apparel":                  "Consumer Discretionary",
	"Consumer Services":                            "Consumer Discretionary",
	"Consumer Discretionary Distribution & Retail": "Consumer Discretionary",

	"Consumer Staples Distribution & Retail": "Consumer Staples",
	"Food, Beverage & Tobacco":               "Consumer Staples",
	"Household & Personal Products":          "Consumer Staples",

	"Health Care Equipment & Services":               "Health Care",
	"Pharmaceuticals, Biotechnology & Life Sciences": "Health Care",

	"Banks":              "Financials",
	"Financial Services": "Financials",
	"Insurance":          "Financials",

	"Software & Services":                      "Information Technology",
	"Technology Hardware & Equipment":          "Information Technology",
	"Semiconductors & Semiconductor Equipment": "Information Technology",

	"Telecommunication Services": "Communication Services",
	"Media & Entertainment":      "Communication Services",

	"Utilities": "Utilities",

	"Equity Real Estate Investment Trusts (REITs)": "Real Estate",
	"Real Estate Management & Development":         "Real Estate",
}

// GICSSector maps an industry-group label to its GICS sector, or "" when the
// label is not one of the 25 known groups.
//
// Empty rather than a guess, deliberately. A label outside the pinned
// vocabulary means either an upstream vocabulary change or a stock we have no
// classification for, and both are things a caller neutralising a cross-section
// must be able to see. Bucketing them into a plausible sector would put
// unclassified names into a sector bet without saying so — which is the exact
// failure #557 is about.
func GICSSector(industryGroup string) string {
	return gicsIndustryGroupToSector[industryGroup]
}
