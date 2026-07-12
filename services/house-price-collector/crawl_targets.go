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

// A tight, curated seed set — deliberately small so the default footprint stays
// low (suburb medians move monthly at most). A production run would expand this
// from an ABS suburb gazetteer.
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
