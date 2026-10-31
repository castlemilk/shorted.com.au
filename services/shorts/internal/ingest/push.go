package ingest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// errDryRun is what a dry run returns from its guard or record hook. It rolls the
// sweep back, and the counts it produced are still reported.
var errDryRun = errors.New("dry run: nothing committed")

// Quarantine reasons. They go into crawl_ingest_quarantine and the warn log.
const (
	reasonPriceMoves = "price_moves_over_threshold"
	reasonDelists    = "delists_over_threshold"
)

// poisonFraction is the share of hard off-target listings (wrong or absent postcode)
// above which a whole sweep is poison. It is the collector's rule: partitionByTarget
// and the 0.30 page-one gate in crawl_listings.go.
const poisonFraction = 0.30

// quarantineError is the guard's refusal. ApplySweep wraps it, so errors.As finds it.
type quarantineError struct {
	reason string
	stats  quarantineStats
}

func (e *quarantineError) Error() string { return "quarantined: " + e.reason }

// ingestRules are the diff thresholds an ingest sweep is applied with: the collector's
// defaults plus the 12-hour MinDelistInterval, which the collector does not use. The
// owner's rule is that a re-swept job cannot speed up delisting. delistStaleAfter is
// the ingest's HOUSING_INGEST_QUARANTINE_DELIST_STALE_AFTER (0 disables the split).
func ingestRules(delistStaleAfter time.Duration) housingcrawl.Config {
	return housingcrawl.Config{
		DelistGrace:       2,
		NoiseAbs:          5000,
		NoisePct:          0.005,
		MinDelistInterval: 12 * time.Hour,
		DelistStaleAfter:  delistStaleAfter,
	}
}

// quarantineCheck holds a sweep back when either trip holds, with both thresholds
// floored so that a small suburb cannot trip on one or two genuine moves:
//
//	(a) LargeMoves > max(PriceFraction × existing listings, QuarantineMinMoves);
//	(b) recent delists > max(MinDelists, min(DelistFraction × active listings before
//	    the sweep, DelistCap)), where the recent delists are Delisted, less
//	    DelistedStale when the sweep covered the region (see staleExempt).
//
// Both are strict: a value exactly on the threshold passes. A held suburb stays held
// until an operator releases it (crawl_ingest_quarantine_bypass) or the figures
// change, so the floors are what keep the hold from freezing a small suburb.
//
// The delist trip is the one the review asked for. A small suburb (fewer than 20
// active) used to have no protection, because the fraction is under one listing and
// the old floor was 20: two genuinely empty COMPLETE pushes 12 hours apart withdrew
// it. MinDelists now bounds it from below, and the cap bounds a large suburb.
//
// DelistedStale is the delists of listings that no sweep has seen for
// DelistStaleAfter (21 days by default). Those are confirmed gone, not a sign of a
// bad sweep: a bad sweep drops listings that are live now, and those were seen
// recently. Measured 2026-10-31, five of the six held sweeps were a backlog of such
// listings. On Bundoora, 41 of the 43 would-be delists were last seen more than 21
// days before the hold, and 36 were last seen on 4 August. Thomastown's 26 were
// seen on 20 October, so they are recent: it stays held, and once they pass 21 days
// a re-crawl applies. A sweep that drops many recently-seen listings is still held,
// whatever its stale count.
//
// The stale exemption needs coverage (staleExempt). A truncated COMPLETE sweep over a
// region no sweep has seen for weeks drops listings that are all stale, so without
// coverage the exemption would let it withdraw the region.
func (s *Service) quarantineCheck(r housingcrawl.Result, status pb.SweepStatus) *quarantineError {
	stats := quarantineStats{
		Status:        status.String(),
		Existing:      r.Existing,
		LargeMoves:    r.LargeMoves,
		ActiveBefore:  r.ActiveBefore,
		WouldDelist:   r.Delisted,
		DelistedStale: r.DelistedStale,
		Listings:      r.Upserted,
	}
	priceFloor := math.Max(s.cfg.PriceFraction*float64(r.Existing), float64(s.cfg.QuarantineMinMoves))
	if float64(r.LargeMoves) > priceFloor {
		return &quarantineError{reason: reasonPriceMoves, stats: stats}
	}
	delistFloor := delistThreshold(s.cfg, r.ActiveBefore)
	if float64(recentDelists(r)) > delistFloor {
		return &quarantineError{reason: reasonDelists, stats: stats}
	}
	return nil
}

