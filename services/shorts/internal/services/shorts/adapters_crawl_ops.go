package shorts

// adapters_crawl_ops.go forwards the housing crawl ledger view through StoreAdapter.
//
// The admin crawl tools reach the ledger by type assertion (adminMCPSource.CrawlOps in
// mcp_admin_crawl_ops.go). serve.go hands them the adapter, not the Postgres store under
// it, so every method of shorts.CrawlOpsAdminStore must be forwarded here. Without them
// the assertion fails and housing_crawl_status, _failures, _job and the smoke tools report
// the ledger as "not configured" (shipped that way in #815).
// TestAdminStoreViewsReachableThroughTheAdapter pins this for every admin view.

import (
	"context"
	"fmt"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// crawlOpsStoreOf returns the underlying store's ledger view, or an error naming the gap
// when the backend does not provide one.
func (s *StoreAdapter) crawlOpsStoreOf() (shorts.CrawlOpsAdminStore, error) {
	c, ok := s.store.(shorts.CrawlOpsAdminStore)
	if !ok {
		return nil, fmt.Errorf("the store backend (%T) does not provide the housing crawl ledger", s.store)
	}
	return c, nil
}

func (s *StoreAdapter) CrawlDispatchOpen(ctx context.Context) (int64, int64, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return 0, 0, err
	}
	return c.CrawlDispatchOpen(ctx)
}

func (s *StoreAdapter) CrawlReceiptGroups(ctx context.Context, since time.Time, rigSubject string, statuses []string) ([]shorts.CrawlReceiptGroup, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlReceiptGroups(ctx, since, rigSubject, statuses)
}

func (s *StoreAdapter) CrawlQuarantineReasons(ctx context.Context, since time.Time, rigSubject string) ([]shorts.CrawlReasonCount, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlQuarantineReasons(ctx, since, rigSubject)
}

func (s *StoreAdapter) CrawlFinalizeWatermark(ctx context.Context) (time.Time, time.Time, bool, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return time.Time{}, time.Time{}, false, err
	}
	return c.CrawlFinalizeWatermark(ctx)
}

func (s *StoreAdapter) CrawlDispatchForRun(ctx context.Context, runID string) ([]shorts.CrawlDispatchRow, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlDispatchForRun(ctx, runID)
}

func (s *StoreAdapter) CrawlOpenDispatchForSuburb(ctx context.Context, slug string) ([]shorts.CrawlDispatchRow, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlOpenDispatchForSuburb(ctx, slug)
}

func (s *StoreAdapter) CrawlDispatchForJob(ctx context.Context, jobID string) (*shorts.CrawlDispatchRow, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlDispatchForJob(ctx, jobID)
}

func (s *StoreAdapter) CrawlReceiptsForJob(ctx context.Context, jobID string) ([]shorts.CrawlReceipt, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlReceiptsForJob(ctx, jobID)
}

func (s *StoreAdapter) CrawlQuarantineForJob(ctx context.Context, jobID string) ([]shorts.CrawlQuarantineEntry, error) {
	c, err := s.crawlOpsStoreOf()
	if err != nil {
		return nil, err
	}
	return c.CrawlQuarantineForJob(ctx, jobID)
}
