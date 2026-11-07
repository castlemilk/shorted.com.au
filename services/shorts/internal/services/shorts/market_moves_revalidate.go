package shorts

// market_moves_revalidate.go tells the web tier a move changed, so the pages
// that draw moves re-render instead of waiting out their ISR window (the
// homepage holds for 24 hours, a stock page for one).
//
// Best effort, like every other revalidation ping (services/jobs/internal/
// platform/revalidate.go): a failed ping never fails the post, and with
// REVALIDATION_URL or REVALIDATION_SECRET unset nothing is sent and the pages
// catch up on their own windows.
//
// Posts arrive in bursts (a workflow posts its whole read of the market in a
// minute), so the pings are coalesced: the first change starts a window of
// marketMovesRevalidateDelay, every change inside it adds its tags and paths,
// and one request carries them all when it closes.
//
// The web reads moves under three tags (web/src/app/actions/market-moves/):
// market-moves (the feed page), market-moves:home (the homepage strip) and
// market-moves:stock:<CODE> (a stock page's card). The paths are named too, so
// a page that has not read under a tag yet still re-renders.

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const marketMovesRevalidateDelay = 15 * time.Second

// marketMovesRevalidator coalesces revalidation pings. A nil one does nothing.
type marketMovesRevalidator struct {
	endpoint string
	secret   string
	client   *http.Client
	delay    time.Duration
	logger   Logger

	mu      sync.Mutex
	tags    map[string]bool
	paths   map[string]bool
	pending bool
}

// newMarketMovesRevalidator returns nil when the web endpoint is not configured.
func newMarketMovesRevalidator(logger Logger) *marketMovesRevalidator {
	endpoint := strings.TrimSpace(os.Getenv("REVALIDATION_URL"))
	secret := strings.TrimSpace(os.Getenv("REVALIDATION_SECRET"))
	if endpoint == "" || secret == "" {
		if logger != nil {
			logger.Infof("market moves: REVALIDATION_URL/REVALIDATION_SECRET not set; pages pick up moves on their ISR windows")
		}
		return nil
	}
	return &marketMovesRevalidator{
		endpoint: endpoint,
		secret:   secret,
		client:   &http.Client{Timeout: 20 * time.Second},
		delay:    marketMovesRevalidateDelay,
		logger:   logger,
		tags:     map[string]bool{},
		paths:    map[string]bool{},
	}
}

// marketMovesTargets are the tags and paths a change to a move naming codes
// makes stale.
func marketMovesTargets(codes []string) (tags, paths []string) {
	tags = []string{"market-moves", "market-moves:home"}
	paths = []string{"/", "/market-moves"}
	for _, code := range codes {
		tags = append(tags, "market-moves:stock:"+code)
		paths = append(paths, "/shorts/"+code)
	}
	return tags, paths
}

// notify records a change and opens a window if none is open.
func (r *marketMovesRevalidator) notify(codes []string) {
	if r == nil {
		return
	}
	tags, paths := marketMovesTargets(codes)
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range tags {
		r.tags[t] = true
	}
	for _, p := range paths {
		r.paths[p] = true
	}
	if r.pending {
		return
	}
	r.pending = true
	time.AfterFunc(r.delay, r.flush)
}

// flush sends one ping for everything gathered in the window.
func (r *marketMovesRevalidator) flush() {
	r.mu.Lock()
	tags, paths := sortedKeys(r.tags), sortedKeys(r.paths)
	r.tags, r.paths, r.pending = map[string]bool{}, map[string]bool{}, false
	r.mu.Unlock()
	if len(tags) == 0 && len(paths) == 0 {
		return
	}

	q := url.Values{}
	q.Set("tag", strings.Join(tags, ","))
	q.Set("path", strings.Join(paths, ","))
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint+"?"+q.Encode(), nil)
	if err != nil {
		r.logf("market moves: build revalidation request: %v", err)
		return
	}
	req.Header.Set("X-Revalidate-Secret", r.secret)
	resp, err := r.client.Do(req)
	if err != nil {
		// The error can carry the URL; the secret is a header, never in it.
		r.logf("market moves: revalidation ping failed: %v", err)
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		r.logf("market moves: revalidation ping answered %d", resp.StatusCode)
		return
	}
	if r.logger != nil {
		r.logger.Infof("market moves: revalidated %d tag(s) and %d path(s)", len(tags), len(paths))
	}
}

func (r *marketMovesRevalidator) logf(format string, args ...any) {
	if r.logger != nil {
		r.logger.Warnf(format, args...)
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
