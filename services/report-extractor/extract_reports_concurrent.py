#!/usr/bin/env python3
"""Concurrent financial-report extraction backfill.

extract.py's main() is sequential (--delay loop) — fine for a handful of stocks
but far too slow for the ~5k latest-reports-per-company backfill. This reuses
extract.py's PDF + langextract + digest helpers under a ThreadPoolExecutor so the
financial-digest coverage can be broadened from ~63 stocks to the whole market.

Run (against prod):
  DATABASE_URL=... GEMINI_API_KEY=... LANGEXTRACT_API_KEY=$GEMINI_API_KEY \
    python extract_reports_concurrent.py --recent 2 --limit 5000 --workers 8 [--top-shorted-first]
"""
from __future__ import annotations

import argparse
import concurrent.futures
import logging
import threading

import psycopg2
import psycopg2.extras
import requests

import extract  # reuse helpers (import is side-effect-free)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reports-backfill")

_tl = threading.local()


def _session() -> requests.Session:
    s = getattr(_tl, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update(extract.ASX_HEADERS)
        _tl.session = s
    return s


def select_reports(conn, recent: int, limit: int, top_shorted_first: bool) -> list[dict]:
    """Latest `recent` key financial reports per company, deduped vs already-extracted."""
    reports = extract.get_reports_to_process(conn, mode="all", codes=[], limit=0, recent=recent)
    if top_shorted_first:
        cur = conn.cursor()
        cur.execute("SELECT product_code, current_percent FROM mv_top_shorts")
        rank = {code: pct for code, pct in cur.fetchall()}
        cur.close()
        reports.sort(key=lambda r: rank.get(r["stock_code"], -1), reverse=True)
    if limit > 0:
        reports = reports[:limit]
    return reports


def process(report: dict, conn, lock: threading.Lock, model: str, max_pages: int, dry_run: bool) -> str:
    text = extract.download_pdf_text(_session(), report["url"], max_pages=max_pages)
    if not text:
        return "no_pdf"
    extractions = extract.extract_financial_data(text, report["stock_code"], model_id=model)
    # GCS upload is best-effort; never fail the report on it.
    try:
        gcs_url = extract.upload_raw_text_to_gcs(report["stock_code"], report["url"], text)
    except Exception:  # noqa: BLE001
        gcs_url = None

    if not extractions:
        with lock:
            extract.store_extraction(conn, report, {}, len(text), dry_run, digest_result=None, raw_text_gcs_url=gcs_url)
        return "no_metrics"

    metrics = extract.extractions_to_metrics(extractions)
    digest = extract.summarize_report(metrics, text, model_id=model)
    with lock:
        extract.store_extraction(conn, report, metrics, len(text), dry_run, digest_result=digest, raw_text_gcs_url=gcs_url)
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recent", type=int, default=2, help="latest N reports per company")
    ap.add_argument("--limit", type=int, default=0, help="cap total reports (0=all)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--model", type=str, default="gemini-2.5-flash")
    ap.add_argument("--max-pages", type=int, default=10)
    ap.add_argument("--top-shorted-first", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = extract.get_db_connection()
    reports = select_reports(conn, args.recent, args.limit, args.top_shorted_first)
    log.info("Report backfill: %d reports to process (recent=%d, workers=%d)", len(reports), args.recent, args.workers)
    if args.dry_run and reports:
        for r in reports[:10]:
            log.info("  [dry-run] %s %s (%s) %s", r["stock_code"], r["title"][:50], r["type"], r["date"])

    lock = threading.Lock()
    counts: dict[str, int] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process, r, conn, lock, args.model, args.max_pages, args.dry_run): r for r in reports}
        for fut in concurrent.futures.as_completed(futs):
            try:
                outcome = fut.result()
            except Exception as e:  # noqa: BLE001
                outcome = "error"
                log.warning("  worker error: %s", e)
            counts[outcome] = counts.get(outcome, 0) + 1
            done += 1
            if done % 50 == 0:
                log.info("  progress %d/%d  %s", done, len(reports), counts)

    log.info("DONE: %s", counts)
    conn.close()


if __name__ == "__main__":
    main()
