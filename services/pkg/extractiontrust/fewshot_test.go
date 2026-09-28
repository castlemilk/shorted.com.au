package extractiontrust

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/fewshot_example.json from the Go value")

const fewShotJSONPath = "testdata/fewshot_example.json"

func marshalExample(t *testing.T, ex Example) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(ex); err != nil {
		t.Fatalf("marshal example: %v", err)
	}
	return buf.Bytes()
}

// The JSON mirror the Python extractor loads (or copies) must equal the Go
// value byte for byte. Regenerate with:
//
//	GOWORK=off go test ./pkg/extractiontrust/ -run TestFewShotExampleJSONMirror -update
func TestFewShotExampleJSONMirror(t *testing.T) {
	want := marshalExample(t, FewShotExample())
	if *update {
		if err := os.WriteFile(fewShotJSONPath, want, 0o644); err != nil {
			t.Fatalf("write %s: %v", fewShotJSONPath, err)
		}
	}
	got, err := os.ReadFile(fewShotJSONPath)
	if err != nil {
		t.Fatalf("read %s: %v", fewShotJSONPath, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s drifted from FewShotExample(); rerun with -update.\n got: %s\nwant: %s", fewShotJSONPath, got, want)
	}
	var parsed Example
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("parse %s: %v", fewShotJSONPath, err)
	}
	if !reflect.DeepEqual(parsed, FewShotExample()) {
		t.Fatalf("%s does not round-trip to FewShotExample()", fewShotJSONPath)
	}
}

// The synthetic example keeps the stored metric vocabulary: the same classes in
// the same order, and per class the same attribute keys, as the example it
// replaces. Only the document and its figures change.
func TestFewShotExampleKeepsTheVocabulary(t *testing.T) {
	ex := FewShotExample()
	if len(ex.Extractions) != len(oldFewShotExample.Extractions) {
		t.Fatalf("extraction count %d, want %d", len(ex.Extractions), len(oldFewShotExample.Extractions))
	}
	wantClasses := []string{"revenue", "net_profit", "eps", "dividend", "cash_flow", "ebitda", "guidance"}
	for i, e := range ex.Extractions {
		old := oldFewShotExample.Extractions[i]
		if e.Class != wantClasses[i] || old.Class != wantClasses[i] {
			t.Errorf("extraction %d class %q (old %q), want %q", i, e.Class, old.Class, wantClasses[i])
		}
		if got, want := sortedKeys(e.Attributes), sortedKeys(old.Attributes); !reflect.DeepEqual(got, want) {
			t.Errorf("%s attribute keys %v, want %v (the old example's)", e.Class, got, want)
		}
	}
}

func TestFewShotExampleIsSyntheticAndSelfConsistent(t *testing.T) {
	ex := FewShotExample()
	if ex.Entity != "Quokka Minerals Limited" || ex.ASXCode != "QKA" || ex.Period != "H1 FY2031" {
		t.Errorf("example identity = %q / %q / %q", ex.Entity, ex.ASXCode, ex.Period)
	}
	if !strings.Contains(ex.Text, "Quokka Minerals Limited (ASX: QKA)") {
		t.Error("the document must name the fictional entity and code")
	}
	oldFigures := regexp.MustCompile(`5,142|5142|1,823|1823|94\.2|2,156|2156|2,891|2891|56\.2|FY2025|2024`)
	for _, e := range ex.Extractions {
		// langextract aligns the example exactly only when the quote is in the
		// text verbatim (the old revenue quote spanned a line break).
		if !strings.Contains(ex.Text, e.Text) {
			t.Errorf("%s: extraction_text not verbatim in the document: %q", e.Class, e.Text)
		}
		if m := oldFigures.FindString(e.Text); m != "" {
			t.Errorf("%s: reuses the old example's %q", e.Class, m)
		}
		for k, v := range e.Attributes {
			if m := oldFigures.FindString(v); m != "" {
				t.Errorf("%s.%s = %q reuses the old example's %q", e.Class, k, v, m)
			}
		}
		// Every value attribute's digits appear in the quote (the 6.1 rule the
		// extractor applies to real extractions holds for its own example).
		for _, k := range []string{"value_millions", "value_cents", "margin_pct"} {
			v, ok := e.Attributes[k]
			if !ok {
				continue
			}
			if !strings.Contains(strings.ReplaceAll(e.Text, ",", ""), v) {
				t.Errorf("%s.%s = %q not in its quote %q", e.Class, k, v, e.Text)
			}
		}
		// Flow periods are the synthetic half; guidance is its full year.
		wantPeriod := "H1 FY2031"
		if e.Class == "guidance" {
			wantPeriod = "FY2031"
		}
		if e.Attributes["period"] != wantPeriod {
			t.Errorf("%s period %q, want %q", e.Class, e.Attributes["period"], wantPeriod)
		}
		// Every quote names the fictional entity or the synthetic period, so no
		// real filing's quote can equal it (the denylist must never withhold a
		// real figure because of the NEW example).
		if !strings.Contains(e.Text, "Quokka") && !strings.Contains(e.Text, "FY2031") && !strings.Contains(e.Text, "2030") {
			t.Errorf("%s quote carries no synthetic marker: %q", e.Class, e.Text)
		}
	}
}

