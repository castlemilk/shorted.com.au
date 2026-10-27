package ingest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// errDryRun is the guard's answer for a dry run. It stops the sweep before commit,
// and the counts it produced are still returned.
var errDryRun = errors.New("dry run: nothing committed")

// Quarantine reasons. They go into crawl_ingest_quarantine and the warn log.
const (
	reasonPriceMoves = "price_moves_over_threshold"
	reasonDelists    = "delists_over_threshold"
)

// quarantineError is the guard's refusal. It is wrapped by ApplySweep, so
// errors.As finds it.
type quarantineError struct {
	reason string
	stats  quarantineStats
}

func (e *quarantineError) Error() string { return "quarantined: " + e.reason }

// ingestRules are the diff thresholds an ingest sweep is applied with. They are the
// collector's defaults plus the 12-hour MinDelistInterval, which the collector does
// not use. The owner's rule is that a re-swept job cannot speed up delisting.
func ingestRules() housingcrawl.Config {
	return housingcrawl.Config{
		DelistGrace:       2,
		NoiseAbs:          5000,
		NoisePct:          0.005,
		MinDelistInterval: 12 * time.Hour,
	}
}

// quarantineCheck holds a sweep back when either trip holds:
//
//	(a) more than PriceFraction of the listings that already existed moved their
//	    price by more than 10%;
//	(b) the sweep would delist more than max(DelistFraction × active listings in
//	    the region before the sweep, DelistFloor).
//
// Both are strict: a value exactly on the threshold passes.
func (s *Service) quarantineCheck(r housingcrawl.Result) *quarantineError {
	stats := quarantineStats{
		Existing:     r.Existing,
		LargeMoves:   r.LargeMoves,
		ActiveBefore: r.ActiveBefore,
		WouldDelist:  r.Delisted,
		Listings:     r.Upserted,
	}
	if r.Existing > 0 && float64(r.LargeMoves) > s.cfg.PriceFraction*float64(r.Existing) {
		return &quarantineError{reason: reasonPriceMoves, stats: stats}
	}
	floor := math.Max(s.cfg.DelistFraction*float64(r.ActiveBefore), float64(s.cfg.DelistFloor))
	if float64(r.Delisted) > floor {
		return &quarantineError{reason: reasonDelists, stats: stats}
	}
	return nil
}

// bodyDigest is the SHA-256 of the request in canonical (deterministic) protobuf
// encoding. A replay must match it, so it covers every field, dry_run included.
func bodyDigest(msg *pb.PushSweepRequest) ([]byte, error) {
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	return sum[:], nil
}

// sourceLib maps the request enum onto the store's source string.
func sourceLib(s pb.Source) string { return sourceName(s) }

// statusLib maps the request enum onto the store's status.
func statusLib(s pb.SweepStatus) housingcrawl.SweepStatus {
	switch s {
	case pb.SweepStatus_SWEEP_STATUS_COMPLETE:
		return housingcrawl.Complete
	case pb.SweepStatus_SWEEP_STATUS_PARTIAL:
		return housingcrawl.Partial
	default:
		return housingcrawl.Blocked
	}
}

// effectiveStatus is the status the sweep is applied with. An empty COMPLETE sweep
// is accepted only when the portal said it had no results. Anything else is PARTIAL,
// which can never delist, so a rig that lost its page data cannot withdraw a suburb.
func effectiveStatus(msg *pb.PushSweepRequest) pb.SweepStatus {
	if msg.Status == pb.SweepStatus_SWEEP_STATUS_COMPLETE && len(msg.Listings) == 0 {
		if msg.PageMeta == nil || msg.PageMeta.TotalResults != 0 {
			return pb.SweepStatus_SWEEP_STATUS_PARTIAL
		}
	}
	return msg.Status
}

