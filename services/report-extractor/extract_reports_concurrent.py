#!/usr/bin/env python3
"""Concurrent financial-report extraction: the scheduled financial-report-extractor job.

Reuses extract.py's PDF + langextract + digest helpers under a thread pool.
Design contract: docs/plans/fundamentals-coverage.md sections 6.1 and 6.2.

Two modes:
  (default)            the statutory results documents worth a paid extraction,
                       ONE per company, in this order (extract.order_extraction_targets):
                       report_date within 45 days (newest first), then
                       companies with no metric-bearing extraction yet (by
                       market cap), then the rest (by market cap). Each runs the
                       full extract + ground + digest + document_meta pipeline.
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

Run (against prod):
  DATABASE_URL=... GEMINI_API_KEY=... LANGEXTRACT_API_KEY=$GEMINI_API_KEY \
    python extract_reports_concurrent.py --recent 2 --limit 120 --workers 4 --max-pages 8
  DATABASE_URL=... GEMINI_API_KEY=... \
    python extract_reports_concurrent.py --backfill-digests --limit 500 --workers 4
  DATABASE_URL=... GEMINI_API_KEY=... \
    python extract_reports_concurrent.py --repair-echo-digests --dry-run

Connections: the selection connection is autocommit and is closed before any
report starts. Each worker opens its own autocommit connection lazily, only to
write, so no connection holds a transaction across a PDF download or a model
call (psycopg2 connections are not thread-safe, hence one per thread).
"""
from __future__ import annotations

import argparse
import concurrent.futures
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


def select_reports(conn, recent: int, limit: int) -> list[dict]:
    """The run's work list (extract.select_extraction_targets)."""
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
) -> str:
    """Extract one company's document (or, when it cannot be read, the next of
    its fallbacks) and store the row. A model error stores nothing and returns
    model_error, so the next run retries the document."""

    def record_unreadable(doc: dict, text_length: int) -> None:
        extract.store_unreadable(_conn(), doc, text_length, dry_run)

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
                document_meta=extract_document_meta(text), write_document_meta=write_meta,
            )
            return "echo_cleared"
        return "no_digest"
    extract.store_extraction(
        _conn(), report, metrics, len(text), dry_run,
        digest_result=digest, raw_text_gcs_url=gcs_url,
        document_meta=extract_document_meta(text), write_document_meta=write_meta,
    )
    return f"ok_{source}"


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
    ap.add_argument("--max-model-errors", type=int, default=extract.MAX_CONSECUTIVE_MODEL_ERRORS,
                    help="stop starting new reports after this many model errors in a row (0 = never)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

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
        if args.repair_echo_digests:
            reports = select_echo_digest_reports(conn, args.limit)
            base_worker = process_digestless
            log.info("Echo repair: %d rows whose metrics carry a few-shot echo (workers=%d)", len(reports), args.workers)
        elif args.backfill_digests:
            reports = select_digestless_reports(conn, args.limit)
            base_worker = process_digestless
            log.info("Digest backfill: %d rows with no digest (workers=%d)", len(reports), args.workers)
        else:
            reports = select_reports(conn, args.recent, args.limit)
            base_worker = process
            log.info("Report extraction: %d reports to process (recent=%d, workers=%d, max_pages=%d, budget=%.0f min)",
                     len(reports), args.recent, args.workers, args.max_pages, args.budget_min)
    finally:
        # Nothing below needs the selection connection: free the slot.
        conn.close()
    if not write_meta:
        log.warning("financial_report_extractions.document_meta is absent (migration 000132); not writing it this run")

    if args.dry_run and reports:
        for r in reports[:10]:
            log.info("  [dry-run] %s %s (%s) %s", r["stock_code"], (r.get("title") or "")[:50], r.get("type"), r.get("date"))

    run_usage = TokenUsage()
    worker = timed(
        functools.partial(
            base_worker, model=args.model, max_pages=args.max_pages,
            dry_run=args.dry_run, write_meta=write_meta, direct=direct,
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
