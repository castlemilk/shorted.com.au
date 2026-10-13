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
		// ReportDate is the day the document was lodged, when the case needs
		// one: test_document_meta.py passes it to extract_document_meta.
		ReportDate string `json:"report_date"`
	} `json:"cases"`
	Invalid []struct {
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
		Expected json.RawMessage `json:"expected"`
	} `json:"invalid"`
	Entities []struct {
		Raw   string `json:"raw"`
		Clean string `json:"clean"`
	} `json:"entities"`
}

// Every stored entity in the shared fixture reduces to its clean form, through
// cleanEntity alone and through ParseDocumentMeta, and a clean form is stable.
// test_document_meta.py asserts the same list against clean_entity.
func TestDocumentMetaFixtureEntities(t *testing.T) {
	f := loadDocumentMetaFixture(t)
	if len(f.Entities) < 20 {
		t.Fatalf("fixture must carry at least 20 entities, has %d", len(f.Entities))
	}
	var dropped int
	for _, e := range f.Entities {
		if got := cleanEntity(e.Raw); got != e.Clean {
			t.Errorf("cleanEntity(%q) = %q, want %q", e.Raw, got, e.Clean)
		}
		if got := cleanEntity(e.Clean); got != e.Clean {
			t.Errorf("cleanEntity(%q) = %q: a clean form must be stable", e.Clean, got)
		}
		raw, _ := json.Marshal(map[string]string{"entity": e.Raw})
		m, err := ParseDocumentMeta(raw)
		if err != nil || m.Entity != e.Clean {
			t.Errorf("ParseDocumentMeta(entity %q).Entity = %q, %v; want %q", e.Raw, m.Entity, err, e.Clean)
		}
		if e.Clean == "" {
			dropped++
		}
	}
	if dropped == 0 || dropped == len(f.Entities) {
		t.Errorf("fixture is lopsided: %d of %d entities dropped", dropped, len(f.Entities))
	}
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
		// A document's own period ended before it was lodged.
		if c.ReportDate != "" {
			if !validISODate(c.ReportDate) {
				t.Errorf("%s: report_date %q is not a YYYY-MM-DD date", c.Name, c.ReportDate)
			} else if m.PeriodEnd != "" && m.PeriodEnd >= c.ReportDate {
				t.Errorf("%s: period_end %s is not before the report date %s", c.Name, m.PeriodEnd, c.ReportDate)
			}
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
	// The entity is what a document says about ITSELF, one case per rule from
	// the stored texts: VIT's own 4E was read as "Cortexa Pty Ltd", a joint
	// venture it deconsolidated, and withheld. Where a document names only
	// other organisations, or no one (CDM's manager, a wrapped name's
	// "Resources Limited", BLG's running title), the entity is absent. A
	// renamed company keeps its former name (BP8), and a responsible entity's
	// letterhead names the trust (CQR).
	for name, want := range map[string]string{
		"vit_control_lost_field_skipped_acn_line_names_the_entity":                                "Vitura Health Limited",
		"srj_numbered_name_of_entity_field_before_its_loss_of_control_field":                      "SRJ Technologies Group Plc",
		"axr_subsidiary_accounts_cover_acn_names_the_subsidiary":                                  "Sturt Exploration Pty Ltd",
		"cdm_directory_manager_of_the_company_is_not_the_entity_and_the_abn_read_is_the_managers": "",
		"mgx_lone_abn_with_no_name_then_its_subsidiary_list":                                      "MGX RESOURCES LIMITED",
		"bmr_wrapped_cover_name_resources_limited_names_no_one":                                   "",
		"blg_report_title_and_year_before_its_abn_is_not_a_name":                                  "",
		"oph_fund_cover_lone_arsn_names_the_fund":                                                 "Ophir High Conviction Fund",
		"bp8_renamed_company_cover_keeps_its_former_name":                                         "Ocean Sciences Ltd (formerly BPH Global Ltd)",
		"cqr_responsible_entity_letterhead_names_the_trust":                                       "Charter Hall Retail REIT",
		"akg_name_label_before_the_name_is_not_part_of_it":                                        "Academies Australasia Group Limited",
		"cpu_of_before_the_name_is_not_part_of_it":                                                "Computershare Limited",
		"ald_authorised_for_release_is_not_a_name":                                                "Ampol Limited",
	} {
		m, ok := byName[name]
		if !ok {
			t.Errorf("fixture lacks the %s case", name)
			continue
		}
		if m.Entity != want {
			t.Errorf("%s: entity %q, want %q", name, m.Entity, want)
		}
	}
	// The ABN rule takes the first valid ABN, which is not always the
	// document's own: CDM's spells its own "A.B.N.", so its manager's is read.
	// Nothing reads document_meta.abn yet.
	if m := byName["cdm_directory_manager_of_the_company_is_not_the_entity_and_the_abn_read_is_the_managers"]; m.ABN != "68 106 551 062" {
		t.Errorf("CDM case: abn %q, want the manager's 68 106 551 062", m.ABN)
	}
}

// A former name in brackets stays after the name, whatever other trailing
// brackets are cut; a former name alone, or an empty one, states no name.
// test_document_meta.py asserts the same.
func TestCleanEntityFormerName(t *testing.T) {
	for raw, want := range map[string]string{
		"Ocean Sciences Ltd (formerly BPH Global Ltd)":                      "Ocean Sciences Ltd (formerly BPH Global Ltd)",
		"Altoro Metals Limited (ASX:ARO) (formerly Variscan Mines Limited)": "Altoro Metals Limited (formerly Variscan Mines Limited)",
		"Altoro Metals Limited (formerly Variscan Mines Limited) (ASX:ARO)": "Altoro Metals Limited (formerly Variscan Mines Limited)",
		"Racura Oncology Ltd (formerly known as Race Oncology Limited)":     "Racura Oncology Ltd (formerly known as Race Oncology Limited)",
		"Ocean Sciences Ltd (formerly BPH Global Ltd) ABN 57 009 104 330":   "Ocean Sciences Ltd (formerly BPH Global Ltd)",
		"Ocean Sciences Ltd (formerly )":                                    "Ocean Sciences Ltd",
		"Moore Australia Audit (WA)":                                        "Moore Australia Audit",
		"ASX: OCN (formerly BPH Global Ltd)":                                "",
		"T +61 2 8777 7777 (formerly 9999 9999)":                            "",
		"Ocean Sciences Ltd (FORMERLY BPH GLOBAL LTD)":                      "Ocean Sciences Ltd (FORMERLY BPH GLOBAL LTD)",
		"Ocean Sciences Ltd (previously BPH Global Ltd)":                    "Ocean Sciences Ltd (previously BPH Global Ltd)",
		"Ocean Sciences Ltd (previously known as BPH Global Ltd)":           "Ocean Sciences Ltd (previously known as BPH Global Ltd)",
		"(formerly BPH Global Ltd), ":                                       "",
		"(formerly BPH Global Ltd) (ASX: BP8)":                              "",
		"(formerly A Ltd) (formerly B Ltd)":                                 "",
		"Name: (formerly BPH Global Ltd) Limited":                           "",
		"((formerly BPH Global Ltd)), ":                                     "",
	} {
		if got := cleanEntity(raw); got != want {
			t.Errorf("cleanEntity(%q) = %q, want %q", raw, got, want)
		}
	}
	// With its former name kept, a renamed company's report matches the name
	// on record, old or new (BP8 is "Bph Global"; OSS, its new code, "Ocean
	// Sciences"), however "formerly" is written.
	for _, cover := range []string{"Ocean Sciences Ltd (formerly BPH Global Ltd)", "Ocean Sciences Ltd (Formerly: BPH Global Ltd)"} {
		for _, company := range []string{"Bph Global", "Ocean Sciences"} {
			if !EntityMatches(cleanEntity(cover), company) {
				t.Errorf("BP8's cover %q must match %q", cover, company)
			}
		}
	}
	// A Pty Ltd's former name is not kept, however the legal form is written:
	// a subsidiary's own accounts never match the parent through it (AXR filed
	// Sturt Exploration's).
	for raw, want := range map[string]string{
		"Sturt Exploration Pty Ltd (formerly Axiant Resources Exploration Pty Ltd)":                         "Sturt Exploration Pty Ltd",
		"Sturt Exploration Pty. Ltd. (formerly Axiant Resources Exploration Pty. Ltd.)":                     "Sturt Exploration Pty. Ltd",
		"Sturt Exploration Proprietary Limited (formerly Axiant Resources Exploration Proprietary Limited)": "Sturt Exploration Proprietary Limited",
	} {
		sturt := cleanEntity(raw)
		if sturt != want {
			t.Errorf("cleanEntity(%q) = %q, want %q", raw, sturt, want)
		}
		if EntityMatches(sturt, "Axiant Resources") {
			t.Errorf("%q must not match Axiant Resources", sturt)
		}
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
