// Package extractiontrust is the ONE trust funnel for LLM-extracted financial
// report metrics (financial_report_extractions.metrics and .document_meta).
//
// Design contract: docs/plans/fundamentals-coverage.md, sections 2.5 and 4.1.
// Every reader of those columns (the picks filings ingest, the shorts API's
// GetStockFinancialHighlights, the weekly-report collector, the digest prompts)
// applies the same rules, from here, so the rules cannot drift between them:
//
//   - Grounded: an entry the extractor could not align to its document, or whose
//     quote is the prompt's own few-shot example echoed back, is dropped. The
//     denylist is by TEXT, never by value: CBA's real 1H25 statutory NPAT is also
//     $5,142m, the old example's revenue figure.
//   - IsProvenanceKey / StripProvenance: the extractor's alignment bookkeeping
//     (alignment, char_start, char_end) never reaches an API response or an LLM
//     prompt.
//   - IsResultsDocument: the statutory-results title classifier (Appendix 4D/4E,
//     half-year and annual reports, preliminary final, results announcements;
//     never Pillar 3, "items impacting", Form 20-F, presentations, webcasts,
//     transcripts or investor days).
//   - DocumentMeta / ParseDocumentMeta: the closed vocabulary of the
//     document_meta column; any out-of-vocabulary value reads as absent.
//
// The few-shot example itself (the new synthetic "Quokka Minerals Limited"
// document) is defined ONCE, here (FewShotExample). The Python extractor
// (services/report-extractor/extract.py) and the Go port
// (services/jobs/internal/jobs/reportextract) copy it verbatim; the JSON mirror
// testdata/fewshot_example.json is pinned to the Go value by a test.
//
// The shared fixtures in testdata/ (results_titles.json,
// document_meta_cases.json) are asserted by this package's tests AND by the
// Python extractor's tests, so the two languages agree on every case.
//
// Every regular expression in this package is written in the common subset of
// Go RE2 and Python re (no look-around, no possessive quantifiers), so the
// Python port can copy the patterns unchanged.
package extractiontrust
