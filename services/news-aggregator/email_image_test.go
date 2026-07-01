package main

import (
	"strings"
	"testing"
)

// TestEmailImageSignatureParity pins the exact vector also asserted by the web
// verifier so the Go signer and the Node route can never silently drift.
func TestEmailImageSignatureParity(t *testing.T) {
	got := emailImageSignature("https://cdn.example.com/a.jpg", 120, "test-secret")
	const want = "f0bb9d0a5b872eb4cb0e8f0a94579d2096a43db8802bb4b5a77256ac6cfdb801"
	if got != want {
		t.Fatalf("signature mismatch:\n got=%s\nwant=%s", got, want)
	}
}

func TestEmailImageURL(t *testing.T) {
	u := emailImageURL("https://shorted.com.au", "sekret", "https://cdn.x/y.png", 120)
	if !strings.HasPrefix(u, "https://shorted.com.au/api/email/img?") {
		t.Fatalf("bad prefix: %s", u)
	}
	for _, want := range []string{"u=https%3A%2F%2Fcdn.x%2Fy.png", "w=120", "s="} {
		if !strings.Contains(u, want) {
			t.Fatalf("url %s missing %q", u, want)
		}
	}
}

func TestEmailImageURLEmptyWhenUnusable(t *testing.T) {
	cases := []struct{ site, secret, raw string }{
		{"", "s", "https://x/y"},            // no site
		{"https://s", "", "https://x/y"},    // no secret
		{"https://s", "s", ""},              // no url
		{"https://s", "s", "ftp://x/y"},     // non-http scheme
		{"https://s", "s", "/relative.png"}, // relative
	}
	for _, c := range cases {
		if got := emailImageURL(c.site, c.secret, c.raw, 120); got != "" {
			t.Errorf("expected empty for %+v, got %q", c, got)
		}
	}
}
