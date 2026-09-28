package extractiontrust

import (
	"regexp"
	"strings"
)

// IsResultsDocument reports whether an extraction's source document is a
// statutory results document (contract 4.1, 4.2 gate 1, 5.1 latest_filing, 6.1
// targeting): an Appendix 4D/4E, a half-year / interim / annual report, a
// preliminary final report, or a full-year / half-year results announcement.
//
// title is the announcement headline (financial_report_extractions
// .report_title). reportKind is document_meta.report_kind ("" when absent).
//
// The title decides; reportKind can only veto or stand in for a missing title:
//
//  1. reportKind "other" (the document names itself as a presentation,
//     Pillar 3 disclosure and so on) is never a results document.
//  2. An empty title is a results document only when reportKind is a
//     statutory kind (appendix_4e, appendix_4d, annual_report,
//     half_year_report, results_announcement).
//  3. Hard exclusions always win: Pillar 3 / Basel, "items impacting",
//     Form 20-F, webcasts, transcripts, investor days and briefings, AGM /
//     chair / CEO addresses, dividend and distribution notices, "Notice of
//     ...", results dates, meeting results, discussion / data packs.
//     Presentations and slides exclude unless the title names an Appendix
//     4D/4E (a bundled "Appendix 4E ... and Investor Presentation" lodges the
//     statutory 4E; the orchestrator's refinement of contract 4.1).
//  4. Quarterly language (quarterly, Appendix 4C, Q3, 3Q26, activities
//     report) excludes unless the title names an Appendix 4D/4E.
//  5. Soft exclusions (webinar, conference call, dial-in, "to present",
//     registration details) exclude unless a strong statutory marker is
//     present ("FY26 Financial Results Release and Webinar" is a real filing).
//  6. Otherwise the title must match a results pattern; a title that matches
//     none is withheld (a neutral "Company Update" is not guessed at, whatever
//     reportKind says).
//
// Matching runs on Normalise(title). The patterns agree with
// services/jobs/internal/jobs/picks/filings.go (classifyResultsFiling) and
// reportextract/select.go (isExtractionTarget) on every headline their tests
// carry, but this classifier is stricter: it answers "are this document's
// figures the company's statutory results", not "did results news happen".
// The shared fixture testdata/results_titles.json pins it for Go and Python.
func IsResultsDocument(title, reportKind string) bool {
	kind := strings.ToLower(strings.TrimSpace(reportKind))
	if kind == ReportKindOther {
		return false
	}
	t := Normalise(title)
	if t == "" {
		return statutoryReportKinds[kind]
	}
	if hardExclusionRE.MatchString(t) {
		return false
	}
	if presentationRE.MatchString(t) && !appendix4DERE.MatchString(t) {
		return false
	}
	if quarterlyRE.MatchString(t) && !appendix4DERE.MatchString(t) {
		return false
	}
	if softExclusionRE.MatchString(t) && !strongStatutoryRE.MatchString(t) {
		return false
	}
	return resultsTitleRE.MatchString(t)
}

// statutoryReportKinds are the document_meta.report_kind values that identify
// a results document on their own (every kind except "other").
var statutoryReportKinds = map[string]bool{
	ReportKindAppendix4E:          true,
	ReportKindAppendix4D:          true,
	ReportKindAnnualReport:        true,
	ReportKindHalfYearReport:      true,
	ReportKindResultsAnnouncement: true,
}

// Period words that introduce a results headline: full year, half year,
// interim, FY26 / FY2026, HY26, 1H26 / 1H FY26, H1 26 / H1 FY26.
const periodWords = `(?:full[\s-]?year|half[\s-]?year(?:ly)?|interim|fy\s?\d{2,4}|hy\s?\d{2,4}|[12]h\s?(?:fy)?\s?\d{2,4}|h[12]\s?(?:fy)?\s?\d{2,4})`

// resultsTitlePatterns: a title matching any is a results document (subject to
// the exclusions above).
var resultsTitlePatterns = []string{
	`\bappendix\s*4[de]\b`,
	`\bresults?\s+for\s+announcement\s+to\s+the\s+market\b`,
	`\bpreliminary\s+final\b`,
	`\bannual\s+(?:financial\s+)?report\b`,
	`\b(?:half[\s-]?year(?:ly)?|interim|yearly)\s+(?:financial\s+)?report\b`,
	`\b` + periodWords + `\b[^.]{0,40}\b(?:results?|financial\s+statements?|accounts)\b`,
	`\bresults?\s+(?:release|announcement|summary)\b`,
	`\bfinancial\s+(?:report|statements?)\b`,
	`\bresults?\b[^.]{0,30}\bfor\s+(?:the\s+)?(?:(?:financial\s+)?year|half[\s-]?year|half|six\s+months|twelve\s+months|12\s+months|period)\b`,
	`\bprofit\s+announcement\b`,
}

