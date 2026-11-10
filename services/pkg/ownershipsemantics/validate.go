package ownershipsemantics

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const maxPayloadBytes = 1 << 20

var (
	sha256Pattern        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	decimalPattern       = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)?$`)
	signedDecimalPattern = regexp.MustCompile(`^[+-]?[0-9]+(?:\.[0-9]+)?$`)
	integerPattern       = regexp.MustCompile(`^[0-9]+$`)
)

// Validate checks representation and lineage shape, not legal filing
// compliance. Inconsistent reported totals remain representable with review
// reasons: it never recalculates C, manufactures A, nets G or applies the
// legacy 5% threshold. Link targets are checked by Store.Append.
func Validate(in Input) error {
	if in.ContractVersion != ContractVersion {
		return fmt.Errorf("contract_version: unsupported %q", in.ContractVersion)
	}
	if err := sourceURL(in.Source.URL); err != nil {
		return fmt.Errorf("source.url: %w", err)
	}
	if in.Source.HashStatus != "captured" || !sha256Pattern.MatchString(in.Source.SHA256) {
		return fmt.Errorf("source: new revisions require captured source bytes and their lowercase SHA256")
	}
	if !sha256Pattern.MatchString(in.ExtractorConfigSHA256) {
		return fmt.Errorf("extractor_config_sha256: expected lowercase SHA256")
	}
	if in.DisclosureSlot < 1 || in.DisclosureSlot > 10000 {
		return fmt.Errorf("disclosure_slot: expected a document position from 1 through 10000")
	}
	if !text(in.ExtractorVersion, 160, true) {
		return fmt.Errorf("extractor_version: required, at most 160 bytes")
	}
	if !oneOf(in.Jurisdiction, "au", "nz", "unknown") {
		return fmt.Errorf("jurisdiction: unsupported %q", in.Jurisdiction)
	}
	if !oneOf(in.DocumentFormat, "au_603_legacy", "au_604_legacy", "au_605_legacy",
		"au_603_transitional_2026", "au_604_transitional_2026", "au_605_transitional_2026",
		"au_shn_2026", "nz", "unknown") {
		return fmt.Errorf("document_format: unsupported %q", in.DocumentFormat)
	}
	if strings.HasPrefix(in.DocumentFormat, "au_") && in.Jurisdiction != "au" ||
		in.DocumentFormat == "nz" && in.Jurisdiction != "nz" {
		return fmt.Errorf("document_format and jurisdiction conflict")
	}
	if !oneOf(in.LegalRegime, "au_pre_2026_12_04", "au_enhanced_2026_12_04", "nz", "unknown") {
		return fmt.Errorf("legal_regime: unsupported %q", in.LegalRegime)
	}
	if !oneOf(in.DeclaredReason, "initial", "change", "ceasing", "unknown") {
		return fmt.Errorf("declared_reason: unsupported %q", in.DeclaredReason)
	}
	for _, field := range []struct{ name, value string }{
		{"announced_on", in.AnnouncedOn}, {"notice_date", in.NoticeDate},
		{"effective_change_date", in.EffectiveChangeDate}, {"previous_notice_date", in.PreviousNoticeDate},
	} {
		if field.value != "" {
			if _, err := time.Parse("2006-01-02", field.value); err != nil {
				return fmt.Errorf("%s: expected a real YYYY-MM-DD date", field.name)
			}
		}
	}
	if in.PublishedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, in.PublishedAt); err != nil {
			return fmt.Errorf("published_at: expected RFC3339 timestamp with timezone")
		}
	}
	if !oneOf(in.ReviewState, "needs_review", "reviewed", "rejected") {
		return fmt.Errorf("review_state: unsupported %q", in.ReviewState)
	}
	if !oneOf(in.ExtractionCompleteness, "partial", "complete", "not_extracted") {
		return fmt.Errorf("extraction_completeness: unsupported %q", in.ExtractionCompleteness)
	}
	if in.PublicationEligible {
		return fmt.Errorf("publication_eligible: this contract cannot publish revisions")
	}
	if err := textSet(in.ReviewReasons, 64, 512); err != nil {
		return fmt.Errorf("review_reasons: %w", err)
	}
	if len(in.Measurements) > 14 || len(in.DisclosedMovements) > 7 || len(in.SecurityClasses) > 256 ||
		len(in.Interests) > 2048 || len(in.Annexures) > 128 {
		return fmt.Errorf("extraction exceeds bounded collection limits")
	}
	seenMeasures := map[string]bool{}
	for i, m := range in.Measurements {
		key := m.Measure + "/" + m.Period
		if !measure(m.Measure) || !period(m.Period) || seenMeasures[key] {
			return fmt.Errorf("measurements[%d]: invalid or duplicate (measure, period)", i)
		}
		seenMeasures[key] = true
		if err := observed(m.Percent, "decimal"); err != nil {
			return fmt.Errorf("measurements[%d].percent: %w", i, err)
		}
		if err := observed(m.Votes, "integer"); err != nil {
			return fmt.Errorf("measurements[%d].votes: %w", i, err)
		}
		if err := observed(m.DenominatorVotes, "integer"); err != nil {
			return fmt.Errorf("measurements[%d].denominator_votes: %w", i, err)
		}
	}
	seenMovements := map[string]bool{}
	for i, m := range in.DisclosedMovements {
		if !measure(m.Measure) || seenMovements[m.Measure] {
			return fmt.Errorf("disclosed_movements[%d]: invalid or duplicate measure", i)
		}
		seenMovements[m.Measure] = true
		if err := observed(m.DisclosedMovementPP, "signed_decimal"); err != nil {
			return fmt.Errorf("disclosed_movements[%d]: %w", i, err)
		}
	}
	classes := map[string]bool{}
	for i, c := range in.SecurityClasses {
		key := c.ClassID + "/" + c.Period
		if !text(c.ClassID, 128, true) || !period(c.Period) || classes[key] {
			return fmt.Errorf("security_classes[%d]: invalid or duplicate (class_id, period)", i)
		}
		classes[key] = true
		for _, v := range []struct {
			name, kind string
			value      ObservedValue
		}{
			{"name", "text", c.Name}, {"issued_securities", "decimal", c.IssuedSecurities},
			{"held_securities", "decimal", c.HeldSecurities}, {"votes_per_security", "decimal", c.VotesPerSecurity},
			{"reported_class_percent", "decimal", c.ReportedClassPercent},
		} {
			if err := observed(v.value, v.kind); err != nil {
				return fmt.Errorf("security_classes[%d].%s: %w", i, v.name, err)
			}
		}
		if !text(c.ClassPercentBasis, 512, c.ReportedClassPercent.Status == Reported) {
			return fmt.Errorf("security_classes[%d].class_percent_basis: required for reported class percent", i)
		}
	}
	rows := map[string]bool{}
	for i, r := range in.Interests {
		if !text(r.RowID, 128, true) || rows[r.RowID] || !period(r.Period) ||
			!oneOf(r.Kind, "relevant_interest", "deemed_economic_interest", "offsetting_short_position") {
			return fmt.Errorf("interests[%d]: invalid row identity, period or kind", i)
		}
		rows[r.RowID] = true
		if !classes[r.ClassID+"/"+r.Period] {
			return fmt.Errorf("interests[%d].class_id: no class in the same period", i)
		}
		for _, v := range []struct {
			name, kind string
			value      ObservedValue
		}{
			{"holder", "text", r.Holder}, {"registered_holder", "text", r.RegisteredHolder},
			{"person_entitled", "text", r.PersonEntitled}, {"quantity", "decimal", r.Quantity}, {"votes", "integer", r.Votes},
		} {
			if err := observed(v.value, v.kind); err != nil {
				return fmt.Errorf("interests[%d].%s: %w", i, v.name, err)
			}
		}
		if err := textSet(r.LegalBases, 32, 128); err != nil {
			return fmt.Errorf("interests[%d].legal_bases: %w", i, err)
		}
		if !text(r.AgreementDetails, 4096, false) {
			return fmt.Errorf("interests[%d].agreement_details: invalid text", i)
		}
		if err := evidence(r.Evidence); err != nil {
			return fmt.Errorf("interests[%d].evidence: %w", i, err)
		}
	}
	annexures := map[string]bool{}
	for i, a := range in.Annexures {
		if !text(a.ID, 128, true) || annexures[a.ID] || a.Parsed && !a.Obtained {
			return fmt.Errorf("annexures[%d]: invalid identity or parsed without obtaining source", i)
		}
		annexures[a.ID] = true
		if a.Referenced && !a.Parsed && in.ExtractionCompleteness == "complete" {
			return fmt.Errorf("annexures[%d]: unparsed referenced annexure makes coverage incomplete", i)
		}
		if err := evidence(a.Evidence); err != nil {
			return fmt.Errorf("annexures[%d].evidence: %w", i, err)
		}
	}
	if err := evidence(in.ContextEvidence); err != nil {
		return fmt.Errorf("context_evidence: %w", err)
	}
	for _, id := range []string{in.SupersedesRevisionID, in.SupersedesDisclosureID} {
		if id != "" && !sha256Pattern.MatchString(id) {
			return fmt.Errorf("supersedes link: expected deterministic lowercase SHA256 identity")
		}
	}
	if (in.SupersedesDisclosureID != "") != (len(in.CorrectionEvidence) > 0) {
		return fmt.Errorf("a filing correction requires both a target disclosure and source evidence")
	}
	if err := evidence(in.CorrectionEvidence); err != nil {
		return fmt.Errorf("correction_evidence: %w", err)
	}
	var evidenceErr error
	visitEvidence(&in, func(e *Evidence) {
		if e.SourceURL == in.Source.URL {
			if e.SourceSHA256 != "" && e.SourceSHA256 != in.Source.SHA256 {
				evidenceErr = fmt.Errorf("source evidence hash conflicts with the main document")
			}
		} else if !sha256Pattern.MatchString(e.SourceSHA256) {
			evidenceErr = fmt.Errorf("cross-document evidence requires that document's captured SHA256")
		}
	})
	if evidenceErr != nil {
		return evidenceErr
	}
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > maxPayloadBytes {
		return fmt.Errorf("extraction payload exceeds %d bytes or cannot be encoded", maxPayloadBytes)
	}
	return nil
}

func observed(v ObservedValue, kind string) error {
	if !oneOf(string(v.Status), string(Reported), string(Unknown), string(Missing), string(Unreadable), string(NotApplicable), string(NotExtracted)) {
		return fmt.Errorf("unknown value status %q", v.Status)
	}
	if v.Status == Reported {
		if v.Value == "" {
			return fmt.Errorf("reported value is absent (zero must be explicit)")
		}
		switch kind {
		case "decimal":
			if len(v.Value) > 128 || !decimalPattern.MatchString(v.Value) {
				return fmt.Errorf("expected finite nonnegative decimal string")
			}
		case "signed_decimal":
			if len(v.Value) > 128 || !signedDecimalPattern.MatchString(v.Value) {
				return fmt.Errorf("expected finite signed decimal string")
			}
		case "integer":
			if len(v.Value) > 128 || !integerPattern.MatchString(v.Value) {
				return fmt.Errorf("expected nonnegative integer string")
			}
		case "text":
			if !text(v.Value, 512, true) {
				return fmt.Errorf("invalid reported text")
			}
		}
	} else if v.Value != "" {
		return fmt.Errorf("only reported observations may carry a value")
	}
	if v.Status != NotExtracted && len(v.Evidence) == 0 {
		return fmt.Errorf("an observed status requires source evidence")
	}
	return evidence(v.Evidence)
}

func evidence(rows []Evidence) error {
	if len(rows) > 64 {
		return fmt.Errorf("too many source locators")
	}
	for i, e := range rows {
		if err := sourceURL(e.SourceURL); err != nil {
			return fmt.Errorf("locator %d: %w", i, err)
		}
		if e.SourceSHA256 != "" && !sha256Pattern.MatchString(e.SourceSHA256) {
			return fmt.Errorf("locator %d: invalid source hash", i)
		}
		if e.Page < 0 || e.Page > 1000000 || !text(e.Section, 256, false) ||
			!text(e.Row, 256, false) || !text(e.TextSpan, 4096, false) {
			return fmt.Errorf("locator %d: invalid page or source text", i)
		}
		if e.Page == 0 && e.Section == "" && e.Row == "" && e.TextSpan == "" {
			return fmt.Errorf("locator %d: URL alone does not locate a field", i)
		}
	}
	return nil
}

func sourceURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || len(value) > 4096 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") ||
		u == nil || !oneOf(u.Scheme, "https", "http") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("expected an absolute HTTP(S) source URL without credentials or fragment")
	}
	return nil
}

func text(value string, max int, required bool) bool {
	return len(value) <= max && utf8.ValidString(value) && !strings.ContainsRune(value, 0) && (!required || strings.TrimSpace(value) != "")
}

func textSet(values []string, limit, max int) error {
	if len(values) > limit {
		return fmt.Errorf("too many entries")
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !text(value, max, true) || seen[value] {
			return fmt.Errorf("empty, oversized or duplicate entry")
		}
		seen[value] = true
	}
	return nil
}

func oneOf(value string, choices ...string) bool { return slices.Contains(choices, value) }
func measure(value string) bool                  { return len(value) == 1 && value[0] >= 'A' && value[0] <= 'G' }
func period(value string) bool                   { return oneOf(value, "previous", "present") }

// DecodeInput rejects unknown fields, trailing JSON and oversized payloads.
func DecodeInput(raw []byte) (Input, error) {
	var in Input
	if len(raw) > maxPayloadBytes {
		return in, fmt.Errorf("extraction payload too large")
	}
	if err := rejectDuplicateJSONFields(json.NewDecoder(bytes.NewReader(raw))); err != nil {
		return in, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&in); err != nil {
		return in, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return in, fmt.Errorf("expected exactly one JSON object")
	}
	return in, Validate(in)
}

// encoding/json otherwise accepts the last occurrence of a duplicate key,
// silently losing supplied extraction metadata before it can be hashed.
func rejectDuplicateJSONFields(d *json.Decoder) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok {
				return fmt.Errorf("expected JSON field name")
			}
			folded := strings.ToLower(name)
			if seen[folded] {
				return fmt.Errorf("duplicate JSON field %q", name)
			}
			seen[folded] = true
			if err := rejectDuplicateJSONFields(d); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := rejectDuplicateJSONFields(d); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	_, err = d.Token()
	return err
}

// Prepare returns deterministic identities and a canonical copy, without a
// storage timestamp. Ordering of keyed observations/sets is not meaningful;
// lexical source values (including precision) and provenance are meaningful.
func Prepare(in Input) (Revision, error) {
	if err := Validate(in); err != nil {
		return Revision{}, err
	}
	// Deep-copy before sorting, so a writer never mutates its caller's values.
	raw, _ := json.Marshal(in)
	var canonical Input
	if err := json.Unmarshal(raw, &canonical); err != nil {
		return Revision{}, err
	}
	canonicalise(&canonical)
	raw, err := json.Marshal(canonical)
	if err != nil {
		return Revision{}, err
	}
	// Explicit inherited hashes expand the input. Bound the actual stored
	// canonical representation too, before Append opens a transaction.
	if len(raw) > maxPayloadBytes {
		return Revision{}, fmt.Errorf("canonical extraction payload exceeds %d bytes", maxPayloadBytes)
	}
	disclosureID := identity("shorted.ownership.disclosure-id.v1", in.Source.URL, in.Source.SHA256, fmt.Sprint(in.DisclosureSlot))
	revisionID := identity("shorted.ownership.revision-id.v1", disclosureID, in.Source.SHA256,
		in.ExtractorVersion, in.ExtractorConfigSHA256, in.ContractVersion)
	if in.SupersedesRevisionID == revisionID || in.SupersedesDisclosureID == disclosureID {
		return Revision{}, fmt.Errorf("a revision or disclosure cannot supersede itself")
	}
	return Revision{DisclosureID: disclosureID, RevisionID: revisionID, PayloadSHA256: digest(raw), Input: canonical}, nil
}

func identity(parts ...string) string { raw, _ := json.Marshal(parts); return digest(raw) }
func digest(raw []byte) string        { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

func canonicalise(in *Input) {
	visitEvidence(in, func(e *Evidence) {
		if e.SourceSHA256 == "" && e.SourceURL == in.Source.URL {
			e.SourceSHA256 = in.Source.SHA256
		}
	})
	sortEvidence := func(rows []Evidence) {
		slices.SortFunc(rows, func(a, b Evidence) int { x, _ := json.Marshal(a); y, _ := json.Marshal(b); return bytes.Compare(x, y) })
	}
	value := func(v *ObservedValue) { sortEvidence(v.Evidence) }
	slices.Sort(in.ReviewReasons)
	slices.SortFunc(in.Measurements, func(a, b Measurement) int { return strings.Compare(a.Measure+"/"+a.Period, b.Measure+"/"+b.Period) })
	for i := range in.Measurements {
		m := &in.Measurements[i]
		value(&m.Percent)
		value(&m.Votes)
		value(&m.DenominatorVotes)
	}
	slices.SortFunc(in.DisclosedMovements, func(a, b DisclosedMovement) int { return strings.Compare(a.Measure, b.Measure) })
	for i := range in.DisclosedMovements {
		value(&in.DisclosedMovements[i].DisclosedMovementPP)
	}
	slices.SortFunc(in.SecurityClasses, func(a, b SecurityClass) int { return strings.Compare(a.ClassID+"/"+a.Period, b.ClassID+"/"+b.Period) })
	for i := range in.SecurityClasses {
		c := &in.SecurityClasses[i]
		value(&c.Name)
		value(&c.IssuedSecurities)
		value(&c.HeldSecurities)
		value(&c.VotesPerSecurity)
		value(&c.ReportedClassPercent)
	}
	slices.SortFunc(in.Interests, func(a, b Interest) int { return strings.Compare(a.RowID, b.RowID) })
	for i := range in.Interests {
		r := &in.Interests[i]
		value(&r.Holder)
		value(&r.RegisteredHolder)
		value(&r.PersonEntitled)
		value(&r.Quantity)
		value(&r.Votes)
		slices.Sort(r.LegalBases)
		sortEvidence(r.Evidence)
	}
	slices.SortFunc(in.Annexures, func(a, b Annexure) int { return strings.Compare(a.ID, b.ID) })
	for i := range in.Annexures {
		sortEvidence(in.Annexures[i].Evidence)
	}
	sortEvidence(in.ContextEvidence)
	sortEvidence(in.CorrectionEvidence)
}

func visitEvidence(in *Input, visit func(*Evidence)) {
	rows := func(es []Evidence) {
		for i := range es {
			visit(&es[i])
		}
	}
	value := func(v *ObservedValue) { rows(v.Evidence) }
	for i := range in.Measurements {
		m := &in.Measurements[i]
		value(&m.Percent)
		value(&m.Votes)
		value(&m.DenominatorVotes)
	}
	for i := range in.DisclosedMovements {
		value(&in.DisclosedMovements[i].DisclosedMovementPP)
	}
	for i := range in.SecurityClasses {
		c := &in.SecurityClasses[i]
		value(&c.Name)
		value(&c.IssuedSecurities)
		value(&c.HeldSecurities)
		value(&c.VotesPerSecurity)
		value(&c.ReportedClassPercent)
	}
	for i := range in.Interests {
		r := &in.Interests[i]
		value(&r.Holder)
		value(&r.RegisteredHolder)
		value(&r.PersonEntitled)
		value(&r.Quantity)
		value(&r.Votes)
		rows(r.Evidence)
	}
	for i := range in.Annexures {
		rows(in.Annexures[i].Evidence)
	}
	rows(in.ContextEvidence)
	rows(in.CorrectionEvidence)
}
