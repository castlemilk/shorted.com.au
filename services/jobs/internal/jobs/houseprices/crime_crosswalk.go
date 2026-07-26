package houseprices

import "strings"

// Offence-type crosswalk — the linchpin of the crime pipeline. Every police
// jurisdiction counts offences under its own bespoke category scheme, and the
// ABS Crime Victimisation Survey (CVS, the cross-jurisdiction scaling anchor)
// uses a THIRD scheme that is prevalence-based, not ANZSOC. This file maps all
// of them onto one common set of 4 crime types.
//
// Common scheme (aligned to ABS ANZSOC groups + the openstats set):
//   break_ins       Residential unlawful entry / burglary (ANZSOC Div 07, residential)
//   violent         Assault & acts intended to cause injury (ANZSOC Div 02)
//   motor_vehicle   Motor-vehicle theft (subdiv 0811)
//   property_damage Malicious/criminal property damage (ANZSOC Div 12)
//   robbery         Robbery (Div 06) — Phase 3, defined but not yet wired.
//
// Documented ambiguities (READ BEFORE ADDING A JURISDICTION):
//  1. motor_vehicle != "steal FROM a motor vehicle". Every jurisdiction has a
//     SEPARATE theft-from-vehicle line (NSW "Steal from motor vehicle"). It is
//     NEVER summed into motor_vehicle — the single easiest crosswalk bug.
//  2. FV/DV assault IS included in `violent` (NSW: both "Domestic violence
//     related assault" and "Non-domestic violence related assault"). "Assault
//     Police" is EXCLUDED from the core — CVS "assault" is population
//     victimisation, not offences against police. The FV split stays recoverable
//     in raw police data if a future "family violence" metric is wanted.
//  3. CVS defs are PREVALENCE not incidence and are bespoke (not ANZSOC): CVS
//     "break-in" = forced entry to a residence, EXCLUDES attempts and vehicles;
//     a person victimised twice counts once. The scaler (crime_compute.go) is a
//     cross-jurisdiction NORMALISATION lever, not a claim the two count the same
//     thing. The map is labelled "adjusted to ABS CVS".

// crimeType is one of the common crime types.
type crimeType string

const (
	crimeBreakIns       crimeType = "break_ins"
	crimeViolent        crimeType = "violent"
	crimeMotorVehicle   crimeType = "motor_vehicle"
	crimePropertyDamage crimeType = "property_damage"
	crimeRobbery        crimeType = "robbery" // Phase 3
)

// coreCrimeTypes is the Phase-1 published set (robbery is Phase 3).
var coreCrimeTypes = []crimeType{crimeBreakIns, crimeViolent, crimeMotorVehicle, crimePropertyDamage}

// baseKind selects which state population base a crime type scales against in
// the victim_estimate scaler: personal crimes benchmark to persons aged 15+,
// household crimes to occupied private dwellings/households.
type baseKind int

const (
	basePersons15  baseKind = iota // CVS personal victimisation (persons 15+)
	baseHouseholds                 // CVS household victimisation (households)
)

// crimeBaseKind maps each crime type to its CVS population base.
var crimeBaseKind = map[crimeType]baseKind{
	crimeViolent:        basePersons15,
	crimeBreakIns:       baseHouseholds,
	crimeMotorVehicle:   baseHouseholds,
	crimePropertyDamage: baseHouseholds,
	crimeRobbery:        basePersons15,
}

// --- NSW (BOCSAR) crosswalk -------------------------------------------------
//
// BOCSAR "Recorded Criminal Incidents by month – by suburb" is keyed by
// (Offence category, Subcategory). The exact strings below were verified against
// SuburbData26Q1.csv (2026-Q1 release). SUM the listed lines per crime_type.

// nswSubcat is a BOCSAR (category, subcategory) pair.
type nswSubcat struct{ category, subcategory string }

// nswCrosswalk maps each BOCSAR (category, subcategory) line to a common crime
// type. Lines absent from this map are intentionally not part of any core type.
var nswCrosswalk = map[nswSubcat]crimeType{
	{"Theft", "Break and enter dwelling"}:                            crimeBreakIns,
	{"Assault", "Domestic violence related assault"}:                 crimeViolent,
	{"Assault", "Non-domestic violence related assault"}:             crimeViolent,
	{"Theft", "Motor vehicle theft"}:                                 crimeMotorVehicle,
	{"Malicious damage to property", "Malicious damage to property"}: crimePropertyDamage,
	// Phase 3 (not published yet): robbery.
	{"Robbery", "Robbery without a weapon"}:            crimeRobbery,
	{"Robbery", "Robbery with a firearm"}:              crimeRobbery,
	{"Robbery", "Robbery with a weapon not a firearm"}: crimeRobbery,
}

// nswCrimeType looks up a BOCSAR line, trimming whitespace defensively. The bool
// is false when the line is not part of any common crime type.
func nswCrimeType(category, subcategory string) (crimeType, bool) {
	ct, ok := nswCrosswalk[nswSubcat{strings.TrimSpace(category), strings.TrimSpace(subcategory)}]
	return ct, ok
}

// --- ABS CVS crosswalk ------------------------------------------------------
//
// The CVS victimisation-rate cube labels each offence block with a bespoke,
// footnoted, en-dashed string (e.g. "Break–in", "Total physical and/or
// threatened assault(d)"). normCVSLabel canonicalises those so the match is
// robust to the en-dash / footnote drift the ABS uses release-to-release.

// normCVSLabel lower-cases, replaces en/em dashes with a hyphen, strips ALL
// "(x)" footnote markers (ABS sometimes stacks them, e.g. "assault(a)(d)"), and
// collapses whitespace. cvsInlineFootnoteRe is defined in crime_abs_cvs.go.
func normCVSLabel(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("–", "-", "—", "-", "‒", "-").Replace(s)
	s = cvsInlineFootnoteRe.ReplaceAllString(s, "")
	s = strings.Join(strings.Fields(s), " ")
	return strings.TrimSpace(s)
}

// cvsCrosswalk maps a normalised CVS offence-block label to a common crime type.
// break_ins/motor_vehicle/property_damage live in the household-crime rate
// sheet (Table 30c); violent's anchor is the personal-crime sheet's "Total
// physical and/or threatened assault" (Table 27c); robbery is Table 29c (P3).
var cvsCrosswalk = map[string]crimeType{
	"break-in":                                 crimeBreakIns,
	"motor vehicle theft":                      crimeMotorVehicle,
	"malicious property damage":                crimePropertyDamage,
	"total physical and/or threatened assault": crimeViolent,
	"robbery":                                  crimeRobbery,
}

// cvsCrimeType maps a raw CVS block label to a common crime type.
func cvsCrimeType(label string) (crimeType, bool) {
	ct, ok := cvsCrosswalk[normCVSLabel(label)]
	return ct, ok
}

// cvsRSECrimeType maps an RSE-sheet block label, which prefixes the offence name
// with "RSE of " (e.g. "RSE of break–in"), to a common crime type.
func cvsRSECrimeType(label string) (crimeType, bool) {
	return cvsCrimeType(strings.TrimPrefix(normCVSLabel(label), "rse of "))
}
