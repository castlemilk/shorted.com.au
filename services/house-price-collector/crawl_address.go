package main

import (
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// slug, addressKey: the listing and property tiers key addresses through the store
// (housingcrawl.AddressKey). These adapters keep the collector call sites unchanged.

// slug lowercases s and collapses non-alphanumeric runs to a single dash.
func slug(s string) string {
	return housingcrawl.Slug(s)
}

// addressKey derives the stable cross-portal address identity. See housingcrawl.AddressKey.
func addressKey(displayAddr, suburb, state, postcode string) string {
	return housingcrawl.AddressKey(displayAddr, suburb, state, postcode)
}

// streetPart strips the suburb suffix off a portal display address. See
// housingcrawl.StreetPart.
func streetPart(displayAddr, suburb string) string {
	return housingcrawl.StreetPart(displayAddr, suburb)
}