// staleExempt reports whether the sweep's stale delists are exempt from the delist
// trip. It must have seen at least half of what the region held before it
// (Upserted against ActiveBefore, not against the recently seen actives). A sweep
// that covered less than half is judged on every delist, so a truncated sweep over a
// dark region cannot withdraw it under the stale exemption.
//
// Residual risk: a truncation that keeps at least half of a dark region still passes,
// and the most it can withdraw is about half that region.
func staleExempt(r housingcrawl.Result) bool {
	return 2*r.Upserted >= r.ActiveBefore
}

// recentDelists is the delist count the threshold judges: every delist, less the stale
// ones when staleExempt holds. It is never negative.
func recentDelists(r housingcrawl.Result) int {
	recent := r.Delisted
	if staleExempt(r) {
		recent -= r.DelistedStale
	}
	if recent < 0 {
		recent = 0
	}
	return recent
}

// delistThreshold is max(MinDelists, min(DelistFraction × active, DelistCap)). It is
// the largest number of delists a sweep may make without being held.
func delistThreshold(cfg Config, active int) float64 {
	return math.Max(float64(cfg.MinDelists), math.Min(cfg.DelistFraction*float64(active), float64(cfg.DelistCap)))
}

// gateSweep applies the collector's off-target rules on the server, before anything
// is written. gated counts the listings that belong to the target and would be
// written. poisoned is true when more than poisonFraction of the listings are hard
// misses: a wrong or absent postcode. A same-postcode, other-suburb listing is a soft
// miss. It is neither written nor poison, because a shared-postcode cluster
// legitimately back-fills with its neighbours (partitionByTarget).
func gateSweep(raw []housingcrawl.RawListing, t housingcrawl.Target) (gated int, poisoned bool) {
	if len(raw) == 0 {
		return 0, false
	}
	hard := 0
	for _, l := range raw {
		if housingcrawl.MatchesTarget(l, t) {
			gated++
			continue
		}
		if l.Postcode != "" && l.Postcode == t.Postcode {
			continue // soft miss
		}
		hard++
	}
	return gated, float64(hard)/float64(len(raw)) > poisonFraction
}

// effectiveStatus is the status the sweep is applied with.
//
//   - A poisoned sweep is BLOCKED: it writes nothing, and the response says so.
//   - A sweep with zero GATED listings is BLOCKED, whatever it claimed. Nothing in it
//     is writable, so there is nothing to apply, and BLOCKED is the one status that
//     never closes the job. This is the collector's thin-page rule. It also covers an
//     empty PARTIAL and a COMPLETE made only of soft misses, which used to be
//     downgraded to PARTIAL and close the job with zero writes.
//
// The gated count is the one the server computed, never the request's listing count.
func effectiveStatus(msg *pb.PushSweepRequest, gated int, poisoned bool) pb.SweepStatus {
	if poisoned || gated == 0 {
		return pb.SweepStatus_SWEEP_STATUS_BLOCKED
	}
	return msg.Status
}

// bodyDigest is the SHA-256 of the request in canonical (deterministic) protobuf
// encoding, with observed_at left out. observed_at is informational, and a retry
// whose timestamp was re-serialised must replay rather than conflict.
func bodyDigest(msg *pb.PushSweepRequest) ([]byte, error) {
	canon := proto.Clone(msg).(*pb.PushSweepRequest)
	canon.ObservedAt = nil
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(canon)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	return sum[:], nil
}

// applied reports whether a status writes listings. Only these close a job.
func applied(s pb.SweepStatus) bool {
	return s == pb.SweepStatus_SWEEP_STATUS_COMPLETE || s == pb.SweepStatus_SWEEP_STATUS_PARTIAL
}

