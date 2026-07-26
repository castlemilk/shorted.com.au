package reportextract

import (
	"strings"
	"testing"
)

// The model routinely wraps its "STRICT JSON" in a markdown fence; the two
// re.sub calls are the only thing between that and a parse failure.
func TestParseDigestJSON(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    digestResult
		wantErr bool
	}{
		{
			name: "plain json",
			raw:  `{"digest":"Revenue up 8%.","confidence":0.82,"key_takeaways":["a","b"]}`,
			want: digestResult{Digest: "Revenue up 8%.", Confidence: 0.82, KeyTakeaways: []string{"a", "b"}},
		},
		{
			name: "json fence",
			raw:  "```json\n{\"digest\":\"x\",\"confidence\":0.5,\"key_takeaways\":[]}\n```",
			want: digestResult{Digest: "x", Confidence: 0.5, KeyTakeaways: []string{}},
		},
		{
			name: "bare fence",
			raw:  "```\n{\"digest\":\"y\",\"confidence\":0.1}\n```",
			want: digestResult{Digest: "y", Confidence: 0.1},
		},
		{
			name: "surrounding whitespace",
			raw:  "\n\n  {\"digest\":\"z\"}  \n",
			want: digestResult{Digest: "z"},
		},
		{
			name: "missing keys default to zero values",
			raw:  `{"confidence":0.9}`,
			want: digestResult{Confidence: 0.9},
		},
		{name: "not json", raw: "I could not read this report.", wantErr: true},
		{name: "empty", raw: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseDigestJSON(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Digest != tt.want.Digest || got.Confidence != tt.want.Confidence {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
			if len(got.KeyTakeaways) != len(tt.want.KeyTakeaways) {
				t.Errorf("key_takeaways: got %v, want %v", got.KeyTakeaways, tt.want.KeyTakeaways)
			}
		})
	}
}

func TestBuildDigestContentShape(t *testing.T) {
	got := buildDigestContent(map[string]any{"revenue": map[string]any{"value_millions": "5142"}}, "Report body text")
	for _, want := range []string{
		"## Extracted metrics (JSON)",
		`"value_millions": "5142"`,
		"## Report text excerpt",
		"Report body text",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}

	// §6.3(b): with no metrics the model still gets the (wide) text window.
	const marker = "## Report text excerpt\n"
	empty := buildDigestContent(nil, strings.Repeat("x", digestTextChars+500))
	if !strings.Contains(empty, "## Extracted metrics (JSON)\n{}") {
		t.Errorf("nil metrics must render as {}, got:\n%.120s", empty)
	}
	_, excerpt, found := strings.Cut(empty, marker)
	if !found {
		t.Fatalf("excerpt marker missing:\n%.200s", empty)
	}
	if n := len(excerpt); n != digestTextChars {
		t.Errorf("report excerpt not truncated to %d chars, got %d", digestTextChars, n)
	}
}

func TestDigestConstantsMatchPython(t *testing.T) {
	if digestTextChars != 16000 || minDigestChars != 400 || digestTemperature != 0.2 {
		t.Errorf("digest tuning drifted: chars=%d min=%d temp=%v (want 16000/400/0.2)",
			digestTextChars, minDigestChars, digestTemperature)
	}
	if digestModel != "gemini-2.5-flash" {
		t.Errorf("digest_model column value drifted: %q", digestModel)
	}
	if !strings.Contains(digestPrompt, `Output STRICT JSON: {"digest": "...", "confidence": 0.0-1.0, "key_takeaways": ["...", "..."]}`) {
		t.Error("digest prompt's output contract drifted")
	}
}

// summarize_report reads GEMINI_API_KEY first; langextract reads
// LANGEXTRACT_API_KEY first. Both orders are separate call-site contracts.
func TestDigestAPIKeyPrefersGeminiVar(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "gem-key")
	t.Setenv("LANGEXTRACT_API_KEY", "lx-key")
	if got := digestAPIKey(); got != "gem-key" {
		t.Errorf("got %q, want the GEMINI_API_KEY value", got)
	}
	t.Setenv("GEMINI_API_KEY", "")
	if got := digestAPIKey(); got != "lx-key" {
		t.Errorf("got %q, want the LANGEXTRACT_API_KEY fallback", got)
	}
}