// canonicalTarget builds the suburb the sweep is applied to from the dispatch row,
// never from the request. The slug is the collector's own rule (lower case, spaces
// to hyphens), which reproduces all 500 catalog slugs from their display names.
func canonicalTarget(d dispatch) housingcrawl.Target {
	display := strings.TrimSpace(d.Suburb)
	return housingcrawl.Target{
		Suburb:   strings.ReplaceAll(strings.ToLower(display), " ", "-"),
		Display:  display,
		Postcode: strings.TrimSpace(d.Postcode),
		State:    strings.TrimSpace(d.State),
	}
}

// targetMatches reports whether the request's target names the dispatched suburb.
// Suburbs compare by slug, so "St Kilda" and "st-kilda" agree. State compares
// case-insensitively and postcode exactly.
func targetMatches(req *pb.Target, d dispatch) bool {
	slug := func(s string) string { return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), " ", "-") }
	return slug(req.Suburb) == slug(d.Suburb) &&
		strings.EqualFold(strings.TrimSpace(req.State), strings.TrimSpace(d.State)) &&
		strings.TrimSpace(req.Postcode) == strings.TrimSpace(d.Postcode)
}

// toRawListings converts the wire listings into the store's type. The address key
// is left empty: housingcrawl stamps it from the canonical target.
func toRawListings(in []*pb.Listing) []housingcrawl.RawListing {
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
			Bedrooms:     int16Ptr(l.Bedrooms),
			Bathrooms:    int16Ptr(l.Bathrooms),
			CarSpaces:    int16Ptr(l.CarSpaces),
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

// int16Ptr narrows a validated count (0 to 100) into the store's type.
func int16Ptr(v *int32) *int16 {
	if v == nil {
		return nil
	}
	n := int16(*v)
	return &n
}

// responseFor builds the counts-only response. It never carries a listing field.
func responseFor(status pb.SweepStatus, r housingcrawl.Result, quarantined bool) *pb.PushSweepResponse {
	return &pb.PushSweepResponse{
		AppliedStatus:    status,
		Events:           int32(r.Events),
		ListingsUpserted: int32(r.Upserted),
		Delisted:         int32(r.Delisted),
		SkippedRows:      int32(r.SkippedRows),
		Quarantined:      quarantined,
	}
}

// pushSweep is the whole PushSweep: validate, check the receipt under a lock,
// check the dispatch, apply, and record the outcome. The receipt is written in the
// same transaction as the sweep, so a rolled-back sweep leaves no receipt behind.
func (s *Service) pushSweep(ctx context.Context, rig string, msg *pb.PushSweepRequest) (*pb.PushSweepResponse, error) {
	receivedAt := s.now().UTC()
	if err := validateEnvelope(msg, s.cfg.MinContractVersion); err != nil {
		return nil, err
	}
	sum, err := bodyDigest(msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("digest_failed"))
	}
	key := msg.IdempotencyKey

	// Serialize every push with this key. The second of two identical pushes waits
	// here, then finds the first one's receipt and replays it. The lock is a session
	// lock on one connection, so it is released with the connection.
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, unavailableDB()
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, key); err != nil {
		return nil, unavailableDB()
	}
	defer func() {
		uctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(uctx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, key)
	}()

	stored, found, err := loadReceipt(ctx, conn, key)
	if err != nil {
		return nil, unavailableDB()
	}
	if found {
		if stored.rig != rig || !bytes.Equal(stored.sha, sum) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("idempotency_key_reused"))
		}
		replay := proto.Clone(stored.resp).(*pb.PushSweepResponse)
		replay.Replayed = true
		return replay, nil
	}

	d, found, err := loadDispatch(ctx, s.pool, msg.JobId)
	if err != nil {
		return nil, unavailableDB()
	}
	if !found {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("not_dispatched"))
	}
	if !targetMatches(msg.Target, d) || sourceName(msg.Source) != d.Source {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("target_mismatch"))
	}

	status := effectiveStatus(msg)
	sw := housingcrawl.Sweep{
		Target:     canonicalTarget(d),
		Source:     sourceLib(msg.Source),
		Status:     statusLib(status),
		Pages:      int(msg.Pages),
		Listings:   toRawListings(msg.Listings),
		RunTS:      receivedAt,
		Rules:      ingestRules(),
		ReceiptKey: key,
	}

	var (
		quarantined *quarantineError
		final       *pb.PushSweepResponse
	)
	sw.Guard = func(r housingcrawl.Result) error {
		if q := s.quarantineCheck(r); q != nil {
			quarantined = q
			return q
		}
		return nil
	}
	if msg.DryRun {
		// The dry run's guard always refuses, so nothing commits. It still reports
		// whether the real sweep would have been held, and it records no receipt: a
		// dry run must never make the real push look applied.
		sw.Guard = func(r housingcrawl.Result) error {
			if q := s.quarantineCheck(r); q != nil {
				quarantined = q
			}
			return errDryRun
		}
	} else {
		sw.Record = func(ctx context.Context, tx pgx.Tx, r housingcrawl.Result) error {
			final = responseFor(status, r, false)
			return insertReceipt(ctx, tx, key, rig, sum, final)
		}
	}

	res, applyErr := housingcrawl.ApplySweep(ctx, s.pool, sw)

	if msg.DryRun {
		if applyErr != nil && !errors.Is(applyErr, errDryRun) {
			return nil, applyError(applyErr)
		}
		resp := responseFor(status, res, quarantined != nil)
		log.Infof("housing ingest: dry run %s by %s: would_quarantine=%t upserted=%d delisted=%d", key, rig, quarantined != nil, res.Upserted, res.Delisted)
		return resp, nil
	}

	switch {
	case applyErr == nil && final == nil:
		// BLOCKED: the store writes nothing and returns before its transaction, so
		// no Record ran. The receipt is still stored, so a retry replays it.
		resp := responseFor(status, res, false)
		if err := s.storeReceipt(ctx, key, rig, sum, resp); err != nil {
			return nil, unavailableDB()
		}
		s.bumpRunStatus(ctx, d.RunID, true, 0, 0, 0)
		return resp, nil

	case applyErr == nil:
		s.bumpRunStatus(ctx, d.RunID, false, res.Upserted, res.Events, 1)
		return final, nil
	}

	var qe *quarantineError
	if errors.As(applyErr, &qe) {
		resp := responseFor(status, housingcrawl.Result{}, true)
		if err := s.storeQuarantine(ctx, key, rig, msg.JobId, sum, qe, resp); err != nil {
			return nil, unavailableDB()
		}
		log.Warnf("housing ingest: quarantined %s from %s: reason=%s existing=%d large_moves=%d active_before=%d would_delist=%d",
			key, rig, qe.reason, qe.stats.Existing, qe.stats.LargeMoves, qe.stats.ActiveBefore, qe.stats.WouldDelist)
		return resp, nil
	}
	return nil, applyError(applyErr)
}

