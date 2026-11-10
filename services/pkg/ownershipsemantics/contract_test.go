package ownershipsemantics

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func syntheticInput() Input {
	in := Input{
		ContractVersion: ContractVersion,
		Source:          Source{URL: "https://example.test/notices/synthetic-shn.pdf", SHA256: digest([]byte("synthetic source bytes")), HashStatus: "captured"},
		DisclosureSlot:  1, ExtractorVersion: "synthetic-reader.v1", ExtractorConfigSHA256: digest([]byte("synthetic config")),
		Jurisdiction: "au", DocumentFormat: "au_shn_2026", LegalRegime: "au_enhanced_2026_12_04", DeclaredReason: "initial",
		AnnouncedOn: "2026-12-08", NoticeDate: "2026-12-07", EffectiveChangeDate: "2026-12-06",
		ReviewState: "needs_review", ReviewReasons: []string{"synthetic_fixture"}, ExtractionCompleteness: "partial",
	}
	for i, pct := range []string{"5.50", "2.00", "3.50", "0.00", "0.00", "3.50", "0.00"} {
		m := string(rune('A' + i))
		in.Measurements = append(in.Measurements, Measurement{Measure: m, Period: "present",
			Percent: reported(in, pct, "summary", m), Votes: notExtracted(), DenominatorVotes: notExtracted()})
	}
	return in
}

func notExtracted() ObservedValue { return ObservedValue{Status: NotExtracted} }
func reported(in Input, value, section, row string) ObservedValue {
	return ObservedValue{Status: Reported, Value: value, Evidence: []Evidence{{SourceURL: in.Source.URL, Page: 1, Section: section, Row: row}}}
}

func syntheticClass(in Input, id, votesPerSecurity string) SecurityClass {
	return SecurityClass{ClassID: id, Period: "present", Name: reported(in, id, "class table", id),
		IssuedSecurities: reported(in, "10000000", "class table", id), HeldSecurities: reported(in, "1000000", "class table", id),
		VotesPerSecurity: reported(in, votesPerSecurity, "class table", id), ReportedClassPercent: notExtracted()}
}

func cloneInput(in Input) Input {
	raw, _ := json.Marshal(in)
	var out Input
	_ = json.Unmarshal(raw, &out)
	return out
}

func TestReportedMeasuresRetainSourceSemantics(t *testing.T) {
	in := syntheticInput()
	in.Measurements[0].Percent.Value = "150.12345678901234567890"
	in.Measurements[1].Percent.Value = "0.00"
	in.Measurements[2].Percent.Value = "9.00" // Does not equal D+E+F; preserve and flag, never repair.
	in.ReviewReasons = append(in.ReviewReasons, "reported_component_sum_conflict")
	in.DeclaredReason = "ceasing" // Cessation does not supply a numeric zero.
	in.DisclosedMovements = []DisclosedMovement{{Measure: "A", DisclosedMovementPP: reported(in, "-1.000000001", "summary", "movement")}}
	before := cloneInput(in)
	r, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, before) {
		t.Fatal("preparation mutated the caller's source observations")
	}
	for i, want := range []string{"150.12345678901234567890", "0.00", "9.00"} {
		if got := r.Input.Measurements[i].Percent.Value; got != want {
			t.Fatalf("measure %d = %q, want %q", i, got, want)
		}
	}
	if r.Input.PublicationEligible || !r.RecordedAt.IsZero() {
		t.Fatal("domain preparation published or invented a storage timestamp")
	}
	if got := r.Input.DisclosedMovements[0].DisclosedMovementPP.Value; got != "-1.000000001" {
		t.Fatal(got)
	}
}

func TestDisclosedMovementPreservesExplicitPositiveSign(t *testing.T) {
	in := syntheticInput()
	in.DisclosedMovements = []DisclosedMovement{{Measure: "A", DisclosedMovementPP: reported(in, "+1.00", "summary", "movement")}}
	r, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	if r.Input.DisclosedMovements[0].DisclosedMovementPP.Value != "+1.00" {
		t.Fatal("source positive sign was discarded")
	}
}

func TestExplicitValueStatesPreserveZeroAndUnknowns(t *testing.T) {
	for _, status := range []ValueStatus{Reported, Unknown, Missing, Unreadable, NotApplicable, NotExtracted} {
		t.Run(string(status), func(t *testing.T) {
			in := syntheticInput()
			v := reported(in, "0.00", "summary", "A")
			v.Status = status
			if status != Reported {
				v.Value = ""
			}
			if status == NotExtracted {
				v.Evidence = nil
			}
			in.Measurements[0].Percent = v
			r, err := Prepare(in)
			if err != nil {
				t.Fatal(err)
			}
			got := r.Input.Measurements[0].Percent
			if got.Status != status || got.Value != v.Value {
				t.Fatalf("observation changed: %+v", got)
			}
		})
	}
}

