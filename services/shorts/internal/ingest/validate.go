package ingest

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// Limits on a PushSweep. The body cap (4 MiB) is enforced by the handler's
// WithReadMaxBytes; these are the per-sweep and per-field caps behind it.
const (
	MaxListingsPerSweep = 2000
	MaxPagesPerSweep    = 50
	maxKeyBytes         = 300
	maxJobIDBytes       = 128
	maxAttempt          = 10000
	maxSuburbBytes      = 100
	maxStateBytes       = 10
	maxPostcodeBytes    = 10
	maxListingIDBytes   = 200
	maxAddressBytes     = 300
	maxURLBytes         = 2048
	maxPropertyBytes    = 100
	maxPriceTextBytes   = 200
	maxKindBytes        = 20
	maxStatusBytes      = 20
	maxAgencyIDBytes    = 100
	maxAgencyNameBytes  = 200
	maxAgentNames       = 20
	maxAgentNameBytes   = 200
	maxRevisionBytes    = 100
	maxCycleIDBytes     = 128
	maxCountValue       = 1_000_000
	maxBedroomsValue    = 100
	maxLandSizeSqm      = 10_000_000
)

// Enum vocabularies. Values are the normalized strings housingcrawl reads.
var (
	validListingStatus = map[string]bool{"": true, "for_sale": true, "under_offer": true, "sold": true, "withdrawn": true}
	validPriceKind     = map[string]bool{
		"": true, "fixed": true, "range_low": true, "range_high": true,
		"offers_over": true, "auction": true, "poa": true, "unknown": true,
	}
	validCycleOutcome = map[string]bool{
		"ok": true, "blocked": true, "partial": true, "rewarm": true,
		"error": true, "deferred": true, "cancelled": true, "failed": true,
	}
)

// validJobID reports whether id matches [A-Za-z0-9._:-]{1,128}. The check runs
// before the id is logged or used as a key.
func validJobID(id string) bool {
	if len(id) < 1 || len(id) > maxJobIDBytes {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == ':', c == '-':
		default:
			return false
		}
	}
	return true
}

// sourceName is the lowercase portal name the idempotency key and the store use.
func sourceName(s pb.Source) string {
	switch s {
	case pb.Source_SOURCE_REA:
		return "rea"
	case pb.Source_SOURCE_DOMAIN:
		return "domain"
	default:
		return ""
	}
}

// invalid is an InvalidArgument whose message names the field, never its value.
func invalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

// checkStr enforces a byte cap on one string field.
func checkStr(field, v string, max int) error {
	if len(v) > max {
		return invalid("%s exceeds %d bytes", field, max)
	}
	return nil
}

// checkRequired enforces a non-empty string within a byte cap.
func checkRequired(field, v string, max int) error {
	if strings.TrimSpace(v) == "" {
		return invalid("%s is required", field)
	}
	return checkStr(field, v, max)
}

// validateEnvelope checks everything about a PushSweep that does not depend on the
// database: the contract version, the idempotency key's shape, the enums, the
// target, the page metadata and every listing. It returns the first failure.
//
// The contract check is FailedPrecondition, not InvalidArgument: the request is
// well formed, but the collector is too old to be applied, and a rig reads that
// as "upgrade", not "fix this payload".
func validateEnvelope(msg *pb.PushSweepRequest, minContract int32) error {
	if msg.ContractVersion < minContract {
		return connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("contract_too_old: contract_version %d is below the minimum %d", msg.ContractVersion, minContract))
	}
	// job_id is checked against a closed alphabet before anything uses it: it is
	// logged, it is a database key, and it is part of the idempotency key.
	if !validJobID(msg.JobId) {
		return invalid("job_id must match [A-Za-z0-9._:-]{1,%d}", maxJobIDBytes)
	}
	if msg.Attempt < 1 || msg.Attempt > maxAttempt {
		return invalid("attempt must be between 1 and %d", maxAttempt)
	}
	src := sourceName(msg.Source)
	if src == "" {
		return invalid("source must be SOURCE_REA or SOURCE_DOMAIN")
	}
	// The key is exactly "<job_id>:<attempt>:<source>". A key that disagrees with
	// its own fields would let two different sweeps share a receipt.
	want := fmt.Sprintf("%s:%d:%s", msg.JobId, msg.Attempt, src)
	if msg.IdempotencyKey == "" {
		return invalid("idempotency_key is required")
	}
	if len(msg.IdempotencyKey) > maxKeyBytes {
		return invalid("idempotency_key exceeds %d bytes", maxKeyBytes)
	}
	if msg.IdempotencyKey != want {
		return invalid("idempotency_key must be <job_id>:<attempt>:<source>")
	}
	switch msg.Status {
	case pb.SweepStatus_SWEEP_STATUS_COMPLETE, pb.SweepStatus_SWEEP_STATUS_PARTIAL, pb.SweepStatus_SWEEP_STATUS_BLOCKED:
	default:
		return invalid("status must be COMPLETE, PARTIAL or BLOCKED")
	}
	if msg.Target == nil {
		return invalid("target is required")
	}
	if err := checkRequired("target.suburb", msg.Target.Suburb, maxSuburbBytes); err != nil {
		return err
	}
	if err := checkRequired("target.state", msg.Target.State, maxStateBytes); err != nil {
		return err
	}
	if err := checkRequired("target.postcode", msg.Target.Postcode, maxPostcodeBytes); err != nil {
		return err
	}
	if msg.Pages < 0 || msg.Pages > MaxPagesPerSweep {
		return invalid("pages must be between 0 and %d", MaxPagesPerSweep)
	}
	if pm := msg.PageMeta; pm != nil {
		for name, v := range map[string]int32{
			"page_meta.total_results":     pm.TotalResults,
			"page_meta.total_pages":       pm.TotalPages,
			"page_meta.page_size":         pm.PageSize,
			"page_meta.on_target_results": pm.OnTargetResults,
		} {
			if v < 0 || v > maxCountValue {
				return invalid("%s must be between 0 and %d", name, maxCountValue)
			}
		}
	}
	if len(msg.Listings) > MaxListingsPerSweep {
		return invalid("a sweep carries at most %d listings", MaxListingsPerSweep)
	}
	if err := checkStr("collector_revision", msg.CollectorRevision, maxRevisionBytes); err != nil {
		return err
	}
	for i, l := range msg.Listings {
		if err := validateListing(i, l, src); err != nil {
			return err
		}
	}
	return nil
}

