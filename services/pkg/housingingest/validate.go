package housingingest

import (
	"fmt"
	"math"
	"strings"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

func checkStr(field, v string, max int) error {
	if len(v) > max {
		return fmt.Errorf("%s exceeds %d bytes", field, max)
	}
	return nil
}

func checkRequired(field, v string, max int) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("%s is required", field)
	}
	return checkStr(field, v, max)
}

// ValidateListing checks one listing against the caps above and against the sweep's
// source. prefix names the field path in an error ("listings[3]." on the server, "" on
// the rig). The returned text is the server's InvalidArgument message, so both ends
// report the same reason.
func ValidateListing(prefix string, l *pb.Listing, src string) error {
	field := func(name string) string { return prefix + name }
	if l.Source != src {
		return fmt.Errorf("%s must equal the request source", field("source"))
	}
	if err := checkRequired(field("listing_id"), l.ListingId, MaxListingIDBytes); err != nil {
		return err
	}
	for _, c := range []struct {
		name string
		v    string
		max  int
	}{
		{"listing_url", l.ListingUrl, MaxURLBytes},
		{"display_addr", l.DisplayAddr, MaxAddressBytes},
		{"suburb", l.Suburb, MaxSuburbBytes},
		{"state", l.State, MaxStateBytes},
		{"postcode", l.Postcode, MaxPostcodeBytes},
		{"address_key", l.AddressKey, MaxAddressBytes},
		{"property_type", l.PropertyType, MaxPropertyBytes},
		{"price_display", l.PriceDisplay, MaxPriceTextBytes},
		{"price_kind", l.PriceKind, MaxKindBytes},
		{"agency_id", l.AgencyId, MaxAgencyIDBytes},
		{"agency_name", l.AgencyName, MaxAgencyNameBytes},
	} {
		if err := checkStr(field(c.name), c.v, c.max); err != nil {
			return err
		}
	}
	if !ValidListingStatus[l.Status] {
		return fmt.Errorf("%s is not a known status", field("status"))
	}
	if len(l.Status) > MaxStatusBytes {
		return fmt.Errorf("%s exceeds %d bytes", field("status"), MaxStatusBytes)
	}
	if !ValidPriceKind[l.PriceKind] {
		return fmt.Errorf("%s is not a known price kind", field("price_kind"))
	}
	if len(l.AgentNames) > MaxAgentNames {
		return fmt.Errorf("%s holds at most %d names", field("agent_names"), MaxAgentNames)
	}
	for _, n := range l.AgentNames {
		if err := checkStr(field("agent_names[]"), n, MaxAgentNameBytes); err != nil {
			return err
		}
	}
	for name, v := range map[string]*float64{
		"price_low":     l.PriceLow,
		"price_high":    l.PriceHigh,
		"land_size_sqm": l.LandSizeSqm,
	} {
		if v == nil {
			continue
		}
		if math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 {
			return fmt.Errorf("%s must be a finite, non-negative number", field(name))
		}
	}
	if l.LandSizeSqm != nil && *l.LandSizeSqm > MaxLandSizeSqm {
		return fmt.Errorf("%s is out of range", field("land_size_sqm"))
	}
	if l.Lat != nil && (math.IsNaN(*l.Lat) || *l.Lat < -90 || *l.Lat > 90) {
		return fmt.Errorf("%s is out of range", field("lat"))
	}
	if l.Lng != nil && (math.IsNaN(*l.Lng) || *l.Lng < -180 || *l.Lng > 180) {
		return fmt.Errorf("%s is out of range", field("lng"))
	}
	for name, v := range map[string]*int32{
		"bedrooms":   l.Bedrooms,
		"bathrooms":  l.Bathrooms,
		"car_spaces": l.CarSpaces,
	} {
		if v != nil && (*v < 0 || *v > MaxBedroomsValue) {
			return fmt.Errorf("%s is out of range", field(name))
		}
	}
	return nil
}