func TestFewShotExampleReturnsACopy(t *testing.T) {
	a := FewShotExample()
	a.Extractions[0].Attributes["value_millions"] = "1"
	a.Extractions[0].Text = "mutated"
	b := FewShotExample()
	if b.Extractions[0].Attributes["value_millions"] != "3847" || b.Extractions[0].Text == "mutated" {
		t.Fatal("FewShotExample must return a deep copy")
	}
	// Mutating the exported lists cannot open a hole in the denylist.
	saved := append([]string(nil), OldFewShotTexts...)
	for i := range OldFewShotTexts {
		OldFewShotTexts[i] = "x"
	}
	defer copy(OldFewShotTexts, saved)
	if !IsFewShotText("Basic earnings per share was 94.2 cents") {
		t.Fatal("denylist must not read the exported slice")
	}
}

func TestOldFewShotTextsCarryEveryEcho(t *testing.T) {
	for _, want := range []string{
		// Every extraction_text, verbatim.
		"Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
		"Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp",
		"Basic earnings per share was 94.2 cents",
		"interim dividend of 45 cents per share, fully franked",
		"Operating cash flow was $2,156 million",
		"EBITDA was $2,891 million, representing a margin of 56.2%",
		"FY2025 guidance: Revenue growth of 6-8% expected",
		// The document's sentences.
		"Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million, an increase of 8% on the prior corresponding period.",
		"The Board declared an interim dividend of 45 cents per share, fully franked.",
	} {
		if !contains(OldFewShotTexts, want) {
			t.Errorf("OldFewShotTexts lacks %q", want)
		}
	}
	for _, e := range FewShotExample().Extractions {
		if !contains(NewFewShotTexts, e.Text) {
			t.Errorf("NewFewShotTexts lacks %q", e.Text)
		}
	}
	for _, list := range [][]string{OldFewShotTexts, NewFewShotTexts} {
		seen := map[string]bool{}
		for _, s := range list {
			k := fewShotKey(s)
			if k == "" || seen[k] {
				t.Errorf("empty or duplicate entry %q", s)
			}
			seen[k] = true
		}
	}
}

