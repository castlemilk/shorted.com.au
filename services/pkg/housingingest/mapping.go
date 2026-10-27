// Package housingingest holds the wire-side half of the housing crawl ingest
// contract: the mapping between the CrawlIngestService protobuf messages and the
// store's types in services/pkg/housingcrawl, plus the contract version both ends
// agree on. The server (services/shorts/internal/ingest) and the rig collector
// (services/house-price-collector) both import it, so the two directions of the
// mapping live in one place and cannot drift apart. See
// docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md, "Ingest API".
package housingingest

import (
	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// ContractVersion is the PushSweepRequest.contract_version this build sends, and the
// version the server's minimum (ProbeAuthResponse.min_contract_version) is compared
// against. Bump it when the request's meaning changes, not for additive fields.
const ContractVersion int32 = 1

// SourceName is the lowercase portal name the idempotency key and the store use.
// An unknown enum yields "".
func SourceName(s pb.Source) string {
	switch s {
	case pb.Source_SOURCE_REA:
		return "rea"
	case pb.Source_SOURCE_DOMAIN:
		return "domain"
	default:
		return ""
	}
}

// SourceEnum is the inverse of SourceName. An unknown name yields SOURCE_UNSPECIFIED.
func SourceEnum(name string) pb.Source {
	switch name {
	case "rea":
		return pb.Source_SOURCE_REA
	case "domain":
		return pb.Source_SOURCE_DOMAIN
	default:
		return pb.Source_SOURCE_UNSPECIFIED
	}
}

// StatusLib maps a request's sweep status onto the store's status. Anything that is
// not COMPLETE or PARTIAL is Blocked, which is the status that writes nothing.
func StatusLib(s pb.SweepStatus) housingcrawl.SweepStatus {
	switch s {
	case pb.SweepStatus_SWEEP_STATUS_COMPLETE:
		return housingcrawl.Complete
	case pb.SweepStatus_SWEEP_STATUS_PARTIAL:
		return housingcrawl.Partial
	default:
		return housingcrawl.Blocked
	}
}

// StatusEnum is the inverse of StatusLib for the three statuses the store has.
func StatusEnum(s housingcrawl.SweepStatus) pb.SweepStatus {
	switch s {
	case housingcrawl.Complete:
		return pb.SweepStatus_SWEEP_STATUS_COMPLETE
	case housingcrawl.Partial:
		return pb.SweepStatus_SWEEP_STATUS_PARTIAL
	default:
		return pb.SweepStatus_SWEEP_STATUS_BLOCKED
	}
}

// ToRawListings converts the wire listings into the store's type. The address key is
// left empty: housingcrawl stamps it from the canonical target, so a value the rig
// sent is never trusted (the wire field is ignored on purpose).
func ToRawListings(in []*pb.Listing) []housingcrawl.RawListing {
	out := make([]housingcrawl.RawListing, 0, len(in))
	for _, l := range in {
		out = append(out, housingcrawl.RawListing{
			Source:       l.Source,
			ListingID:    l.ListingId,
			ListingURL:   l.ListingUrl,
			DisplayAddr:  l.DisplayAddr,
			Suburb:       l.Suburb,
			State:        l.State,
			Postcode:     l.Postcode,
			Lat:          l.Lat,
			Lng:          l.Lng,
			PropertyType: l.PropertyType,
			Bedrooms:     Int16Ptr(l.Bedrooms),
			Bathrooms:    Int16Ptr(l.Bathrooms),
			CarSpaces:    Int16Ptr(l.CarSpaces),
			LandSizeSqm:  l.LandSizeSqm,
			PriceDisplay: l.PriceDisplay,
			PriceLow:     l.PriceLow,
			PriceHigh:    l.PriceHigh,
			PriceKind:    l.PriceKind,
			Status:       l.Status,
			AgencyID:     l.AgencyId,
			AgencyName:   l.AgencyName,
			AgentNames:   append([]string(nil), l.AgentNames...),
		})
	}
	return out
}

// FromRawListings is the inverse of ToRawListings: the rig's listings as the wire
// messages. AddressKey is sent as the rig stamped it. The server ignores it, so a
// round trip through ToRawListings clears it, which is the intended behaviour.
func FromRawListings(in []housingcrawl.RawListing) []*pb.Listing {
	out := make([]*pb.Listing, 0, len(in))
	for _, r := range in {
		out = append(out, &pb.Listing{
			Source:       r.Source,
			ListingId:    r.ListingID,
			ListingUrl:   r.ListingURL,
			DisplayAddr:  r.DisplayAddr,
			Suburb:       r.Suburb,
			State:        r.State,
			Postcode:     r.Postcode,
			AddressKey:   r.AddressKey,
			Lat:          r.Lat,
			Lng:          r.Lng,
			PropertyType: r.PropertyType,
			Bedrooms:     Int32Ptr(r.Bedrooms),
			Bathrooms:    Int32Ptr(r.Bathrooms),
			CarSpaces:    Int32Ptr(r.CarSpaces),
			LandSizeSqm:  r.LandSizeSqm,
			PriceDisplay: r.PriceDisplay,
			PriceLow:     r.PriceLow,
			PriceHigh:    r.PriceHigh,
			PriceKind:    r.PriceKind,
			Status:       r.Status,
			AgencyId:     r.AgencyID,
			AgencyName:   r.AgencyName,
			AgentNames:   append([]string(nil), r.AgentNames...),
		})
	}
	return out
}

// Int16Ptr narrows a wire count into the store's type. A nil stays nil. The sanitiser
// caps every count at 0 to 100, so the narrowing never truncates a real value.
func Int16Ptr(v *int32) *int16 {
	if v == nil {
		return nil
	}
	n := int16(*v)
	return &n
}

// Int32Ptr widens a store count onto the wire. A nil stays nil.
func Int32Ptr(v *int16) *int32 {
	if v == nil {
		return nil
	}
	n := int32(*v)
	return &n
}