// applyError maps a store failure. An invalid sweep is the caller's bug
// (InvalidArgument). Anything else is transient, so the rig retries.
func applyError(err error) error {
	if errors.Is(err, housingcrawl.ErrInvalidSweep) {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sweep_invalid"))
	}
	log.Warnf("housing ingest: apply failed: %v", err)
	return connect.NewError(connect.CodeUnavailable, errors.New("apply_failed"))
}

func unavailableDB() error {
	return connect.NewError(connect.CodeUnavailable, errors.New(msgDatabaseDown))
}

// storeReceipt writes a receipt on its own transaction, for the paths that write no
// listing data (BLOCKED, and a quarantine that has already rolled back).
func (s *Service) storeReceipt(ctx context.Context, key, rig string, sum []byte, resp *pb.PushSweepResponse) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertReceipt(ctx, tx, key, rig, sum, resp); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// storeQuarantine writes the quarantine row and the quarantined receipt together.
// The held sweep has already rolled back, so this is the only write for it.
func (s *Service) storeQuarantine(ctx context.Context, key, rig, job string, sum []byte, qe *quarantineError, resp *pb.PushSweepResponse) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertQuarantine(ctx, tx, key, rig, job, sum, qe.reason, qe.stats); err != nil {
		return err
	}
	if err := insertReceipt(ctx, tx, key, rig, sum, resp); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
