package shorts

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"golang.org/x/sync/singleflight"
)

// The register is read once, into a universe, and every ownership response is
// assembled from it. One universe serves every rpc for ownershipTTL. The only
// other reads are a holder's or a stock's newest notices, cached beside the
// universe under its generation, so no entry outlives the universe it was read
// beside.

// ownershipRefreshAhead is how long before its expiry a background build
// starts, so a request rarely finds the universe expired and has to wait.
const ownershipRefreshAhead = 2 * time.Minute

// ownershipBuildTimeout bounds one build, whichever path runs it.
const ownershipBuildTimeout = 60 * time.Second

// ownershipHistoryLimit is how many notices a stock's or an institution's
// history serves: the newest.
const ownershipHistoryLimit = 100

// withholdingOutcomes withhold a notice that was read or could not be read.
// not_a_notice and fetch_error are documents, not withheld notices: they sit in
// the overview's breakdown and never in a stock's withheld count.
var withholdingOutcomes = []string{
	"no_text", "no_voting_power", "implausible", "ambiguous_target", "no_holder", "inconsistent_votes",
}

// errOwnershipUniverseExpired is a build that finished past its own expiry. It
// is never served.
var errOwnershipUniverseExpired = errors.New("ownership universe expired before it was served")

// ownershipUniverse is the whole register at one build. A handler reads it and
// never writes it: a view, the overview and every index are immutable once the
// universe is swapped in, so responses may share them.
type ownershipUniverse struct {
	builtAt, expiresAt time.Time
	generation         int64 // builtAt.UnixNano(): the key suffix of every entry built beside it
	data               *ownershipData
	views              map[string]*shortsv1alpha1.OwnershipStock
	overview           *shortsv1alpha1.GetOwnershipOverviewResponse

	holdingsByStock           map[string][]shortsstore.SubstantialHoldingRow
	holdingsByHolder          map[string][]shortsstore.SubstantialHoldingRow
	fundHoldingsByStock       map[string][]shortsstore.FundHoldingRow // file order kept (value desc)
	fundHoldingsByInstitution map[string][]shortsstore.FundHoldingRow // file order kept (value desc)
	fundsByInstitution        map[string][]shortsstore.OwnershipFundRow
	noticeCountByStock        map[string]int
	attemptsByStock           map[string]map[string]int // code -> outcome -> count
	byOutcome                 map[string]int            // outcome -> count, every outcome
	documentsAttempted        int
}

// newOwnershipUniverse builds every index and the overview from the rows. It is
// pure: the tests call it with a fixed now.
func newOwnershipUniverse(d *ownershipData, counts map[string]int, attempts []shortsstore.AttemptOutcomeRow, now time.Time) *ownershipUniverse {
	u := &ownershipUniverse{
		builtAt:                   now,
		expiresAt:                 now.Add(ownershipTTL),
		generation:                now.UnixNano(),
		data:                      d,
		views:                     d.stockViews(),
		holdingsByStock:           map[string][]shortsstore.SubstantialHoldingRow{},
		holdingsByHolder:          map[string][]shortsstore.SubstantialHoldingRow{},
		fundHoldingsByStock:       map[string][]shortsstore.FundHoldingRow{},
		fundHoldingsByInstitution: map[string][]shortsstore.FundHoldingRow{},
		fundsByInstitution:        map[string][]shortsstore.OwnershipFundRow{},
		noticeCountByStock:        counts,
		attemptsByStock:           map[string]map[string]int{},
		byOutcome:                 map[string]int{},
	}
	for _, h := range d.holdings {
		u.holdingsByStock[h.StockCode] = append(u.holdingsByStock[h.StockCode], h)
		u.holdingsByHolder[h.HolderKey] = append(u.holdingsByHolder[h.HolderKey], h)
	}
	for _, h := range d.fundHoldings {
		u.fundHoldingsByStock[h.StockCode] = append(u.fundHoldingsByStock[h.StockCode], h)
		u.fundHoldingsByInstitution[h.InstitutionSlug] = append(u.fundHoldingsByInstitution[h.InstitutionSlug], h)
	}
	for _, f := range d.funds {
		if f.InstitutionSlug != "" {
			u.fundsByInstitution[f.InstitutionSlug] = append(u.fundsByInstitution[f.InstitutionSlug], f)
		}
	}
	for _, a := range attempts {
		if u.attemptsByStock[a.StockCode] == nil {
			u.attemptsByStock[a.StockCode] = map[string]int{}
		}
		u.attemptsByStock[a.StockCode][a.Outcome] += a.Count
		u.byOutcome[a.Outcome] += a.Count
		u.documentsAttempted += a.Count
	}
	u.overview = buildOwnershipOverview(u)
	return u
}

// withheldListed is the notices listed under a code whose outcome withholds
// them.
func (u *ownershipUniverse) withheldListed(code string) int {
	n := 0
	for _, outcome := range withholdingOutcomes {
		n += u.attemptsByStock[code][outcome]
	}
	return n
}

// ttlRemaining is how long an entry built beside u may live: until u expires,
// and never less than a second.
func (u *ownershipUniverse) ttlRemaining() time.Duration {
	return max(time.Until(u.expiresAt), time.Second)
}

