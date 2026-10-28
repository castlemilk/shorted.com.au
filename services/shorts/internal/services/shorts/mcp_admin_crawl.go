package shorts

// mcp_admin_crawl.go: the housing-crawl half of the admin MCP operator. It adapts
// the allowlist store (housing_ingest_rigs) and the BrandBrain grant client to the
// types internal/mcp uses, behind the housing_crawl_rigs and
// housing_crawl_authorize tools (internal/mcp/admin_crawl.go).

import (
	"context"
	"os"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// brandbrainGrantClientFromEnv returns the BrandBrain grant client, or nil when the
// grant token is unset or the base URL is refused. A refused URL is logged once here;
// the message names the variable, never the token.
func brandbrainGrantClientFromEnv() mcp.CrawlGrantClient {
	c, err := brandbrain.FromEnv(os.Getenv)
	if err != nil {
		log.Errorf("admin housing crawl: %v; the BrandBrain grant tools are not configured", err)
		return nil
	}
	if c == nil {
		return nil
	}
	return c
}

// adminCrawlStore adapts the store's allowlist to mcp.CrawlRigStore.
type adminCrawlStore struct {
	store shortsstore.IngestRigAdminStore
}

func (a adminCrawlStore) ListCrawlRigs(ctx context.Context) ([]mcp.CrawlRigRow, error) {
	rows, err := a.store.ListIngestRigs(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlRigRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcp.CrawlRigRow{Subject: r.Subject, Enabled: r.Enabled, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

func (a adminCrawlStore) CrawlRigState(ctx context.Context, subject string) (bool, bool, error) {
	return a.store.IngestRigState(ctx, subject)
}

func (a adminCrawlStore) EnableCrawlRig(ctx context.Context, subject string, note *string) (bool, error) {
	return a.store.EnableIngestRig(ctx, subject, note)
}

func (a adminCrawlStore) DisableCrawlRig(ctx context.Context, subject string) (string, error) {
	return a.store.DisableIngestRig(ctx, subject)
}

// CrawlRigStore is nil when the store does not provide the allowlist, which the
// tools report as not configured.
func (a *adminMCPSource) CrawlRigStore() mcp.CrawlRigStore {
	if a == nil || a.server == nil {
		return nil
	}
	s, ok := a.server.store.(shortsstore.IngestRigAdminStore)
	if !ok {
		return nil
	}
	return adminCrawlStore{store: s}
}

// CrawlGrants is nil (not a typed nil) when BRANDBRAIN_HOUSING_GRANT_TOKEN is unset.
func (a *adminMCPSource) CrawlGrants() mcp.CrawlGrantClient {
	if a == nil || a.crawlGrants == nil {
		return nil
	}
	return a.crawlGrants
}

// CrawlOperatorEmail is the caller's verified address, sent to BrandBrain as
// X-Operator. Empty when it cannot be read: BrandBrain then records no operator, and
// the tool still runs.
func (a *adminMCPSource) CrawlOperatorEmail(ctx context.Context, userID string) string {
	if a == nil || a.verifiedEmail == nil {
		return ""
	}
	email, err := a.verifiedEmail(ctx, userID)
	if err != nil {
		return ""
	}
	return email
}

// CrawlIngestAdmission is "true", "false" or "unknown": whether the deployed housing-ingest
// admits subject. It never gates a change.
func (a *adminMCPSource) CrawlIngestAdmission(ctx context.Context, subject string) string {
	if a == nil {
		return "unknown"
	}
	return a.crawlIngest.Admits(ctx, subject)
}
