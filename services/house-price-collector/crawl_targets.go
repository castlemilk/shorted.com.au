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
	{"bondi", "Bondi", "2026", "NSW", "1GSYD"},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD"},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD"},
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL"},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL"},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL"},
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI"},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI"},
	{"glenelg", "Glenelg", "5045", "SA", "4GADE"},
	{"fremantle", "Fremantle", "6160", "WA", "5GPER"},
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
