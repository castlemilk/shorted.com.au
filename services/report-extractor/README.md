# report-extractor

Python entry points for the financial-report, director-trade, register and notice passes.
Each runs as a Cloud Run job (`services/report-extractor/Dockerfile`, the job's `args`) or by hand.

## Withheld substantial holding notices (`--notices`)

The ownership parser (`services/jobs/internal/jobs/ownership/notice.go`) withholds a notice it
cannot read: `no_text` (a scan), `no_voting_power` or `no_holder`. `notice_direct.py` offers those
to a second reader, under the same consensus as the director trades (`director_direct.py`):

- **Readers.** For a text-layer PDF, `EXTRACTOR_PRIMARY_MODEL` (DeepSeek v4 Flash) and
  `EXTRACTOR_CHECKER_MODEL` (Gemini 2.5 Flash-Lite) read independently; `EXTRACTOR_ARBITER_MODEL`
  (Gemini 2.5 Flash) settles a disagreement. No two of three agreeing is withheld (`disputed`).
  A scan has its own pair (see Text or scan) and no arbiter.
- **Text or scan.** A text-layer PDF is read as its first four pages of text. A scan (its first
  page holds under 100 characters of text layer) is rasterised by `register_vision.rasterise` and
  sent as images to two vision models, `google/gemini-2.5-flash-lite` and `google/gemini-2.5-flash`
  (`NOTICE_SCAN_PRIMARY_MODEL`, `NOTICE_SCAN_CHECKER_MODEL`). The text primary,
  `deepseek/deepseek-v4-flash`, is text-only on OpenRouter, so a scan never goes to it. A scan has no
  arbiter: both must state the same holder and figures, or the notice is withheld as `disputed`.
- **Validation** (`validate_notice`, in code, never by the model): the form agrees with the ASX
  headline; the holder is named in the notice and is not a placeholder (the parser's rules); each
  stated figure has a quote that is in the text and contains the number; a 604 states both
  percentages and both votes, a 603 the present pair, a 605 the previous percentage and is the only
  form that ceases (its present figure, if stated, must be under 5 and lower than the previous; a
  605 stores no figures, as `notice.go` keeps none from a cessation); no change is over 50 points;
  the votes fit ASIC's share count as at the notice's date within the parser's tolerance (a ratio in
  [0.5, 2]). A notice with no share count on record for its date is neither fetched nor read: its votes cannot be checked, so it is counted as `no_share_count`, no model is called and nothing is written, and it is offered again once a count appears. A 605 states no votes, so it is read without a count.
  The check itself still runs in `validate_notice` (a reading that states votes with no count is withheld as `no_share_count`). An event date is kept only when its quote is in the text and states the
  date's day, month and year; on a scan it is kept only when both readers agree.
- **Replies.** A reply with no JSON object is a model failure (`ModelCallError`), never a reading.
- **Failures.** A model that cannot answer raises `ModelCallError`: the notice is not an attempt
  and is retried next run. The run exits 1 when the errors look systemic (5 in the run, or 3 at a
  fifth of the calls).
- **Writes.** A recovered notice is upserted with `read_by = 'model'` and the parser's
  `parser_version`, only where no row exists or the row was itself read by a model; the attempt
  becomes `parsed`, `read_by = 'model'`. A withheld second read keeps the parser's outcome and
  records `read_by = 'model'` with a detail beginning `model:`. Migration `000154_notice_read_by`
  adds the column.
- **Selection.** Attempts with outcome `no_text`, `no_voting_power` or `no_holder` and
  `read_by = 'parser'`, largest company first (`company-metadata.market_cap`), optionally only
  notices announced on or after `--since`.

Hand run (dry run by default: it prints what it would write and writes nothing):

```bash
DATABASE_URL=... OPENROUTER_API_KEY=... python extract_reports_concurrent.py --notices \
    --limit 50 --workers 4 --budget-min 60 --since 2026-01-01
```

No write happens before the gold bench has reported. `--no-dry-run` refuses (exit 2) while any
notice in `testdata/notices/gold.json` has no hand reading (`gold_unread()`), and
`--skip-gold-check` overrides that only for a deliberate experiment, never for the backfill.
The order is: finish the hand readings, run `bench_notices.py CACHE.json --fill -v` (with `NOTICE_BENCH_LIVE=1`) and record
its precision per field and withheld rate in the PR, then the dry run, then:

```bash
DATABASE_URL=... OPENROUTER_API_KEY=... python extract_reports_concurrent.py --notices \
    --limit 50 --workers 4 --budget-min 60 --no-dry-run
```

`--notices` hands the run to `notice_direct.main`, which owns its own flags (`--limit`,
`--workers`, `--budget-min`, `--since`, `--dry-run/--no-dry-run`); the filings options do not apply.

Parity with the Go pass: `holder_key` cuts the name at the registry's `nameTails` (copied from
`registry.go`; a test fails when the two lists drift) before the legal suffixes are dropped, and
`NOTICE_PARSER_VERSION` is `notice.go`'s `noticeParserVersion` (also pinned by a test). The institution
is resolved by an exact match of the registry's names and aliases only. A holder the pass cannot
resolve exactly is grouped by name.

