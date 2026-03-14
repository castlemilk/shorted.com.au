package enrichment

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

func TestChromiumSanity(t *testing.T) {
	if testing.Short() {
		t.Skip("requires chromium")
	}

	t.Log("Creating Chromium client...")
	client, err := stealthhttp.NewChromium(
		stealthhttp.WithTimeout(15*time.Second),
		stealthhttp.WithExecPath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
	)
	if err != nil {
		t.Fatalf("NewChromium failed: %v", err)
	}
	defer func() { _ = client.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	t.Log("Fetching page...")
	doc, finalURL, fetchErr := client.FetchHTML(ctx, "https://duckduckgo.com/?q=test")
	if fetchErr != nil {
		t.Fatalf("FetchHTML failed: %v", fetchErr)
	}

	title := doc.Find("title").Text()
	t.Logf("Success! title=%q finalURL=%v", title, finalURL)
}