func TestMalformedOrAmbiguousInputsAreRejected(t *testing.T) {
	cases := []struct {
		name string
		edit func(*Input)
	}{
		{"uncaptured source hash", func(in *Input) { in.Source.HashStatus = "not_captured" }},
		{"URL hash is not a source hash", func(in *Input) { in.Source.SHA256 = "hash-not-captured" }},
		{"missing config", func(in *Input) { in.ExtractorConfigSHA256 = "" }},
		{"zero slot", func(in *Input) { in.DisclosureSlot = 0 }},
		{"invalid period", func(in *Input) { in.Measurements[0].Period = "change" }},
		{"duplicate body total", func(in *Input) { in.Measurements = append(in.Measurements, in.Measurements[0]) }},
		{"negative holding percent", func(in *Input) { in.Measurements[0].Percent.Value = "-1" }},
		{"NaN", func(in *Input) { in.Measurements[0].Percent.Value = "NaN" }},
		{"exponent", func(in *Input) { in.Measurements[0].Percent.Value = "1e3" }},
		{"unbounded number text", func(in *Input) { in.Measurements[0].Percent.Value = strings.Repeat("1", 129) }},
		{"reported without value", func(in *Input) { in.Measurements[0].Percent.Value = "" }},
		{"unknown with zero", func(in *Input) { in.Measurements[0].Percent.Status = Unknown }},
		{"reported without evidence", func(in *Input) { in.Measurements[0].Percent.Evidence = nil }},
		{"unknown status", func(in *Input) { in.Measurements[0].Percent.Status = "unset" }},
		{"fractional votes", func(in *Input) { in.Measurements[0].Votes = reported(*in, "12.5", "summary", "A votes") }},
		{"publication bypass", func(in *Input) {
			in.ReviewState = "reviewed"
			in.ExtractionCompleteness = "complete"
			in.PublicationEligible = true
		}},
		{"invalid date", func(in *Input) { in.NoticeDate = "2026-02-30" }},
		{"publication date is not time", func(in *Input) { in.PublishedAt = "2026-12-08" }},
		{"AU cannot fall through NZ", func(in *Input) { in.Jurisdiction = "nz" }},
		{"unknown format is explicit", func(in *Input) { in.DocumentFormat = "arbitrary-new-format" }},
		{"source credentials", func(in *Input) { in.Source.URL = "https://secret:token@example.test/file.pdf" }},
		{"invalid utf8 source evidence", func(in *Input) { in.Measurements[0].Percent.Evidence[0].TextSpan = string([]byte{0xff}) }},
		{"missing correction evidence", func(in *Input) { in.SupersedesDisclosureID = strings.Repeat("a", 64) }},
		{"evidence without correction target", func(in *Input) { in.CorrectionEvidence = in.Measurements[0].Percent.Evidence }},
		{"phantom parsed annexure", func(in *Input) { in.Annexures = []Annexure{{ID: "A", Referenced: true, Parsed: true}} }},
		{"unread annexure not complete", func(in *Input) {
			in.ExtractionCompleteness = "complete"
			in.Annexures = []Annexure{{ID: "A", Referenced: true}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := syntheticInput()
			tc.edit(&in)
			if err := Validate(in); err == nil {
				t.Fatal("accepted invalid input")
			}
		})
	}
}

func TestClassesAndMultipleLegalBasesRemainDistinct(t *testing.T) {
	in := syntheticInput()
	in.SecurityClasses = []SecurityClass{syntheticClass(in, "ORD", "1"), syntheticClass(in, "PREF", "2")}
	in.Interests = []Interest{{RowID: "item5-row1", Period: "present", Kind: "relevant_interest", ClassID: "PREF",
		Holder: reported(in, "Synthetic holder", "5", "1"), RegisteredHolder: notExtracted(),
		PersonEntitled: ObservedValue{Status: Unknown, Evidence: []Evidence{{SourceURL: in.Source.URL, Page: 2, Section: "5", TextSpan: "unknown"}}},
		Quantity:       reported(in, "1000000", "5", "1"), Votes: reported(in, "2000000", "5", "1"),
		LegalBases: []string{"608(3)(b)", "608(1)(a)"}}}
	r, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Input.Interests) != 1 || len(r.Input.Interests[0].LegalBases) != 2 || len(r.Input.SecurityClasses) != 2 {
		t.Fatal("legal bases multiplied a parcel or merged classes")
	}
	if r.Input.Measurements[1].Percent.Value != "2.00" {
		t.Fatal("class votes changed the reported body B")
	}
	bad := cloneInput(in)
	bad.Interests[0].Period = "previous"
	if Validate(bad) == nil {
		t.Fatal("interest accepted a class from another period")
	}
	bad = cloneInput(in)
	bad.SecurityClasses[0].ReportedClassPercent = reported(in, "10", "5", "class percent")
	if Validate(bad) == nil {
		t.Fatal("class percentage accepted without denominator basis")
	}
}

