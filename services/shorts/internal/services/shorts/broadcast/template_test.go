package broadcast

import (
	"strings"
	"testing"
)

func TestRenderIncludesUnsubAndSenderID(t *testing.T) {
	html := RenderHTML("Weekly report", "<p>hi</p>", "https://shorted.com.au/unsubscribe?t=TOK")
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
