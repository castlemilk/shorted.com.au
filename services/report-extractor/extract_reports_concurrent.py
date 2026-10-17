#!/usr/bin/env python3
"""Concurrent financial-report extraction: the scheduled financial-report-extractor job.

Reuses extract.py's PDF + langextract + digest helpers under a thread pool.
Design contract: docs/plans/fundamentals-coverage.md sections 6.1 and 6.2.

Modes:
  (default)            the statutory results documents worth a paid extraction,
                       ONE per company, in this order (extract.order_extraction_targets):
                       report_date within 45 days (newest first), then
                       companies with no metric-bearing extraction yet (by
                       market cap), then the rest (by market cap). Each runs the
                       full extract + ground + digest + document_meta pipeline.
                       A document ASX lists under several codes (a renamed
                       company's old and new code) is read once, under its
                       owner (extract.choose_document_owners), and an
                       extracted one filed under an out-of-date listing is
                       moved to its owner first (extract.rehome_shared_extractions).
  --backfill-digests   §6.3(b): re-summarise rows ALREADY in
                       financial_report_extractions that have digest IS NULL.
                       Prefers the raw text stored in GCS so it does not
                       re-download (older 2024 ASX URLs no longer resolve);
                       falls back to re-downloading the PDF.
  --repair-echo-digests  the one-off repair after the trust funnel: rows whose
                       stored metrics carry a few-shot-echo entry lose those
                       entries (nothing else changes) and get a new digest
                       through the trusted prompt, or digest NULL when none
                       can be written. Until then the API withholds their
                       summaries. Run it once after the deploy (--dry-run
                       first lists the rows).
  --repair-document-meta  the one-off repair after a change to where
                       document_meta's entity or period is read from: every
                       row with document_meta has both read again, with the
                       current rule and the row's report date, from the raw
                       text stored in GCS (no PDF download, no model call, so
                       no key), and only those keys are written: an entity
                       readers would see the same (cosmetic), another name
                       (renamed) or a name where they saw none (added); a
                       period that differs (changed) or where none was stated
                       (added). A name readers check, or a period, that the
                       text no longer yields is kept as stored. It selects
                       nothing for extraction. Run it once after the deploy,
                       never while the daily extractor runs. --dry-run first
                       lists every renamed, added and kept entity with its
                       company and the entity check's outcome (now passes, now
                       fails, no change), and every changed, added and kept
                       period with the report date and what it does to the
                       stock page's own-period check (becomes the newest
                       period, was the newest period, neither), then recaps
                       the rows to check against their documents just before
                       the summary.

Budget: --budget-min (default 90). Once it elapses no new report is started;
in-flight reports finish, the remaining count is logged and the job exits 0.
The next run picks the remainder up (selection is incremental). Every report's
wall time and tokens are logged, and the run's Gemini token totals at exit.

Model errors: a document whose model call failed (extract.ModelError: an API
error, a blocked or empty response) counts as model_error and writes NO row,
so the next run retries it. After MAX_CONSECUTIVE_MODEL_ERRORS model errors in
a row (--max-model-errors) no new report is started: a dead key, a retired
model or an exhausted quota fails every call. The run then prints its counts
and exits 1 when the model errors look systemic (model_errors_fail_run: the
breaker's worth of them, or at least 3 that are at least a fifth of the
documents that called the model), so the Cloud Run execution fails visibly
instead of reporting success. One or two documents the model refuses every
day (a chunk blocked by the safety filter) are logged as errors and retried,
but do not fail every run: a job that fails daily for one document is an
alarm nobody reads.

Unreadable documents: a PDF with no text layer gets a marker row
(extract.store_unreadable) and the company's next document is tried in the
same run; a download that fails otherwise writes nothing, and the company's
next document is still tried (extract.read_first_available).

Empty extractions: a row with no metrics and no usable digest, from a document
with a text layer (see extract.EMPTY_RETRY_LIMIT), is read again
EMPTY_RETRY_MIN_DAYS apart, at most EMPTY_RETRY_LIMIT times, at up to
EMPTY_RETRY_MAX_PAGES pages.

Run (against prod):
  DATABASE_URL=... GEMINI_API_KEY=... LANGEXTRACT_API_KEY=$GEMINI_API_KEY \
    python extract_reports_concurrent.py --recent 2 --limit 360 --workers 4 --max-pages 8
  DATABASE_URL=... GEMINI_API_KEY=... \
    python extract_reports_concurrent.py --backfill-digests --limit 500 --workers 4
  DATABASE_URL=... GEMINI_API_KEY=... \
    python extract_reports_concurrent.py --repair-echo-digests --dry-run
  DATABASE_URL=... \
    python extract_reports_concurrent.py --repair-document-meta --dry-run

Connections: the selection connection is autocommit and is closed before any
report starts. Each worker opens its own autocommit connection lazily, only to
write, so no connection holds a transaction across a PDF download or a model
call (psycopg2 connections are not thread-safe, hence one per thread).
--repair-document-meta reads GCS on --workers threads and writes on its one
autocommit selection connection, one guarded statement per row.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import functools
import json
import logging
import os
import sys
import threading
import time
from collections import Counter
from typing import Any, Callable, Iterable, Optional

import psycopg2
import psycopg2.extras
import requests

import entity_match
import extract  # reuse helpers (import is side-effect-free)
import extraction_trust
from document_meta import extract_document_meta
from token_usage import TokenUsage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reports-backfill")

DEFAULT_BUDGET_MIN = 90

# Outcomes that say nothing about the model (no call was made, or the worker
# failed for another reason): they neither extend nor break a run of model
# errors.
_NO_MODEL_CALL = frozenset({extract.FETCH_FAILED, extract.FETCH_UNREADABLE, "no_text", "error"})

# model_errors_fail_run's share rule: at least this many model errors, making
# up at least 1/MODEL_ERROR_SHARE_DENOMINATOR of the documents that called the
# model.
MODEL_ERROR_MIN_TO_FAIL = 3
MODEL_ERROR_SHARE_DENOMINATOR = 5


def model_errors_fail_run(counts: Counter, max_consecutive: int = extract.MAX_CONSECUTIVE_MODEL_ERRORS) -> bool:
    """Whether this run's model errors look systemic enough to fail it.

    True when there were at least max_consecutive of them (what trips the
    breaker: a dead key, a retired model, an exhausted quota), or at least
    MODEL_ERROR_MIN_TO_FAIL making up at least a fifth of the documents that
    called the model. A document the model refuses every day stays a logged
    error and is retried, but does not fail every run on its own."""
    errors = counts.get(extract.MODEL_ERROR, 0)
    if errors == 0:
        return False
    if max_consecutive > 0 and errors >= max_consecutive:
        return True
    calls = sum(n for outcome, n in counts.items() if outcome not in _NO_MODEL_CALL)
    return errors >= MODEL_ERROR_MIN_TO_FAIL and errors * MODEL_ERROR_SHARE_DENOMINATOR >= calls

_tl = threading.local()


def _session() -> requests.Session:
    s = getattr(_tl, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update(extract.ASX_HEADERS)
        _tl.session = s
    return s


def _conn():
    """Thread-local autocommit DB connection, opened on first write. psycopg2
    connections are NOT thread-safe, so each worker thread gets its own."""
    c = getattr(_tl, "conn", None)
    if c is None or c.closed:
        c = extract.get_db_connection(autocommit=True)
        _tl.conn = c
    return c


def gemini_key_present() -> bool:
    return bool((os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY") or "").strip())


def openrouter_key_present() -> bool:
    return bool((os.environ.get("OPENROUTER_API_KEY") or "").strip())


BACKENDS = ("openrouter", "gemini")


def open_selection_connection():
    """The selection connection: autocommit, so the selection queries leave no
    transaction open behind them."""
    return extract.get_db_connection(autocommit=True)


def select_reports(conn, recent: int, limit: int, dry_run: bool = False) -> list[dict]:
    """The run's work list (extract.select_extraction_targets), after moving
    shared documents filed under an out-of-date listing to their owner
    (extract.rehome_shared_extractions; a dry run only lists them)."""
    moves = extract.rehome_shared_extractions(conn, dry_run=dry_run)
    if moves:
        log.info(
            "%s %d extracted documents to the listing that owns them: %s",
            "Would move" if dry_run else "Moved",
            len(moves),
            ", ".join(f"{src}->{dst}" for _, src, dst in moves[:20]) + (" ..." if len(moves) > 20 else ""),
        )
    return extract.select_extraction_targets(conn, recent=recent, limit=limit)


def select_echo_digest_reports(conn, limit: int) -> list[dict]:
    """Rows whose stored metrics carry a few-shot-echo entry (the old prompt's
    example leaking into the extraction). Their digest, if any, was written
    from those metrics, so the API withholds it; --repair-echo-digests drops
    the echo entries and writes a new digest through the trusted prompt.
    Newest first. The echo is decided in Python with the same denylist the
    funnel uses (extraction_trust.has_few_shot_entry), over every row with
    metrics: the corpus is a few thousand rows."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        cur.execute(
            """
            SELECT stock_code, report_url, report_type, report_title,
                   report_date::text AS report_date, metrics::text AS metrics,
                   raw_text_length, raw_text_gcs_url
            FROM financial_report_extractions
            WHERE metrics <> '{}'::jsonb
              AND (raw_text_length IS NULL OR raw_text_length >= %s)
            ORDER BY report_date DESC NULLS LAST, stock_code
            """,
            (extract.MIN_PDF_TEXT_CHARS,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    finally:
        cur.close()
    reports = []
    for r in rows:
        try:
            metrics = json.loads(r["metrics"] or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(metrics, dict) or not extraction_trust.has_few_shot_entry(metrics, extract.FEWSHOT_DENYLIST):
            continue
        reports.append({
            "stock_code": r["stock_code"],
            "url": r["report_url"],
            "type": r["report_type"],
            "title": r["report_title"] or "",
            "date": r["report_date"],
            "metrics": r["metrics"],
            "raw_text_gcs_url": r["raw_text_gcs_url"],
            "repair_echo": True,
        })
    if limit > 0:
        reports = reports[:limit]
    return reports


def select_digestless_reports(conn, limit: int) -> list[dict]:
    """§6.3(b) Rows already extracted but with NO digest yet (the historical
    no-metrics corpus), newest first. Carries the stored metrics + GCS text
    pointer so the digest can be (re)generated without re-downloading the PDF.
    Unreadable markers (extract.store_unreadable: raw_text_length under
    MIN_PDF_TEXT_CHARS) are skipped: there is no text to summarise, and
    newest first they would hold the head of every backfill."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        cur.execute(
            """
            SELECT stock_code, report_url, report_type, report_title,
                   report_date::text AS report_date, metrics::text AS metrics,
                   raw_text_length, raw_text_gcs_url
            FROM financial_report_extractions
            WHERE digest IS NULL
              AND (raw_text_length IS NULL OR raw_text_length >= %s)
            ORDER BY report_date DESC NULLS LAST, stock_code
            """,
            (extract.MIN_PDF_TEXT_CHARS,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    finally:
        cur.close()
    reports = [
        {
            "stock_code": r["stock_code"],
            "url": r["report_url"],
            "type": r["report_type"],
            "title": r["report_title"] or "",
            "date": r["report_date"],
            "metrics": r["metrics"],
            "raw_text_gcs_url": r["raw_text_gcs_url"],
        }
        for r in rows
    ]
    if limit > 0:
        reports = reports[:limit]
    return reports


def process(
    report: dict,
    model: str,
    max_pages: int,
    dry_run: bool,
    write_meta: bool = False,
    usage: Optional[TokenUsage] = None,
    direct: Any = None,
    count_attempts: bool = False,
) -> str:
    """Extract one company's document (or, when it cannot be read, the next of
    its fallbacks) and store the row. A model error stores nothing and returns
    model_error, so the next run retries the document."""

    def record_unreadable(doc: dict, text_length: int) -> None:
        extract.store_unreadable(_conn(), doc, text_length, dry_run, count_attempt=count_attempts)

    doc, text, fetched = extract.read_first_available(_session(), report, max_pages, record_unreadable)
    if text is None:
        return fetched
    try:
        extra = {"direct": direct} if direct is not None else {}
        metrics, digest, meta, outcome = extract.process_report_text(doc, text, model, usage=usage, **extra)
    except extract.ModelError as e:
        log.warning("  %s %s: model error, not stored (the next run retries it): %s", doc["stock_code"], doc["url"], e)
        return extract.MODEL_ERROR
    # GCS upload is best-effort; never fail the report on it. A dry run writes
    # nothing anywhere, the report bucket included.
    gcs_url = None
    if not dry_run:
        try:
            gcs_url = extract.upload_raw_text_to_gcs(doc["stock_code"], doc["url"], text)
        except Exception:  # noqa: BLE001
            gcs_url = None
    # The first database touch for this report: after the download and every
    # model call, one autocommit statement.
    extract.store_extraction(
        _conn(), doc, metrics, len(text), dry_run,
        digest_result=digest, raw_text_gcs_url=gcs_url,
        document_meta=meta, write_document_meta=write_meta,
        count_attempt=count_attempts,
    )
    return outcome


def process_digestless(
    report: dict,
    model: str,
    max_pages: int,
    dry_run: bool,
    write_meta: bool = False,
    usage: Optional[TokenUsage] = None,
    direct: Any = None,
) -> str:
    """Re-summarise one already-extracted row that has no digest. Prefers stored GCS
    text; only re-downloads the PDF if the text isn't in GCS."""
    gcs_url = report.get("raw_text_gcs_url")
    text = extract.download_text_from_gcs(gcs_url) if gcs_url else None
    source = "gcs"
    if not text:
        text = extract.download_pdf_text(_session(), report["url"], max_pages=max_pages)
        source = "pdf"
        # Backfill the GCS pointer if we had to re-download.
        if text and not gcs_url:
            try:
                gcs_url = extract.upload_raw_text_to_gcs(report["stock_code"], report["url"], text)
            except Exception:  # noqa: BLE001
                gcs_url = None
    if not text or len(text) < extract.MIN_DIGEST_CHARS:
        return "no_text"

    try:
        metrics = json.loads(report.get("metrics") or "{}")
    except (ValueError, TypeError):
        metrics = {}
    if report.get("repair_echo") and isinstance(metrics, dict):
        # --repair-echo-digests: the echo entries go, everything else stays as
        # stored, so the API stops withholding the row's summary.
        metrics = extraction_trust.drop_few_shot_entries(metrics, extract.FEWSHOT_DENYLIST)

    # summarize_report applies the trust funnel to the stored metrics before
    # they reach the prompt; the stored metrics themselves are rewritten as-is.
    try:
        if direct is not None:
            digest = extract.summarize_report_openrouter(metrics, text, direct.client, direct.primary, usage=usage)
        else:
            digest = extract.summarize_report(metrics, text, model_id=model, usage=usage)
    except extract.ModelError as e:
        log.warning("  %s %s: digest model error, not stored: %s", report.get("stock_code"), report.get("url"), e)
        return extract.MODEL_ERROR
    if not (digest and digest.get("digest")):
        if report.get("repair_echo"):
            # The echo entries and the digest written from them go even when
            # no new digest could be written: the row is stored clean, with
            # digest NULL, so a later --backfill-digests can summarise it.
            extract.store_extraction(
                _conn(), report, metrics, len(text), dry_run,
                digest_result=None, raw_text_gcs_url=gcs_url,
                document_meta=extract_document_meta(text, extract.report_date_of(report)),
                write_document_meta=write_meta,
            )
            return "echo_cleared"
        return "no_digest"
    extract.store_extraction(
        _conn(), report, metrics, len(text), dry_run,
        digest_result=digest, raw_text_gcs_url=gcs_url,
        document_meta=extract_document_meta(text, extract.report_date_of(report)), write_document_meta=write_meta,
    )
    return f"ok_{source}"


# --- --repair-document-meta ----------------------------------------------------
#
# document_meta is read once, at extraction time, from the raw text of the
# pages read, and that text is what raw_text_gcs_url stores. The Go reader
# re-applies the NAME rules (cleanEntity) to every stored entity, but a rule
# about WHERE in a document the entity or the period is read from needs the
# text: VIT's own Appendix 4E (idsId=03130179) was stored as "Cortexa Pty
# Ltd", the entity named in the 4E's control gained or lost section, which the
# entity check withholds, and with period_end 2025-06-30, read from its prior
# year's dividend line ahead of "The reporting period covers the year ended 30
# June 2026". latest_filing.go's own-period check and picks gate 4 take that
# period_end as the document's own period, so its FY26 results would have
# stayed off the stock page and out of picks with the entity alone repaired. A
# fresh extraction never reaches a stored row: both are read again here, the
# period with the row's report date, as every extraction now reads it.
#
# A new entity is judged by what readers see now, not by the stored string.
# Every entity gate (latest_filing.go, picks filings_ingest.go, the dividend
# estimate's ConfirmEstimate) checks an entity only when one is stated, so one
# rewrite can publish a withheld row or withhold a published one. The first
# review of this repair found it would have removed the auditor's name stored
# with AXR's two "Sturt Exploration Pty Ltd financial statements" (a Core
# Lithium subsidiary's accounts) and so published them as Axiant Resources'
# filings.
#
# Every renamed, added and kept row is therefore logged with its company
# ("company-metadata".company_name, what the gates compare) and the gates'
# outcome (entity_check_outcome). A prod dry run of this repair (2026-10-13)
# listed 568 renamed, added and kept rows, none with its company, and only 11
# of them changed a verdict: 5 renamed rows now passed (VIT among them) and 6
# added rows now failed. Only a renamed row can make a failing row pass; an
# added row can only make one fail. The recap before the summary lists those
# rows and every kept row, so the workflow's step summary holds every line a
# reviewer must check against its document.
#
# A period is judged the same way, by what readers see
# (extract.period_readers_see). Three readers take period_end as the
# document's own: latest_filing.go's own-period check, picks gate 4, and the
# dividend estimate's ConfirmEstimate (dividend_estimate.go), which counts a
# results document only when it is the notice's period end. One the text no
# longer yields is kept: without it readers place the document from its
# report date alone, a guess the repair does not make for them. Every changed,
# added and kept period is logged and recapped with the row's report date and
# what it does to the stock page's own-period check (own_period_effect),
# against the code's newest flow period as the shorts store reads it. That
# effect is the stock page's alone: picks gate 4 and ConfirmEstimate read the
# same period_end, unlabelled. The repair never moves extracted_at (half of
# its write guard), and the dividend pass reads an estimated_only notice again
# only after an extraction of its code newer than its last attempt
# (pendingNoticesSql), so an estimate waiting on a document whose period this
# repair writes is read again only at its code's next extraction, or after a
# parser bump.
#
# The repair has no way to skip a row, so a recap line found wrong is fixed in
# the rule, until it reads that document right, before the real run. A prod
# dry run (2026-10-13) would have rewritten VIG's correct FY2025 period
# (idsId=03144078) to the half its events after the reporting period say is
# still to be reported; the rule now reads it as stored.

UNCHANGED, COSMETIC, RENAMED, ADDED, KEPT = "unchanged", "cosmetic", "renamed", "added", "kept"
NOW_PASSES, NOW_FAILS, NO_CHANGE = "now passes", "now fails", "no change"
PERIOD_UNCHANGED, PERIOD_CHANGED, PERIOD_ADDED, PERIOD_KEPT = (
    "period unchanged", "period changed", "period added", "period kept",
)
BECOMES_NEWEST, WAS_NEWEST, NEITHER = "becomes the newest period", "was the newest period", "neither"

# Cosmetic rows change nothing readers see: the first COSMETIC_SAMPLES are
# logged and the rest only counted, so the lines that need checking stand out
# in the log the workflow reads back.
COSMETIC_SAMPLES = 5

# latest_filing.go ownPeriodMaxLagMonths: a results document is lodged within
# two months of its balance date (4D/4E), the annual report within four.
OWN_PERIOD_MAX_LAG_MONTHS = 5


def classify_entity_change(stored: Optional[str], new: str) -> str:
    """What --repair-document-meta does with a row whose stored entity is
    `stored` (None: the row states none) and whose stored text now reads `new`
    ("" for none), judged by seen = extract.entity_readers_see(stored), the
    entity the API reads today:

      unchanged  new == stored, or neither states one: not written.
      cosmetic   new == seen: written, and readers see no difference (a name
                 rule the reader already applies: "Vitura Health Limited |"
                 becomes "Vitura Health Limited"; or a stored value that is
                 not a name goes).
      renamed    seen and new are different names: written; the entity check
                 compares the new one.
      added      seen none, new a name: written; readers now check a name.
      kept       seen a name, new none: NOT written. Without the name readers
                 would check none (store_document_meta_repair refuses it).
    """
    if stored is None:
        return ADDED if new else UNCHANGED
    if new == stored:
        return UNCHANGED
    seen = extract.entity_readers_see(stored)
    if new == seen:
        return COSMETIC
    if not seen:
        return ADDED
    return RENAMED if new else KEPT


def classify_period_change(stored: tuple[str, str], new: tuple[str, str]) -> str:
    """What --repair-document-meta does with a row's period: `stored` is its
    (period_end, period_type) as readers see it (extract.period_readers_see),
    `new` what its stored text reads now with its report date ("" for absent).
    A period is stated when it has an end.

      period unchanged  new == stored, or neither states one: not written.
      period changed    both state one and they differ: written.
      period added      only new states one: written.
      period kept       only stored states one: NOT written. Readers would
                        place the document from its report date alone.
    """
    if not new[0]:
        return PERIOD_KEPT if stored[0] else PERIOD_UNCHANGED
    if not stored[0]:
        return PERIOD_ADDED
    return PERIOD_UNCHANGED if new == stored else PERIOD_CHANGED


def entity_check_fails(entity: str, company: Optional[str]) -> bool:
    """Whether every entity gate (latest_filing.go, picks filings_ingest.go,
    the dividend estimate's ConfirmEstimate) withholds a row whose entity, as
    readers see it, is `entity` ("" for none): they check a stated entity only,
    against "company-metadata".company_name, and none (a code with no row) or
    a blank one withholds it."""
    return bool(entity) and not entity_match.entity_matches(entity, company)


def entity_check_outcome(before: str, after: str, company: Optional[str]) -> str:
    """What the entity gates decide about a row whose entity, as readers see
    it, goes from `before` to `after`: NOW_PASSES (withheld, then not),
    NOW_FAILS (the reverse) or NO_CHANGE. A rename can do either; an added
    name (before "") can only make the row fail; a kept row (after = before)
    changes nothing."""
    was, now = entity_check_fails(before, company), entity_check_fails(after, company)
    if was == now:
        return NO_CHANGE
    return NOW_FAILS if now else NOW_PASSES


# --- the stock page's own-period check (latest_filing.go), ported ---------------
#
# selectLatestFiling summarises a results document only when its own period,
# folded onto the month end it belongs to (canonicalMonthEnd), is the stock's
# newest flow period (LatestFilingInputs.NewestFlowPeriodEnd, folded too). Its
# own period (resolveOwnPeriod) is document_meta.period_end when stated, else
# the latest half or annual end on or before its report date on the company's
# balance date (the month of LatestAnnualPeriodEnd), within
# OWN_PERIOD_MAX_LAG_MONTHS. A period the repair adds therefore changes
# nothing when the report date already placed the document there, and takes it
# off the page when the report date placed it on the newest period and the
# text names another.


def _last_day_of_month(year: int, month: int) -> _dt.date:
    return _dt.date(year + month // 12, month % 12 + 1, 1) - _dt.timedelta(days=1)


def canonical_month_end(d: _dt.date) -> _dt.date:
    """latest_filing.go canonicalMonthEnd: 2 July 2023 and 28 June 2023 are
    both June 2023 (the 52/53-week shift the picks job uses)."""
    eff = d if d.day >= 24 else d - _dt.timedelta(days=7)
    return _last_day_of_month(eff.year, eff.month)


def _latest_month_end_on_or_before(d: _dt.date, month: int) -> Optional[_dt.date]:
    for year in (d.year, d.year - 1):
        end = _last_day_of_month(year, month)
        if end <= d:
            return end
    return None


def _months_between(a: _dt.date, b: _dt.date) -> int:
    n = (b.year - a.year) * 12 + b.month - a.month
    if b.day < a.day and b.day < _last_day_of_month(b.year, b.month).day:
        n -= 1
    return n


def own_period_end(period_end: str, report_date: _dt.date, balance_month: Optional[int]) -> Optional[_dt.date]:
    """The end of latest_filing.go resolveOwnPeriod: `period_end` (as readers
    see it, "" for none) folded onto its month end; without one, the later of
    the latest balance-month end and the latest half-year end on or before the
    report date, unless more than OWN_PERIOD_MAX_LAG_MONTHS before it; None
    when it cannot be placed (no balance month either)."""
    if period_end:
        return canonical_month_end(_dt.date.fromisoformat(period_end))
    if not balance_month:
        return None
    annual = _latest_month_end_on_or_before(report_date, balance_month)
    half = _latest_month_end_on_or_before(report_date, (balance_month + 5) % 12 + 1)
    end = half if half is not None and (annual is None or half > annual) else annual
    if end is None or _months_between(end, report_date) > OWN_PERIOD_MAX_LAG_MONTHS:
        return None
    return end


def own_period_effect(
    before: str,
    after: str,
    report_date: Optional[_dt.date],
    newest_flow_end: Optional[_dt.date],
    latest_annual_end: Optional[_dt.date],
) -> str:
    """What a row's period going from `before` to `after` (period_end as
    readers see it, "" for none) does to the stock page's own-period check:
    BECOMES_NEWEST when the document's own period (own_period_end) is the
    code's newest flow period after and not before, WAS_NEWEST the reverse,
    NEITHER otherwise. Also NEITHER for a code with no newest flow period (the
    page shows no summary) and a row with no report date (never a candidate).
    newest_flow_end and latest_annual_end are LatestFilingInputs'
    NewestFlowPeriodEnd and LatestAnnualPeriodEnd, as
    select_document_meta_rows reads them."""
    if newest_flow_end is None or report_date is None:
        return NEITHER
    target = canonical_month_end(newest_flow_end)
    balance_month = canonical_month_end(latest_annual_end).month if latest_annual_end else None
    was = own_period_end(before, report_date, balance_month) == target
    now = own_period_end(after, report_date, balance_month) == target
    if was == now:
        return NEITHER
    return BECOMES_NEWEST if now else WAS_NEWEST


def select_document_meta_rows(conn) -> list[dict]:
    """Every row with document_meta (a JSON object) and raw text stored in GCS,
    whether or not it states an entity or a period, newest first: what
    --repair-document-meta reads again. document_meta is the stored object's
    text, as read: with extracted_at, the write guard. entity, period_end and
    period_type are its keys (None for one the row does not state);
    company_name is "company-metadata".company_name, the name the entity gates
    compare (None for a code with no row there; stock_code is unique there, so
    the join adds no row). newest_flow_period_end and latest_annual_period_end
    are the shorts store's LatestFilingInputs.NewestFlowPeriodEnd and
    LatestAnnualPeriodEnd for the row's code (latestFilingContextQuery,
    postgres_fundamentals.go), read the same way; None for a code with no such
    row. stock_fundamentals ships with 000129 and 000132 widens it in the same
    migration that adds document_meta, so a schema with the column has the
    table."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        cur.execute(
            """
            SELECT e.stock_code, e.report_url, e.report_date, e.document_meta::text AS document_meta,
                   e.document_meta->>'entity' AS entity, e.document_meta->>'period_end' AS period_end,
                   e.document_meta->>'period_type' AS period_type, e.raw_text_gcs_url, e.extracted_at,
                   cm.company_name::text AS company_name, nf.newest_flow_period_end, la.latest_annual_period_end
            FROM financial_report_extractions e
            LEFT JOIN "company-metadata" cm ON cm.stock_code = e.stock_code
            LEFT JOIN (
                SELECT f.stock_code, max(f.period_end)::date AS newest_flow_period_end
                FROM stock_fundamentals f
                WHERE f.period_type IN ('annual', 'half', 'ttm')
                  AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL
                       OR f.eps_diluted IS NOT NULL OR f.operating_cash_flow IS NOT NULL OR f.free_cash_flow IS NOT NULL)
                GROUP BY f.stock_code
            ) nf ON nf.stock_code = e.stock_code
            LEFT JOIN (
                SELECT f.stock_code, max(f.period_end)::date AS latest_annual_period_end
                FROM stock_fundamentals f
                WHERE f.period_type = 'annual'
                GROUP BY f.stock_code
            ) la ON la.stock_code = e.stock_code
            WHERE e.document_meta IS NOT NULL
              AND jsonb_typeof(e.document_meta) = 'object'
              AND e.raw_text_gcs_url IS NOT NULL
            ORDER BY e.report_date DESC NULLS LAST, e.stock_code, e.report_url
            """
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        cur.close()


def _meta_from_stored_text(gcs_url: str, report_date: Optional[_dt.date]) -> tuple[Optional[dict], str]:
    """(the document_meta the current rule reads from a row's stored text,
    given the row's report date; "") or, when the text cannot be read, (None,
    why)."""
    try:
        text = extract.fetch_text_from_gcs(gcs_url)
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    if not text or not text.strip():
        return None, "the stored text is blank"
    return extract_document_meta(text, report_date), ""


def _entity_repr(stored: Optional[str]) -> str:
    return "(none)" if stored is None else repr(stored)


def _period_repr(period: tuple[str, str]) -> str:
    return " ".join(p for p in period if p) if period[0] else "(none)"


def _day_repr(day: Optional[_dt.date]) -> str:
    return "(none)" if day is None else str(day)


def _log_recap(recap: dict[str, list[str]], dry_run: bool) -> None:
    """The lines a reviewer must check against each document, logged just
    before the summary (so the workflow's step summary holds them however long
    the log): every row the entity check now passes, every row it now fails
    and every kept entity, each with its code, company, URL, seen -> new and
    outcome; then every changed, added and kept period, with the report date,
    the code's newest flow period and the own-period check's effect."""
    log.info(
        "Document meta repair recap%s, every line to check against its document: entity now passes %d, now fails %d, "
        "kept %d; period changed %d, added %d, kept %d",
        " (dry run, nothing written)" if dry_run else "",
        len(recap[NOW_PASSES]), len(recap[NOW_FAILS]), len(recap[KEPT]),
        len(recap[PERIOD_CHANGED]), len(recap[PERIOD_ADDED]), len(recap[PERIOD_KEPT]),
    )
    for group in (NOW_PASSES, NOW_FAILS, KEPT, PERIOD_CHANGED, PERIOD_ADDED, PERIOD_KEPT):
        for line in recap[group]:
            log.info("%s", line)


def repair_document_meta(conn, rows: list[dict], workers: int, dry_run: bool) -> Counter:
    """Read each row's document_meta again from its stored text with its
    report date (the GCS reads on `workers` threads), classify its entity
    (classify_entity_change) and its period (classify_period_change), and
    write each row with a cosmetic, renamed or added entity or a changed or
    added period on `conn`: one UPDATE editing both keys, guarded by the whole
    document_meta and the extracted_at read (a guard that misses counts the
    row as left_alone, and neither of its classes). A dry run writes nothing.

    Every renamed, added and kept entity is logged with its code, URL,
    company, stored entity, the one readers see, the new one and the entity
    check's outcome (entity_check_outcome: after = new when written, seen when
    kept), in both runs; cosmetic rows only as a count after the first
    COSMETIC_SAMPLES; rows whose text cannot be read only as a count after the
    first one's cause. Every changed, added and kept period is logged with its
    company, report date, stored and new period, the code's newest flow period
    and the own-period check's effect (own_period_effect: after = new when
    written, stored when kept). Each class, outcome and effect is counted, and
    a recap (_log_recap) ends the listing."""
    counts: Counter = Counter()
    recap: dict[str, list[str]] = {
        group: [] for group in (NOW_PASSES, NOW_FAILS, KEPT, PERIOD_CHANGED, PERIOD_ADDED, PERIOD_KEPT)
    }
    tag = "[dry-run] " if dry_run else ""
    gcs_urls, report_dates = [r["raw_text_gcs_url"] for r in rows], [r["report_date"] for r in rows]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(workers, 1)) as ex:
        for row, (new_meta, cause) in zip(rows, ex.map(_meta_from_stored_text, gcs_urls, report_dates)):
            code, url, stored = row["stock_code"], row["report_url"], row["entity"]
            company = row["company_name"] or ""
            if new_meta is None:
                counts["without_text"] += 1
                if counts["without_text"] == 1:
                    log.warning(
                        "  %s %s: stored text %s not read (%s); left as stored, and later rows whose text "
                        "cannot be read are only counted",
                        code, url, row["raw_text_gcs_url"], cause,
                    )
                continue
            counts["read"] += 1
            new = new_meta.get("entity", "")
            seen = extract.entity_readers_see(stored)
            change = classify_entity_change(stored, new)
            stored_period = extract.period_readers_see(row["period_end"], row["period_type"])
            new_period = (new_meta.get("period_end", ""), new_meta.get("period_type", ""))
            period_change = classify_period_change(stored_period, new_period)
            write_entity = change in (COSMETIC, RENAMED, ADDED)
            write_period = period_change in (PERIOD_CHANGED, PERIOD_ADDED)
            detail = f"company {company!r}, stored {_entity_repr(stored)}, seen {seen!r}, new {new!r}"
            period_detail = (
                f"company {company!r}, report date {_day_repr(row['report_date'])}, stored "
                f"{_period_repr(stored_period)}, new {_period_repr(new_period)}, newest flow period "
                f"{_day_repr(row['newest_flow_period_end'])}"
            )
            if (write_entity or write_period) and not dry_run and not extract.store_document_meta_repair(
                conn, url, row["extracted_at"], row["document_meta"],
                entity=new if write_entity else None, period=new_period if write_period else None,
            ):
                counts["left_alone"] += 1
                decided = [f"{change}, {detail}"] if change != UNCHANGED else []
                if period_change != PERIOD_UNCHANGED:
                    decided.append(f"{period_change}, {period_detail}")
                log.warning("  left alone %s %s: %s (rewritten since it was read)", code, url, "; ".join(decided))
                continue
            counts[change] += 1
            counts[period_change] += 1
            if change != UNCHANGED:
                outcome = entity_check_outcome(seen, new if write_entity else seen, company)
                counts[outcome] += 1
                if change == KEPT:
                    recap[KEPT].append(f"  {code} {company!r} {url}: {change} {seen!r} -> {new!r} (left as stored); "
                                       f"entity check: {outcome}")
                    log.warning(
                        "  kept %s %s: %s; entity check: %s (the text names no entity, and without this name readers "
                        "would check none: left as stored)",
                        code, url, detail, outcome,
                    )
                else:
                    if outcome != NO_CHANGE:
                        recap[outcome].append(f"  {code} {company!r} {url}: {change} {seen!r} -> {new!r}; "
                                              f"entity check: {outcome}")
                    if change != COSMETIC or counts[COSMETIC] <= COSMETIC_SAMPLES:
                        log.info("  %s%s %s %s: %s; entity check: %s", tag, change, code, url, detail, outcome)
            if period_change != PERIOD_UNCHANGED:
                after = new_period if write_period else stored_period
                effect = own_period_effect(
                    stored_period[0], after[0], row["report_date"],
                    row["newest_flow_period_end"], row["latest_annual_period_end"],
                )
                counts[effect] += 1
                recap[period_change].append(
                    f"  {code} {company!r} {url}: {period_change} {_period_repr(stored_period)} -> "
                    f"{_period_repr(new_period)}{' (left as stored)' if period_change == PERIOD_KEPT else ''}, "
                    f"report date {_day_repr(row['report_date'])}, newest flow period "
                    f"{_day_repr(row['newest_flow_period_end'])}; own-period check: {effect}"
                )
                if period_change == PERIOD_KEPT:
                    log.warning(
                        "  %s %s %s: %s; own-period check: %s (the text states no period of its own: left as stored)",
                        period_change, code, url, period_detail, effect,
                    )
                else:
                    log.info("  %s%s %s %s: %s; own-period check: %s", tag, period_change, code, url, period_detail,
                             effect)
    if counts[COSMETIC] > COSMETIC_SAMPLES:
        log.info(
            "  %s%d more cosmetic rows not listed (readers see no difference)",
            tag, counts[COSMETIC] - COSMETIC_SAMPLES,
        )
    _log_recap(recap, dry_run)
    return counts


def run_document_meta_repair(workers: int, dry_run: bool) -> int:
    """The whole --repair-document-meta run, on one autocommit connection.
    Returns the exit code: 1 when no selected row's text could be read (a run
    that read nothing must not pass for one that found nothing to change),
    else 0."""
    conn = open_selection_connection()
    try:
        if not extract.document_meta_column_exists(conn):
            log.warning("financial_report_extractions.document_meta is absent (migration 000132): nothing to repair")
            return 0
        rows = select_document_meta_rows(conn)
        log.info(
            "Document meta repair: %d rows with document_meta and stored text, %d of them state an entity and %d a "
            "period (workers=%d)",
            len(rows), sum(r["entity"] is not None for r in rows), sum(r["period_end"] is not None for r in rows),
            workers,
        )
        counts = repair_document_meta(conn, rows, workers, dry_run)
    finally:
        conn.close()
    log.info(
        "Document meta repair%s: %d rows selected, %d read, %d without text; entity: %d unchanged, %d cosmetic, "
        "%d renamed, %d added, %d kept; period: %d unchanged, %d changed, %d added, %d kept; %d left alone (guard "
        "missed); entity check: now passes %d, now fails %d, no change %d; own-period check: becomes the newest "
        "period %d, was the newest period %d, neither %d",
        " (dry run, nothing written)" if dry_run else "",
        len(rows), counts["read"], counts["without_text"], counts[UNCHANGED], counts[COSMETIC],
        counts[RENAMED], counts[ADDED], counts[KEPT], counts[PERIOD_UNCHANGED], counts[PERIOD_CHANGED],
        counts[PERIOD_ADDED], counts[PERIOD_KEPT], counts["left_alone"],
        counts[NOW_PASSES], counts[NOW_FAILS], counts[NO_CHANGE],
        counts[BECOMES_NEWEST], counts[WAS_NEWEST], counts[NEITHER],
    )
    if rows and not counts["read"]:
        log.error(
            "No row's stored text could be read (%d selected): nothing was read again and nothing was written",
            len(rows),
        )
        return 1
    return 0


def timed(worker: Callable[..., str], run_usage: TokenUsage) -> Callable[[dict], str]:
    """Wrap a worker so each report logs its wall time, outcome and tokens."""

    def run(report: dict) -> str:
        usage = TokenUsage(parent=run_usage)
        started = time.monotonic()
        outcome = "error"
        try:
            outcome = worker(report, usage=usage)
            return outcome
        finally:
            log.info(
                "  report %s %s: %s in %.1fs, tokens %s",
                report.get("stock_code"),
                report.get("url"),
                outcome,
                time.monotonic() - started,
                usage.summary(),
            )

    return run


def run_with_budget(
    items: list,
    worker: Callable[[Any], str],
    workers: int,
    budget_seconds: float,
    clock: Callable[[], float] = time.monotonic,
    max_consecutive_model_errors: int = extract.MAX_CONSECUTIVE_MODEL_ERRORS,
) -> tuple[Counter, int]:
    """Run worker over items with at most `workers` in flight, submitting a new
    item only while the budget has not elapsed. In-flight items always finish.

    Circuit breaker: once max_consecutive_model_errors items in a row (in
    completion order, among items that called the model) end in model_error,
    no new item is submitted: the model or its key is failing, and every
    further item would fail the same way. 0 disables it.

    Returns (outcome counts, number submitted). items[submitted:] were never
    started."""
    counts: Counter = Counter()
    if not items:
        return counts, 0
    start = clock()
    pending: Iterable = iter(items)
    submitted = 0
    budget_logged = False
    in_flight: set = set()
    consecutive_model_errors = 0
    breaker_open = False

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(workers, 1)) as ex:

        def submit_next() -> bool:
            nonlocal submitted, budget_logged
            if breaker_open:
                return False
            if clock() - start >= budget_seconds:
                if not budget_logged and submitted < len(items):
                    budget_logged = True
                    log.warning(
                        "Budget of %.0f min reached: no new reports started; %d of %d remain for the next run",
                        budget_seconds / 60, len(items) - submitted, len(items),
                    )
                return False
            try:
                item = next(pending)
            except StopIteration:
                return False
            in_flight.add(ex.submit(worker, item))
            submitted += 1
            return True

        for _ in range(max(workers, 1)):
            if not submit_next():
                break
        done_count = 0
        while in_flight:
            done, _ = concurrent.futures.wait(in_flight, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                in_flight.discard(fut)
                try:
                    outcome = fut.result()
                except Exception as e:  # noqa: BLE001
                    outcome = "error"
                    log.warning("  worker error: %s", e)
                counts[outcome] += 1
                done_count += 1
                if outcome == extract.MODEL_ERROR:
                    consecutive_model_errors += 1
                elif outcome not in _NO_MODEL_CALL:
                    consecutive_model_errors = 0
                if (
                    not breaker_open
                    and max_consecutive_model_errors > 0
                    and consecutive_model_errors >= max_consecutive_model_errors
                ):
                    breaker_open = True
                    log.error(
                        "%d consecutive model errors: the model or its key is failing. No new reports started; "
                        "%d of %d remain for the next run",
                        consecutive_model_errors, len(items) - submitted, len(items),
                    )
                if done_count % 25 == 0:
                    log.info("  progress %d/%d  %s", done_count, len(items), dict(counts))
                submit_next()
    return counts, submitted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recent", type=int, default=2, help="newest N results documents per company considered")
    ap.add_argument("--limit", type=int, default=0, help="cap total reports (0=all, still capped by GEMINI_MAX_RUN_ITEMS)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--backend", choices=BACKENDS, default=os.environ.get("EXTRACTOR_BACKEND") or "openrouter",
                    help="openrouter (default): one validated call per document, DeepSeek primary + cheapest-Gemini "
                         "consensus (direct_extract.py; models via EXTRACTOR_*_MODEL). gemini: the langextract path.")
    ap.add_argument("--model", type=str, default="gemini-2.5-flash", help="langextract model (--backend gemini only)")
    ap.add_argument("--max-pages", type=int, default=extract.DEFAULT_MAX_PAGES)
    ap.add_argument("--budget-min", type=float, default=DEFAULT_BUDGET_MIN,
                    help="stop starting new reports after this many minutes (in-flight reports finish)")
    ap.add_argument("--backfill-digests", action="store_true",
                    help="§6.3(b): re-summarise existing rows with digest IS NULL (uses stored GCS text)")
    ap.add_argument("--repair-echo-digests", action="store_true",
                    help="drop few-shot-echo entries from stored metrics and re-summarise those rows "
                         "(the one-off repair after the trust funnel; uses stored GCS text)")
    ap.add_argument("--repair-document-meta", action="store_true",
                    help="read document_meta's entity and period again, with the current rule and each row's report "
                         "date, from its stored GCS text and rewrite only those keys, never removing a name readers "
                         "check or a stated period (no model call, no PDF download; runs alone)")
    ap.add_argument("--max-model-errors", type=int, default=extract.MAX_CONSECUTIVE_MODEL_ERRORS,
                    help="stop starting new reports after this many model errors in a row (0 = never)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.repair_document_meta:
        # No model call and no PDF download: neither the Gemini run budget nor
        # the key check applies, and nothing is selected for extraction.
        if run_document_meta_repair(args.workers, args.dry_run):
            sys.exit(1)
        return

    original_limit, original_workers = args.limit, args.workers
    args.limit, args.workers = extract.resolve_gemini_run_budget(
        limit=args.limit,
        workers=args.workers,
        default_max_items=10,
        default_max_workers=2,
    )
    if (args.limit, args.workers) != (original_limit, original_workers):
        log.warning(
            "Gemini run budget capped --limit/--workers from %s/%s to %s/%s",
            original_limit,
            original_workers,
            args.limit,
            args.workers,
        )

    # Without a key every model call fails (each would count as a model error
    # and store nothing): fail before selecting anything. A dry run writes
    # nothing, so it may run without one.
    if args.backend == "openrouter":
        if not args.dry_run and not openrouter_key_present():
            log.error("--backend openrouter needs OPENROUTER_API_KEY: refusing to run (nothing selected, nothing written)")
            sys.exit(1)
    elif not args.dry_run and not gemini_key_present():
        log.error("No GEMINI_API_KEY / LANGEXTRACT_API_KEY set: refusing to run (nothing selected, nothing written)")
        sys.exit(1)
    direct = None
    if args.backend == "openrouter" and openrouter_key_present():
        import direct_extract

        direct = direct_extract.from_env()
        direct.denylist = extract.FEWSHOT_DENYLIST
        log.info("Backend openrouter: primary=%s checker=%s arbiter=%s strict=%s",
                 direct.primary, direct.checker, direct.arbiter, direct.strict)

    conn = open_selection_connection()
    try:
        write_meta = extract.document_meta_column_exists(conn)
        count_attempts = extract.extraction_attempts_column_exists(conn)
        if args.repair_echo_digests:
            reports = select_echo_digest_reports(conn, args.limit)
            base_worker = process_digestless
            log.info("Echo repair: %d rows whose metrics carry a few-shot echo (workers=%d)", len(reports), args.workers)
        elif args.backfill_digests:
            reports = select_digestless_reports(conn, args.limit)
            base_worker = process_digestless
            log.info("Digest backfill: %d rows with no digest (workers=%d)", len(reports), args.workers)
        else:
            reports = select_reports(conn, args.recent, args.limit, dry_run=args.dry_run)
            base_worker = process
            retries = sum(1 for r in reports if r.get("empty_retry"))
            log.info("Report extraction: %d reports to process, %d of them empty extractions read again (recent=%d, workers=%d, max_pages=%d, budget=%.0f min)",
                     len(reports), retries, args.recent, args.workers, args.max_pages, args.budget_min)
    finally:
        # Nothing below needs the selection connection: free the slot.
        conn.close()
    if not write_meta:
        log.warning("financial_report_extractions.document_meta is absent (migration 000132); not writing it this run")
    if not count_attempts:
        log.warning("financial_report_extractions.extraction_attempts is absent (migration 000136); empty extractions are not retried this run")

    if args.dry_run and reports:
        for r in reports[:10]:
            log.info("  [dry-run] %s %s (%s) %s", r["stock_code"], (r.get("title") or "")[:50], r.get("type"), r.get("date"))

    run_usage = TokenUsage()
    extra = {"count_attempts": count_attempts} if base_worker is process else {}
    worker = timed(
        functools.partial(
            base_worker, model=args.model, max_pages=args.max_pages,
            dry_run=args.dry_run, write_meta=write_meta, direct=direct, **extra,
        ),
        run_usage,
    )
    started = time.monotonic()
    counts, submitted = run_with_budget(
        reports, worker, args.workers, args.budget_min * 60,
        max_consecutive_model_errors=args.max_model_errors,
    )

    log.info(
        "DONE in %.1f min: %s; started %d of %d, %d remain for the next run",
        (time.monotonic() - started) / 60, dict(counts), submitted, len(reports), len(reports) - submitted,
    )
    log.info("Gemini tokens this run: %s", run_usage.summary())
    if direct is not None:
        log.info("Direct extraction: %s", dict(direct.stats))
    if counts[extract.MODEL_ERROR]:
        # Nothing was stored for these documents; the next run retries them.
        log.error(
            "%d model errors: those documents were not stored and the next run retries them",
            counts[extract.MODEL_ERROR],
        )
        if model_errors_fail_run(counts, args.max_model_errors):
            # Systemic: a run whose model calls failed must not read as a
            # success.
            sys.exit(1)


if __name__ == "__main__":
    main()