func TestSourceEvidenceRequiresCapturedDocumentIdentity(t *testing.T) {
	in := syntheticInput()
	bad := cloneInput(in)
	bad.Measurements[0].Percent.Evidence[0].SourceURL = "https://example.test/annexure.pdf"
	if Validate(bad) == nil {
		t.Fatal("accepted a mutable cross-document locator without captured hash")
	}
	bad.Measurements[0].Percent.Evidence[0].SourceSHA256 = digest([]byte("annexure bytes"))
	if err := Validate(bad); err != nil {
		t.Fatal(err)
	}
	bad = cloneInput(in)
	bad.Measurements[0].Percent.Evidence[0].SourceSHA256 = digest([]byte("wrong main bytes"))
	if Validate(bad) == nil {
		t.Fatal("accepted conflicting main document hash")
	}
	explicit := cloneInput(in)
	explicit.Measurements[0].Percent.Evidence[0].SourceSHA256 = in.Source.SHA256
	a, _ := Prepare(in)
	b, _ := Prepare(explicit)
	if a.PayloadSHA256 != b.PayloadSHA256 {
		t.Fatal("inherited and explicit identical main-source hashes changed replay identity")
	}
}

func TestReplayIdentityExcludesGeneratedMetadataAndPreservesSourcePrecision(t *testing.T) {
	in := syntheticInput()
	in.ReviewReasons = []string{"second", "first"}
	reordered := cloneInput(in)
	slices.Reverse(reordered.Measurements)
	slices.Reverse(reordered.ReviewReasons)
	a, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Prepare(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatal("reordering keyed observations changed canonical replay")
	}
	changed := cloneInput(in)
	changed.Measurements[0].Percent.Value = "5.500"
	c, _ := Prepare(changed)
	if a.RevisionID != c.RevisionID || a.PayloadSHA256 == c.PayloadSHA256 {
		t.Fatal("same source/version must keep identity but detect changed source precision")
	}
	changed = cloneInput(in)
	changed.ReviewState = "reviewed"
	c, _ = Prepare(changed)
	if a.RevisionID != c.RevisionID || a.PayloadSHA256 == c.PayloadSHA256 {
		t.Fatal("review metadata was omitted from replay comparison")
	}
	changed = cloneInput(in)
	changed.ExtractorVersion = "synthetic-reader.v2"
	changed.SupersedesRevisionID = a.RevisionID
	c, err = Prepare(changed)
	if err != nil {
		t.Fatal(err)
	}
	if a.DisclosureID != c.DisclosureID || a.RevisionID == c.RevisionID {
		t.Fatal("re-extraction became a different disclosure or overwrote the old revision")
	}
	changed.DisclosureSlot = 2
	d, _ := Prepare(changed)
	if a.DisclosureID == d.DisclosureID {
		t.Fatal("different document notice positions collided")
	}
}

func TestDatesAndUnknownFormatDoNotAcquireInventedSemantics(t *testing.T) {
	in := syntheticInput()
	in.DocumentFormat = "au_604_legacy"
	in.LegalRegime = "unknown"
	in.DeclaredReason = "unknown"
	in.NoticeDate = "2026-12-03"
	in.AnnouncedOn = "2026-12-05"
	r, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	if r.Input.PublishedAt != "" || r.Input.LegalRegime != "unknown" || r.Input.DocumentFormat != "au_604_legacy" {
		t.Fatal("date-only publication inferred a timestamp/regime/format")
	}
	in.DocumentFormat = "unknown"
	in.Jurisdiction = "unknown"
	if err := Validate(in); err != nil {
		t.Fatal(err)
	}
}

func TestStrictDecodeRejectsUnknownAndTrailingPayload(t *testing.T) {
	raw, _ := json.Marshal(syntheticInput())
	if _, err := DecodeInput(raw); err != nil {
		t.Fatal(err)
	}
	unknown := strings.Replace(string(raw), `"contract_version":`, `"future_metadata":true,"contract_version":`, 1)
	if _, err := DecodeInput([]byte(unknown)); err == nil {
		t.Fatal("silently dropped unknown metadata")
	}
	duplicate := strings.Replace(string(raw), `"review_state":`, `"review_state":"reviewed","review_state":`, 1)
	if _, err := DecodeInput([]byte(duplicate)); err == nil {
		t.Fatal("silently replaced duplicate review metadata")
	}
	if _, err := DecodeInput(append(raw, []byte(` {}`)...)); err == nil {
		t.Fatal("accepted trailing JSON")
	}
}

