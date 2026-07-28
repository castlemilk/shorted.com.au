// Package reportextract is the Python→Go port of services/report-extractor —
// the ASX financial-report + director-trade extraction family
// (docs/jobs-consolidation-plan.md Phase 3, item 10).
//
// Three Python scripts, two deployed Cloud Run Jobs, one shared helper library:
//
//	extract.py                    the helper library (PDF fetch/parse, langextract
//	                              wiring, digest, GCS, upsert) AND a sequential
//	                              laptop CLI over it. NOT deployed.
//	extract_reports_concurrent.py the deployed `financial-report-extractor`
//	                              (weekly): the same pipeline under a thread pool,
//	                              plus a --backfill-digests mode.
//	extract_director_trades.py    the deployed `director-trade-extractor` (daily):
//	                              Appendix 3Y PDFs → director_trades columns.
//
// The Go shape mirrors that topology:
//
//	shorted report-extract concurrent   ← extract_reports_concurrent.py  (DEPLOYED)
//	shorted report-extract sequential   ← extract.py's main()            (laptop)
//	shorted director-trades             ← extract_director_trades.py     (DEPLOYED)
//
// `report-extract` is a runner.Group rather than one flat subcommand because the
// two report scripts disagree on flag DEFAULTS (-recent 2 vs 0, -workers 8 vs a
// sequential -delay loop, -mode all vs top50). Folding them into one flag set
// would have silently changed one caller's defaults — exactly the divergence the
// port is meant to avoid. `director-trades` stays flat: one script, one job.
//
// Everything the three scripts share (`import extract`) lives in this one
// package, the same way it lives in one module in Python.
//
// # Divergences that matter
//
// See services/jobs/README.md ("Phase 3 port notes") for the full per-flag and
// per-interaction parity tables, including the PDF-text-extraction engine swap
// (pymupdf → github.com/ledongthuc/pdf) which is the one place output is NOT
// guaranteed byte-identical.
package reportextract
