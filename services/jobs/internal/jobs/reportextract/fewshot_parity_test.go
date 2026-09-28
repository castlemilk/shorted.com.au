package reportextract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// extractPyPath is the deployed Python extractor, relative to this package.
var extractPyPath = filepath.Join("..", "..", "..", "..", "report-extractor", "extract.py")

// TestExtractPyExampleMatchesTheTrustExample is the few-shot PARITY gate
// between the two extractors (docs/plans/fundamentals-coverage.md 4.1, 6.1,
// 6.3): the extraction_text literals of extract.py's EXTRACTION_EXAMPLES must
// equal, in order, the extraction texts of extractiontrust's NEW synthetic
// example, which is exactly what this package's extractionExamples() sends.
//
// CROSS-STREAM, READ THIS BEFORE "FIXING" IT: the Python side switches to the
// synthetic example in the extractor stream (services/report-extractor/**).
// Until that lands, extract.py still carries the OLD example (revenue $5,142m,
// NPAT $1,823m, EPS 94.2c) and this test SKIPS, saying so. It skips for that
// reason ONLY: any other extract.py (a third example, a partial copy, a typo)
// fails. Once the switch is merged the skip can never fire again, and the test
// enforces parity for good. If extract.py loads extractiontrust's JSON mirror
// (testdata/fewshot_example.json) instead of copying literals, parity holds by
// construction and the mirror itself is checked against Go here.
func TestExtractPyExampleMatchesTheTrustExample(t *testing.T) {
	src, err := os.ReadFile(extractPyPath)
	if err != nil {
		t.Fatalf("extract.py not readable at %s: %v", extractPyPath, err)
	}
	block := pyExamplesBlock(string(src))
	if block == "" {
		t.Fatal("extract.py: no EXTRACTION_EXAMPLES assignment found")
	}

	want := extractiontrust.FewShotExample()
	literals, err := pyExtractionTextLiterals(block)
	if err != nil {
		t.Fatalf("extract.py: %v", err)
	}

	if carriesOldExample(block, literals) {
		t.Skip("PENDING THE EXTRACTOR STREAM: extract.py still carries the OLD few-shot example " +
			"(revenue $5,142m / NPAT $1,823m / EPS 94.2c, \"H1 FY2025\"). Parity with " +
			"extractiontrust.FewShotExample() is enforced as soon as it switches (contract 6.1).")
	}

	if len(literals) == 0 {
		if strings.Contains(string(src), "fewshot_example.json") {
			assertMirrorIsTheTrustExample(t, want)
			return
		}
		t.Fatal("extract.py: EXTRACTION_EXAMPLES has no extraction_text literals and does not load fewshot_example.json")
	}

	if len(literals) != len(want.Extractions) {
		t.Fatalf("extract.py has %d extraction_text literals, extractiontrust's example has %d:\n got %q",
			len(literals), len(want.Extractions), literals)
	}
	for i, lit := range literals {
		if lit != want.Extractions[i].Text {
			t.Errorf("extraction %d: extract.py %q, extractiontrust %q", i, lit, want.Extractions[i].Text)
		}
		if lit != extractionExamples()[0].Extractions[i].ExtractionText {
			t.Errorf("extraction %d: extract.py and the Go port disagree", i)
		}
		if !extractiontrust.IsFewShotText(lit) {
			t.Errorf("extraction %d: %q is not on the NEW denylist", i, lit)
		}
	}
	// The document text too, when it is a literal.
	if text, ok := pyTripleQuotedText(block); ok && text != want.Text {
		t.Errorf("extract.py's example text differs from extractiontrust's:\n got %q\nwant %q", text, want.Text)
	}
}

// carriesOldExample reports whether the block still holds the OLD example:
// any of its extraction texts as a literal, or its unmistakable figures.
func carriesOldExample(block string, literals []string) bool {
	old := map[string]bool{}
	for _, s := range extractiontrust.OldFewShotTexts {
		old[extractiontrust.Normalise(s)] = true
	}
	for _, lit := range literals {
		if old[extractiontrust.Normalise(lit)] {
			return true
		}
	}
	return strings.Contains(block, "$5,142 million") && strings.Contains(block, "94.2 cents")
}

