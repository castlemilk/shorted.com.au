package shorts

// Suppression of purpose text we cannot attribute to a specific property.
//
// THE DEFECT THIS GUARDS AGAINST
//
// Item 3 of the register form is a table with one row per property:
//
//	Location                                Purpose for which owned
//	House Buchanan NSW                       Residential (owned jointly with spouse)
//	Unit Kingston ACT                        Residential (owned jointly with spouse)
//	House and granny flat Kurri Kurri NSW    Investment (owned jointly with spouse)
//	Unit Nelson Bay NSW                      Investment (owned jointly with spouse)
//
// The deterministic parser groups lines into holder bands, and within a band it
// cannot yet tell a WRAPPED cell from a NEW property row — only the first row
// carries the "Self" label, so the rest read as continuations. Those four rows
// therefore collapse into one declared item whose purpose is the space-joined
// run-on "Residential (...) Residential (...) Investment (...) Investment (...)".
//
// Measured on the loaded corpus (2026-07-25): 106 of 363 non-nil item-3 rows
// (29%) merge two or more properties, and 115 (32%) carry a run-on purpose.
//
// WHY SUPPRESS RATHER THAN SHOW IT
//
// Rendering that string beside one resolved suburb asserts that all of those
// purposes attach to the property IN THAT SUBURB. For Swanson above, the Kingston
// unit would read as both residential and investment. That is a misattribution
// about a named individual, which docs/influence-editorial-standards.md rule 1
// (every figure traceable) and rule 5 (what is held, nothing more) exist to
// prevent. A blank field is honest; a run-on is not.
//
// This is deliberately a READ-PATH gate, not a data fix. The rows keep their raw
// text for audit and for the re-parse that will split them properly (the same
// Phase-3 parser work as the quarantined 47P centred-label form). When the
// splitter lands, these strings stop matching and purpose reappears with no
// change here.

import "regexp"

// realEstateItemNo is item 3, "Real estate, including the location (suburb or
// area only) and the purpose for which it is owned".
const realEstateItemNo int32 = 3

// purposeRunOnRe matches a purpose string that covers MORE THAN ONE property.
//
// The register's purpose vocabulary is small and repetitive ("Residential",
// "Investment", "Business", "Farming", "Vacant land", "Holiday"). Two purpose
// keywords in one cell means the parser merged rows: a single property has one
// purpose. Matching on repetition rather than on length is what keeps a long but
// single-property purpose ("Residential — principal place of residence, owned
// jointly with spouse") readable.
//
// "parliamentary second residence" is matched as a WHOLE PHRASE, never as a bare
// "residence". A bare alternative would fire on "principal place of residence",
// which is one property's purpose spelled out — suppressing that would be the
// gate destroying good data to catch a merge that never happened.
const purposeKeyword = `(residential|investment|business|commercial|farm\w*|holiday|vacant|rental|industrial|parliamentary second residence)`

var purposeRunOnRe = regexp.MustCompile(`(?i)\b` + purposeKeyword + `\b.*\b` + purposeKeyword + `\b`)

// attributableSecondaryText returns the purpose only when it demonstrably
// belongs to one property.
//
// Applies to item 3 alone. Other items use secondary_text for things with no
// per-row pairing problem — item 6's creditor, item 4's activities — and
// blanking those would lose good data for no editorial gain.
func attributableSecondaryText(itemNo int32, secondary string) string {
	if itemNo != realEstateItemNo {
		return secondary
	}
	if purposeRunOnRe.MatchString(secondary) {
		return ""
	}
	return secondary
}
