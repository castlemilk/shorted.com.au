package shortdatasync

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// algoliaSyncScript is the in-image script the Python preferred when present.
// It has never existed in any deployed image (the Python image has no
// /app/scripts), so in practice the URL branch below is the live one; both are
// kept so the env contract does not change under an operator.
const algoliaSyncScript = "/app/scripts/sync-search-index.sh"

// algoliaTimeout matches the Python's 300s subprocess/HTTP timeout.
const algoliaTimeout = 300 * time.Second

// triggerAlgoliaSync reproduces trigger_algolia_sync(): it runs only when
// SYNC_ALGOLIA=true (checked by the caller), needs ALGOLIA_APP_ID +
// ALGOLIA_ADMIN_KEY, then either runs the in-image sync script or POSTs
// ALGOLIA_SYNC_URL with a bearer token.
//
// Every failure is logged and swallowed — an index refresh must never fail a
// run whose data is already committed.
func triggerAlgoliaSync(ctx context.Context, client *http.Client) {
	appID := os.Getenv("ALGOLIA_APP_ID")
	adminKey := os.Getenv("ALGOLIA_ADMIN_KEY")
	if appID == "" || adminKey == "" {
		log.Printf("⚠️  Algolia credentials not configured, skipping index sync")
		return
	}
	log.Printf("🔍 Triggering Algolia index sync...")

	if _, err := os.Stat(algoliaSyncScript); err == nil {
		runAlgoliaScript(ctx, appID, adminKey)
		return
	}

	syncURL := os.Getenv("ALGOLIA_SYNC_URL")
	if syncURL == "" {
		log.Printf("ℹ️  No Algolia sync mechanism configured (set ALGOLIA_SYNC_URL or include sync script)")
		return
	}
	postAlgoliaSync(ctx, client, syncURL)
}

// runAlgoliaScript executes the in-image sync script with the same environment
// overlay the Python passed.
func runAlgoliaScript(ctx context.Context, appID, adminKey string) {
	runCtx, cancel := context.WithTimeout(ctx, algoliaTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, algoliaSyncScript) //nolint:gosec // fixed in-image path, no user input
	cmd.Env = append(os.Environ(),
		"ALGOLIA_APP_ID="+appID,
		"ALGOLIA_ADMIN_KEY="+adminKey,
		"ALGOLIA_INDEX="+envOr("ALGOLIA_INDEX", "stocks"),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("❌ Algolia sync failed: %v: %s", err, truncateBytes(out, 500))
		return
	}
	log.Printf("✅ Algolia sync completed successfully")
}

// postAlgoliaSync POSTs the external sync endpoint.
func postAlgoliaSync(ctx context.Context, client *http.Client, syncURL string) {
	reqCtx, cancel := context.WithTimeout(ctx, algoliaTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, syncURL, nil)
	if err != nil {
		log.Printf("❌ Algolia sync request failed: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("ALGOLIA_SYNC_TOKEN"))

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("❌ Algolia sync request failed: %v", err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		log.Printf("❌ Algolia sync failed: %d", resp.StatusCode)
		return
	}
	log.Printf("✅ Algolia sync triggered successfully")
}

func truncateBytes(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n])
}