// validateListing checks one listing's caps, enums and numbers. A listing whose
// source disagrees with the request is refused, because housingcrawl would refuse
// the whole sweep for it.
func validateListing(i int, l *pb.Listing, src string) error {
	field := func(name string) string { return "listings[" + strconv.Itoa(i) + "]." + name }
	if l.Source != src {
		return invalid("%s must equal the request source", field("source"))
	}
	if err := checkRequired(field("listing_id"), l.ListingId, maxListingIDBytes); err != nil {
		return err
	}
	for _, c := range []struct {
		name string
		v    string
		max  int
	}{
		{"listing_url", l.ListingUrl, maxURLBytes},
		{"display_addr", l.DisplayAddr, maxAddressBytes},
		{"suburb", l.Suburb, maxSuburbBytes},
		{"state", l.State, maxStateBytes},
		{"postcode", l.Postcode, maxPostcodeBytes},
		{"address_key", l.AddressKey, maxAddressBytes},
		{"property_type", l.PropertyType, maxPropertyBytes},
		{"price_display", l.PriceDisplay, maxPriceTextBytes},
		{"price_kind", l.PriceKind, maxKindBytes},
		{"agency_id", l.AgencyId, maxAgencyIDBytes},
		{"agency_name", l.AgencyName, maxAgencyNameBytes},
	} {
		if err := checkStr(field(c.name), c.v, c.max); err != nil {
			return err
		}
	}
	if !validListingStatus[l.Status] {
		return invalid("%s is not a known status", field("status"))
	}
	if len(l.Status) > maxStatusBytes {
		return invalid("%s exceeds %d bytes", field("status"), maxStatusBytes)
	}
	if !validPriceKind[l.PriceKind] {
		return invalid("%s is not a known price kind", field("price_kind"))
	}
	if len(l.AgentNames) > maxAgentNames {
		return invalid("%s holds at most %d names", field("agent_names"), maxAgentNames)
	}
	for _, n := range l.AgentNames {
		if err := checkStr(field("agent_names[]"), n, maxAgentNameBytes); err != nil {
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
			return invalid("%s must be a finite, non-negative number", field(name))
		}
	}
	if l.LandSizeSqm != nil && *l.LandSizeSqm > maxLandSizeSqm {
		return invalid("%s is out of range", field("land_size_sqm"))
	}
	if l.Lat != nil && (math.IsNaN(*l.Lat) || *l.Lat < -90 || *l.Lat > 90) {
		return invalid("%s is out of range", field("lat"))
	}
	if l.Lng != nil && (math.IsNaN(*l.Lng) || *l.Lng < -180 || *l.Lng > 180) {
		return invalid("%s is out of range", field("lng"))
	}
	for name, v := range map[string]*int32{
		"bedrooms":   l.Bedrooms,
		"bathrooms":  l.Bathrooms,
		"car_spaces": l.CarSpaces,
	} {
		if v != nil && (*v < 0 || *v > maxBedroomsValue) {
			return invalid("%s is out of range", field(name))
		}
	}
	return nil
}

// validateCycle checks a ReportCycle request.
func validateCycle(msg *pb.ReportCycleRequest) error {
	if err := checkRequired("cycle_id", msg.CycleId, maxCycleIDBytes); err != nil {
		return err
	}
	if !validCycleOutcome[msg.Outcome] {
		return invalid("outcome is not a known cycle outcome")
	}
	if msg.ExitCode < 0 || msg.ExitCode > 255 {
		return invalid("exit_code must be between 0 and 255")
	}
	if c := msg.Counts; c != nil {
		for name, v := range map[string]int32{
			"suburbs_selected": c.SuburbsSelected,
			"suburbs_done":     c.SuburbsDone,
			"listings_touched": c.ListingsTouched,
			"events_written":   c.EventsWritten,
			"blocked_count":    c.BlockedCount,
		} {
			if v < 0 || v > maxCountValue {
				return invalid("counts.%s must be between 0 and %d", name, maxCountValue)
			}
		}
	}
	return nil
}

// errIsInvalid reports whether err came from a validation check above. Tests use it.
func errIsInvalid(err error) bool {
	var ce *connect.Error
	return errors.As(err, &ce) && ce.Code() == connect.CodeInvalidArgument
}