func assertMirrorIsTheTrustExample(t *testing.T, want extractiontrust.Example) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "pkg", "extractiontrust", "testdata", "fewshot_example.json"))
	if err != nil {
		t.Fatalf("extract.py loads fewshot_example.json but the mirror is unreadable: %v", err)
	}
	var got extractiontrust.Example
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("fewshot_example.json: %v", err)
	}
	if got.Text != want.Text || len(got.Extractions) != len(want.Extractions) {
		t.Fatal("fewshot_example.json differs from extractiontrust.FewShotExample()")
	}
	for i := range got.Extractions {
		if got.Extractions[i].Text != want.Extractions[i].Text {
			t.Errorf("fewshot_example.json extraction %d differs", i)
		}
	}
}

// pyExamplesBlock is the source of the EXTRACTION_EXAMPLES assignment, up to
// the first line that closes the list at column zero (or the end of file).
func pyExamplesBlock(src string) string {
	start := strings.Index(src, "EXTRACTION_EXAMPLES")
	for start >= 0 {
		rest := src[start+len("EXTRACTION_EXAMPLES"):]
		trimmed := strings.TrimLeft(rest, " \t")
		// An assignment (possibly annotated), not a use.
		if strings.HasPrefix(trimmed, "=") || strings.HasPrefix(trimmed, ":") {
			break
		}
		next := strings.Index(rest, "EXTRACTION_EXAMPLES")
		if next < 0 {
			return ""
		}
		start += len("EXTRACTION_EXAMPLES") + next
	}
	if start < 0 {
		return ""
	}
	rest := src[start:]
	if end := strings.Index(rest, "\n]"); end >= 0 {
		return rest[:end+2]
	}
	if end := strings.Index(rest, "\n\n\n"); end >= 0 {
		return rest[:end]
	}
	return rest
}

// pyExtractionTextLiterals returns the value of every extraction_text=
// keyword argument in the block, in order. A value may be one string literal
// or several adjacent ones (Python's implicit concatenation), optionally in
// parentheses; single, double and triple quotes are accepted. A value that is
// not a literal (a name, an f-string, a call) is an error: parity cannot be
// checked against something computed.
func pyExtractionTextLiterals(block string) ([]string, error) {
	var out []string
	const kw = "extraction_text"
	for i := 0; ; {
		j := strings.Index(block[i:], kw)
		if j < 0 {
			return out, nil
		}
		p := i + j + len(kw)
		p = skipSpace(block, p)
		if p >= len(block) || block[p] != '=' {
			i = p
			continue
		}
		p = skipSpace(block, p+1)
		paren := false
		if p < len(block) && block[p] == '(' {
			paren = true
			p = skipSpace(block, p+1)
		}
		var b strings.Builder
		n := 0
		for p < len(block) && (block[p] == '"' || block[p] == '\'') {
			s, next, err := readPyString(block, p)
			if err != nil {
				return nil, err
			}
			b.WriteString(s)
			n++
			p = skipSpace(block, next)
		}
		if n == 0 {
			return nil, errNotLiteral(block, p)
		}
		if paren {
			if p >= len(block) || block[p] != ')' {
				return nil, errNotLiteral(block, p)
			}
			p++
		}
		out = append(out, b.String())
		i = p
	}
}

type parityError string

func (e parityError) Error() string { return string(e) }

func errNotLiteral(block string, p int) error {
	end := p + 40
	if end > len(block) {
		end = len(block)
	}
	return parityError("extraction_text is not a string literal near " + strconv.Quote(block[p:end]))
}

func skipSpace(s string, p int) int {
	for p < len(s) && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' || s[p] == '\r') {
		p++
	}
	return p
}

