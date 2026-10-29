package shorts

// adapters_ingest_rigs.go forwards the housing crawl allowlist through StoreAdapter.
//
// The admin crawl tools reach the allowlist by type assertion
// (adminMCPSource.CrawlRigStore in mcp_admin_crawl.go). serve.go hands them the
// adapter, not the Postgres store under it, so every method of
// shorts.IngestRigAdminStore must be forwarded here. Without them the assertion
// fails and housing_crawl_rigs and housing_crawl_authorize report the allowlist as
// not configured. TestCrawlRigStoreReachableThroughTheAdapter pins this.

import (
	"context"
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ingestRigStoreOf returns the underlying store's allowlist view, or an error naming
// the gap when the backend does not provide one.
func (s *StoreAdapter) ingestRigStoreOf() (shorts.IngestRigAdminStore, error) {
	r, ok := s.store.(shorts.IngestRigAdminStore)
	if !ok {
		return nil, fmt.Errorf("the store backend (%T) does not provide the housing crawl allowlist", s.store)
	}
	return r, nil
}

func (s *StoreAdapter) ListIngestRigs(ctx context.Context) ([]shorts.IngestRig, error) {
	r, err := s.ingestRigStoreOf()
	if err != nil {
		return nil, err
	}
	return r.ListIngestRigs(ctx)
}

func (s *StoreAdapter) IngestRigState(ctx context.Context, subject string) (present, enabled bool, err error) {
	r, err := s.ingestRigStoreOf()
	if err != nil {
		return false, false, err
	}
	return r.IngestRigState(ctx, subject)
}

func (s *StoreAdapter) EnableIngestRig(ctx context.Context, subject string, note *string) (wasEnabled bool, err error) {
	r, err := s.ingestRigStoreOf()
	if err != nil {
		return false, err
	}
	return r.EnableIngestRig(ctx, subject, note)
}

func (s *StoreAdapter) DisableIngestRig(ctx context.Context, subject string) (outcome string, err error) {
	r, err := s.ingestRigStoreOf()
	if err != nil {
		return "", err
	}
	return r.DisableIngestRig(ctx, subject)
}
