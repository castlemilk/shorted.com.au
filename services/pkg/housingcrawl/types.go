// Package housingcrawl is the store side of the housing listing crawl: it diffs
// one (source, suburb) sweep against the stored listings in a single
// transaction, writes the price, status and lifecycle events, and delists only
// on a COMPLETE sweep.
//
// It is shared by two callers that must run exactly the same logic: the
// collector on the residential rig (house-price-collector), and the shorts
// ingest service that receives the rig's raw sweeps. The package never fetches,
// extracts or classifies a page; those stay on the rig. It must not import the
// collector (package main), CDP, Playwright or any brandbrain client.
package housingcrawl

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// RawListing is one property listing as harvested from a search-results page,
// before validation. Pointer fields are nil when absent.
type RawListing struct {
	Source      string
	ListingID   string
	ListingURL  string
	DisplayAddr string
	Suburb      string
	State       string
	Postcode    string
	// AddressKey is a stable per-physical-address identity. It is stamped by
	// ApplySweep from the CANONICAL target suburb/state/postcode, never populated
	// by extraction (see AddressKey).
	AddressKey   string
	Lat, Lng     *float64
	PropertyType string
	Bedrooms     *int16
	Bathrooms    *int16
	CarSpaces    *int16
	LandSizeSqm  *float64
	PriceDisplay string
	PriceLow     *float64
	PriceHigh    *float64
	PriceKind    string
	Status       string // normalized: for_sale|under_offer|sold|withdrawn
	// Marketing agency + agents, harvested from the same search-results blob.
	// Best-effort — empty when the portal omits them.
	AgencyID   string
	AgencyName string
	AgentNames []string
}

// Target is the canonical suburb a sweep was made for. Listings are keyed to its
// fields, never to the portal's own address fields.
type Target struct {
	Suburb   string // url slug: "bondi", "st-kilda"
	Display  string // "Bondi"
	Postcode string // "2026"
	State    string // "NSW"
}

// RegionCode is the listing foreign-key target for the suburb.
func (t Target) RegionCode() string {
	return "SUBURB:" + t.State + "-" + t.Postcode + "-" + strings.ToUpper(t.Suburb)
}

// SweepStatus is how far a sweep can be trusted. Only Complete may delist.
type SweepStatus string

const (
	// Complete: paged to an empty or duplicate page, so the whole suburb was
	// seen and listings absent for DelistGrace sweeps may be withdrawn.
	Complete SweepStatus = "COMPLETE"
	// Partial: real data, but the page cap was hit or a late page failed. Update
	// what was seen and delist nothing.
	Partial SweepStatus = "PARTIAL"
	// Blocked: nothing believable (block, poison or empty first page). Writes
	// nothing.
	Blocked SweepStatus = "BLOCKED"
)

// Config holds the diff thresholds a sweep is applied with.
type Config struct {
	// DelistGrace is how many consecutive COMPLETE sweeps a listing may be absent
	// before it is withdrawn.
	DelistGrace int
	// NoiseAbs and NoisePct are the price-move thresholds: a move must clear both
	// to be recorded.
	NoiseAbs float64
	NoisePct float64
	// MinDelistInterval bounds how often a listing's absence counts toward
	// delisting. When > 0, missed_sweeps advances at most once per listing per
	// interval, so a re-swept job cannot speed up delisting. Zero means every
	// COMPLETE sweep counts, as the collector has always done.
	MinDelistInterval time.Duration
	// DelistStaleAfter splits the delists of a COMPLETE sweep. A listing whose
	// last_seen_at is older than runTs - DelistStaleAfter is confirmed gone, and
	// Result.DelistedStale counts it. Zero disables the split: DelistedStale stays 0.
	DelistStaleAfter time.Duration
}

// LargeMoveFraction is the price move that Result.LargeMoves counts: a listing
// already stored whose price moved by more than this fraction of its stored
// price. It is the quarantine's "moved more than 10%" test, reported here so the
// guard does not re-derive it.
const LargeMoveFraction = 0.10