// readPyString reads one Python string literal starting at s[p] (a quote)
// and returns its value and the index after it. Escapes: \\ \" \' \n \t.
func readPyString(s string, p int) (string, int, error) {
	q := s[p]
	triple := strings.HasPrefix(s[p:], strings.Repeat(string(q), 3))
	delim := string(q)
	if triple {
		delim = strings.Repeat(string(q), 3)
	}
	p += len(delim)
	var b strings.Builder
	for p < len(s) {
		if strings.HasPrefix(s[p:], delim) {
			return b.String(), p + len(delim), nil
		}
		c := s[p]
		if c == '\\' && p+1 < len(s) {
			switch s[p+1] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case '\\', '"', '\'':
				b.WriteByte(s[p+1])
			case '\n':
				// line continuation inside a literal
			default:
				b.WriteByte('\\')
				b.WriteByte(s[p+1])
			}
			p += 2
			continue
		}
		if c == '\n' && !triple {
			return "", p, parityError("unterminated string literal")
		}
		b.WriteByte(c)
		p++
	}
	return "", p, parityError("unterminated string literal")
}

// pyTripleQuotedText reads the ExampleData's text="""...""" literal.
func pyTripleQuotedText(block string) (string, bool) {
	idx := strings.Index(block, "text=\"\"\"")
	if idx < 0 {
		return "", false
	}
	// Guard against matching the tail of extraction_text=.
	if idx > 0 && (block[idx-1] == '_' || isIdent(block[idx-1])) {
		return "", false
	}
	s, _, err := readPyString(block, idx+len("text="))
	if err != nil {
		return "", false
	}
	return s, true
}

func isIdent(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// The literal reader handles the forms extract.py uses or could use, so the
// parity gate above is not vacuous.
func TestPyExtractionTextLiteralsReadsEveryForm(t *testing.T) {
	block := `EXTRACTION_EXAMPLES = [
    lx.data.ExampleData(
        text="""Doc line one.
Doc line two.""",
        extractions=[
            lx.data.Extraction(
                extraction_class="revenue",
                extraction_text="Revenue was $3,847 million",
            ),
            lx.data.Extraction(extraction_class="eps", extraction_text='Basic EPS "48.3" cents'),
            lx.data.Extraction(
                extraction_class="guidance",
                extraction_text=(
                    "FY2031 guidance: "
                    "Quokka expects growth"
                ),
            ),
        ],
    ),
]
`
	got, err := pyExtractionTextLiterals(pyExamplesBlock(block))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Revenue was $3,847 million", `Basic EPS "48.3" cents`, "FY2031 guidance: Quokka expects growth"}
	if len(got) != len(want) {
		t.Fatalf("got %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("literal %d: got %q want %q", i, got[i], want[i])
		}
	}
	if text, ok := pyTripleQuotedText(pyExamplesBlock(block)); !ok || text != "Doc line one.\nDoc line two." {
		t.Errorf("text literal: %q %v", text, ok)
	}
	if _, err := pyExtractionTextLiterals(`EXTRACTION_EXAMPLES = [ lx.data.Extraction(extraction_text=EXAMPLE_TEXT) ]`); err == nil {
		t.Error("a non-literal extraction_text must be an error, never a silent pass")
	}

	// The OLD example is recognised (the skip condition) and the NEW one is not.
	oldBlock := "EXTRACTION_EXAMPLES = [\n    lx.data.Extraction(extraction_text=\"Basic earnings per share was 94.2 cents\"),\n]\n"
	lits, _ := pyExtractionTextLiterals(pyExamplesBlock(oldBlock))
	if !carriesOldExample(oldBlock, lits) {
		t.Error("the old example must be recognised")
	}
	var nb strings.Builder
	nb.WriteString("EXTRACTION_EXAMPLES = [\n")
	for _, e := range extractiontrust.FewShotExample().Extractions {
		nb.WriteString("    lx.data.Extraction(extraction_text=" + strconv.Quote(e.Text) + "),\n")
	}
	nb.WriteString("]\n")
	lits, _ = pyExtractionTextLiterals(pyExamplesBlock(nb.String()))
	if carriesOldExample(nb.String(), lits) {
		t.Error("the new example must not read as the old one")
	}
}
