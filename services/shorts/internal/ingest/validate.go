package ingest

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
)

// Limits on a PushSweep. The body cap (4 MiB) is enforced by the handler's
// WithReadMaxBytes; these are the per-sweep and per-field caps behind it.
// The caps live in services/pkg/housingingest, where the rig sanitises to the same values.
const (
	MaxListingsPerSweep = housingingest.MaxListingsPerSweep
	MaxPagesPerSweep    = housingingest.MaxPagesPerSweep
	maxKeyBytes         = housingingest.MaxKeyBytes
	maxJobIDBytes       = housingingest.MaxJobIDBytes
	maxAttempt          = housingingest.MaxAttempt
	maxSuburbBytes      = housingingest.MaxSuburbBytes
	maxStateBytes       = housingingest.MaxStateBytes
	maxPostcodeBytes    = housingingest.MaxPostcodeBytes
	maxListingIDBytes   = housingingest.MaxListingIDBytes
	maxAddressBytes     = housingingest.MaxAddressBytes
	maxURLBytes         = housingingest.MaxURLBytes
	maxPropertyBytes    = housingingest.MaxPropertyBytes
	maxPriceTextBytes   = housingingest.MaxPriceTextBytes
	maxKindBytes        = housingingest.MaxKindBytes
	maxStatusBytes      = housingingest.MaxStatusBytes
	maxAgencyIDBytes    = housingingest.MaxAgencyIDBytes
	maxAgencyNameBytes  = housingingest.MaxAgencyNameBytes
	maxAgentNames       = housingingest.MaxAgentNames
	maxAgentNameBytes   = housingingest.MaxAgentNameBytes
	maxRevisionBytes    = housingingest.MaxRevisionBytes
	maxCycleIDBytes     = housingingest.MaxCycleIDBytes
	maxCountValue       = housingingest.MaxCountValue
	maxBedroomsValue    = housingingest.MaxBedroomsValue
	maxLandSizeSqm      = housingingest.MaxLandSizeSqm
)

// Enum vocabularies. Values are the normalized strings housingcrawl reads.
var (
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
func sourceName(s pb.Source) string { return housingingest.SourceName(s) }

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
	// A listing_id may appear once per request. A repeated copy used to be counted as an
	// existing listing twice over, so eight real price moves among nine stored listings
	// could be padded below the quarantine line with copies of an unchanged listing. The
	// request is refused whole, and nothing is written.
	seen := make(map[string]struct{}, len(msg.Listings))
	for i, l := range msg.Listings {
		if _, dup := seen[l.ListingId]; dup {
			return invalid("listings[%d].listing_id repeats an earlier listing in this request", i)
		}
		seen[l.ListingId] = struct{}{}
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
	if err := housingingest.ValidateListing("listings["+strconv.Itoa(i)+"].", l, src); err != nil {
		return invalid("%s", err.Error())
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
