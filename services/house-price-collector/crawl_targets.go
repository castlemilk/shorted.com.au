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
	// Dwellings is an OPTIONAL coarse dwelling-count hint that softPageCap
	// (crawl_listings.go) uses to size the per-suburb page cap when the
	// portal's own PageMeta is unusable. 0 == unknown -> softPageCap falls
	// back to the configured default cap. Populated for the whole catalog as
	// DWELLING-EQUIVALENTS: ABS Census 2021 SAL population (prod
	// suburb_demographics.population, matched on qualifier-stripped sal_name +
	// state) divided by 2.4 (people per dwelling), because prod's
	// dwelling_count column is NULL everywhere and softPageCap's tier
	// thresholds are calibrated for dwelling counts — feeding raw population
	// shifted ~half the catalog into the 2x tier. Regenerate the same way
	// after a census refresh.
	Dwellings int
}

// Metro suburb catalog: a curated seed (Bondi, St Kilda, ...) PLUS an expanded set
// of the top suburbs by ABS population across the five mainland capitals. The
// expansion was generated from the ABS SAL gazetteer (population) joined to
// Australia Post postcodes, filtered to Greater-Capital-City postcode ranges.
var crawlTargets = []CrawlTarget{
	// NSW — Greater Sydney (1GSYD)
	{"bondi", "Bondi", "2026", "NSW", "1GSYD", 4338},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD", 12588},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD", 10647},
	{"manly", "Manly", "2095", "NSW", "1GSYD", 6790},
	{"newtown", "Newtown", "2042", "NSW", "1GSYD", 6121},
	{"mosman", "Mosman", "2088", "NSW", "1GSYD", 11804},
	{"surry-hills", "Surry Hills", "2010", "NSW", "1GSYD", 6595},
	// VIC — Greater Melbourne (2GMEL)
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL", 8121},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL", 10373},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL", 10428},
	{"richmond", "Richmond", "3121", "VIC", "2GMEL", 11911},
	{"fitzroy", "Fitzroy", "3065", "VIC", "2GMEL", 4346},
	{"footscray", "Footscray", "3011", "VIC", "2GMEL", 7138},
	{"brighton", "Brighton", "3186", "VIC", "2GMEL", 9688},
	// QLD — Greater Brisbane (3GBRI)
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI", 5082},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI", 5232},
	{"paddington", "Paddington", "4064", "QLD", "3GBRI", 3776},
	{"chermside", "Chermside", "4032", "QLD", "3GBRI", 4761},
	// SA — Greater Adelaide (4GADE)
	{"glenelg", "Glenelg", "5045", "SA", "4GADE", 1433},
	{"norwood", "Norwood", "5067", "SA", "4GADE", 2648},
	{"unley", "Unley", "5061", "SA", "4GADE", 1665},
	// WA — Greater Perth (5GPER)
	{"fremantle", "Fremantle", "6160", "WA", "5GPER", 3855},
	{"cottesloe", "Cottesloe", "6011", "WA", "5GPER", 3229},
	{"subiaco", "Subiaco", "6008", "WA", "5GPER", 4142},
	{"scarborough", "Scarborough", "6019", "WA", "5GPER", 7335},

	// --- Expanded metro coverage (top suburbs by ABS population) ---
	// NSW — Greater Sydney (1GSYD) — top metro suburbs by ABS population
	{"blacktown", "Blacktown", "2148", "NSW", "1GSYD", 21234},
	{"castle-hill", "Castle Hill", "2154", "NSW", "1GSYD", 17031},
	{"auburn", "Auburn", "2144", "NSW", "1GSYD", 16389},
	{"baulkham-hills", "Baulkham Hills", "2153", "NSW", "1GSYD", 15590},
	{"bankstown", "Bankstown", "2200", "NSW", "1GSYD", 14555},
	{"merrylands", "Merrylands", "2160", "NSW", "1GSYD", 13530},
	{"ryde", "Ryde", "2112", "NSW", "1GSYD", 13295},
	{"hurstville", "Hurstville", "2220", "NSW", "1GSYD", 12984},
	{"liverpool", "Liverpool", "2170", "NSW", "1GSYD", 12949},
	{"maroubra", "Maroubra", "2035", "NSW", "1GSYD", 12801},
	{"randwick", "Randwick", "2031", "NSW", "1GSYD", 12060},
	{"carlingford", "Carlingford", "2118", "NSW", "1GSYD", 11685},
	{"quakers-hill", "Quakers Hill", "2763", "NSW", "1GSYD", 11622},
	{"kellyville", "Kellyville", "2155", "NSW", "1GSYD", 11255},
	{"marrickville", "Marrickville", "2204", "NSW", "1GSYD", 11071},
	{"greenacre", "Greenacre", "2190", "NSW", "1GSYD", 10964},
	{"campsie", "Campsie", "2194", "NSW", "1GSYD", 10888},
	{"strathfield", "Strathfield", "2135", "NSW", "1GSYD", 10798},
	// VIC — Greater Melbourne (2GMEL) — top metro suburbs by ABS population
	{"point-cook", "Point Cook", "3030", "VIC", "2GMEL", 27825},
	{"craigieburn", "Craigieburn", "3064", "VIC", "2GMEL", 27158},
	{"tarneit", "Tarneit", "3029", "VIC", "2GMEL", 23488},
	{"melbourne", "Melbourne", "3000", "VIC", "2GMEL", 22892},
	{"pakenham", "Pakenham", "3810", "VIC", "2GMEL", 22549},
	{"reservoir", "Reservoir", "3073", "VIC", "2GMEL", 21290},
	{"berwick", "Berwick", "3806", "VIC", "2GMEL", 20958},
	{"werribee", "Werribee", "3030", "VIC", "2GMEL", 20845},
	{"glen-waverley", "Glen Waverley", "3150", "VIC", "2GMEL", 17768},
	{"sunbury", "Sunbury", "3429", "VIC", "2GMEL", 16188},
	{"st-albans", "St Albans", "3021", "VIC", "2GMEL", 15851},
	{"frankston", "Frankston", "3199", "VIC", "2GMEL", 15555},
	{"hoppers-crossing", "Hoppers Crossing", "3029", "VIC", "2GMEL", 15507},
	{"truganina", "Truganina", "3029", "VIC", "2GMEL", 15127},
	{"mount-waverley", "Mount Waverley", "3149", "VIC", "2GMEL", 14725},
	{"preston", "Preston", "3072", "VIC", "2GMEL", 14079},
	{"rowville", "Rowville", "3178", "VIC", "2GMEL", 13988},
	{"epping", "Epping", "3076", "VIC", "2GMEL", 13954},
	// QLD — Greater Brisbane (3GBRI) — top metro suburbs by ABS population
	{"caboolture", "Caboolture", "4510", "QLD", "3GBRI", 12306},
	{"morayfield", "Morayfield", "4506", "QLD", "3GBRI", 10374},
	{"redbank-plains", "Redbank Plains", "4301", "QLD", "3GBRI", 10145},
	{"north-lakes", "North Lakes", "4509", "QLD", "3GBRI", 9596},
	{"forest-lake", "Forest Lake", "4078", "QLD", "3GBRI", 9448},
	{"kallangur", "Kallangur", "4503", "QLD", "3GBRI", 9067},
	{"narangba", "Narangba", "4504", "QLD", "3GBRI", 8712},
	{"deception-bay", "Deception Bay", "4508", "QLD", "3GBRI", 8155},
	{"thornlands", "Thornlands", "4164", "QLD", "3GBRI", 8026},
	{"coorparoo", "Coorparoo", "4151", "QLD", "3GBRI", 7555},
	{"sunnybank-hills", "Sunnybank Hills", "4109", "QLD", "3GBRI", 7535},
	{"capalaba", "Capalaba", "4157", "QLD", "3GBRI", 7501},
	{"calamvale", "Calamvale", "4116", "QLD", "3GBRI", 7498},
	{"bracken-ridge", "Bracken Ridge", "4017", "QLD", "3GBRI", 7287},
	{"the-gap", "The Gap", "4061", "QLD", "3GBRI", 7216},
	{"springfield-lakes", "Springfield Lakes", "4300", "QLD", "3GBRI", 7171},
	{"redland-bay", "Redland Bay", "4165", "QLD", "3GBRI", 7107},
	{"carindale", "Carindale", "4152", "QLD", "3GBRI", 6890},
	// SA — Greater Adelaide (4GADE) — top metro suburbs by ABS population
	{"morphett-vale", "Morphett Vale", "5162", "SA", "4GADE", 10001},
	{"parafield-gardens", "Parafield Gardens", "5107", "SA", "4GADE", 7695},
	{"adelaide", "Adelaide", "5000", "SA", "4GADE", 7584},
	{"paralowie", "Paralowie", "5108", "SA", "4GADE", 7293},
	{"prospect", "Prospect", "5082", "SA", "4GADE", 6077},
	{"mawson-lakes", "Mawson Lakes", "5095", "SA", "4GADE", 5748},
	{"hallett-cove", "Hallett Cove", "5158", "SA", "4GADE", 5213},
	{"happy-valley", "Happy Valley", "5159", "SA", "4GADE", 4758},
	{"woodcroft", "Woodcroft", "5162", "SA", "4GADE", 4719},
	{"aberfoyle-park", "Aberfoyle Park", "5159", "SA", "4GADE", 4681},
	{"craigmore", "Craigmore", "5114", "SA", "4GADE", 4560},
	{"seaton", "Seaton", "5023", "SA", "4GADE", 4532},
	{"salisbury-north", "Salisbury North", "5108", "SA", "4GADE", 4451},
	{"aldinga-beach", "Aldinga Beach", "5173", "SA", "4GADE", 4445},
	{"golden-grove", "Golden Grove", "5125", "SA", "4GADE", 4291},
	{"flagstaff-hill", "Flagstaff Hill", "5159", "SA", "4GADE", 4243},
	{"greenwith", "Greenwith", "5125", "SA", "4GADE", 4210},
	{"magill", "Magill", "5072", "SA", "4GADE", 4039},
	// WA — Greater Perth (5GPER) — top metro suburbs by ABS population
	{"baldivis", "Baldivis", "6171", "WA", "5GPER", 15707},
	{"canning-vale", "Canning Vale", "6155", "WA", "5GPER", 14377},
	{"ellenbrook", "Ellenbrook", "6069", "WA", "5GPER", 10278},
	{"dianella", "Dianella", "6059", "WA", "5GPER", 10070},
	{"thornlie", "Thornlie", "6108", "WA", "5GPER", 9860},
	{"morley", "Morley", "6062", "WA", "5GPER", 9391},
	{"gosnells", "Gosnells", "6110", "WA", "5GPER", 8812},
	{"willetton", "Willetton", "6155", "WA", "5GPER", 8026},
	{"byford", "Byford", "6122", "WA", "5GPER", 7866},
	{"ballajura", "Ballajura", "6066", "WA", "5GPER", 7691},
	{"duncraig", "Duncraig", "6023", "WA", "5GPER", 6659},
	{"landsdale", "Landsdale", "6065", "WA", "5GPER", 6417},
	{"rockingham", "Rockingham", "6168", "WA", "5GPER", 6380},
	{"bayswater", "Bayswater", "6053", "WA", "5GPER", 6370},
	{"piara-waters", "Piara Waters", "6112", "WA", "5GPER", 6262},
	{"como", "Como", "6152", "WA", "5GPER", 6161},
	{"halls-head", "Halls Head", "6210", "WA", "5GPER", 6031},
	{"wellard", "Wellard", "6170", "WA", "5GPER", 5886},
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
