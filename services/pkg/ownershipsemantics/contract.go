// Package ownershipsemantics stores source-grounded extraction revisions for
// ownership notices. It neither parses documents nor publishes holdings.
package ownershipsemantics

import "time"

const ContractVersion = "shorted.ownership.disclosure.v1"

// ValueStatus distinguishes an observed zero from information not available to
// an extraction. A legacy NULL is NotExtracted, never evidence of Missing.
type ValueStatus string

const (
	Reported      ValueStatus = "reported"
	Unknown       ValueStatus = "unknown"
	Missing       ValueStatus = "missing"
	Unreadable    ValueStatus = "unreadable"
	NotApplicable ValueStatus = "not_applicable"
	NotExtracted  ValueStatus = "not_extracted"
)

// Evidence locates a field in a source. Page is one-based; zero means no page
// was captured. TextSpan is a short source excerpt, not an invented explanation.
type Evidence struct {
	SourceURL string `json:"source_url"`
	// An omitted hash inherits Input.Source.SHA256 only for the same URL.
	// A locator in another document must supply that document's captured hash.
	SourceSHA256 string `json:"source_sha256,omitempty"`
	Page         int    `json:"page,omitempty"`
	Section      string `json:"section,omitempty"`
	Row          string `json:"row,omitempty"`
	TextSpan     string `json:"text_span,omitempty"`
}

// ObservedValue preserves the reported lexical value and its own evidence.
// Numeric fields use exact decimal/integer strings, never binary floats. The
// same shape holds text observations (for example an explicitly unknown name).
type ObservedValue struct {
	Status   ValueStatus `json:"status"`
	Value    string      `json:"value,omitempty"`
	Evidence []Evidence  `json:"evidence,omitempty"`
}

type Source struct {
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	HashStatus string `json:"hash_status"`
}

// Measurement is a body-level total, not a security-class percentage. Measure
// is the source's A–G label; Period is previous or present. B retains the
// existing voting-power meaning. A is never computed as B+C and G is not netted.
type Measurement struct {
	Measure          string        `json:"measure"`
	Period           string        `json:"period"`
	Percent          ObservedValue `json:"percent"`
	Votes            ObservedValue `json:"votes"`
	DenominatorVotes ObservedValue `json:"denominator_votes"`
}

// DisclosedMovement preserves a signed source-reported movement in percentage
// points. It is not a third period or an automatically calculated change.
type DisclosedMovement struct {
	Measure             string        `json:"measure"`
	DisclosedMovementPP ObservedValue `json:"disclosed_movement_pp"`
}

// SecurityClass is one class's observations in one period. ClassID is an
// extraction-local source label, not a market-wide security identity. Class
// quantities and voting rights stay separate from body-level A–G totals.
type SecurityClass struct {
	ClassID              string        `json:"class_id"`
	Period               string        `json:"period"`
	Name                 ObservedValue `json:"name"`
	IssuedSecurities     ObservedValue `json:"issued_securities"`
	HeldSecurities       ObservedValue `json:"held_securities"`
	VotesPerSecurity     ObservedValue `json:"votes_per_security"`
	ReportedClassPercent ObservedValue `json:"reported_class_percent"`
	ClassPercentBasis    string        `json:"class_percent_basis,omitempty"`
}

// Interest is one disclosed row, even when more than one statutory basis
// applies to it. No holder/associate deduplication or aggregation is performed.
type Interest struct {
	RowID            string        `json:"row_id"`
	Period           string        `json:"period"`
	Kind             string        `json:"kind"`
	Holder           ObservedValue `json:"holder"`
	RegisteredHolder ObservedValue `json:"registered_holder"`
	PersonEntitled   ObservedValue `json:"person_entitled"`
	ClassID          string        `json:"class_id"`
	Quantity         ObservedValue `json:"quantity"`
	Votes            ObservedValue `json:"votes"`
	LegalBases       []string      `json:"legal_bases,omitempty"`
	AgreementDetails string        `json:"agreement_details,omitempty"`
	Evidence         []Evidence    `json:"evidence,omitempty"`
}

type Annexure struct {
	ID         string     `json:"id"`
	Referenced bool       `json:"referenced"`
	Obtained   bool       `json:"obtained"`
	Parsed     bool       `json:"parsed"`
	Evidence   []Evidence `json:"evidence,omitempty"`
}

// Input is immutable extraction metadata. ReviewState describes the supplied
// extraction (needs_review, reviewed or rejected); it is not a review decision
// API. Completeness describes extraction coverage, never statutory compliance.
// PublicationEligible must be false even for a complete/reviewed extraction.
//
// DisclosureSlot is a stable, one-based position of the notice in the source
// document, not a holder slug. URL, captured source SHA256 and slot identify a
// filing, so corrected bytes replacing the same URL remain a different filing.
// SupersedesRevisionID means a new extraction of those SAME source bytes.
// SupersedesDisclosureID means an evidenced correction in a DIFFERENT filing.
type Input struct {
	ContractVersion        string              `json:"contract_version"`
	Source                 Source              `json:"source"`
	DisclosureSlot         int                 `json:"disclosure_slot"`
	ExtractorVersion       string              `json:"extractor_version"`
	ExtractorConfigSHA256  string              `json:"extractor_config_sha256"`
	Jurisdiction           string              `json:"jurisdiction"`
	DocumentFormat         string              `json:"document_format"`
	LegalRegime            string              `json:"legal_regime"`
	DeclaredReason         string              `json:"declared_reason"`
	AnnouncedOn            string              `json:"announced_on,omitempty"`
	PublishedAt            string              `json:"published_at,omitempty"`
	NoticeDate             string              `json:"notice_date,omitempty"`
	EffectiveChangeDate    string              `json:"effective_change_date,omitempty"`
	PreviousNoticeDate     string              `json:"previous_notice_date,omitempty"`
	ReviewState            string              `json:"review_state"`
	ReviewReasons          []string            `json:"review_reasons,omitempty"`
	ExtractionCompleteness string              `json:"extraction_completeness"`
	PublicationEligible    bool                `json:"publication_eligible"`
	Measurements           []Measurement       `json:"measurements,omitempty"`
	DisclosedMovements     []DisclosedMovement `json:"disclosed_movements,omitempty"`
	SecurityClasses        []SecurityClass     `json:"security_classes,omitempty"`
	Interests              []Interest          `json:"interests,omitempty"`
	Annexures              []Annexure          `json:"annexures,omitempty"`
	ContextEvidence        []Evidence          `json:"context_evidence,omitempty"`
	SupersedesRevisionID   string              `json:"supersedes_revision_id,omitempty"`
	SupersedesDisclosureID string              `json:"supersedes_disclosure_id,omitempty"`
	CorrectionEvidence     []Evidence          `json:"correction_evidence,omitempty"`
}

// Revision is the stored result. IDs and PayloadSHA256 are deterministic;
// RecordedAt is set by storage once and is excluded from replay identity and
// equality. A replay returns this original timestamp and payload.
type Revision struct {
	DisclosureID  string    `json:"disclosure_id"`
	RevisionID    string    `json:"revision_id"`
	PayloadSHA256 string    `json:"payload_sha256"`
	RecordedAt    time.Time `json:"recorded_at"`
	Input         Input     `json:"input"`
}