func TestPrepareBoundsExpandedInheritedEvidenceHashes(t *testing.T) {
	in := syntheticInput()
	in.Measurements = in.Measurements[:4]
	const locatorsPerMeasure = 64
	for i := range in.Measurements {
		in.Measurements[i].Percent.Evidence = make([]Evidence, locatorsPerMeasure)
		for j := range in.Measurements[i].Percent.Evidence {
			in.Measurements[i].Percent.Evidence[j] = Evidence{
				SourceURL: in.Source.URL, Page: 1, Section: "synthetic near-limit source", Row: strconv.Itoa(j + 1),
			}
		}
	}
	setExcerptLength := func(length int) {
		for i := range in.Measurements {
			for j := range in.Measurements[i].Percent.Evidence {
				in.Measurements[i].Percent.Evidence[j].TextSpan = strings.Repeat("x", length)
			}
		}
	}
	// Find the largest valid source-excerpt length whose input fits the public
	// one-MiB bound. The 256 omitted same-document hashes still need expansion.
	low, high := 0, 4096
	for low < high {
		middle := (low + high + 1) / 2
		setExcerptLength(middle)
		raw, _ := json.Marshal(in)
		if len(raw) <= maxPayloadBytes {
			low = middle
		} else {
			high = middle - 1
		}
	}
	setExcerptLength(low)
	raw, _ := json.Marshal(in)
	if len(raw) > maxPayloadBytes || maxPayloadBytes-len(raw) >= 256 {
		t.Fatalf("fixture is not immediately below the input limit: %d bytes", len(raw))
	}
	if err := Validate(in); err != nil {
		t.Fatalf("near-limit unexpanded input should be valid: %v", err)
	}
	explicit := cloneInput(in)
	for i := range explicit.Measurements {
		for j := range explicit.Measurements[i].Percent.Evidence {
			explicit.Measurements[i].Percent.Evidence[j].SourceSHA256 = explicit.Source.SHA256
		}
	}
	expanded, _ := json.Marshal(explicit)
	if len(expanded) <= maxPayloadBytes {
		t.Fatal("fixture does not exercise inherited-hash expansion overflow")
	}
	t.Logf("unexpanded input=%d bytes; inherited hashes expand it to=%d bytes", len(raw), len(expanded))
	if _, err := Prepare(in); err == nil {
		t.Fatal("Prepare accepted a canonical payload that DecodeInput cannot read after storage")
	}

	// A slightly smaller input must still survive preparation and the same
	// decoder used by readRevision; rejecting every large input is not the fix.
	shrink := (len(expanded)-maxPayloadBytes+255)/256 + 1
	setExcerptLength(low - shrink)
	r, err := Prepare(in)
	if err != nil {
		t.Fatalf("bounded near-limit input rejected: %v", err)
	}
	stored, _ := json.Marshal(r.Input)
	read, err := DecodeInput(stored)
	if err != nil {
		t.Fatalf("prepared canonical payload cannot be read: %v", err)
	}
	again, err := Prepare(read)
	if err != nil || again.PayloadSHA256 != r.PayloadSHA256 {
		t.Fatalf("near-limit roundtrip changed payload: %v", err)
	}
	// JSONB can return the same object with additional insignificant spaces.
	// Storage decoding must apply the canonical bound, not reject DB formatting.
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, stored, "", " "); err != nil {
		t.Fatal(err)
	}
	if formatted.Len() <= maxPayloadBytes {
		t.Fatal("fixture does not exercise formatted JSONB size")
	}
	r.RecordedAt = time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	fromStorage, err := readRevision(syntheticRevisionRow{revision: r, payload: formatted.Bytes()})
	if err != nil || fromStorage.PayloadSHA256 != r.PayloadSHA256 {
		t.Fatalf("valid near-limit canonical payload was rejected because of JSONB whitespace: %v", err)
	}
}

type syntheticRevisionRow struct {
	revision Revision
	payload  []byte
}

func (r syntheticRevisionRow) Scan(values ...any) error {
	*values[0].(*string) = r.revision.DisclosureID
	*values[1].(*string) = r.revision.RevisionID
	*values[2].(*string) = r.revision.PayloadSHA256
	*values[3].(*[]byte) = r.payload
	*values[4].(*time.Time) = r.revision.RecordedAt
	return nil
}
