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

import psycopg2
import psycopg2.extras
import requests

# Reuse the PDF-fetch + ASX-resolve helpers and DB connector from the
# financial-report extractor (importing is side-effect-free — its work is under
# `if __name__ == "__main__"`).
import extract  # noqa: E402

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
        return json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("  JSON parse failed: %s", e)
        return None
    except Exception as e:
        log.warning("  gemini extract failed: %s", e)
        return None


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


def select_urls(conn, priority: str, limit: int) -> list[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    base = """
        SELECT DISTINCT ON (announcement_url)
               announcement_url, stock_code, trade_date
        FROM director_trades
        WHERE announcement_url ~ '^https?://'
          AND (director_name = 'Unknown Director' OR total_value IS NULL)
    """
    if priority == "unknown":
        base += " AND director_name = 'Unknown Director'"
    if priority == "top-shorted":
        base = """
            SELECT DISTINCT ON (dt.announcement_url)
                   dt.announcement_url, dt.stock_code, dt.trade_date
            FROM director_trades dt
            JOIN mv_top_shorts t ON t.product_code = dt.stock_code
            WHERE dt.announcement_url ~ '^https?://'
              AND (dt.director_name = 'Unknown Director' OR dt.total_value IS NULL)
        """
    order_col = "trade_date" if priority == "top-shorted" else "trade_date"
    base += f" ORDER BY announcement_url, {order_col} DESC" if priority != "top-shorted" \
        else " ORDER BY dt.announcement_url, dt.trade_date DESC"
    # Re-sort the de-duplicated set by recency and cap.
    outer = f"SELECT * FROM ({base}) s ORDER BY trade_date DESC LIMIT %s"
    cur.execute(outer, (limit,))
    return [dict(r) for r in cur.fetchall()]


def update_trade(conn, url: str, d: dict, lock: threading.Lock, dry_run: bool):
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
    with lock:
        cur = conn.cursor()
        cur.execute(sql, (d["director_name"], d["trade_type"], d["shares_traded"],
                          d["total_value"], d["price_per_share"], d["trade_date"], url))
        conn.commit()


def process_one(row: dict, conn, lock: threading.Lock, dry_run: bool) -> str:
    url = row["announcement_url"]
    text = extract.download_pdf_text(_session(), url, max_pages=4)
    if not text:
        return "no_pdf"
    parsed = extract_3y(text)
    if not parsed:
        return "no_extract"
    d = derive_trade(parsed)
    if not d:
        return "low_conf"
    update_trade(conn, url, d, lock, dry_run)
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--priority", choices=["recent", "unknown", "top-shorted"], default="recent")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = extract.get_db_connection()
    rows = select_urls(conn, args.priority, args.limit)
    log.info("Director-trade extraction: %d PDFs to process (priority=%s)", len(rows), args.priority)

    lock = threading.Lock()
    counts: dict[str, int] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, r, conn, lock, args.dry_run): r for r in rows}
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

    log.info("DONE: %s", counts)
    conn.close()


if __name__ == "__main__":
    main()
