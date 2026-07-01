package broadcast

import (
	"strings"
	"testing"
)

func TestRenderIncludesUnsubAndSenderID(t *testing.T) {
	html := RenderHTML("https://shorted.com.au", "Weekly report", "<p>hi</p>", "https://shorted.com.au/unsubscribe?t=TOK")
	for _, want := range []string{"https://shorted.com.au/unsubscribe?t=TOK", "Gamma Systems Pty Ltd", "ABN 52 682 863 690", "<p>hi</p>"} {
		if !strings.Contains(html, want) {
			t.Fatalf("rendered HTML missing %q", want)
		}
	}
	text := RenderText("Weekly report", "hi", "https://shorted.com.au/unsubscribe?t=TOK")
	if !strings.Contains(text, "unsubscribe?t=TOK") || !strings.Contains(text, "Gamma Systems Pty Ltd") {
		t.Fatal("text body missing unsubscribe or sender ID")
	}
}

func TestRenderIncludesLogo(t *testing.T) {
	html := RenderHTML("https://shorted.com.au", "Weekly report", "<p>hi</p>", "https://shorted.com.au/unsubscribe?t=TOK")
	if !strings.Contains(html, `src="https://shorted.com.au/email/logo.png"`) {
		t.Fatal("rendered HTML missing absolute logo image")
	}
	if !strings.Contains(html, `alt="Shorted"`) {
		t.Fatal("logo image missing alt text")
	}
}

func TestRenderLogoFallsBackToDefaultOrigin(t *testing.T) {
	// Empty siteURL must still yield an absolute asset URL (email clients can't
	// resolve relative paths).
	html := RenderHTML("", "T", "<p>b</p>", "https://shorted.com.au/unsubscribe?t=T")
	if !strings.Contains(html, `src="https://shorted.com.au/email/logo.png"`) {
		t.Fatalf("empty siteURL should fall back to default origin, got:\n%s", html)
	}
}

func TestRenderDarkShellRobustness(t *testing.T) {
	// Gmail/Outlook drop a background set only on <body>; the dark canvas must
	// come from a bgcolor table, the fixed width from an MSO ghost table, and
	// the inner container must carry its own light text colour.
	html := RenderHTML("https://shorted.com.au", "T", "<p>b</p>", "u")
	for _, want := range []string{
		`bgcolor="#0b0f16"`,          // full-width dark canvas table
		`<!--[if mso]>`,              // Outlook ghost table opens
		`width="600"`,                // fixed width for the Word engine
		`max-width:600px;margin:0 auto;padding:24px;color:#e7edf5`, // inner div carries colour
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("shell missing %q", want)
		}
	}
}

func TestRenderLogoTrimsTrailingSlash(t *testing.T) {
	html := RenderHTML("https://preview.example.com/", "T", "<p>b</p>", "u")
	if !strings.Contains(html, `src="https://preview.example.com/email/logo.png"`) {
		t.Fatal("trailing slash on siteURL should be normalised")
	}
	if strings.Contains(html, "example.com//email") {
		t.Fatal("double slash in asset URL")
	}
}
