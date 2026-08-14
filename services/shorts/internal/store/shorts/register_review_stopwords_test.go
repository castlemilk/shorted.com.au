package shorts

// The console warns a reviewer before they resolve a declared name onto a code
// that is really an ordinary word. That warning is only as good as its list, and
// the list lives in ANOTHER GO MODULE (services/jobs), so it had to be copied.
//
// A copied security-critical list is exactly the defect class this subsystem has
// already paid for twice: the entity_kind fiction was defaulted in three layers
// and fixing two of them left the API still serving it, and the "not matched to
// an ASX listing" wording was fixed in the SQL while the Go mapper kept
// producing it. So the copy is not trusted — it is asserted, against the
// original, read from disk.
//
// If this test fails, the two lists have diverged. Copy the jobs list into
// registerReviewTickerStopwords; do not edit this test to agree with the copy.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// sourceOfTruth is influence.tickerStopwords. Relative from
// services/shorts/internal/store/shorts.
const stopwordSourcePath = "../../../../jobs/internal/jobs/influence/aph_resolve.go"

var stopwordEntryRe = regexp.MustCompile(`"([A-Z]+)":\s*true`)

func TestTickerStopwordsMatchTheResolver(t *testing.T) {
	src, err := os.ReadFile(filepath.Clean(stopwordSourcePath))
	if err != nil {
		t.Fatalf("cannot read the resolver's stopword list at %s: %v", stopwordSourcePath, err)
	}

	body := string(src)
	start := strings.Index(body, "var tickerStopwords = map[string]bool{")
	if start == -1 {
		t.Fatal("tickerStopwords is no longer declared in aph_resolve.go; this mirror has lost its source")
	}
	end := strings.Index(body[start:], "\n}")
	if end == -1 {
		t.Fatal("unterminated tickerStopwords declaration")
	}

	want := map[string]bool{}
	for _, m := range stopwordEntryRe.FindAllStringSubmatch(body[start:start+end], -1) {
		want[m[1]] = true
	}
	if len(want) < 20 {
		t.Fatalf("parsed only %d stopwords from the resolver; the parser is wrong, not the list", len(want))
	}

	for code := range want {
		if !registerReviewTickerStopwords[code] {
			t.Errorf("resolver treats %q as a stopword ticker; the console does not warn about it", code)
		}
	}
	for code := range registerReviewTickerStopwords {
		if !want[code] {
			t.Errorf("console warns about %q; the resolver does not treat it as a stopword", code)
		}
	}
}

// The mapping from a console decision to what gets WRITTEN is the whole safety
// story: 'resolved' is the only value that may carry a code, and there is no
// path to a fuzzy match at all.
func TestAliasWriteForIsClosedAndSafe(t *testing.T) {
	cases := []struct {
		decision   string
		kindIn     string
		resolution string
		kind       string
	}{
		{"resolved", "etf", "resolved", "etf"},
		{"resolved", "lic", "resolved", "lic"},
		// An unspecified kind is descriptive metadata only, so it defaults —
		// but it must default to the LEAST specific claim, never to 'etf'.
		{"resolved", "", "resolved", "equity"},
		{"resolved", "nonsense", "resolved", "equity"},
		{"unlisted_fund", "", "unlisted_fund", "managed_fund"},
		{"not_a_security", "", "not_a_security", "noise"},
		{"foreign", "", "foreign", "foreign"},
	}
	for _, c := range cases {
		resolution, kind, err := aliasWriteFor(c.decision, c.kindIn)
		if err != nil {
			t.Errorf("%s/%s: unexpected error %v", c.decision, c.kindIn, err)
			continue
		}
		if resolution != c.resolution || kind != c.kind {
			t.Errorf("%s/%s -> (%q,%q), want (%q,%q)",
				c.decision, c.kindIn, resolution, kind, c.resolution, c.kind)
		}
	}

	// The public gate (register_item_securities_public_gate) forbids a fuzzy
	// match from ever being 'resolved'. An unknown decision must be an ERROR,
	// never a default: a default here is a published claim about a named person.
	for _, bad := range []string{"analyst_fuzzy", "probable", "", "RESOLVED", "maybe"} {
		if _, _, err := aliasWriteFor(bad, "equity"); err == nil {
			t.Errorf("aliasWriteFor(%q) was accepted; unknown decisions must be refused", bad)
		}
	}
}
