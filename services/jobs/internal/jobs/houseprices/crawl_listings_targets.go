package houseprices

import (
	"strconv"
	"strings"
)

// Search-results (for-sale listing) URLs for the two portals, built from the same
// CrawlTarget the suburb-median crawl uses. These are the LISTING-level pages —
// paginated lists of individual properties — as opposed to the suburb-summary
// pages that reaURL()/domainURL() (crawl_targets.go) point at.

const (
	reaOrigin    = "https://www.realestate.com.au"
	domainOrigin = "https://www.domain.com.au"
)

// domainSearchURL is a Domain for-sale search page for the suburb.
//
//	https://www.domain.com.au/sale/bondi-nsw-2026/?page=2
func (t CrawlTarget) domainSearchURL(page int) string {
	u := domainOrigin + "/sale/" + t.Suburb + "-" + strings.ToLower(t.State) + "-" + t.Postcode + "/"
	if page > 1 {
		u += "?page=" + strconv.Itoa(page)
	}
	return u
}

// reaSearchURL is a realestate.com.au buy search page for the suburb. The buy
// slug uses '+' between words (derived from Display, not the hyphenated Suburb
// slug) and encodes pagination as the /list-N path segment.
//
//	https://www.realestate.com.au/buy/in-st+kilda,+vic+3182/list-1
func (t CrawlTarget) reaSearchURL(page int) string {
	if page < 1 {
		page = 1
	}
	slug := strings.ReplaceAll(strings.ToLower(t.Display), " ", "+")
	return reaOrigin + "/buy/in-" + slug + ",+" + strings.ToLower(t.State) + "+" + t.Postcode + "/list-" + strconv.Itoa(page)
}

// portalOrigin returns the absolute origin for a source, used to absolutize
// relative listing hrefs harvested from the embedded JSON.
func portalOrigin(source string) string {
	if source == "domain" {
		return domainOrigin
	}
	return reaOrigin
}
