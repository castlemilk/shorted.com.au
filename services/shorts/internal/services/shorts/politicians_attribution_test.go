package shorts

import "testing"

func TestAttributableSecondaryTextSuppressesRunOns(t *testing.T) {
	// Real strings from the loaded corpus. Each merges several item-3 property
	// rows, so no single purpose can be attached to the one resolved suburb.
	runOns := []string{
		"Residential (owned jointly with spouse) Residential (owned jointly with spouse) Investment (owned jointly with spouse) Investment (owned jointly with spouse)",
		"Residential Investment Investment Residential",
		"Residential Parliamentary Second Residence Investment",
		"Investment Residential",
		// Two merged rows where the SECOND purpose is the parliamentary-residence
		// phrase. Caught only because that phrase is a keyword in its own right.
		"Residential Parliamentary Second Residence",
	}
	for _, s := range runOns {
		if got := attributableSecondaryText(realEstateItemNo, s); got != "" {
			t.Errorf("attributableSecondaryText(3, %q) = %q, want \"\" (unattributable)", s, got)
		}
	}
}

func TestAttributableSecondaryTextKeepsSinglePurpose(t *testing.T) {
	// A single property's purpose must survive, however verbose. Suppressing
	// these would throw away the residential-vs-investment signal that makes the
	// housing surfaces worth having.
	keep := []string{
		"Residential",
		"Investment",
		// "residence" here is prose describing the ONE residential purpose, not a
		// second merged property — the reason the phrase is matched whole.
		"Residential — principal place of residence, owned jointly with spouse",
		"Residential, principal place of residence",
		"Residential (owned jointly with spouse)",
		"Vacant land",
		"Parliamentary second residence",
		"",
	}
	for _, s := range keep {
		if got := attributableSecondaryText(realEstateItemNo, s); got != s {
			t.Errorf("attributableSecondaryText(3, %q) = %q, want it unchanged", s, got)
		}
	}
}

func TestAttributableSecondaryTextOnlyGatesRealEstate(t *testing.T) {
	// Items 4 and 6 use secondary_text for activities and creditors, which have
	// no per-row pairing problem. Two bank names in one creditor cell is normal
	// and must not be blanked.
	other := "Commonwealth Bank Investment Residential"
	for _, item := range []int32{1, 2, 4, 5, 6, 7, 14} {
		if got := attributableSecondaryText(item, other); got != other {
			t.Errorf("attributableSecondaryText(%d, ...) = %q, want it unchanged", item, got)
		}
	}
	if got := attributableSecondaryText(realEstateItemNo, other); got != "" {
		t.Errorf("item 3 should still be gated, got %q", got)
	}
}