// canonicalTarget builds the suburb the sweep is applied to from the dispatch row,
// never from the request. The slug is the collector's own rule (lower case, spaces to
// hyphens), which reproduces all 500 catalog slugs from their display names. The
// state is upper case, as the collector's catalog stores it, so the region code
// matches the one the collector writes.
func canonicalTarget(d dispatch) housingcrawl.Target {
	display := strings.TrimSpace(d.Suburb)
	return housingcrawl.Target{
		Suburb:   strings.ReplaceAll(strings.ToLower(display), " ", "-"),
		Display:  display,
		Postcode: strings.TrimSpace(d.Postcode),
		State:    strings.ToUpper(strings.TrimSpace(d.State)),
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

// responseFor builds the counts-only response. It never carries a listing field.
func responseFor(status pb.SweepStatus, r housingcrawl.Result, quarantined, poisoned bool) *pb.PushSweepResponse {
	return &pb.PushSweepResponse{
		AppliedStatus:    status,
		Events:           int32(r.Events),
		ListingsUpserted: int32(r.Upserted),
		Delisted:         int32(r.Delisted),
		SkippedRows:      int32(r.SkippedRows),
		Quarantined:      quarantined,
		Poisoned:         poisoned,
	}
}

// precondition is a FailedPrecondition whose message is a fixed reason.
func precondition(reason string) error {
	return connect.NewError(connect.CodeFailedPrecondition, errors.New(reason))
}

// txErr keeps a connect error the sweep decided on, and maps anything else (a
// connection, a deadlock, a context) to Unavailable, so the rig retries.
func txErr(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return err
	}
	log.Warnf("housing ingest: transaction failed: %v", err)
	return unavailableDB()
}

// mapApplyError maps an error from ApplySweep onto the response code.
func mapApplyError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce
	}
	if errors.Is(err, housingcrawl.ErrInvalidSweep) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("sweep_invalid"))
	}
	log.Warnf("housing ingest: apply failed: %v", err)
	return connect.NewError(connect.CodeUnavailable, errors.New("apply_failed"))
}

func unavailableDB() error {
	return connect.NewError(connect.CodeUnavailable, errors.New(msgDatabaseDown))
}

// inTx runs fn in one transaction on the ingest pool. It is used for the one write
// that happens outside a sweep: recording a quarantine, which ApplySweep has rolled
// back by then.
func (s *Service) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return txErr(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return txErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return txErr(err)
	}
	return nil
}

