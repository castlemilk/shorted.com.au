#!/usr/bin/env python3
"""Stock reputation / risk-signal collector — the "intelligent crawler" path.

Instead of bespoke per-source scrapers, this calls brandbrain's
ResolveBusinessSignals RPC (api.brandbrain.dev) — Gemini-grounded web research
that surfaces adverse signals (court matters, regulator sanctions, money-
laundering findings, safety incidents, complaints) and positive signals
(awards, certifications, major press), each with citations + confidence.

For a short-selling platform the adverse signals are first-class risk
indicators (e.g. Star Entertainment -> "Federal Court fines/bans former execs
over money-laundering risk").

Run (against prod):
  DATABASE_URL=... python collect.py --priority top-shorted --limit 100 \
      [--max-age-days 30] [--workers 4] [--dry-run]
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import logging
import os
import threading
import time

import psycopg2
import psycopg2.extras
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("signals-collector")

BRANDBRAIN_URL = os.environ.get(
    "BRANDBRAIN_URL",
    "https://api.brandbrain.dev/brandbrain.v1.DiscoveryService/ResolveBusinessSignals",
)

_thread_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        _thread_local.session = s
    return s


def db():
    url = os.environ["DATABASE_URL"]
    return psycopg2.connect(url)


def select_stocks(conn, priority: str, limit: int, max_age_days: int) -> list[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    # company name + a state hint (most ASX issuers are AU; state often unknown).
    base = """
        SELECT cm.stock_code, cm.company_name
        FROM "company-metadata" cm
        {join}
        WHERE COALESCE(cm.company_name,'') <> ''
          AND NOT EXISTS (
            SELECT 1 FROM stock_signals_runs r
            WHERE r.stock_code = cm.stock_code
              AND r.last_fetched_at > now() - (%s || ' days')::interval
          )
        {order}
        LIMIT %s
    """
    if priority == "top-shorted":
        sql = base.format(
            join='JOIN mv_top_shorts t ON t.product_code = cm.stock_code',
            order='ORDER BY t.current_percent DESC NULLS LAST',
        )
    else:  # enriched stocks, most-complete first
        sql = base.format(
            join='',
            order="ORDER BY (cm.enhanced_summary IS NOT NULL) DESC, cm.stock_code",
        )
    cur.execute(sql, (max_age_days, limit))
    return [dict(r) for r in cur.fetchall()]


def resolve_signals(company_name: str, retries: int = 3) -> dict | None:
    """Call brandbrain ResolveBusinessSignals with 5xx retry/backoff.

    brandbrain runs on a single instance and 502s under concurrency, so retry
    transient 5xx with exponential backoff (these grounded calls are slow).
    """
    for attempt in range(retries):
        try:
            resp = _session().post(
                BRANDBRAIN_URL,
                data=json.dumps({"business_name": company_name, "state": ""}),
                timeout=180,
            )
            if resp.status_code == 200:
                return resp.json()
            if 500 <= resp.status_code < 600 and attempt < retries - 1:
                time.sleep(2 ** attempt + attempt)  # 1s, 3s, 6s
                continue
            log.warning("  brandbrain HTTP %d for %s", resp.status_code, company_name)
            return None
        except Exception as e:  # noqa: BLE001
            if attempt < retries - 1:
                time.sleep(2 ** attempt + attempt)
                continue
            log.warning("  brandbrain call failed for %s: %s", company_name, e)
            return None
    return None


def _hash(stock_code: str, polarity: str, headline: str) -> str:
    return hashlib.sha1(f"{stock_code}|{polarity}|{headline}".encode()).hexdigest()


def _rows_from_signals(stock_code: str, payload: dict) -> list[tuple]:
    rows: list[tuple] = []
    for polarity, key in (("adverse", "adverse"), ("positive", "positive")):
        for s in payload.get(key, []) or []:
            headline = (s.get("headline") or "").strip()
            if not headline:
                continue
            rows.append((
                stock_code, polarity, s.get("kind"), headline, s.get("detail"),
                s.get("date"), s.get("severity"),
                json.dumps(s.get("citations") or []),
                float(s.get("confidence") or 0.0),
                _hash(stock_code, polarity, headline),
            ))
    return rows


def store(conn, lock: threading.Lock, stock_code: str, rows: list[tuple], dry_run: bool):
    adverse = sum(1 for r in rows if r[1] == "adverse")
    positive = sum(1 for r in rows if r[1] == "positive")
    if dry_run:
        for r in rows:
            log.info("  [dry-run] %s %s/%s: %s", stock_code, r[1], r[6] or "-", r[3][:80])
        log.info("  [dry-run] %s -> %d adverse, %d positive", stock_code, adverse, positive)
        return adverse, positive
    with lock:
        cur = conn.cursor()
        if rows:
            psycopg2.extras.execute_values(
                cur,
                """INSERT INTO stock_signals
                   (stock_code, polarity, kind, headline, detail, event_date, severity,
                    citations, confidence, content_hash)
                   VALUES %s
                   ON CONFLICT (stock_code, content_hash) DO UPDATE SET
                     detail = EXCLUDED.detail, severity = EXCLUDED.severity,
                     citations = EXCLUDED.citations, confidence = EXCLUDED.confidence,
                     fetched_at = now()""",
                rows,
                template="(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)",
            )
        cur.execute(
            """INSERT INTO stock_signals_runs (stock_code, last_fetched_at, adverse_count, positive_count)
               VALUES (%s, now(), %s, %s)
               ON CONFLICT (stock_code) DO UPDATE SET
                 last_fetched_at = now(), adverse_count = EXCLUDED.adverse_count,
                 positive_count = EXCLUDED.positive_count""",
            (stock_code, adverse, positive),
        )
        conn.commit()
    return adverse, positive


def process(stock: dict, conn, lock: threading.Lock, dry_run: bool) -> str:
    payload = resolve_signals(stock["company_name"])
    if payload is None:
        return "error"
    rows = _rows_from_signals(stock["stock_code"], payload)
    a, p = store(conn, lock, stock["stock_code"], rows, dry_run)
    return f"ok({a}a,{p}p)" if rows else "ok(0)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--priority", choices=["top-shorted", "enriched"], default="top-shorted")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--max-age-days", type=int, default=30)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = db()
    stocks = select_stocks(conn, args.priority, args.limit, args.max_age_days)
    log.info("Signal collection: %d stocks (priority=%s)", len(stocks), args.priority)

    lock = threading.Lock()
    counts: dict[str, int] = {}
    tot_adverse = 0
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process, s, conn, lock, args.dry_run): s for s in stocks}
        for fut in concurrent.futures.as_completed(futs):
            try:
                outcome = fut.result()
            except Exception as e:  # noqa: BLE001
                outcome = "error"
                log.warning("  worker error: %s", e)
            bucket = outcome.split("(")[0]
            counts[bucket] = counts.get(bucket, 0) + 1
            if "a," in outcome:
                tot_adverse += int(outcome.split("(")[1].split("a")[0])
            done += 1
            if done % 10 == 0:
                log.info("  progress %d/%d  %s  adverse_total=%d", done, len(stocks), counts, tot_adverse)

    log.info("DONE: %s  total_adverse_signals=%d", counts, tot_adverse)
    conn.close()


if __name__ == "__main__":
    main()
