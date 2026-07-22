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
	// back to the configured default cap. Populated for the whole catalog from
	// ABS Census 2021 SAL population (prod suburb_demographics.population,
	// matched on qualifier-stripped sal_name + state; dwelling_count is NULL in
	// prod, and softPageCap's coarse thresholds are calibrated for either
	// scale). Regenerate the same way after a census refresh.
	Dwellings int
}

// Metro suburb catalog: a curated seed (Bondi, St Kilda, ...) PLUS an expanded set
// of the top suburbs by ABS population across the five mainland capitals. The
// expansion was generated from the ABS SAL gazetteer (population) joined to
// Australia Post postcodes, filtered to Greater-Capital-City postcode ranges.
var crawlTargets = []CrawlTarget{
	// NSW — Greater Sydney (1GSYD)
	{"bondi", "Bondi", "2026", "NSW", "1GSYD", 10411},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD", 30211},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD", 25553},
	{"manly", "Manly", "2095", "NSW", "1GSYD", 16296},
	{"newtown", "Newtown", "2042", "NSW", "1GSYD", 14690},
	{"mosman", "Mosman", "2088", "NSW", "1GSYD", 28329},
	{"surry-hills", "Surry Hills", "2010", "NSW", "1GSYD", 15828},
	// VIC — Greater Melbourne (2GMEL)
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL", 19490},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL", 24896},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL", 25028},
	{"richmond", "Richmond", "3121", "VIC", "2GMEL", 28587},
	{"fitzroy", "Fitzroy", "3065", "VIC", "2GMEL", 10431},
	{"footscray", "Footscray", "3011", "VIC", "2GMEL", 17131},
	{"brighton", "Brighton", "3186", "VIC", "2GMEL", 23252},
	// QLD — Greater Brisbane (3GBRI)
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI", 12197},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI", 12556},
	{"paddington", "Paddington", "4064", "QLD", "3GBRI", 9063},
	{"chermside", "Chermside", "4032", "QLD", "3GBRI", 11426},
	// SA — Greater Adelaide (4GADE)
	{"glenelg", "Glenelg", "5045", "SA", "4GADE", 3440},
	{"norwood", "Norwood", "5067", "SA", "4GADE", 6354},
	{"unley", "Unley", "5061", "SA", "4GADE", 3997},
	// WA — Greater Perth (5GPER)
	{"fremantle", "Fremantle", "6160", "WA", "5GPER", 9251},
	{"cottesloe", "Cottesloe", "6011", "WA", "5GPER", 7750},
	{"subiaco", "Subiaco", "6008", "WA", "5GPER", 9940},
	{"scarborough", "Scarborough", "6019", "WA", "5GPER", 17605},

	// --- Expanded metro coverage (top suburbs by ABS population) ---
	// NSW — Greater Sydney (1GSYD) — top metro suburbs by ABS population
	{"blacktown", "Blacktown", "2148", "NSW", "1GSYD", 50961},
	{"castle-hill", "Castle Hill", "2154", "NSW", "1GSYD", 40874},
	{"auburn", "Auburn", "2144", "NSW", "1GSYD", 39333},
	{"baulkham-hills", "Baulkham Hills", "2153", "NSW", "1GSYD", 37415},
	{"bankstown", "Bankstown", "2200", "NSW", "1GSYD", 34933},
	{"merrylands", "Merrylands", "2160", "NSW", "1GSYD", 32472},
	{"ryde", "Ryde", "2112", "NSW", "1GSYD", 31907},
	{"hurstville", "Hurstville", "2220", "NSW", "1GSYD", 31162},
	{"liverpool", "Liverpool", "2170", "NSW", "1GSYD", 31078},
	{"maroubra", "Maroubra", "2035", "NSW", "1GSYD", 30722},
	{"randwick", "Randwick", "2031", "NSW", "1GSYD", 28943},
	{"carlingford", "Carlingford", "2118", "NSW", "1GSYD", 28044},
	{"quakers-hill", "Quakers Hill", "2763", "NSW", "1GSYD", 27893},
	{"kellyville", "Kellyville", "2155", "NSW", "1GSYD", 27011},
	{"marrickville", "Marrickville", "2204", "NSW", "1GSYD", 26570},
	{"greenacre", "Greenacre", "2190", "NSW", "1GSYD", 26314},
	{"campsie", "Campsie", "2194", "NSW", "1GSYD", 26132},
	{"strathfield", "Strathfield", "2135", "NSW", "1GSYD", 25915},
	// VIC — Greater Melbourne (2GMEL) — top metro suburbs by ABS population
	{"point-cook", "Point Cook", "3030", "VIC", "2GMEL", 66781},
	{"craigieburn", "Craigieburn", "3064", "VIC", "2GMEL", 65178},
	{"tarneit", "Tarneit", "3029", "VIC", "2GMEL", 56370},
	{"melbourne", "Melbourne", "3000", "VIC", "2GMEL", 54941},
	{"pakenham", "Pakenham", "3810", "VIC", "2GMEL", 54118},
	{"reservoir", "Reservoir", "3073", "VIC", "2GMEL", 51096},
	{"berwick", "Berwick", "3806", "VIC", "2GMEL", 50298},
	{"werribee", "Werribee", "3030", "VIC", "2GMEL", 50027},
	{"glen-waverley", "Glen Waverley", "3150", "VIC", "2GMEL", 42642},
	{"sunbury", "Sunbury", "3429", "VIC", "2GMEL", 38851},
	{"st-albans", "St Albans", "3021", "VIC", "2GMEL", 38042},
	{"frankston", "Frankston", "3199", "VIC", "2GMEL", 37331},
	{"hoppers-crossing", "Hoppers Crossing", "3029", "VIC", "2GMEL", 37216},
	{"truganina", "Truganina", "3029", "VIC", "2GMEL", 36305},
	{"mount-waverley", "Mount Waverley", "3149", "VIC", "2GMEL", 35340},
	{"preston", "Preston", "3072", "VIC", "2GMEL", 33790},
	{"rowville", "Rowville", "3178", "VIC", "2GMEL", 33571},
	{"epping", "Epping", "3076", "VIC", "2GMEL", 33489},
	// QLD — Greater Brisbane (3GBRI) — top metro suburbs by ABS population
	{"caboolture", "Caboolture", "4510", "QLD", "3GBRI", 29534},
	{"morayfield", "Morayfield", "4506", "QLD", "3GBRI", 24898},
	{"redbank-plains", "Redbank Plains", "4301", "QLD", "3GBRI", 24349},
	{"north-lakes", "North Lakes", "4509", "QLD", "3GBRI", 23030},
	{"forest-lake", "Forest Lake", "4078", "QLD", "3GBRI", 22676},
	{"kallangur", "Kallangur", "4503", "QLD", "3GBRI", 21761},
	{"narangba", "Narangba", "4504", "QLD", "3GBRI", 20910},
	{"deception-bay", "Deception Bay", "4508", "QLD", "3GBRI", 19573},
	{"thornlands", "Thornlands", "4164", "QLD", "3GBRI", 19263},
	{"coorparoo", "Coorparoo", "4151", "QLD", "3GBRI", 18132},
	{"sunnybank-hills", "Sunnybank Hills", "4109", "QLD", "3GBRI", 18085},
	{"capalaba", "Capalaba", "4157", "QLD", "3GBRI", 18002},
	{"calamvale", "Calamvale", "4116", "QLD", "3GBRI", 17994},
	{"bracken-ridge", "Bracken Ridge", "4017", "QLD", "3GBRI", 17488},
	{"the-gap", "The Gap", "4061", "QLD", "3GBRI", 17318},
	{"springfield-lakes", "Springfield Lakes", "4300", "QLD", "3GBRI", 17211},
	{"redland-bay", "Redland Bay", "4165", "QLD", "3GBRI", 17056},
	{"carindale", "Carindale", "4152", "QLD", "3GBRI", 16535},
	// SA — Greater Adelaide (4GADE) — top metro suburbs by ABS population
	{"morphett-vale", "Morphett Vale", "5162", "SA", "4GADE", 24002},
	{"parafield-gardens", "Parafield Gardens", "5107", "SA", "4GADE", 18467},
	{"adelaide", "Adelaide", "5000", "SA", "4GADE", 18202},
	{"paralowie", "Paralowie", "5108", "SA", "4GADE", 17504},
	{"prospect", "Prospect", "5082", "SA", "4GADE", 14584},
	{"mawson-lakes", "Mawson Lakes", "5095", "SA", "4GADE", 13794},
	{"hallett-cove", "Hallett Cove", "5158", "SA", "4GADE", 12512},
	{"happy-valley", "Happy Valley", "5159", "SA", "4GADE", 11420},
	{"woodcroft", "Woodcroft", "5162", "SA", "4GADE", 11326},
	{"aberfoyle-park", "Aberfoyle Park", "5159", "SA", "4GADE", 11234},
	{"craigmore", "Craigmore", "5114", "SA", "4GADE", 10943},
	{"seaton", "Seaton", "5023", "SA", "4GADE", 10877},
	{"salisbury-north", "Salisbury North", "5108", "SA", "4GADE", 10683},
	{"aldinga-beach", "Aldinga Beach", "5173", "SA", "4GADE", 10667},
	{"golden-grove", "Golden Grove", "5125", "SA", "4GADE", 10299},
	{"flagstaff-hill", "Flagstaff Hill", "5159", "SA", "4GADE", 10184},
	{"greenwith", "Greenwith", "5125", "SA", "4GADE", 10103},
	{"magill", "Magill", "5072", "SA", "4GADE", 9693},
	// WA — Greater Perth (5GPER) — top metro suburbs by ABS population
	{"baldivis", "Baldivis", "6171", "WA", "5GPER", 37697},
	{"canning-vale", "Canning Vale", "6155", "WA", "5GPER", 34504},
	{"ellenbrook", "Ellenbrook", "6069", "WA", "5GPER", 24668},
	{"dianella", "Dianella", "6059", "WA", "5GPER", 24169},
	{"thornlie", "Thornlie", "6108", "WA", "5GPER", 23665},
	{"morley", "Morley", "6062", "WA", "5GPER", 22539},
	{"gosnells", "Gosnells", "6110", "WA", "5GPER", 21149},
	{"willetton", "Willetton", "6155", "WA", "5GPER", 19262},
	{"byford", "Byford", "6122", "WA", "5GPER", 18878},
	{"ballajura", "Ballajura", "6066", "WA", "5GPER", 18459},
	{"duncraig", "Duncraig", "6023", "WA", "5GPER", 15982},
	{"landsdale", "Landsdale", "6065", "WA", "5GPER", 15401},
	{"rockingham", "Rockingham", "6168", "WA", "5GPER", 15312},
	{"bayswater", "Bayswater", "6053", "WA", "5GPER", 15288},
	{"piara-waters", "Piara Waters", "6112", "WA", "5GPER", 15029},
	{"como", "Como", "6152", "WA", "5GPER", 14786},
	{"halls-head", "Halls Head", "6210", "WA", "5GPER", 14474},
	{"wellard", "Wellard", "6170", "WA", "5GPER", 14127},
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