// pushSweep is the whole PushSweep.
//
// Everything that decides the outcome happens inside ONE transaction, on ONE pooled
// connection, after the key's transaction-level advisory lock is taken as its first
// statement: the receipt is read (replay or conflict), the dispatch row is locked and
// checked (closed, expired), the region is ensured, the sweep is applied, and the
// receipt and the dispatch close are written. The receipts primary key is the final
// guard. No connection is held while another is taken, so the pool cannot deadlock
// however many pushes run at once.
//
// The only work outside that transaction is reads that do not decide anything (the
// dispatch target, the quarantine bypass) and the counts bump, which runs after the
// commit.
func (s *Service) pushSweep(ctx context.Context, who identity, msg *pb.PushSweepRequest) (*pb.PushSweepResponse, error) {
	rig := who.Subject
	receivedAt := s.now().UTC()
	if err := validateEnvelope(msg, s.cfg.MinContractVersion); err != nil {
		return nil, err
	}
	sum, err := bodyDigest(msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("digest_failed"))
	}
	key := msg.IdempotencyKey
	job := msg.JobId

	// The dispatch target and source are immutable, so they can be read before the
	// sweep. A job the ledger never dispatched has no receipt (a receipt needs a
	// dispatch row), so refusing it here does not skip a replay.
	d, found, err := loadDispatch(ctx, s.pool, job)
	if err != nil {
		return nil, unavailableDB()
	}
	if !found {
		return nil, precondition("not_dispatched")
	}
	if !targetMatches(msg.Target, d) || sourceName(msg.Source) != d.Source {
		return nil, precondition("target_mismatch")
	}
	target := canonicalTarget(d)
	raw := housingingest.ToRawListings(msg.Listings)
	gated, poisoned := gateSweep(raw, target)
	status := effectiveStatus(msg, gated, poisoned)
	if poisoned {
		log.Warnf("housing ingest: %s from %s is poisoned (more than %.0f%% off-target): applied as BLOCKED", key, rig, poisonFraction*100)
	}
	bypass, err := bypassed(ctx, s.pool, target.Suburb, target.State, d.Source)
	if err != nil {
		return nil, unavailableDB()
	}

	var (
		replayed *pb.PushSweepResponse
		final    *pb.PushSweepResponse
		dryHeld  *quarantineError
	)
	sw := housingcrawl.Sweep{
		Target:     target,
		Source:     d.Source,
		Status:     housingingest.StatusLib(status),
		Pages:      int(msg.Pages),
		Listings:   raw,
		RunTS:      receivedAt,
		Rules:      ingestRules(s.cfg.DelistStaleAfter),
		ReceiptKey: key,
	}

	sw.Begin = func(ctx context.Context, tx pgx.Tx) (bool, error) {
		// First statement of the transaction: the key's lock. Concurrent identical
		// pushes queue here, and the second finds the first's receipt below.
		if err := lockKeyTx(ctx, tx, key); err != nil {
			return false, txErr(err)
		}
		if !msg.DryRun {
			stored, ok, err := loadReceiptTx(ctx, tx, key)
			if err != nil {
				return false, txErr(err)
			}
			if ok {
				if stored.rig != rig || !bytes.Equal(stored.sha, sum) {
					return false, connect.NewError(connect.CodeAlreadyExists, errors.New("idempotency_key_reused"))
				}
				replayed = proto.Clone(stored.resp).(*pb.PushSweepResponse)
				replayed.Replayed = true
				return false, nil
			}
		}
		st, err := lockDispatchTx(ctx, tx, job)
		if err != nil {
			return false, txErr(err)
		}
		if !st.found {
			return false, precondition("not_dispatched")
		}
		// Two distinct reasons. dispatch_applied means an earlier attempt already
		// applied this job: the job is done, and a rig may treat it as success.
		// dispatch_expired means the job timed out before any attempt applied, which is a
		// failure. Applied is checked first, so a job that applied and later expired still
		// reports applied.
		if st.closed {
			return false, precondition("dispatch_applied")
		}
		if st.expired {
			return false, precondition("dispatch_expired")
		}
		// A suburb nobody has crawled has no region row, and every listing for it would
		// fail the foreign key and be skipped. The collector creates this row the same
		// way; the write is idempotent.
		if err := housingcrawl.UpsertRegionTx(ctx, tx, housingcrawl.Region{
			RegionCode: target.RegionCode(),
			RegionType: "suburb",
			RegionName: target.Display,
			StateCode:  target.State,
			Postcode:   target.Postcode,
		}); err != nil {
			return false, txErr(err)
		}
		return true, nil
	}

	if msg.DryRun {
		// A dry run reports the outcome it would have had and commits nothing: the
		// guard reports whether the sweep would be held, and the record hook always
		// refuses, so the transaction rolls back on every path.
		sw.Guard = func(r housingcrawl.Result) error {
			if !bypass {
				if q := s.quarantineCheck(r, status); q != nil {
					dryHeld = q
				}
			}
			return errDryRun
		}
		sw.Record = func(context.Context, pgx.Tx, housingcrawl.Result) error { return errDryRun }
	} else {
		sw.Guard = func(r housingcrawl.Result) error {
			if bypass {
				return nil
			}
			if q := s.quarantineCheck(r, status); q != nil {
				return q
			}
			return nil
		}
		sw.Record = func(ctx context.Context, tx pgx.Tx, r housingcrawl.Result) error {
			final = responseFor(status, r, false, poisoned)
			if err := insertReceiptTx(ctx, tx, key, who, sum, final); err != nil {
				return txErr(err)
			}
			// The job closes only when a gated listing was written. A sweep that applied
			// with no writes (every row skipped) leaves the job open for a real attempt.
			if applied(status) && r.Upserted > 0 {
				if err := closeDispatchTx(ctx, tx, job); err != nil {
					return txErr(err)
				}
			}
			return nil
		}
	}

	res, applyErr := housingcrawl.ApplySweep(ctx, s.pool, sw)

	if replayed != nil {
		return replayed, nil
	}

	if msg.DryRun {
		if applyErr != nil && !errors.Is(applyErr, errDryRun) {
			return nil, mapApplyError(applyErr)
		}
		log.Infof("housing ingest: dry run %s by %s: would_quarantine=%t upserted=%d delisted=%d delisted_stale=%d", key, rig, dryHeld != nil, res.Upserted, res.Delisted, res.DelistedStale)
		return responseFor(status, res, dryHeld != nil, poisoned), nil
	}

	if applyErr == nil {
		if final == nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("no_outcome"))
		}
		if res.Delisted > 0 {
			// One line per applied sweep that withdrew listings, so a stale cleanup
			// leaves a record. delisted_stale is what the exemption removed from the
			// count; stale_exempt says whether it was allowed to.
			log.Infof("housing ingest: applied %s from %s: upserted=%d active_before=%d delisted=%d delisted_stale=%d stale_exempt=%t",
				key, rig, res.Upserted, res.ActiveBefore, res.Delisted, res.DelistedStale, staleExempt(res))
		}
		if status == pb.SweepStatus_SWEEP_STATUS_BLOCKED {
			s.bumpRunStatus(ctx, d.RunID, true, 0, 0, 0)
		} else {
			s.bumpRunStatus(ctx, d.RunID, false, res.Upserted, res.Events, 1)
		}
		return final, nil
	}

	var qe *quarantineError
	if errors.As(applyErr, &qe) {
		resp, err := s.recordQuarantine(ctx, key, who, job, sum, qe, status, poisoned)
		if err != nil {
			return nil, err
		}
		log.Warnf("housing ingest: quarantined %s from %s: reason=%s existing=%d large_moves=%d active_before=%d would_delist=%d delisted_stale=%d",
			key, rig, qe.reason, qe.stats.Existing, qe.stats.LargeMoves, qe.stats.ActiveBefore, qe.stats.WouldDelist, qe.stats.DelistedStale)
		return resp, nil
	}
	return nil, mapApplyError(applyErr)
}

