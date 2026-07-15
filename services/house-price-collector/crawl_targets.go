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
}

// Metro suburb catalog: a curated seed (Bondi, St Kilda, ...) PLUS an expanded set
// of the top suburbs by ABS population across the five mainland capitals. The
// expansion was generated from the ABS SAL gazetteer (population) joined to
// Australia Post postcodes, filtered to Greater-Capital-City postcode ranges.
var crawlTargets = []CrawlTarget{
	// NSW — Greater Sydney (1GSYD)
	{"bondi", "Bondi", "2026", "NSW", "1GSYD"},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD"},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD"},
	{"manly", "Manly", "2095", "NSW", "1GSYD"},
	{"newtown", "Newtown", "2042", "NSW", "1GSYD"},
	{"mosman", "Mosman", "2088", "NSW", "1GSYD"},
	{"surry-hills", "Surry Hills", "2010", "NSW", "1GSYD"},
	// VIC — Greater Melbourne (2GMEL)
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL"},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL"},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL"},
	{"richmond", "Richmond", "3121", "VIC", "2GMEL"},
	{"fitzroy", "Fitzroy", "3065", "VIC", "2GMEL"},
	{"footscray", "Footscray", "3011", "VIC", "2GMEL"},
	{"brighton", "Brighton", "3186", "VIC", "2GMEL"},
	// QLD — Greater Brisbane (3GBRI)
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI"},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI"},
	{"paddington", "Paddington", "4064", "QLD", "3GBRI"},
	{"chermside", "Chermside", "4032", "QLD", "3GBRI"},
	// SA — Greater Adelaide (4GADE)
	{"glenelg", "Glenelg", "5045", "SA", "4GADE"},
	{"norwood", "Norwood", "5067", "SA", "4GADE"},
	{"unley", "Unley", "5061", "SA", "4GADE"},
	// WA — Greater Perth (5GPER)
	{"fremantle", "Fremantle", "6160", "WA", "5GPER"},
	{"cottesloe", "Cottesloe", "6011", "WA", "5GPER"},
	{"subiaco", "Subiaco", "6008", "WA", "5GPER"},
	{"scarborough", "Scarborough", "6019", "WA", "5GPER"},

	// --- Expanded metro coverage (top suburbs by ABS population) ---
	// NSW — Greater Sydney (1GSYD) — top metro suburbs by ABS population
	{"blacktown", "Blacktown", "2148", "NSW", "1GSYD"},
	{"castle-hill", "Castle Hill", "2154", "NSW", "1GSYD"},
	{"auburn", "Auburn", "2144", "NSW", "1GSYD"},
	{"baulkham-hills", "Baulkham Hills", "2153", "NSW", "1GSYD"},
	{"bankstown", "Bankstown", "2200", "NSW", "1GSYD"},
	{"merrylands", "Merrylands", "2160", "NSW", "1GSYD"},
	{"ryde", "Ryde", "2112", "NSW", "1GSYD"},
	{"hurstville", "Hurstville", "2220", "NSW", "1GSYD"},
	{"liverpool", "Liverpool", "2170", "NSW", "1GSYD"},
	{"maroubra", "Maroubra", "2035", "NSW", "1GSYD"},
	{"randwick", "Randwick", "2031", "NSW", "1GSYD"},
	{"carlingford", "Carlingford", "2118", "NSW", "1GSYD"},
	{"quakers-hill", "Quakers Hill", "2763", "NSW", "1GSYD"},
	{"kellyville", "Kellyville", "2155", "NSW", "1GSYD"},
	{"marrickville", "Marrickville", "2204", "NSW", "1GSYD"},
	{"greenacre", "Greenacre", "2190", "NSW", "1GSYD"},
	{"campsie", "Campsie", "2194", "NSW", "1GSYD"},
	{"strathfield", "Strathfield", "2135", "NSW", "1GSYD"},
	// VIC — Greater Melbourne (2GMEL) — top metro suburbs by ABS population
	{"point-cook", "Point Cook", "3030", "VIC", "2GMEL"},
	{"craigieburn", "Craigieburn", "3064", "VIC", "2GMEL"},
	{"tarneit", "Tarneit", "3029", "VIC", "2GMEL"},
	{"melbourne", "Melbourne", "3000", "VIC", "2GMEL"},
	{"pakenham", "Pakenham", "3810", "VIC", "2GMEL"},
	{"reservoir", "Reservoir", "3073", "VIC", "2GMEL"},
	{"berwick", "Berwick", "3806", "VIC", "2GMEL"},
	{"werribee", "Werribee", "3030", "VIC", "2GMEL"},
	{"glen-waverley", "Glen Waverley", "3150", "VIC", "2GMEL"},
	{"sunbury", "Sunbury", "3429", "VIC", "2GMEL"},
	{"st-albans", "St Albans", "3021", "VIC", "2GMEL"},
	{"frankston", "Frankston", "3199", "VIC", "2GMEL"},
	{"hoppers-crossing", "Hoppers Crossing", "3029", "VIC", "2GMEL"},
	{"truganina", "Truganina", "3029", "VIC", "2GMEL"},
	{"mount-waverley", "Mount Waverley", "3149", "VIC", "2GMEL"},
	{"preston", "Preston", "3072", "VIC", "2GMEL"},
	{"rowville", "Rowville", "3178", "VIC", "2GMEL"},
	{"epping", "Epping", "3076", "VIC", "2GMEL"},
	// QLD — Greater Brisbane (3GBRI) — top metro suburbs by ABS population
	{"caboolture", "Caboolture", "4510", "QLD", "3GBRI"},
	{"morayfield", "Morayfield", "4506", "QLD", "3GBRI"},
	{"redbank-plains", "Redbank Plains", "4301", "QLD", "3GBRI"},
	{"north-lakes", "North Lakes", "4509", "QLD", "3GBRI"},
	{"forest-lake", "Forest Lake", "4078", "QLD", "3GBRI"},
	{"kallangur", "Kallangur", "4503", "QLD", "3GBRI"},
	{"narangba", "Narangba", "4504", "QLD", "3GBRI"},
	{"deception-bay", "Deception Bay", "4508", "QLD", "3GBRI"},
	{"thornlands", "Thornlands", "4164", "QLD", "3GBRI"},
	{"coorparoo", "Coorparoo", "4151", "QLD", "3GBRI"},
	{"sunnybank-hills", "Sunnybank Hills", "4109", "QLD", "3GBRI"},
	{"capalaba", "Capalaba", "4157", "QLD", "3GBRI"},
	{"calamvale", "Calamvale", "4116", "QLD", "3GBRI"},
	{"bracken-ridge", "Bracken Ridge", "4017", "QLD", "3GBRI"},
	{"the-gap", "The Gap", "4061", "QLD", "3GBRI"},
	{"springfield-lakes", "Springfield Lakes", "4300", "QLD", "3GBRI"},
	{"redland-bay", "Redland Bay", "4165", "QLD", "3GBRI"},
	{"carindale", "Carindale", "4152", "QLD", "3GBRI"},
	// SA — Greater Adelaide (4GADE) — top metro suburbs by ABS population
	{"morphett-vale", "Morphett Vale", "5162", "SA", "4GADE"},
	{"parafield-gardens", "Parafield Gardens", "5107", "SA", "4GADE"},
	{"adelaide", "Adelaide", "5000", "SA", "4GADE"},
	{"paralowie", "Paralowie", "5108", "SA", "4GADE"},
	{"prospect", "Prospect", "5082", "SA", "4GADE"},
	{"mawson-lakes", "Mawson Lakes", "5095", "SA", "4GADE"},
	{"hallett-cove", "Hallett Cove", "5158", "SA", "4GADE"},
	{"happy-valley", "Happy Valley", "5159", "SA", "4GADE"},
	{"woodcroft", "Woodcroft", "5162", "SA", "4GADE"},
	{"aberfoyle-park", "Aberfoyle Park", "5159", "SA", "4GADE"},
	{"craigmore", "Craigmore", "5114", "SA", "4GADE"},
	{"seaton", "Seaton", "5023", "SA", "4GADE"},
	{"salisbury-north", "Salisbury North", "5108", "SA", "4GADE"},
	{"aldinga-beach", "Aldinga Beach", "5173", "SA", "4GADE"},
	{"golden-grove", "Golden Grove", "5125", "SA", "4GADE"},
	{"flagstaff-hill", "Flagstaff Hill", "5159", "SA", "4GADE"},
	{"greenwith", "Greenwith", "5125", "SA", "4GADE"},
	{"magill", "Magill", "5072", "SA", "4GADE"},
	// WA — Greater Perth (5GPER) — top metro suburbs by ABS population
	{"baldivis", "Baldivis", "6171", "WA", "5GPER"},
	{"canning-vale", "Canning Vale", "6155", "WA", "5GPER"},
	{"ellenbrook", "Ellenbrook", "6069", "WA", "5GPER"},
	{"dianella", "Dianella", "6059", "WA", "5GPER"},
	{"thornlie", "Thornlie", "6108", "WA", "5GPER"},
	{"morley", "Morley", "6062", "WA", "5GPER"},
	{"gosnells", "Gosnells", "6110", "WA", "5GPER"},
	{"willetton", "Willetton", "6155", "WA", "5GPER"},
	{"byford", "Byford", "6122", "WA", "5GPER"},
	{"ballajura", "Ballajura", "6066", "WA", "5GPER"},
	{"duncraig", "Duncraig", "6023", "WA", "5GPER"},
	{"landsdale", "Landsdale", "6065", "WA", "5GPER"},
	{"rockingham", "Rockingham", "6168", "WA", "5GPER"},
	{"bayswater", "Bayswater", "6053", "WA", "5GPER"},
	{"piara-waters", "Piara Waters", "6112", "WA", "5GPER"},
	{"como", "Como", "6152", "WA", "5GPER"},
	{"halls-head", "Halls Head", "6210", "WA", "5GPER"},
	{"wellard", "Wellard", "6170", "WA", "5GPER"},
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
