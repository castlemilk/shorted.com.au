#!/usr/bin/env python3
"""ASX Appendix 3Y director-trade extractor.

The asx-announcement-crawler populates `director_trades` from announcement
HEADLINES only, which is why ~59% of rows are "Unknown Director" (the headline
is often just "Change of Director's Interest Notice" with no name) and 100% have
NULL total_value / shares_traded (the headline carries no financials).

The real data lives in the Appendix 3Y PDF — a standardised form with the
director's full name, securities acquired/disposed, consideration ($), and the
nature of the change. This script fetches each 3Y PDF (reusing report-extractor's
PDF + Gemini helpers), extracts that structured data with gemini-2.5-flash, and
writes clean values back to `director_trades` keyed on announcement_url.

Run (against prod):
  DATABASE_URL=... GEMINI_API_KEY=... python extract_director_trades.py \
      --limit 500 --priority recent --workers 8 [--dry-run]

Backends (EXTRACTOR_BACKEND / --backend):
  openrouter  (default) director_direct.py: DeepSeek v4 Flash reads the notice,
              Gemini 2.5 Flash-Lite reads it independently, Gemini 2.5 Flash
              arbitrates; the trade is written only on agreement, every name and
              number validated against the notice. Needs OPENROUTER_API_KEY.
  gemini      the original single gemini-2.5-flash call (GEMINI_API_KEY).

Model failures: a call that fails (bad key, quota, outage) is model_error. It
is NOT recorded as an attempt, so the next run retries the notice, and the run
exits 1 when model errors look systemic. Until 2026-09-29 a failed call was
recorded as no_extract and the notice skipped for 30 days: from 2026-07-30 every
attempt was such a failure (--retry-no-extract-between re-admits them).

Priorities:
  recent      most recent trade_date first (default)
  unknown     only rows still named "Unknown Director"
  top-shorted join mv_top_shorts so the stocks users look at get done first
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import re
import sys
import threading
from collections import Counter
from typing import Any, Optional

import psycopg2
import psycopg2.extras
import requests

# Reuse the PDF-fetch + ASX-resolve helpers and DB connector from the
# financial-report extractor (importing is side-effect-free — its work is under
# `if __name__ == "__main__"`).
import extract  # noqa: E402
from token_usage import TokenUsage  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("director-extract")

EXTRACT_MODEL = "gemini-2.5-flash"

EXTRACT_PROMPT = """You extract structured data from an ASX "Appendix 3Y — Change of \
Director's Interest Notice". These are standardised forms. Return STRICT JSON \
(no markdown) with exactly these keys:

- "director_name": the FULL name of the director (a person, NOT the company). \
Title-case it, strip honorifics (Mr/Ms/Dr). null if you cannot find it.
- "date_of_change": ISO date YYYY-MM-DD of the change in interest, or null.
- "securities_class": e.g. "Ordinary fully paid shares", "Performance rights", or null.
- "number_acquired": integer — total securities ACQUIRED across all changes in the \
notice (sum the table), or null.
- "number_disposed": integer — total securities DISPOSED, or null.
- "consideration_aud": number — total dollar value / consideration in AUD across the \
changes, or null. Strip "$" and commas. Use null if "Nil" or not stated.
- "nature_of_change": short phrase, e.g. "On-market purchase", "On-market sale", \
"Exercise of options", "Vesting of performance rights", "Off-market transfer".
- "interest_type": "direct" or "indirect" or null.
- "confidence": 0.0-1.0 — your confidence the director_name + figures are correct.

If the document is NOT an Appendix 3Y, or has no identifiable director, set \
director_name to null and confidence 0. Output ONLY the JSON object."""

_thread_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update(extract.ASX_HEADERS)
        _thread_local.session = s
    return s


def _conn():
    """Thread-local DB connection. psycopg2 connections are NOT thread-safe, so each
    worker gets its own — this removes the shared-connection + lock race where a failed
    commit in one worker would poison another worker's transaction."""
    c = getattr(_thread_local, "conn", None)
    if c is None:
        c = extract.get_db_connection()
        _thread_local.conn = c
    return c


def _genai_client():
    """One genai client per thread (the SDK client is not guaranteed thread-safe)."""
    c = getattr(_thread_local, "genai", None)
    if c is None:
        from google import genai

        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY")
        if not api_key:
            log.error("GEMINI_API_KEY (or LANGEXTRACT_API_KEY) required")
            sys.exit(1)
        c = genai.Client(api_key=api_key)
        _thread_local.genai = c
    return c