// recordQuarantine writes the quarantine row and the quarantined receipt in one
// transaction, after the held sweep has rolled back. It takes the key lock again and
// re-reads the receipt first. If an identical push got there first, its receipt is
// replayed, so a retry never writes a second quarantine row for the same key.
func (s *Service) recordQuarantine(ctx context.Context, key string, who identity, job string, sum []byte, qe *quarantineError, status pb.SweepStatus, poisoned bool) (*pb.PushSweepResponse, error) {
	rig := who.Subject
	resp := responseFor(status, housingcrawl.Result{}, true, poisoned)
	var out *pb.PushSweepResponse
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockKeyTx(ctx, tx, key); err != nil {
			return err
		}
		stored, ok, err := loadReceiptTx(ctx, tx, key)
		if err != nil {
			return err
		}
		if ok {
			if stored.rig != rig || !bytes.Equal(stored.sha, sum) {
				return connect.NewError(connect.CodeAlreadyExists, errors.New("idempotency_key_reused"))
			}
			out = proto.Clone(stored.resp).(*pb.PushSweepResponse)
			out.Replayed = true
			return nil
		}
		if err := insertQuarantineTx(ctx, tx, key, rig, job, sum, qe.reason, qe.stats); err != nil {
			return err
		}
		if err := insertReceiptTx(ctx, tx, key, who, sum, resp); err != nil {
			return err
		}
		out = resp
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
