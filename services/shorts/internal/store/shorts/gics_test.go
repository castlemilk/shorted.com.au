package shorts

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The 25 industry-group labels the economy pipeline pins in
// jobs/internal/jobs/economy/markets.go (industrySlugs), verified against the
// database by the 2026-07-22 probe. Duplicated here ON PURPOSE rather than
// imported: if that list changes and this one does not, the mismatch is what
// should fail, and importing it would make the two agree by construction while
// leaving real vocabulary drift unnoticed.
var pinnedIndustryGroups = []string{
	"Materials",
	"Energy",
	"Software & Services",
	"Financial Services",
	"Health Care Equipment & Services",
	"Pharmaceuticals, Biotechnology & Life Sciences",
	"Capital Goods",
	"Commercial & Professional Services",
	"Media & Entertainment",
	"Food, Beverage & Tobacco",
	"Consumer Discretionary Distribution & Retail",
	"Consumer Services",
	"Equity Real Estate Investment Trusts (REITs)",
	"Technology Hardware & Equipment",
	"Transportation",
	"Real Estate Management & Development",
	"Utilities",
	"Telecommunication Services",
	"Consumer Durables & Apparel",
	"Banks",
	"Household & Personal Products",
	"Insurance",
	"Automobiles & Components",
	"Consumer Staples Distribution & Retail",
	"Semiconductors & Semiconductor Equipment",
}

func TestGICSSectorCoversEveryPinnedGroup(t *testing.T) {
	// A partial map is the dangerous failure: the missing groups return "" and
	// look like "unclassified", so a caller neutralising on sector quietly drops
	// every stock in them — reintroducing the sector bet the field exists to
	// remove.
	for _, group := range pinnedIndustryGroups {
		require.NotEmpty(t, GICSSector(group),
			"%q is a real industry group in the database with no sector", group)
	}
	require.Len(t, gicsIndustryGroupToSector, len(pinnedIndustryGroups),
		"the map and the database's pinned vocabulary have drifted apart")
}

func TestGICSSectorProducesTheElevenSectors(t *testing.T) {
	// GICS has exactly 11 sectors. Fewer means a group was mapped into the
	// wrong parent; more means a typo created a sector that does not exist, and
	// a typo'd sector silently splits a neutralisation bucket in two.
	seen := map[string]int{}
	for _, group := range pinnedIndustryGroups {
		seen[GICSSector(group)]++
	}
	require.Len(t, seen, 11, "expected the 11 GICS sectors, got %v", keysOf(seen))

	for _, expected := range []string{
		"Energy", "Materials", "Industrials", "Consumer Discretionary",
		"Consumer Staples", "Health Care", "Financials",
		"Information Technology", "Communication Services", "Utilities",
		"Real Estate",
	} {
		require.Contains(t, seen, expected, "%q is not produced by any group", expected)
	}
}

func TestGICSSectorRefusesToGuess(t *testing.T) {
	// An unknown label means either an upstream vocabulary change or a stock we
	// have no classification for. Both must be visible. Bucketing them into a
	// plausible sector would put unclassified names into a sector bet without
	// saying so.
	for _, unknown := range []string{
		"",
		"Banks ",         // trailing space — a near-miss must not match
		"banks",          // case differs
		"Diversified Financials", // the pre-2023 name for Financial Services
		"Retailing",              // pre-2023, superseded by the two Distribution & Retail groups
		"Something New",
	} {
		require.Empty(t, GICSSector(unknown),
			"%q must not be guessed into a sector", unknown)
	}
}

func keysOf(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