// Sweep is one (source, suburb) sweep as the store sees it.
type Sweep struct {
	Target Target
	// Source is the portal: "rea" or "domain".
	Source string
	Status SweepStatus
	// Pages is the number of pages fetched. It is carried for the caller's
	// accounting; the store does not read it.
	Pages int
	// Listings are the observed listings. ApplySweep gates them against Target
	// and clamps their prices before any write.
	Listings []RawListing
	// RunTS is when the sweep ran: the rig's clock in the collector, the server's
	// receive time on ingest.
	RunTS time.Time
	Rules Config
	// ReceiptKey, when non-empty, is stamped on every listing row upserted and
	// every price event inserted by this sweep (ingest_receipt_key). The
	// collector leaves it empty, so those columns stay NULL, as before.
	ReceiptKey string
	// Guard, when non-nil, is called after the diff and before the commit, with
	// the Result the sweep would commit. A non-nil error rolls the whole sweep
	// back, and ApplySweep returns it wrapped. A nil Guard means no check.
	Guard func(Result) error
	// Begin, when non-nil, runs as the FIRST statement of the sweep's transaction,
	// before any read or write the sweep makes. Whatever it takes (an advisory
	// lock, a row lock) is held until the transaction ends, and whatever it reads
	// it reads under that lock. Returning false means the caller has already
	// decided the outcome (a replay), so ApplySweep applies nothing and returns a
	// zero Result with no error. A non-nil error rolls back and is returned as is.
	// A transaction pooler may run each statement on a different backend, so the
	// lock must be a transaction-level lock, never a session lock.
	Begin func(ctx context.Context, tx pgx.Tx) (proceed bool, err error)
	// Record, when non-nil, runs inside the sweep's transaction after Guard and
	// before the commit, with the Result about to be committed. It lets a caller
	// write its own rows (the ingest receipt) atomically with the sweep: a
	// receipt that outlived a rolled-back sweep would make a retry look applied.
	// A non-nil error rolls the sweep back and is returned wrapped. A nil Record
	// means no extra write.
	Record func(ctx context.Context, tx pgx.Tx, res Result) error
}

// Result is what one ApplySweep call did. It is meaningful on error too: a
// transient failure returns the counts accumulated before it, as the collector's
// run summary always has.
type Result struct {
	// Applied is the status the sweep was applied with. Blocked means nothing
	// was written.
	Applied SweepStatus
	// Events is the number of price, status and lifecycle events written.
	Events int
	// Upserted is the number of listing snapshots written.
	Upserted int
	// Delisted is the number of listings withdrawn by this sweep.
	Delisted int
	// DelistedStale is the subset of Delisted whose last_seen_at is older than
	// Config.DelistStaleAfter: no sweep has seen them for that long. It is 0 when
	// DelistStaleAfter is 0. The quarantine gate subtracts it, so a backlog of
	// long-gone listings does not trip a hold on a sweep that is otherwise sound.
	DelistedStale int
	// SkippedRows is the number of listings dropped on a PERMANENT per-row error.
	// The rest of the sweep still persisted.
	SkippedRows int
	// NewListings counts first_seen events.
	NewListings int
	// Drops and Rises count price moves on a listing already tracked.
	Drops, Rises int
	// Relisted counts listings that came back after being inactive.
	Relisted int
	// StatusChanges counts status transitions that were not a relist.
	StatusChanges int
	// AddressRelistDrops and AddressRelistRises count price moves found by the
	// address-level relist check (a new listing_id at a known address).
	AddressRelistDrops, AddressRelistRises int
	// Existing is the number of listings in the sweep that already had a stored
	// snapshot. It is the denominator of the quarantine's price-move test.
	Existing int
	// LargeMoves is the number of those existing listings whose price moved by
	// more than LargeMoveFraction of the stored price. Sold listings and price
	// kinds that are not comparable are excluded, as they are for price events.
	LargeMoves int
	// ActiveBefore is the number of active listings in the sweep's region before
	// the sweep wrote anything. It is counted only when a Guard is set.
	ActiveBefore int
}

// Region is one suburb row for the listing and fact foreign keys.
type Region struct {
	RegionCode string
	RegionType string // national | state | gccsa | rest_of_state | suburb | lga
	RegionName string
	StateCode  string
	Postcode   string
}