// strongStatutoryPatterns override the soft exclusions.
var strongStatutoryPatterns = []string{
	`\bappendix\s*4[de]\b`,
	`\bresults?\s+for\s+announcement\s+to\s+the\s+market\b`,
	`\bpreliminary\s+final\b`,
	`\bresults?\s+(?:release|announcement|summary)\b`,
	`\bfinancial\s+report\s+for\b`,
	`\b(?:half[\s-]?year(?:ly)?|interim)\s+(?:financial\s+)?report\b`,
	`\bannual\s+financial\s+report\b`,
}

// hardExclusionPatterns: never a results document, whatever else the title
// says.
var hardExclusionPatterns = []string{
	// Prudential disclosures (banks' Pillar 3 / APS 330 reports).
	`\bpillar\s*(?:3|iii)\b`,
	`\bbasel\b`,
	`\baps\s*330\b`,
	// Reconciliations of one-off items, not the result.
	`\bitems?\s+impacting\b`,
	// The US-format duplicate of the annual report.
	`\b20-?f\b`,
	// Presentation derivatives (presentations and slides themselves are in
	// presentationPatterns: an Appendix 4D/4E marker overrides those).
	`\bwebcasts?\b`,
	`\btranscripts?\b`,
	`\binvestor\s+(?:day|days|briefing|strategy\s+day)\b`,
	`\bcapital\s+markets?\s+day\b`,
	`\bstrategy\s+day\b`,
	`\bbriefings?\b`,
	`\b(?:discussion|investor|data|analyst)\s+pack\b`,
	`\bdata\s*book\b`,
	`\bfact\s*sheet\b`,
	// Meeting addresses and outcomes.
	`\bagm\s+(?:address|speech|presentation)\b`,
	`\b(?:chair(?:man|woman|person)?|ceo|md|managing\s+director)(?:'s|s'|s)?\s+(?:agm\s+)?(?:address|speech)\b`,
	`\baddress\s+to\s+(?:share|security|unit)\s?holders\b`,
	`\bresults?\s+of\s+(?:the\s+)?(?:\d{4}\s+)?(?:annual\s+general\s+|general\s+|extraordinary\s+general\s+|extraordinary\s+)?meeting\b`,
	`^notice\s+of\b`,
	// Scheduling notices.
	`\bresults?\s+(?:announcement\s+|release\s+)?dates?\b`,
	// Dividend and distribution administration.
	`^(?:update\s*-\s*)?dividend/distribution\b`,
	`^confirmation\s+of\b.*\bdividend\b`,
	`\b(?:dividend|distribution)\s+(?:notice|reinvestment)\b`,
}

// presentationPatterns exclude unless the title names an Appendix 4D/4E: a
// bundled "Appendix 4E ... and Investor Presentation" lodges the statutory 4E,
// and the own-period and statutory gates downstream still apply to whatever
// figures it yields. A bare "Results Presentation" stays withheld.
var presentationPatterns = []string{
	`\bpresentations?\b`,
	`\bslides?\b`,
}

// softExclusionPatterns exclude unless a strong statutory marker is present.
var softExclusionPatterns = []string{
	`\bwebinars?\b`,
	`\bconference\s+call\b`,
	`\bdial[-\s]?in\b`,
	`\bto\s+present\b`,
	`\bregistration\s+details\b`,
}

var (
	resultsTitleRE    = joinPatterns(resultsTitlePatterns)
	strongStatutoryRE = joinPatterns(strongStatutoryPatterns)
	hardExclusionRE   = joinPatterns(hardExclusionPatterns)
	presentationRE    = joinPatterns(presentationPatterns)
	softExclusionRE   = joinPatterns(softExclusionPatterns)

	appendix4DERE = regexp.MustCompile(`(?i)\bappendix\s*4[de]\b`)
	// Quarterly documents (Appendix 4C cash-flow reports, activities reports,
	// Q3 / 3Q26 results), from reportextract/select.go's quarterlyRE.
	quarterlyRE = regexp.MustCompile(`(?i)\bquarterly\b|\bquarter\b|\bappendix\s*4c\b|\b4c\b|\b[1-4]q\s?(?:fy)?\s?\d{2,4}\b|\bq[1-4]\b|\bactivit(?:y|ies)\s+(?:report|statement|update)\b`)
)

func joinPatterns(patterns []string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)(?:` + strings.Join(patterns, `)|(?:`) + `)`)
}
