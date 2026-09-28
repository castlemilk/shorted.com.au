package extractiontrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type documentMetaFixture struct {
	Comment string   `json:"comment"`
	Rules   []string `json:"rules"`
	Cases   []struct {
		Name     string          `json:"name"`
		Text     string          `json:"text"`
		Expected json.RawMessage `json:"expected"`
	} `json:"cases"`
	Invalid []struct {
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
		Expected json.RawMessage `json:"expected"`
	} `json:"invalid"`
}

func loadDocumentMetaFixture(t *testing.T) documentMetaFixture {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "document_meta_cases.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f documentMetaFixture
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return f
}

// asMap re-encodes a DocumentMeta through its JSON tags, so a comparison with a
// fixture object is by key set and values (omitempty drops absent fields).
func asMap(t *testing.T, m DocumentMeta) map[string]any {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func rawMap(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// Every expected object in the shared fixture is inside the closed vocabulary:
// ParseDocumentMeta returns it unchanged.
func TestDocumentMetaFixtureExpectedObjectsAreInVocabulary(t *testing.T) {
	f := loadDocumentMetaFixture(t)
	if len(f.Cases) < 8 {
		t.Fatalf("fixture carries %d cases, want at least 8", len(f.Cases))
	}
	for _, c := range f.Cases {
		if strings.TrimSpace(c.Text) == "" {
			t.Errorf("%s: empty text", c.Name)
		}
		m, err := ParseDocumentMeta(c.Expected)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if got, want := asMap(t, m), rawMap(t, c.Expected); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: expected object is not in vocabulary:\n got %v\nwant %v", c.Name, got, want)
		}
		// Evidence is quoted from the text, never paraphrased.
		for _, ev := range []string{m.CurrencyEvidence, m.UnitsEvidence, m.Entity} {
			if ev != "" && !strings.Contains(c.Text, ev) {
				t.Errorf("%s: %q is not verbatim in the text", c.Name, ev)
			}
		}
		if m.ABN != "" && !strings.Contains(c.Text, m.ABN) {
			t.Errorf("%s: abn %q is not in the text", c.Name, m.ABN)
		}
	}
}

// The fixture exercises the contract's named behaviours and the whole closed
// vocabulary, so the Python extractor's tests cover them too.
func TestDocumentMetaFixtureCoverage(t *testing.T) {
	f := loadDocumentMetaFixture(t)
	kinds, units, periods, currencies := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	byName := map[string]DocumentMeta{}
	for _, c := range f.Cases {
		m, err := ParseDocumentMeta(c.Expected)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		byName[c.Name] = m
		kinds[m.ReportKind] = true
		units[m.Units] = true
		periods[m.PeriodType] = true
		currencies[m.Currency] = true
	}
	for k := range reportKinds {
		if !kinds[k] {
			t.Errorf("no case has report_kind %q", k)
		}
	}
	for u := range unitsMultiplier {
		if !units[u] {
			t.Errorf("no case has units %q", u)
		}
	}
	for p := range periodTypes {
		if !periods[p] {
			t.Errorf("no case has period_type %q", p)
		}
	}
	if !units[""] || !currencies[""] {
		t.Error("the fixture needs cases where units and currency are omitted")
	}

	// Several distinct unit statements -> units omitted (contract 2.5).
	several, ok := byName["several_unit_statements_units_omitted"]
	if !ok {
		t.Fatal("fixture lacks the several-unit-statements case")
	}
	if several.Units != "" || several.UnitsEvidence != "" {
		t.Errorf("several unit statements must omit units, got %+v", several)
	}
	// The contract's BHP example object.
	bhp := byName["bhp_appendix_4e_usd_millions"]
	want := DocumentMeta{
		Currency: "USD", CurrencyEvidence: "presented in US dollars",
		Units: "millions", UnitsEvidence: "US$ Million",
		Entity: "BHP Group Limited", ABN: "49 004 028 077",
		PeriodEnd: "2026-06-30", PeriodType: "annual", ReportKind: "appendix_4e",
	}
	if bhp != want {
		t.Errorf("BHP case = %+v, want the contract 2.5 example %+v", bhp, want)
	}
	// An invalid ABN in the text is withheld, not repaired.
	if m := byName["invalid_abn_checksum_withheld"]; m.ABN != "" {
		t.Errorf("an ABN failing its checksum must be omitted, got %q", m.ABN)
	}
}

// Each invalid input loses exactly its bad keys (and evidence whose value went
// with them).
func TestDocumentMetaFixtureInvalidInputsLoseTheirBadKeys(t *testing.T) {
	f := loadDocumentMetaFixture(t)
	if len(f.Invalid) < 10 {
		t.Fatalf("fixture carries %d invalid inputs, want at least 10", len(f.Invalid))
	}
	for _, c := range f.Invalid {
		m, err := ParseDocumentMeta(c.Input)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		got, want := asMap(t, m), rawMap(t, c.Expected)
		if len(want) == 0 {
			want = nil
		}
		if len(got) == 0 {
			got = nil
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %v\nwant %v", c.Name, got, want)
		}
	}
}

func TestParseDocumentMetaEdgeInputs(t *testing.T) {
	for _, raw := range []string{"", "   ", "null", " null "} {
		m, err := ParseDocumentMeta([]byte(raw))
		if err != nil || !m.IsZero() {
			t.Errorf("ParseDocumentMeta(%q) = %+v, %v; want zero, nil", raw, m, err)
		}
	}
	if m, err := ParseDocumentMeta(nil); err != nil || !m.IsZero() {
		t.Errorf("ParseDocumentMeta(nil) = %+v, %v", m, err)
	}
	for _, raw := range []string{"[1,2]", `"appendix_4e"`, "not json", "{", "42"} {
		if _, err := ParseDocumentMeta([]byte(raw)); err == nil {
			t.Errorf("ParseDocumentMeta(%q) must error: not a JSON object", raw)
		}
	}
	// Free text over 200 characters is a runaway capture, not evidence.
	long := strings.Repeat("A", maxFreeTextRunes+1)
	m, err := ParseDocumentMeta([]byte(`{"entity":"` + long + `","currency":"AUD","currency_evidence":"` + long + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Entity != "" || m.CurrencyEvidence != "" || m.Currency != "AUD" {
		t.Errorf("over-long free text must be dropped, value kept: %+v", m)
	}
	ok := strings.Repeat("\u00e9", maxFreeTextRunes) // 200 runes, 400 bytes
	m, _ = ParseDocumentMeta([]byte(`{"entity":"` + ok + `"}`))
	if m.Entity != ok {
		t.Error("the free-text cap counts characters, not bytes")
	}
}

func TestDocumentMetaHelpers(t *testing.T) {
	for units, want := range map[string]float64{"units": 1, "thousands": 1e3, "millions": 1e6, "billions": 1e9} {
		got, ok := DocumentMeta{Units: units}.UnitsMultiplier()
		if !ok || got != want {
			t.Errorf("UnitsMultiplier(%q) = %v, %v", units, got, ok)
		}
	}
	if _, ok := (DocumentMeta{}).UnitsMultiplier(); ok {
		t.Error("absent units must report false")
	}
	d, ok := DocumentMeta{PeriodEnd: "2025-12-31"}.PeriodEndDate()
	if !ok || !d.Equal(time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("PeriodEndDate = %v, %v", d, ok)
	}
	if _, ok := (DocumentMeta{}).PeriodEndDate(); ok {
		t.Error("absent period_end must report false")
	}
	if !(DocumentMeta{}).IsZero() || (DocumentMeta{ReportKind: "other"}).IsZero() {
		t.Error("IsZero")
	}
}

func TestValidABN(t *testing.T) {
	for abn, want := range map[string]bool{
		"49 004 028 077": true, // BHP Group Limited
		"48 123 123 124": true, // Commonwealth Bank of Australia
		"49 004 028 078": false,
		"12 345 678 901": false,
		"49004028077":    false, // canonical spelling only
		"49 004 028 07":  false,
		"4900 4028 077":  false,
		"ab 004 028 077": false,
		"":               false,
	} {
		if got := ValidABN(abn); got != want {
			t.Errorf("ValidABN(%q) = %v, want %v", abn, got, want)
		}
	}
}

func TestParseDocumentMetaVocabulary(t *testing.T) {
	for _, c := range []string{"AUD", "USD", "NZD", "GBP", "EUR", "CAD", "HKD", "SGD", "JPY"} {
		if m, _ := ParseDocumentMeta([]byte(`{"currency":"` + c + `"}`)); m.Currency != c {
			t.Errorf("currency %q must be accepted", c)
		}
	}
	for _, c := range []string{"aud", "A$", "AU", "AUDD", "XAU", "ABC", " AUD"} {
		if m, _ := ParseDocumentMeta([]byte(`{"currency":"` + c + `"}`)); m.Currency != "" {
			t.Errorf("currency %q must be rejected", c)
		}
	}
	for _, k := range []string{"appendix_4e", "appendix_4d", "annual_report", "half_year_report", "results_announcement", "other"} {
		if m, _ := ParseDocumentMeta([]byte(`{"report_kind":"` + k + `"}`)); m.ReportKind != k {
			t.Errorf("report_kind %q must be accepted", k)
		}
	}
	for _, d := range []string{"2024-02-29", "2026-06-30", "2025-12-31"} {
		if m, _ := ParseDocumentMeta([]byte(`{"period_end":"` + d + `"}`)); m.PeriodEnd != d {
			t.Errorf("period_end %q must be accepted", d)
		}
	}
	for _, d := range []string{"2025-02-29", "2026-13-01", "2026-06-30T00:00:00Z", "2026/06/30"} {
		if m, _ := ParseDocumentMeta([]byte(`{"period_end":"` + d + `"}`)); m.PeriodEnd != "" {
			t.Errorf("period_end %q must be rejected", d)
		}
	}
}
