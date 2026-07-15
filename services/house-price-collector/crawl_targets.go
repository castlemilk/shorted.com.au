package main

import "strings"

// CrawlTarget is one suburb to crawl. Capital is the GCCSA region_code of the
// suburb's capital city (e.g. "1GSYD"), used to look up the TRUSTED ABS median
// that every crawled value is validated against.
type CrawlTarget struct {
	Suburb   string // url slug: "bondi", "st-kilda"
	Display  string // "Bondi"
	Postcode string // "2026"
	State    string // "NSW"
	Capital  string // GCCSA region_code: "1GSYD"
	// Dwellings is an OPTIONAL coarse dwelling/population-count hint that
	// softPageCap (crawl_listings.go) uses to size the per-suburb page cap when
	// the portal's own PageMeta is unusable. 0 == unknown -> softPageCap falls
	// back to the configured default cap (today's behaviour, unchanged). Left
	// unpopulated for the whole catalog for now — a real per-suburb ABS
	// dwelling-count backfill is a follow-up data task, not part of the
	// smart-pagination code itself; the mechanism is wired and unit-tested
	// end-to-end regardless of whether any suburb currently carries a hint.
	Dwellings int
}

// Metro suburb catalog: a curated seed (Bondi, St Kilda, ...) PLUS an expanded set
// of the top suburbs by ABS population across the five mainland capitals. The
// expansion was generated from the ABS SAL gazetteer (population) joined to
// Australia Post postcodes, filtered to Greater-Capital-City postcode ranges.
var crawlTargets = []CrawlTarget{
	// NSW — Greater Sydney (1GSYD)
	{"bondi", "Bondi", "2026", "NSW", "1GSYD", 0},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD", 0},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD", 0},
	{"manly", "Manly", "2095", "NSW", "1GSYD", 0},
	{"newtown", "Newtown", "2042", "NSW", "1GSYD", 0},
	{"mosman", "Mosman", "2088", "NSW", "1GSYD", 0},
	{"surry-hills", "Surry Hills", "2010", "NSW", "1GSYD", 0},
	// VIC — Greater Melbourne (2GMEL)
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL", 0},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL", 0},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL", 0},
	{"richmond", "Richmond", "3121", "VIC", "2GMEL", 0},
	{"fitzroy", "Fitzroy", "3065", "VIC", "2GMEL", 0},
	{"footscray", "Footscray", "3011", "VIC", "2GMEL", 0},
	{"brighton", "Brighton", "3186", "VIC", "2GMEL", 0},
	// QLD — Greater Brisbane (3GBRI)
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI", 0},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI", 0},
	{"paddington", "Paddington", "4064", "QLD", "3GBRI", 0},
	{"chermside", "Chermside", "4032", "QLD", "3GBRI", 0},
	// SA — Greater Adelaide (4GADE)
	{"glenelg", "Glenelg", "5045", "SA", "4GADE", 0},
	{"norwood", "Norwood", "5067", "SA", "4GADE", 0},
	{"unley", "Unley", "5061", "SA", "4GADE", 0},
	// WA — Greater Perth (5GPER)
	{"fremantle", "Fremantle", "6160", "WA", "5GPER", 0},
	{"cottesloe", "Cottesloe", "6011", "WA", "5GPER", 0},
	{"subiaco", "Subiaco", "6008", "WA", "5GPER", 0},
	{"scarborough", "Scarborough", "6019", "WA", "5GPER", 0},

	// --- Expanded metro coverage (top suburbs by ABS population) ---
	// NSW — Greater Sydney (1GSYD) — top metro suburbs by ABS population
	{"blacktown", "Blacktown", "2148", "NSW", "1GSYD", 0},
	{"castle-hill", "Castle Hill", "2154", "NSW", "1GSYD", 0},
	{"auburn", "Auburn", "2144", "NSW", "1GSYD", 0},
	{"baulkham-hills", "Baulkham Hills", "2153", "NSW", "1GSYD", 0},
	{"bankstown", "Bankstown", "2200", "NSW", "1GSYD", 0},
	{"merrylands", "Merrylands", "2160", "NSW", "1GSYD", 0},
	{"ryde", "Ryde", "2112", "NSW", "1GSYD", 0},
	{"hurstville", "Hurstville", "2220", "NSW", "1GSYD", 0},
	{"liverpool", "Liverpool", "2170", "NSW", "1GSYD", 0},
	{"maroubra", "Maroubra", "2035", "NSW", "1GSYD", 0},
	{"randwick", "Randwick", "2031", "NSW", "1GSYD", 0},
	{"carlingford", "Carlingford", "2118", "NSW", "1GSYD", 0},
	{"quakers-hill", "Quakers Hill", "2763", "NSW", "1GSYD", 0},
	{"kellyville", "Kellyville", "2155", "NSW", "1GSYD", 0},
	{"marrickville", "Marrickville", "2204", "NSW", "1GSYD", 0},
	{"greenacre", "Greenacre", "2190", "NSW", "1GSYD", 0},
	{"campsie", "Campsie", "2194", "NSW", "1GSYD", 0},
	{"strathfield", "Strathfield", "2135", "NSW", "1GSYD", 0},
	// VIC — Greater Melbourne (2GMEL) — top metro suburbs by ABS population
	{"point-cook", "Point Cook", "3030", "VIC", "2GMEL", 0},
	{"craigieburn", "Craigieburn", "3064", "VIC", "2GMEL", 0},
	{"tarneit", "Tarneit", "3029", "VIC", "2GMEL", 0},
	{"melbourne", "Melbourne", "3000", "VIC", "2GMEL", 0},
	{"pakenham", "Pakenham", "3810", "VIC", "2GMEL", 0},
	{"reservoir", "Reservoir", "3073", "VIC", "2GMEL", 0},
	{"berwick", "Berwick", "3806", "VIC", "2GMEL", 0},
	{"werribee", "Werribee", "3030", "VIC", "2GMEL", 0},
	{"glen-waverley", "Glen Waverley", "3150", "VIC", "2GMEL", 0},
	{"sunbury", "Sunbury", "3429", "VIC", "2GMEL", 0},
	{"st-albans", "St Albans", "3021", "VIC", "2GMEL", 0},
	{"frankston", "Frankston", "3199", "VIC", "2GMEL", 0},
	{"hoppers-crossing", "Hoppers Crossing", "3029", "VIC", "2GMEL", 0},
	{"truganina", "Truganina", "3029", "VIC", "2GMEL", 0},
	{"mount-waverley", "Mount Waverley", "3149", "VIC", "2GMEL", 0},
	{"preston", "Preston", "3072", "VIC", "2GMEL", 0},
	{"rowville", "Rowville", "3178", "VIC", "2GMEL", 0},
	{"epping", "Epping", "3076", "VIC", "2GMEL", 0},
	// QLD — Greater Brisbane (3GBRI) — top metro suburbs by ABS population
	{"caboolture", "Caboolture", "4510", "QLD", "3GBRI", 0},
	{"morayfield", "Morayfield", "4506", "QLD", "3GBRI", 0},
	{"redbank-plains", "Redbank Plains", "4301", "QLD", "3GBRI", 0},
	{"north-lakes", "North Lakes", "4509", "QLD", "3GBRI", 0},
	{"forest-lake", "Forest Lake", "4078", "QLD", "3GBRI", 0},
	{"kallangur", "Kallangur", "4503", "QLD", "3GBRI", 0},
	{"narangba", "Narangba", "4504", "QLD", "3GBRI", 0},
	{"deception-bay", "Deception Bay", "4508", "QLD", "3GBRI", 0},
	{"thornlands", "Thornlands", "4164", "QLD", "3GBRI", 0},
	{"coorparoo", "Coorparoo", "4151", "QLD", "3GBRI", 0},
	{"sunnybank-hills", "Sunnybank Hills", "4109", "QLD", "3GBRI", 0},
	{"capalaba", "Capalaba", "4157", "QLD", "3GBRI", 0},
	{"calamvale", "Calamvale", "4116", "QLD", "3GBRI", 0},
	{"bracken-ridge", "Bracken Ridge", "4017", "QLD", "3GBRI", 0},
	{"the-gap", "The Gap", "4061", "QLD", "3GBRI", 0},
	{"springfield-lakes", "Springfield Lakes", "4300", "QLD", "3GBRI", 0},
	{"redland-bay", "Redland Bay", "4165", "QLD", "3GBRI", 0},
	{"carindale", "Carindale", "4152", "QLD", "3GBRI", 0},
	// SA — Greater Adelaide (4GADE) — top metro suburbs by ABS population
	{"morphett-vale", "Morphett Vale", "5162", "SA", "4GADE", 0},
	{"parafield-gardens", "Parafield Gardens", "5107", "SA", "4GADE", 0},
	{"adelaide", "Adelaide", "5000", "SA", "4GADE", 0},
	{"paralowie", "Paralowie", "5108", "SA", "4GADE", 0},
	{"prospect", "Prospect", "5082", "SA", "4GADE", 0},
	{"mawson-lakes", "Mawson Lakes", "5095", "SA", "4GADE", 0},
	{"hallett-cove", "Hallett Cove", "5158", "SA", "4GADE", 0},
	{"happy-valley", "Happy Valley", "5159", "SA", "4GADE", 0},
	{"woodcroft", "Woodcroft", "5162", "SA", "4GADE", 0},
	{"aberfoyle-park", "Aberfoyle Park", "5159", "SA", "4GADE", 0},
	{"craigmore", "Craigmore", "5114", "SA", "4GADE", 0},
	{"seaton", "Seaton", "5023", "SA", "4GADE", 0},
	{"salisbury-north", "Salisbury North", "5108", "SA", "4GADE", 0},
	{"aldinga-beach", "Aldinga Beach", "5173", "SA", "4GADE", 0},
	{"golden-grove", "Golden Grove", "5125", "SA", "4GADE", 0},
	{"flagstaff-hill", "Flagstaff Hill", "5159", "SA", "4GADE", 0},
	{"greenwith", "Greenwith", "5125", "SA", "4GADE", 0},
	{"magill", "Magill", "5072", "SA", "4GADE", 0},
	// WA — Greater Perth (5GPER) — top metro suburbs by ABS population
	{"baldivis", "Baldivis", "6171", "WA", "5GPER", 0},
	{"canning-vale", "Canning Vale", "6155", "WA", "5GPER", 0},
	{"ellenbrook", "Ellenbrook", "6069", "WA", "5GPER", 0},
	{"dianella", "Dianella", "6059", "WA", "5GPER", 0},
	{"thornlie", "Thornlie", "6108", "WA", "5GPER", 0},
	{"morley", "Morley", "6062", "WA", "5GPER", 0},
	{"gosnells", "Gosnells", "6110", "WA", "5GPER", 0},
	{"willetton", "Willetton", "6155", "WA", "5GPER", 0},
	{"byford", "Byford", "6122", "WA", "5GPER", 0},
	{"ballajura", "Ballajura", "6066", "WA", "5GPER", 0},
	{"duncraig", "Duncraig", "6023", "WA", "5GPER", 0},
	{"landsdale", "Landsdale", "6065", "WA", "5GPER", 0},
	{"rockingham", "Rockingham", "6168", "WA", "5GPER", 0},
	{"bayswater", "Bayswater", "6053", "WA", "5GPER", 0},
	{"piara-waters", "Piara Waters", "6112", "WA", "5GPER", 0},
	{"como", "Como", "6152", "WA", "5GPER", 0},
	{"halls-head", "Halls Head", "6210", "WA", "5GPER", 0},
	{"wellard", "Wellard", "6170", "WA", "5GPER", 0},
}

func (t CrawlTarget) reaURL() string {
	return "https://www.realestate.com.au/neighbourhoods/" + t.Suburb + "-" + t.Postcode + "-" + strings.ToLower(t.State)
}

func (t CrawlTarget) domainURL() string {
	return "https://www.domain.com.au/suburb-profile/" + t.Suburb + "-" + strings.ToLower(t.State) + "-" + t.Postcode
}

// regionCode is the canonical house_price_regions key for a suburb.
func (t CrawlTarget) regionCode() string {
	return "SUBURB:" + t.State + "-" + t.Postcode + "-" + strings.ToUpper(t.Suburb)
}

func (t CrawlTarget) regionName() string {
	return t.Display + ", " + t.State + " " + t.Postcode
}