// ownershipUniverseHolder keeps the current universe and replaces it. Inside
// the refresh-ahead window one background build starts while the current
// universe is served. Past its expiry a request builds the next one itself,
// joining any build already in flight, and builds once more for itself if the
// one it joined failed.
type ownershipUniverseHolder struct {
	mu         sync.Mutex
	cur        *ownershipUniverse
	refreshing bool
	sf         singleflight.Group
	now        func() time.Time
	build      func(context.Context) (*ownershipUniverse, error)
	logger     Logger
}

// newServerOwnershipUniverse is the holder a ShortsServer with an ownership
// store reads through. h.now() is read before the build's first statement, so a
// universe is never stamped later than the data it holds.
func newServerOwnershipUniverse(s *ShortsServer) *ownershipUniverseHolder {
	h := &ownershipUniverseHolder{now: time.Now, logger: s.logger}
	h.build = func(ctx context.Context) (*ownershipUniverse, error) {
		return s.buildOwnershipUniverse(ctx, h.now())
	}
	return h
}

// buildOwnershipUniverse reads the register once: the registry, the holdings,
// the newest notices, the funds and the companies, then the two whole-table
// counts. That is eleven statements per build, once per ownershipTTL per
// instance.
func (s *ShortsServer) buildOwnershipUniverse(ctx context.Context, builtAt time.Time) (*ownershipUniverse, error) {
	d, err := s.loadOwnership(ctx, 30)
	if err != nil {
		return nil, err
	}
	counts, err := s.ownershipStore.NoticeCountsByStock(ctx)
	if err != nil {
		return nil, err
	}
	attempts, err := s.ownershipStore.AttemptOutcomes(ctx)
	if err != nil {
		return nil, err
	}
	return newOwnershipUniverse(d, counts, attempts, builtAt), nil
}

// get returns the universe a handler serves. It never returns one past its
// expiry: an expired universe is rebuilt on the request path, and a build that
// has itself run past its expiry is an error rather than an answer.
func (h *ownershipUniverseHolder) get(ctx context.Context) (*ownershipUniverse, error) {
	h.mu.Lock()
	cur, now := h.cur, h.now()
	if cur != nil && now.Before(cur.expiresAt) {
		inWindow := !now.Add(ownershipRefreshAhead).Before(cur.expiresAt)
		if !inWindow || h.refreshing {
			h.mu.Unlock()
			return cur, nil
		}
		h.refreshing = true
		h.mu.Unlock()
		go h.refreshInBackground(ctx)
		return cur, nil
	}
	// Past expiry, a refresh may still be in flight, and the build this request
	// joins could be that refresh.
	refreshing := h.refreshing
	h.mu.Unlock()

	u, joined, err := h.buildShared(ctx)
	if joined && refreshing && (err != nil || !h.now().Before(u.expiresAt)) {
		// This request joined the refresh. A refresh stalls while no request is
		// in flight and can then fail on its own deadline, which says nothing
		// about the database, so the request builds for itself and its answer is
		// that build's alone.
		u, _, err = h.buildShared(ctx)
	}
	if err != nil {
		return nil, err
	}
	if !h.now().Before(u.expiresAt) {
		return nil, errOwnershipUniverseExpired
	}
	return u, nil
}

// refreshInBackground is the one build a refresh window allows. A failure keeps
// the current universe, and the next request in the window starts another. The
// flag clears on every exit.
func (h *ownershipUniverseHolder) refreshInBackground(ctx context.Context) {
	defer func() {
		h.mu.Lock()
		h.refreshing = false
		h.mu.Unlock()
	}()
	if _, _, err := h.buildShared(ctx); err != nil && h.logger != nil {
		h.logger.Warnf("ownership universe refresh failed; serving the current universe: %v", err)
	}
}

// buildShared runs one build for every caller that arrives while it is in
// flight. The build is detached from any one caller's cancellation, so a client
// that goes away fails nobody else, and it is bounded by ownershipBuildTimeout.
// A successful build is swapped in before any caller sees it. joined reports
// that this caller waited on a build another caller had started.
func (h *ownershipUniverseHolder) buildShared(ctx context.Context) (*ownershipUniverse, bool, error) {
	led := false
	v, err, _ := h.sf.Do("universe", func() (any, error) {
		led = true
		u, err := h.buildOnce(ctx)
		if err != nil {
			return nil, err
		}
		return u, nil
	})
	joined := !led
	if err != nil {
		return nil, joined, err
	}
	return v.(*ownershipUniverse), joined, nil
}

// buildOnce is one build: stamped as it starts, and swapped in on success. A
// panic fails the build and is logged rather than crashing the process. A
// refresh runs on no request's goroutine, and singleflight would re-raise the
// panic in every caller that joined the build.
func (h *ownershipUniverseHolder) buildOnce(ctx context.Context) (u *ownershipUniverse, err error) {
	defer func() {
		if r := recover(); r != nil {
			if h.logger != nil {
				h.logger.Errorf("ownership universe build panicked: %v\n%s", r, debug.Stack())
			}
			u, err = nil, fmt.Errorf("ownership universe build panicked: %v", r)
		}
	}()
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownershipBuildTimeout)
	defer cancel()
	built, err := h.build(bctx)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.cur = built
	h.mu.Unlock()
	return built, nil
}