Failures that are not model errors: a PDF that opens with `%PDF` but cannot be read is withheld as
`unreadable_pdf` (permanent); a rasteriser failure is a fetch failure and is retried. A read that
raises an unexpected exception is counted as `crashed` and the rest of the run goes on.

### Gold set and bench

`testdata/notices/gold.json` holds thirty production notices (ten per parser outcome, read-only
sample of 2026-11-05), with the parser's outcome on each. Every entry is read: nine have a hand reading that
validates against its own text (`test_every_gold_entry_is_read_by_hand_and_each_reading_validates`), and
twenty-one are withheld (`withheld_expected`, with the reason: eight for no ASIC count on record for the notice's
date, which `test_a_gold_notice_with_no_count_on_record_is_withheld_for_that_reason_and_not_read` pins, and the
rest for a garbled text layer, a placeholder holder, a group holder, an annexed form missing from the text, or a
figure the text does not settle). No entry is pending. The five scans over 300 KB (PDN, D3E, IPC, MDX, DBF) were
fetched through the ASX access-terms page's `pdfURL` link, not the page itself. PDN and DBF keep their extracted
text; the other three scans have no text layer and keep no file. The bench reads a scan only from its PDF,
so it skips all five (`skipped_no_pdf`) until a PDF under 300 KB is stored.
`--no-dry-run` refuses the backfill while any entry is unread (`gold_unread()`). Documents are staged:
`text_file` is the text the reader sees, `pdf_file` the PDF of a scan under 300 KB. `reading` is the hand
reading; the tests and the bench skip an entry whose `reading_status` is still "awaiting hand reading"
until a person has read each one. Set `reading` (or `withheld_expected` with a null reading) and drop
`reading_status` to score it. A notice is stored
as its extracted text (`text_file`) or, for a scan, its PDF when under 300 KB (`pdf_file`); otherwise
its ASX URL is recorded and the bench skips it with the reason.

```bash
python bench_notices.py CACHE.json              # replays cached answers, no model call
python bench_notices.py CACHE.json --dry-run            # no call: the answers --fill would ask for, and the score of the cache as it is
NOTICE_BENCH_LIVE=1 OPENROUTER_API_KEY=... python bench_notices.py CACHE.json --fill -v   # asks the models for any answer not cached
```

The bench scores with the same five model names `--fill` asks for, taken from the environment
(`EXTRACTOR_PRIMARY_MODEL`, `EXTRACTOR_CHECKER_MODEL`, `EXTRACTOR_ARBITER_MODEL`, `NOTICE_SCAN_PRIMARY_MODEL`,
`NOTICE_SCAN_CHECKER_MODEL`) or from `--primary`, `--checker`, `--arbiter`, `--scan-primary`, `--scan-checker`; the
summary's `models` field records them. `--fill` is paid and refuses unless `NOTICE_BENCH_LIVE=1`. A reading made
where the hand reading is withheld counts against every field it states.

`test_notice_direct.py` runs the validator over every hand reading against its own document, with
no model call. `REPORT_EXTRACTOR_TEST_POSTGRES_URL` runs the selection and write SQL against a
disposable Postgres (temporary tables, rolled back); without it that test is skipped.