func TestIsFewShotText(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		// The echo rows stored on prod (BHP, CBA, DRO, EDV, MSB).
		{"prod echo revenue", "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", true},
		{"prod echo npat", "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", true},
		{"prod echo eps", "Basic earnings per share was 94.2 cents", true},
		{"prod echo dividend", "interim dividend of 45 cents per share, fully franked", true},
		{"prod echo ocf", "Operating cash flow was $2,156 million", true},
		{"prod echo ebitda", "EBITDA was $2,891 million, representing a margin of 56.2%", true},
		{"prod echo guidance", "FY2025 guidance: Revenue growth of 6-8% expected", true},
		// Normalisation: case, whitespace, line breaks, typographic dashes,
		// trailing sentence punctuation.
		{"upper case", "BASIC EARNINGS PER SHARE WAS 94.2 CENTS", true},
		{"wrapped like the prompt", "Revenue from continuing operations for the half year ended 31 December 2024\nwas $5,142 million", true},
		{"trailing period", "Basic earnings per share was 94.2 cents.", true},
		{"padded", "  Operating cash flow was $2,156 million  ", true},
		{"en dash", "FY2025 guidance: Revenue growth of 6\u20138% expected", true},
		{"nbsp", "Operating\u00A0cash flow was $2,156\u00A0million", true},
		{"old whole sentence", "The Board declared an interim dividend of 45 cents per share, fully franked.", true},
		// The new synthetic example is denied the same way.
		{"new revenue", "Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million", true},
		{"new eps", "basic earnings per share was 48.3 cents for h1 fy2031", true},
		{"new header", "Quokka Minerals Limited (ASX: QKA) Appendix 4D and half year report for H1 FY2031.", true},
		// NEVER a value match: real filings stating the same figures.
		{"CBA real NPAT", "Statutory NPAT2 $5,142m", false},
		{"same value other words", "Revenue was $5,142 million", false},
		{"superset of an echo", "Basic earnings per share was 94.2 cents, up 3% on the prior corresponding period", false},
		{"substring of an echo", "Operating cash flow was", false},
		{"real EDV EPS", "Basic earnings per share was 21.9 cents", false},
		{"empty", "", false},
		{"punctuation only", " . ", false},
	}
	for _, c := range cases {
		if got := IsFewShotText(c.in); got != c.want {
			t.Errorf("%s: IsFewShotText(%q) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

func TestNormalise(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"  Hello\tWorld \n", "hello world"},
		{"Chairman\u2019s \u201CAddress\u201D", `chairman's "address"`},
		{"4\u20136%", "4-6%"},
		{"a\u2014b\u2212c\u2011d", "a-b-c-d"},
		{"non\u00A0breaking\u202Fthin\u2009space", "non breaking thin space"},
		{"zero\u200Bwidth\u00ADsoft", "zerowidthsoft"},
		{"wait\u2026", "wait..."},
		{"STATUTORY NPAT2 $5,142M", "statutory npat2 $5,142m"},
	}
	for _, c := range cases {
		if got := Normalise(c.in); got != c.want {
			t.Errorf("Normalise(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// extract.py must carry the OLD or the NEW example, verbatim: an example that is
// on neither list escapes the denylist, so a third example must never ship.
// The extractor stream switches extract.py from old to new (contract 6.1); this
// test passes before and after that switch and fails on anything else. When
// extract.py loads the JSON mirror instead of copying it, parity holds by
// construction.
func TestExtractPyExampleIsOnTheDenylist(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "report-extractor", "extract.py"))
	if err != nil {
		t.Skipf("extract.py not reachable from this checkout: %v", err)
	}
	block := pythonExamplesBlock(string(src))
	if block == "" {
		t.Fatal("extract.py: EXTRACTION_EXAMPLES not found")
	}
	if !strings.Contains(block, "lx.data.ExampleData(") {
		if strings.Contains(string(src), "fewshot_example.json") {
			return // loads the canonical mirror
		}
		t.Fatal("extract.py: EXTRACTION_EXAMPLES has no ExampleData literal and does not load fewshot_example.json")
	}
	got, err := parsePythonExample(block)
	if err != nil {
		t.Fatalf("extract.py: %v", err)
	}
	if exampleEqual(got, oldFewShotExample) || exampleEqual(got, newFewShotExample) {
		return
	}
	t.Fatalf("extract.py's EXTRACTION_EXAMPLES is neither the old nor the new few-shot example; copy FewShotExample() verbatim.\n got: %+v", got)
}

func pythonExamplesBlock(src string) string {
	start := strings.Index(src, "EXTRACTION_EXAMPLES = [")
	if start < 0 {
		return ""
	}
	rest := src[start:]
	// The block ends at the first line that closes the list at column zero.
	if end := strings.Index(rest, "\n]\n"); end >= 0 {
		return rest[:end+2]
	}
	return rest
}

var (
	pyTextTripleRE = regexp.MustCompile(`(?s)text\s*=\s*"""(.*?)"""`)
	pyExtractionRE = regexp.MustCompile(`(?s)lx\.data\.Extraction\((.*?)\n\s*\),`)
	pyClassRE      = regexp.MustCompile(`extraction_class\s*=\s*"((?:[^"\\]|\\.)*)"`)
	pyTextRE       = regexp.MustCompile(`extraction_text\s*=\s*"((?:[^"\\]|\\.)*)"`)
	pyAttrsRE      = regexp.MustCompile(`(?s)attributes\s*=\s*\{(.*?)\}`)
	pyPairRE       = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"`)
)

// parsePythonExample reads the single ExampleData literal in extract.py's
// EXTRACTION_EXAMPLES: a triple-quoted text and lx.data.Extraction(...) calls
// with string keyword arguments and a string-to-string attributes dict.
func parsePythonExample(block string) (Example, error) {
	var ex Example
	m := pyTextTripleRE.FindStringSubmatch(block)
	if m == nil {
		return ex, errString("ExampleData text is not a triple-quoted literal")
	}
	ex.Text = m[1]
	for _, em := range pyExtractionRE.FindAllStringSubmatch(block, -1) {
		body := em[1]
		c := pyClassRE.FindStringSubmatch(body)
		tx := pyTextRE.FindStringSubmatch(body)
		if c == nil || tx == nil {
			return ex, errString("an Extraction lacks a string extraction_class or extraction_text")
		}
		e := Extraction{Class: pyUnescape(c[1]), Text: pyUnescape(tx[1]), Attributes: map[string]string{}}
		if am := pyAttrsRE.FindStringSubmatch(body); am != nil {
			for _, p := range pyPairRE.FindAllStringSubmatch(am[1], -1) {
				e.Attributes[pyUnescape(p[1])] = pyUnescape(p[2])
			}
		}
		ex.Extractions = append(ex.Extractions, e)
	}
	if len(ex.Extractions) == 0 {
		return ex, errString("no lx.data.Extraction literals parsed")
	}
	return ex, nil
}

func pyUnescape(s string) string {
	return strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n").Replace(s)
}

// exampleEqual compares what the prompt sees: the text and the ordered
// extractions (the metadata fields are Go-side only).
func exampleEqual(a, b Example) bool {
	if a.Text != b.Text || len(a.Extractions) != len(b.Extractions) {
		return false
	}
	for i := range a.Extractions {
		x, y := a.Extractions[i], b.Extractions[i]
		if x.Class != y.Class || x.Text != y.Text || !reflect.DeepEqual(x.Attributes, y.Attributes) {
			return false
		}
	}
	return true
}

// The parser recognises the example exactly as extract.py writes it today (a
// hand-built Python literal of the OLD example), so the parity test above is not
// vacuous.
func TestParsePythonExampleReadsTheLiteralForm(t *testing.T) {
	var b strings.Builder
	b.WriteString("EXTRACTION_EXAMPLES = [\n    lx.data.ExampleData(\n        text=\"\"\"")
	b.WriteString(oldFewShotExample.Text)
	b.WriteString("\"\"\",\n        extractions=[\n")
	for _, e := range oldFewShotExample.Extractions {
		b.WriteString("            lx.data.Extraction(\n")
		b.WriteString("                extraction_class=\"" + e.Class + "\",\n")
		b.WriteString("                extraction_text=\"" + e.Text + "\",\n")
		b.WriteString("                attributes={\n")
		for _, k := range sortedKeys(e.Attributes) {
			b.WriteString("                    \"" + k + "\": \"" + e.Attributes[k] + "\",\n")
		}
		b.WriteString("                },\n            ),\n")
	}
	b.WriteString("        ],\n    ),\n]\n")
	got, err := parsePythonExample(pythonExamplesBlock(b.String()))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !exampleEqual(got, oldFewShotExample) {
		t.Fatalf("parsed example differs from the old example:\n got %+v", got)
	}
	if exampleEqual(got, newFewShotExample) {
		t.Fatal("old and new examples must differ")
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
