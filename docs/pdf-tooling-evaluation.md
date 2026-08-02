# PDF tooling evaluation — pdf-inspector and Unlimited-OCR (2026-08-02)

Evidence-based assessment of two candidate tools against the actual extraction
stack (register pipeline + report-extractor). Trial artifacts and clones:
`/Volumes/gamma-systems-2/dev-caches/pdf-tools-eval/`.

## Corrected premise first

The register's scanned backlog is **already drained**: architecture.md §8.9
supersedes §6.2 — 44P/45P are at 100% via the vision tier. The residual gaps
are (a) the 46P/47P centred-label quarantine (§2.8 — a text-tier gap with a
scoped fix: `pymupdf.find_tables()` cell boxes), and (b) the 35 Senate volumes,
blocked on the Form A splitter (§2.7) — 2022+ volumes are born-digital text, so
neither gap is an OCR problem.

## baidu/Unlimited-OCR — SKIP

DeepSeek-OCR with sliding-window decoder attention (constant KV cache, whole
documents in one 32K pass; MIT code AND weights; 21k stars in 6 weeks; Baidu-
backed). Not a fit at any integration cost:

- **CUDA-only** (fa3/Hopper pins); we have no GPU anywhere and the vision tier
  runs on operator Macs.
- **No cost to beat** — the Gemini vision tier bills nothing (operator `agy`
  auth), and its target backlog is already extracted.
- **Determinism is worse**: it ships a `no_repeat_ngram` logit processor to
  suppress decode loops — hallucination management on a corpus where invention
  is the cardinal sin; our tier has JSON schemas + the contains_amount tripwire.
- **Supply chain**: the documented install is an unsigned pre-release SGLang
  wheel vendored in the repo (not on PyPI) plus `trust_remote_code=True`.

Revisit only if we acquire GPU capacity AND a genuinely heavy-OCR corpus.

## firecrawl/pdf-inspector — SKIP for the register, TRIAL for report-extractor

Pure-Rust classifier + born-digital-PDF→Markdown converter (MIT, no ML, no
network, ~7–30ms per register PDF, credible third-party bench, active but
bus-factor-1). Measured on real register PDFs (Aly 48P, Templeman 47P):

- Genuinely strong on simple forms — recovered holder-attributed tables
  matching our golden JSON, and its per-page `needs_ocr` matched our classifier.
- **Disqualifying for the register**: Markdown tables flatten multi-line cells
  ("Winmalee NSW Campbell ACT Wentworth Falls NSW" as one string) — the exact
  §2.6 violation that silently loses declared properties — and on the 47P
  centred-label class it degrades to *silent partial structure* (orphaned
  Dependent-children rows, merged items), worse for us than the explicit
  `partial` quarantine. The cell-bbox API that could fix both is not exposed
  through the Python binding (bring-your-own-model TSR or a Rust sidecar),
  while `pymupdf.find_tables()` — already a dependency — returns cell boxes
  in Python today. The §2.8 fix stays pymupdf.

**Trial (report-extractor only)**: swap raw `get_text()` input to langextract
for `process_pdf().markdown` (`--compact`) on 10 corpus PDFs (3 large-cap
half-years, 3 small-cap annuals, 2 awkward layouts, 2 low-confidence docs,
pulled by document_sha256). Metrics vs baseline: field-level accuracy (zero
regressions tolerated), Gemini input tokens (adopt needs ≥20% reduction), added
wall time. Rationale: that path pays per token (`resolve_gemini_run_budget`),
so structure-preserving Markdown input is the one place the tool touches real
dollars.

## Trial outcome (2026-08-02) — do not integrate

Ran per the design above (10 stratified ASX filings pulled through the
extractor's own resolve+download path; baseline validated byte-for-byte
against `financial_report_extractions.raw_text_length`; artifacts in
`/Volumes/gamma-systems-2/dev-caches/pdf-tools-eval/trial/RESULTS.md`):

- **Token reduction −2.5%** against the ≥20% adopt threshold — and the digest
  window (16,000 chars) is already saturated on 8/10 docs, so the billed call
  is identical either way.
- **Structural results mixed**: ruled financial tables genuinely reconstruct
  (CBA capital ratios, BXB income statement — the baseline emits one cell per
  line), but WBC's bar-chart value labels were silently DROPPED (the headline
  deposit/loan figures), designed pages grow invented grids, and the same
  multi-line-cell flattening appeared again. Numeric-token recall 98.6%;
  invents nothing (reverse recall 1.000 on 9/10).
- **Wall time**: fine typically; WBC 10.99s vs 0.054s baseline (203×,
  reproducible) — a bad tail for a batch job.
- Field-accuracy comparison NOT run (needs paid Gemini spend ×~400 calls);
  no accuracy numbers are claimed.

**Final position: both tools skipped everywhere.** If Gemini cost on
report-extractor matters, the levers the trial actually exposed are the digest
constants (`max_char_buffer=2000` multiplies call count; the 16k window is the
binding cap) and page SELECTION — for which pdf-inspector's `--analyze`
(pdf_type / pages_with_tables, ms-fast, correct on all 10) would be a
defensible narrow import if ever needed. Nothing adopted now.