def extract_3y(text: str) -> dict | None:
    """Run gemini structured extraction over the 3Y PDF text. Returns parsed dict or None."""
    from google.genai import types as genai_types

    client = _genai_client()
    # 3Y notices are short — 6000 chars covers the form comfortably.
    user_content = (text or "")[:6000]
    try:
        resp = client.models.generate_content(
            model=EXTRACT_MODEL,
            contents=user_content,
            config=genai_types.GenerateContentConfig(
                system_instruction=EXTRACT_PROMPT,
                temperature=0.0,
                response_mime_type="application/json",
            ),
        )
        raw = (resp.text or "").strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw).strip()
        parsed = json.loads(raw)
        # Some 3Y notices have several changes; the model occasionally returns a
        # JSON ARRAY of change-objects instead of the requested single object.
        # Merge them: sum the quantities/consideration, take the first name.
        if isinstance(parsed, list):
            parsed = _merge_changes([c for c in parsed if isinstance(c, dict)])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError as e:
        log.warning("  JSON parse failed: %s", e)
        return None
    except Exception as e:  # noqa: BLE001 - the call itself failed: retry next run
        raise extract.ModelError(f"gemini extract failed: {e}") from e


def _merge_changes(changes: list) -> dict | None:
    """Collapse a list of 3Y change-objects into one summed record."""
    if not changes:
        return None
    out: dict = {}
    acq = dis = val = 0.0
    have_qty = False
    for c in changes:
        for k in ("director_name", "date_of_change", "securities_class",
                  "nature_of_change", "interest_type", "confidence"):
            if not out.get(k) and c.get(k) is not None:
                out[k] = c[k]
        a, d, v = _num(c.get("number_acquired")), _num(c.get("number_disposed")), _num(c.get("consideration_aud"))
        if a:
            acq += a; have_qty = True
        if d:
            dis += d; have_qty = True
        if v:
            val += v
    out["number_acquired"] = acq or None
    out["number_disposed"] = dis or None
    out["consideration_aud"] = val or None
    if not have_qty:
        out.setdefault("confidence", out.get("confidence", 0.5))
    return out


