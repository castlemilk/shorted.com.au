package ownership

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Shared with the model reader. These are synthetic format-guard cases, not
// extraction goldens or evidence that every future notice layout is supported.
func TestReformFormatGuard(t *testing.T) {
	data, err := os.ReadFile("testdata/notices/reform_format_guard.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			ID              string `json:"id"`
			Text            string `json:"text"`
			Headline        string `json:"headline"`
			ExpectedFormat  string `json:"expected_format"`
			ExpectedOutcome string `json:"expected_outcome"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixtures.Cases {
		t.Run(tc.ID, func(t *testing.T) {
			if got := unsupportedNoticeFormat(tc.Text); got != tc.ExpectedFormat {
				t.Fatalf("format = %q, want %q", got, tc.ExpectedFormat)
			}
			n, outcome, detail := parseSubstantialNotice(tc.Text, tc.Headline)
			if string(outcome) != tc.ExpectedOutcome {
				t.Fatalf("outcome = %s (%s), want %s; notice=%+v", outcome, detail, tc.ExpectedOutcome, n)
			}
			if tc.ExpectedOutcome == "unsupported_format" && (n.Ceased || n.PresentPct != nil || n.PreviousPct != nil || n.PresentVotes != nil || n.PreviousVotes != nil) {
				t.Fatalf("unsupported format produced a derived holding: %+v", n)
			}
		})
	}
}

func TestSHNHeadlineIsSelectedWithoutPretendingItIsLegacy(t *testing.T) {
	for _, headline := range []string{"Substantial Holding Notice", "Revised substantial holding notice from Example Investments"} {
		if !IsSubstantialHoldingHeadline(headline) {
			t.Errorf("new headline not selected: %q", headline)
		}
		if got := formFromHeadline(headline); got != "" {
			t.Errorf("new headline became legacy form %q", got)
		}
	}
}

func TestReformNoticePassKeepsSourceWithoutWritingAHolding(t *testing.T) {
	data, err := os.ReadFile("testdata/notices/reform_format_guard.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct{ ID, Text string } `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	var text string
	for _, tc := range fixtures.Cases {
		if tc.ID == "shn_ceasing" {
			text = tc.Text
		}
	}
	if text == "" {
		t.Fatal("missing synthetic SHN fixture")
	}
	const source = "https://example.test/synthetic-shn.pdf"
	store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{
		{URL: source, Headline: "Ceasing to be a substantial holder", AnnouncedOn: "2026-12-04", ListedCodes: []string{"ZIP"}},
	}}
	pass := &noticePass{store: store, pdfs: fakePDFs{source: text}, extractor: passthrough{}, workers: 1, logf: t.Logf}
	result, err := pass.run(context.Background(), 10, "2026-01-01")
	if err != nil {
		t.Fatal(err)
	}
	if result.Parsed != 0 || len(store.rows) != 0 || result.Outcomes["unsupported_format"] != 1 {
		t.Fatalf("new-format notice produced a holding or lost its outcome: %+v, rows=%+v", result, store.rows)
	}
	attempt, ok := store.attempts[source]
	if !ok || attempt.URL != source || attempt.Outcome != "unsupported_format" || !strings.Contains(attempt.Detail, "identified shn") {
		t.Fatalf("source/reprocessing evidence not preserved: %+v", attempt)
	}
}