def _num(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(re.sub(r"[^0-9.\-]", "", str(v)) or "0") or None
    except ValueError:
        return None


def derive_trade(parsed: dict) -> dict | None:
    """Turn the extracted 3Y fields into director_trades columns. None if unusable."""
    name = (parsed.get("director_name") or "").strip()
    conf = _num(parsed.get("confidence")) or 0.0
    if not name or conf < 0.5:
        return None

    acquired = _num(parsed.get("number_acquired")) or 0
    disposed = _num(parsed.get("number_disposed")) or 0
    consideration = _num(parsed.get("consideration_aud"))
    nature = (parsed.get("nature_of_change") or "").lower()

    if acquired >= disposed and acquired > 0:
        trade_type, shares = "buy", acquired
    elif disposed > 0:
        trade_type, shares = "sell", disposed
    else:
        # No quantity in the form (e.g. nil change / annual confirmation).
        trade_type, shares = "buy", 0

    if shares > 0 and ("option" in nature or "performance right" in nature or "vesting" in nature):
        trade_type = "exercise_options"

    price = None
    if consideration and shares > 0:
        price = round(consideration / shares, 4)

    return {
        "director_name": name,
        "trade_type": trade_type,
        "shares_traded": int(shares),
        "total_value": consideration,
        "price_per_share": price,
        "trade_date": parsed.get("date_of_change"),
        "confidence": conf,
    }


def attempts_table_exists(conn) -> bool:
    """Whether the §6.9 failure-budget marker table is present (migration 000069).
    The script degrades gracefully when it isn't (no skip, no recording)."""
    cur = conn.cursor()
    cur.execute("SELECT to_regclass('public.director_extract_attempts')")
    exists = cur.fetchone()[0] is not None
    cur.close()
    return exists


def select_urls(conn, priority: str, limit: int, retry_after_days: int = 0,
                retry_no_extract_between: Optional[tuple[str, str]] = None) -> list[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    # §6.9 Skip URLs attempted within the cool-off window so the scheduled job converges
    # instead of re-burning Gemini on the same persistent no_pdf/no_extract failures.
    # A no_extract recorded inside retry_no_extract_between is NOT a reason to
    # skip: those were model failures misrecorded (see the module docstring).
    skip = ""
    params: list = []
    if retry_after_days > 0 and attempts_table_exists(conn):
        forgive = ""
        if retry_no_extract_between:
            forgive = (" AND NOT (a.last_outcome = 'no_extract' "
                       "AND a.last_attempted_at >= %s::date AND a.last_attempted_at < %s::date)")
        skip = (
            " AND NOT EXISTS (SELECT 1 FROM director_extract_attempts a "
            "WHERE a.announcement_url = {col} "
            "AND a.last_attempted_at > NOW() - make_interval(days => %s)" + forgive + ")"
        )

    if priority == "top-shorted":
        base = """
            SELECT DISTINCT ON (dt.announcement_url)
                   dt.announcement_url, dt.stock_code, dt.trade_date
            FROM director_trades dt
            JOIN mv_top_shorts t ON t.product_code = dt.stock_code
            WHERE dt.announcement_url ~ '^https?://'
              AND (dt.director_name = 'Unknown Director' OR dt.total_value IS NULL)
        """
        if skip:
            base += skip.format(col="dt.announcement_url")
            params.append(retry_after_days)
            params.extend(retry_no_extract_between or ())
        base += " ORDER BY dt.announcement_url, dt.trade_date DESC"
    else:
        base = """
            SELECT DISTINCT ON (announcement_url)
                   announcement_url, stock_code, trade_date
            FROM director_trades
            WHERE announcement_url ~ '^https?://'
              AND (director_name = 'Unknown Director' OR total_value IS NULL)
        """
        if priority == "unknown":
            base += " AND director_name = 'Unknown Director'"
        if skip:
            base += skip.format(col="director_trades.announcement_url")
            params.append(retry_after_days)
            params.extend(retry_no_extract_between or ())
        base += " ORDER BY announcement_url, trade_date DESC"

    # Re-sort the de-duplicated set by recency and cap.
    outer = f"SELECT * FROM ({base}) s ORDER BY trade_date DESC LIMIT %s"
    params.append(limit)
    cur.execute(outer, tuple(params))
    return [dict(r) for r in cur.fetchall()]


def record_attempt(url: str, outcome: str):
    """Upsert the §6.9 failure-budget marker for a URL (no-op if the table is absent).
    Uses the worker's thread-local connection."""
    conn = _conn()
    sql = """
        INSERT INTO director_extract_attempts (announcement_url, attempts, last_outcome, last_attempted_at)
        VALUES (%s, 1, %s, NOW())
        ON CONFLICT (announcement_url) DO UPDATE SET
            attempts = director_extract_attempts.attempts + 1,
            last_outcome = EXCLUDED.last_outcome,
            last_attempted_at = NOW()
    """
    try:
        cur = conn.cursor()
        cur.execute(sql, (url, outcome))
        conn.commit()
        cur.close()
    except psycopg2.Error:
        conn.rollback()  # table missing / transient — never fail the run on the marker


def update_trade(url: str, d: dict, dry_run: bool):
    if dry_run:
        log.info("  [dry-run] %s -> %s %s shares=%s $%s conf=%.2f",
                 url[-40:], d["director_name"], d["trade_type"],
                 d["shares_traded"], d["total_value"], d["confidence"])
        return
    sql = """
        UPDATE director_trades
        SET director_name = %s,
            trade_type = %s,
            shares_traded = %s,
            total_value = %s,
            price_per_share = %s,
            trade_date = COALESCE(%s::date, trade_date)
        WHERE announcement_url = %s
    """
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(sql, (d["director_name"], d["trade_type"], d["shares_traded"],
                          d["total_value"], d["price_per_share"], d["trade_date"], url))
        conn.commit()
        cur.close()
    except psycopg2.Error:
        conn.rollback()  # keep this worker's connection usable for the next row
        raise


def process_one(row: dict, dry_run: bool, record_attempts: bool, direct: Any = None, usage: Any = None) -> str:
    url = row["announcement_url"]
    outcome = _process_one_inner(row, dry_run, direct, usage)
    # §6.9 Record the attempt so persistent failures are skipped next run. A
    # model failure is never recorded: it says nothing about the notice.
    if record_attempts and not dry_run and outcome != extract.MODEL_ERROR:
        record_attempt(url, outcome)
    return outcome


def _process_one_inner(row: dict, dry_run: bool, direct: Any = None, usage: Any = None) -> str:
    url = row["announcement_url"]
    text = extract.download_pdf_text(_session(), url, max_pages=4)
    if not text:
        return "no_pdf"
    if direct is not None:
        import direct_extract

        try:
            trade, outcome = direct.extract(text, usage=usage)
        except direct_extract.ModelCallError as e:
            log.warning("  %s: model error, not recorded (the next run retries it): %s", url[-40:], e)
            return extract.MODEL_ERROR
        if trade is None:
            return outcome  # not_3y | disputed | invalid_<reason>
        d = {
            "director_name": trade.director_name,
            "trade_type": trade.trade_type,
            "shares_traded": trade.shares,
            "total_value": trade.total_value,
            "price_per_share": trade.price,
            "trade_date": trade.trade_date,
            "confidence": 1.0 if outcome in ("agree", "majority") else 0.6,
        }
        update_trade(url, d, dry_run)
        return "ok" if outcome in ("agree", "majority") else f"ok_{outcome}"
    try:
        parsed = extract_3y(text)
    except extract.ModelError as e:
        log.warning("  %s: model error, not recorded (the next run retries it): %s", url[-40:], e)
        return extract.MODEL_ERROR
    if not parsed:
        return "no_extract"
    d = derive_trade(parsed)
    if not d:
        return "low_conf"
    update_trade(url, d, dry_run)
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--priority", choices=["recent", "unknown", "top-shorted"], default="recent")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--retry-after-days", type=int, default=30,
                    help="§6.9 skip URLs attempted within this many days (0=disable, retry everything)")
    ap.add_argument("--backend", choices=["openrouter", "gemini"], default=os.environ.get("EXTRACTOR_BACKEND") or "openrouter")
    ap.add_argument("--retry-no-extract-between", default=os.environ.get("DIRECTOR_RETRY_NO_EXTRACT_BETWEEN", ""),
                    help="FROM:TO dates: no_extract markers recorded in [FROM, TO) do not cause a skip "
                         "(re-admits notices misrecorded during a model outage)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    window = None
    if args.retry_no_extract_between:
        a, _, b = args.retry_no_extract_between.partition(":")
        if not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", a) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", b)):
            ap.error("--retry-no-extract-between must be YYYY-MM-DD:YYYY-MM-DD")
        window = (a, b)
    direct = None
    if args.backend == "openrouter":
        import director_direct

        direct = director_direct.from_env()
        if direct is None and not args.dry_run:
            log.error("--backend openrouter needs OPENROUTER_API_KEY: refusing to run (nothing selected, nothing written)")
            sys.exit(1)
        if direct is not None:
            log.info("Backend openrouter: primary=%s checker=%s arbiter=%s", direct.primary, direct.checker, direct.arbiter)

    original_limit, original_workers = args.limit, args.workers
    args.limit, args.workers = extract.resolve_gemini_run_budget(
        limit=args.limit,
        workers=args.workers,
        default_max_items=20,
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

    conn = extract.get_db_connection()
    rows = select_urls(conn, args.priority, args.limit, retry_after_days=args.retry_after_days,
                       retry_no_extract_between=window)
    record_attempts = args.retry_after_days > 0 and attempts_table_exists(conn)
    if args.retry_after_days > 0 and not record_attempts:
        log.warning("director_extract_attempts table missing (apply migration 000069) — failure-budget disabled this run")
    conn.close()  # selection is done; workers open their own connections
    log.info("Director-trade extraction: %d PDFs to process (priority=%s, retry_after_days=%d)",
             len(rows), args.priority, args.retry_after_days)

    counts: Counter = Counter()
    done = 0
    run_usage = TokenUsage()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, r, args.dry_run, record_attempts, direct, TokenUsage(parent=run_usage)): r
                for r in rows}
        for fut in concurrent.futures.as_completed(futs):
            try:
                outcome = fut.result()
            except Exception as e:  # noqa: BLE001
                outcome = "error"
                log.warning("  worker error: %s", e)
            counts[outcome] = counts.get(outcome, 0) + 1
            done += 1
            if done % 50 == 0:
                log.info("  progress %d/%d  %s", done, len(rows), counts)

    log.info("DONE: %s", dict(counts))
    log.info("Model tokens this run: %s", run_usage.summary())
    if direct is not None:
        log.info("Consensus: %s", dict(direct.stats))
    if counts[extract.MODEL_ERROR]:
        log.error("%d model errors: those notices were not recorded and the next run retries them",
                  counts[extract.MODEL_ERROR])
        from extract_reports_concurrent import model_errors_fail_run

        if model_errors_fail_run(counts, extract.MAX_CONSECUTIVE_MODEL_ERRORS):
            sys.exit(1)


if __name__ == "__main__":
    main()
