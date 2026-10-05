#!/usr/bin/env python3
"""
ASX Financial Report Extractor using langextract.

Downloads financial report PDFs from ASX, extracts text, and uses langextract
with Gemini Flash to extract structured financial data. Results are stored in
PostgreSQL (financial_report_extractions) for the picks filings ingest, the
stock page highlights and the weekly report.

Design contract: docs/plans/fundamentals-coverage.md section 6.1. What this
module guarantees about a row it writes:

  - Grounded metrics only. An extraction langextract could not align to the
    document (char_interval None, or an alignment status outside match_exact /
    match_greater / match_lesser / match_fuzzy) is dropped before storage, and
    so is one whose quote is a few-shot example text. A numeric class (revenue,
    net_profit, eps, dividend, cash_flow, ebitda) must carry its value, and the
    value's digits must be a number written inside the ALIGNED span of the
    document. Each stored entry records the string attributes alignment,
    char_start and char_end (the provenance the Go trust funnel reads).
  - A synthetic few-shot example ("Quokka Minerals Limited", H1 FY2031), copied
    verbatim from services/pkg/extractiontrust (FewShotExample, mirrored in its
    testdata/fewshot_example.json). No real filing's own period can be H1
    FY2031, so an echo of the example can never pass as a real result.
  - Thinking off and tokens counted: every Gemini call (langextract's per-prompt
    calls through BudgetedGemini, and the digest call) sets
    thinking_config=ThinkingConfig(thinking_budget=0) and adds its
    usage_metadata to a TokenUsage.
  - document_meta from deterministic regexes over the raw text (currency,
    units, entity, ABN, period end and type, report kind), written when the
    column exists.
  - No transaction is ever held across a PDF download or a model call.
  - A model failure is never stored. A Gemini call that fails (an API error
    after langextract's retries: quota, auth, a retired model; a blocked
    response; a response with no text) raises ModelError instead of looking
    like "nothing grounded", and the caller writes no row, so the next run
    retries the document. Grounded metrics whose digest call failed are
    stored with digest NULL for --backfill-digests.
  - A PDF with no text layer (a scanned document: under MIN_PDF_TEXT_CHARS
    characters on the pages read) gets a marker row (store_unreadable), so
    selection moves on to the company's next document. A download that fails
    for any other reason writes nothing and is retried next run.

Usage:
    # Process top 50 most-shorted stocks
    python extract.py --mode=top50 --limit=50

    # Process specific stocks
    python extract.py --codes=CBA,BHP,CSL

    # Dry run (no DB writes)
    python extract.py --codes=CBA --dry-run

    # Statutory results documents, in the production run's order
    python extract.py --mode=all --limit=100

The scheduled job runs extract_reports_concurrent.py, which reuses these helpers.
"""

import argparse
import datetime as _dt
import hashlib
import json
import logging
import math
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime
from typing import Any, Callable, Iterable, Optional

import fitz  # pymupdf
import langextract as lx
import psycopg2
import psycopg2.extras
import requests

import extraction_trust
from document_meta import extract_document_meta
from token_usage import TokenUsage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y/%m/%d %H:%M:%S",
)
log = logging.getLogger(__name__)


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as e:
        raise ValueError(f"{name} must be a positive integer") from e
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def resolve_gemini_run_budget(
    limit: int,
    workers: int,
    default_max_items: int,
    default_max_workers: int,
    max_items_env: str = "GEMINI_MAX_RUN_ITEMS",
    max_workers_env: str = "GEMINI_MAX_RUN_WORKERS",
) -> tuple[int, int]:
    """Cap paid Gemini batch size/concurrency even when CLI args are too broad."""
    max_items = _positive_int_env(max_items_env, default_max_items)
    max_workers = _positive_int_env(max_workers_env, default_max_workers)

    guarded_limit = max_items if limit <= 0 or limit > max_items else limit
    guarded_workers = min(max(workers, 1), max_workers)
    return guarded_limit, guarded_workers


class ModelError(Exception):
    """A Gemini call failed: an API error (quota, auth, a retired model, an
    overload that outlasted langextract's retries), a blocked response or one
    with no text, or no client to call. Not the same as "nothing grounded": a
    document whose extraction raised this must not be stored, so the next run
    retries it."""


# The outcome of a document whose model call failed (nothing stored), and how
# many in a row stop a run: a dead key, a retired model or an exhausted quota
# fails every call, and each further document only spends a download.
MODEL_ERROR = "model_error"
MAX_CONSECUTIVE_MODEL_ERRORS = 5


# Financial data extraction prompt
EXTRACTION_PROMPT = """Extract key financial metrics from this ASX company financial report.
For each metric found, extract the exact text containing the number and classify it.
Focus on the MOST RECENT reporting period (not comparative/prior period).
All monetary values should be in millions AUD unless stated otherwise.
Only extract metrics that are explicitly stated - do not calculate or infer."""

# Few-shot example for langextract: the SYNTHETIC example defined once in
# services/pkg/extractiontrust (FewShotExample; JSON mirror
# testdata/fewshot_example.json), copied here VERBATIM. Its extraction classes,
# their order and each class's attribute keys are the stored metric vocabulary.
# Do not edit it here: change the Go value, regenerate the mirror, then copy.
# extractiontrust's TestExtractPyExampleIsOnTheDenylist parses this literal and
# fails on anything but the old or the new example; test_extract.py asserts it
# equals the JSON mirror.
EXTRACTION_EXAMPLES = [
    lx.data.ExampleData(
        text="""Quokka Minerals Limited (ASX: QKA) Appendix 4D and half year report for H1 FY2031.
Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million, an increase of 7% on the prior corresponding period.
Statutory net profit after tax (NPAT) attributable to Quokka shareholders was $612 million, up 15% on pcp.
Basic earnings per share was 48.3 cents for H1 FY2031.
The Quokka Board declared an interim dividend of 21 cents per share, fully franked.
Operating cash flow for H1 FY2031 was $1,094 million.
H1 FY2031 EBITDA was $1,529 million, representing a margin of 39.7%.
FY2031 guidance: Quokka expects revenue growth of 4-6%.""",
        extractions=[
            lx.data.Extraction(
                extraction_class="revenue",
                extraction_text="Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million",
                attributes={
                    "value_millions": "3847",
                    "period": "H1 FY2031",
                    "change_pct": "+7",
                },
            ),
            lx.data.Extraction(
                extraction_class="net_profit",
                extraction_text="Statutory net profit after tax (NPAT) attributable to Quokka shareholders was $612 million, up 15% on pcp",
                attributes={
                    "value_millions": "612",
                    "period": "H1 FY2031",
                    "change_pct": "+15",
                },
            ),
            lx.data.Extraction(
                extraction_class="eps",
                extraction_text="Basic earnings per share was 48.3 cents for H1 FY2031",
                attributes={
                    "value_cents": "48.3",
                    "period": "H1 FY2031",
                },
            ),
            lx.data.Extraction(
                extraction_class="dividend",
                extraction_text="The Quokka Board declared an interim dividend of 21 cents per share, fully franked",
                attributes={
                    "value_cents": "21",
                    "franking": "fully franked",
                    "period": "H1 FY2031",
                },
            ),
            lx.data.Extraction(
                extraction_class="cash_flow",
                extraction_text="Operating cash flow for H1 FY2031 was $1,094 million",
                attributes={
                    "value_millions": "1094",
                    "period": "H1 FY2031",
                },
            ),
            lx.data.Extraction(
                extraction_class="ebitda",
                extraction_text="H1 FY2031 EBITDA was $1,529 million, representing a margin of 39.7%",
                attributes={
                    "value_millions": "1529",
                    "margin_pct": "39.7",
                    "period": "H1 FY2031",
                },
            ),
            lx.data.Extraction(
                extraction_class="guidance",
                extraction_text="FY2031 guidance: Quokka expects revenue growth of 4-6%",
                attributes={
                    "metric": "revenue_growth",
                    "range": "4-6%",
                    "period": "FY2031",
                },
            ),
        ],
    ),
]


def _example_texts(example: Any) -> tuple[str, list[str]]:
    return example.text, [e.extraction_text for e in example.extractions]


# Every few-shot example the extractor has ever prompted with: the retired one
# (still stored for BHP, CBA, DRO, EDV and MSB) and the synthetic one above. A
# quote equal to one of their texts is the model echoing its prompt.
FEWSHOT_DENYLIST = extraction_trust.FewShotDenylist(
    [
        (extraction_trust.RETIRED_FEWSHOT_TEXT, extraction_trust.RETIRED_FEWSHOT_EXTRACTION_TEXTS),
        _example_texts(EXTRACTION_EXAMPLES[0]),
    ]
)

# --- Report selection: title filters ------------------------------------------

# The legacy §6.3 noise filter (kept for its callers and tests). Targeting now
# uses is_results_document, the stricter statutory-results classifier ported
# from services/pkg/extractiontrust, so a document the trust funnel would
# refuse to read is never paid for.
NOISE_TITLE_PATTERNS = [
    r"media release",
    r"media announcement",
    r"letter to (?:share|security)\s?holders",
    r"chair(?:man|woman|person)?'?s? letter",
    r"ceo'?s? letter",
    r"letter from the chair",
    r"chair(?:man|woman|person)?'?s? address",
    r"ceo'?s? address",
    r"address to (?:share|security)\s?holders",
    r"agm address",
    r"notice of (?:annual general )?meeting",
    r"notice of agm",
    r"proxy form",
    r"cleansing (?:notice|statement)",
    r"trading halt",
    r"suspension (?:from|of) (?:quotation|trading)",
    r"appendix 3[xyz]",
    r"change (?:of|in) director'?s? interest",
    r"director'?s? interest notice",
    r"(?:becoming|ceasing).{0,30}substantial (?:holder|holding)",
    r"change (?:in|to) substantial holding",
    r"substantial (?:holder|holding) notice",
    r"on-?market buy-?back",
    r"buy-?back (?:notice|booklet)",
]
_NOISE_TITLE_RE = re.compile("|".join(NOISE_TITLE_PATTERNS), re.IGNORECASE)

KEEP_OVERRIDE_PATTERNS = [
    r"appendix 4[de]",
    r"preliminary final report",
    r"annual report",
    r"(?:annual|half[\s-]?year|full[\s-]?year|interim) financial (?:report|statements)",
    r"financial (?:report|statements)",
    r"results announcement",
]
_KEEP_OVERRIDE_RE = re.compile("|".join(KEEP_OVERRIDE_PATTERNS), re.IGNORECASE)


def is_financial_report_title(title: str) -> bool:
    """Legacy noise filter: False for headlines that are clearly NOT a financial
    statement/results document (media releases, letters/addresses, notices of
    meeting, director/holder notices, trading halts, buy-backs). A strong
    statement signal overrides the noise patterns. Empty titles pass.

    Selection no longer uses this; see is_results_document.
    """
    if not title or not title.strip():
        return True
    if _KEEP_OVERRIDE_RE.search(title):
        return True
    return _NOISE_TITLE_RE.search(title) is None


# The statutory-results classifier (extractiontrust.IsResultsDocument, ported
# rule for rule; the shared fixture results_titles.json pins both).
is_results_document = extraction_trust.is_results_document

# Report types (the ASX-announcement crawler's classifyReportType) worth a
# look; quarterlies are deliberately excluded.
KEY_REPORT_TYPES = (
    "annual_results",
    "half_year_results",
    "full_year_results",
    "annual_report",
    "financial_report",
)

# ASX PDF download headers
ASX_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/pdf,*/*",
    "Referer": "https://www.asx.com.au/",
}

DEFAULT_MAX_PAGES = 8


def get_db_connection(autocommit: bool = False):
    """Connect to PostgreSQL.

    autocommit=True for any connection that must not sit idle in a transaction
    (the selection connection, the report workers): psycopg2 otherwise opens a
    transaction on the first statement and holds it until commit, which on the
    selection connection meant a transaction open for the whole run.
    """
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL environment variable required")
        sys.exit(1)
    conn = psycopg2.connect(db_url)
    if autocommit:
        conn.autocommit = True
    return conn


def document_meta_column_exists(conn) -> bool:
    """Whether financial_report_extractions.document_meta exists (migration
    000132). Checked ONCE at start; without it the column is simply not
    written, so the extractor keeps working before the migration lands."""
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = ANY (current_schemas(false))
              AND table_name = 'financial_report_extractions'
              AND column_name = 'document_meta'
            LIMIT 1
            """
        )
        return cur.fetchone() is not None
    finally:
        cur.close()


def _parse_financial_reports(stock_code: str, raw: Optional[str]) -> list[dict]:
    """The asx_announcements key-type statutory results documents in one
    company's financial_reports JSON. Unparseable JSON skips the company."""
    try:
        fin_reports = json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(fin_reports, list):
        return []
    out = []
    for r in fin_reports:
        if not isinstance(r, dict) or r.get("source") != "asx_announcements":
            continue
        rtype = r.get("type", "")
        if rtype not in KEY_REPORT_TYPES:
            continue
        title = r.get("title") or ""
        if not is_results_document(title):
            log.debug("  skip non-results title: %s (%s) %s", stock_code, rtype, title[:80])
            continue
        url = r.get("url") or ""
        if not url:
            continue
        out.append({
            "stock_code": stock_code,
            "url": url,
            "title": title,
            "date": r.get("date") or "",
            "type": rtype,
        })
    return out


def _existing_report_urls(conn, urls: list[str]) -> set[str]:
    if not urls:
        return set()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT report_url FROM financial_report_extractions WHERE report_url = ANY(%s)",
            (urls,),
        )
        return {row[0] for row in cur.fetchall()}
    finally:
        cur.close()


def get_reports_to_process(conn, mode: str, codes: list[str], limit: int, recent: int = 0) -> list[dict]:
    """Unextracted statutory results documents for --mode codes / top50 (manual
    runs). Newest first per company, at most `recent` per company."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    if mode == "codes" and codes:
        placeholders = ",".join(["%s"] * len(codes))
        cur.execute(
            f"""
            SELECT stock_code, financial_reports::text
            FROM "company-metadata"
            WHERE stock_code IN ({placeholders})
              AND financial_reports IS NOT NULL
              AND financial_reports::text != '[]'
              AND financial_reports::text != 'null'
            """,
            codes,
        )
    else:
        cur.execute(
            """
            SELECT cm.stock_code, cm.financial_reports::text
            FROM "company-metadata" cm
            INNER JOIN (
                SELECT product_code
                FROM mv_top_shorts
                ORDER BY current_percent DESC
                LIMIT 50
            ) top ON cm.stock_code = top.product_code
            WHERE cm.financial_reports IS NOT NULL
              AND cm.financial_reports::text != '[]'
              AND cm.financial_reports::text != 'null'
            """
        )
    rows = cur.fetchall()
    cur.close()

    reports = []
    for row in rows:
        reports.extend(_parse_financial_reports(row["stock_code"], row["financial_reports"]))

    reports.sort(key=lambda r: (r["stock_code"], r["date"]), reverse=True)
    if recent > 0:
        company_count: Counter = Counter()
        filtered = []
        for r in reports:
            if company_count[r["stock_code"]] < recent:
                filtered.append(r)
                company_count[r["stock_code"]] += 1
        reports = filtered

    existing = _existing_report_urls(conn, [r["url"] for r in reports])
    reports = [r for r in reports if r["url"] not in existing]
    if limit > 0:
        reports = reports[:limit]
    return reports


# --- Targeting for the scheduled run (contract 6.1) ---------------------------

RECENT_FILING_DAYS = 45

_TIE_PRIMARY_RE = re.compile(
    r"\bappendix\s*4[de]\b|\bpreliminary\s+final\b|\bresults?\s+for\s+announcement\s+to\s+the\s+market\b",
    re.IGNORECASE,
)
_TIE_SECONDARY_RE = re.compile(
    r"\bresults?\s+(?:release|announcement|summary)\b|\bprofit\s+announcement\b|\bfinancial\s+(?:report|statements?)\b"
    r"|\b(?:half[\s-]?year(?:ly)?|interim)\s+(?:financial\s+)?report\b",
    re.IGNORECASE,
)


def _same_day_rank(title: str) -> int:
    """Which of one company's same-day results documents to prefer: the
    Appendix 4D/4E (its results table is on the first pages) before a results
    release or financial report, before an annual report (whose first pages are
    usually letters)."""
    t = extraction_trust.normalise(title)
    if _TIE_PRIMARY_RE.search(t):
        return 0
    if _TIE_SECONDARY_RE.search(t):
        return 1
    if "annual report" in t:
        return 2
    return 3


def _report_day(value: str) -> Optional[_dt.date]:
    try:
        return _dt.date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


def parse_market_cap(*values: Any) -> Optional[float]:
    """The first finite, positive market cap among values (text or numbers:
    key_metrics->>'market_cap', then the market_cap column, whose type differs
    between environments)."""
    for v in values:
        if v is None or isinstance(v, bool):
            continue
        try:
            f = float(str(v).strip().replace(",", ""))
        except ValueError:
            continue
        if math.isfinite(f) and f > 0:
            return f
    return None


def order_extraction_targets(
    candidates: Iterable[dict],
    extracted_urls: set,
    metric_codes: set,
    market_caps: dict,
    today: _dt.date,
    recent: int = 2,
    recent_days: int = RECENT_FILING_DAYS,
) -> list[dict]:
    """The scheduled run's work list: ONE document per company, in this order:

      1. companies whose document's report_date is within `recent_days` of
         `today`, newest first;
      2. then companies with no metric-bearing extraction yet, by market cap;
      3. then the rest, by market cap.

    Market cap ties (and missing market caps, which sort last) break on stock
    code. Per company only its `recent` newest results documents are
    considered (0 = all); already-extracted ones are dropped and the newest
    remaining one is the company's document (same day: the statutory filing
    first, see _same_day_rank). The company's other remaining documents ride
    along, newest first, as its "fallbacks": read_first_available tries them
    in the same run when the document cannot be downloaded, so one bad URL
    never blocks the company's other statutory document. Still at most one
    paid extraction per company per run."""
    by_code: dict[str, list[dict]] = {}
    for r in candidates:
        by_code.setdefault(r["stock_code"], []).append(r)

    chosen = []
    for code, docs in by_code.items():
        # Newest first; same day, the statutory filing first.
        docs = sorted(docs, key=lambda r: _same_day_rank(r["title"]))
        docs.sort(key=lambda r: r["date"] or "", reverse=True)
        if recent > 0:
            docs = docs[:recent]
        remaining = [r for r in docs if r["url"] not in extracted_urls]
        if remaining:
            chosen.append({**remaining[0], "fallbacks": remaining[1:]})

    horizon = today - _dt.timedelta(days=recent_days)

    def key(r: dict):
        mcap = market_caps.get(r["stock_code"])
        mcap_key = -mcap if mcap is not None else math.inf
        day = _report_day(r["date"])
        if day is not None and horizon <= day <= today + _dt.timedelta(days=1):
            return (0, -day.toordinal(), mcap_key, r["stock_code"])
        tier = 1 if r["stock_code"] not in metric_codes else 2
        return (tier, 0, mcap_key, r["stock_code"])

    chosen.sort(key=key)
    return chosen


def select_extraction_targets(conn, recent: int, limit: int, today: Optional[_dt.date] = None) -> list[dict]:
    """The scheduled run's selection (order_extraction_targets over the DB).
    Run it on an autocommit connection: it must leave no transaction open."""
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        cur.execute(
            """
            SELECT stock_code,
                   financial_reports::text AS financial_reports,
                   key_metrics->>'market_cap' AS km_market_cap,
                   market_cap::text AS market_cap_text
            FROM "company-metadata"
            WHERE financial_reports IS NOT NULL
              AND financial_reports::text LIKE '%asx_announcements%'
            """
        )
        rows = cur.fetchall()
        cur.execute(
            """
            SELECT DISTINCT stock_code
            FROM financial_report_extractions
            WHERE metrics IS NOT NULL AND metrics <> '{}'::jsonb
            """
        )
        metric_codes = {row[0] for row in cur.fetchall()}
    finally:
        cur.close()

    candidates: list[dict] = []
    market_caps: dict[str, Optional[float]] = {}
    for row in rows:
        code = row["stock_code"]
        candidates.extend(_parse_financial_reports(code, row["financial_reports"]))
        market_caps[code] = parse_market_cap(row["km_market_cap"], row["market_cap_text"])

    extracted = _existing_report_urls(conn, [r["url"] for r in candidates])
    ordered = order_extraction_targets(candidates, extracted, metric_codes, market_caps, today, recent=recent)
    if limit > 0:
        ordered = ordered[:limit]
    return ordered


def resolve_asx_pdf_url(session: requests.Session, display_url: str) -> Optional[str]:
    """Resolve an ASX displayAnnouncement URL to the actual PDF URL.

    ASX's displayAnnouncement.do shows a terms page with a hidden form field
    containing the real PDF URL at announcements.asx.com.au.
    """
    try:
        resp = session.get(display_url, timeout=15)
        if resp.status_code != 200:
            return None

        # Check if this is already a direct PDF
        if resp.content[:5] == b"%PDF-":
            return display_url

        # Extract the real PDF URL from the hidden form field
        match = re.search(r'name="pdfURL"\s+value="([^"]+)"', resp.text)
        if match:
            return match.group(1)

        return None
    except Exception as e:
        log.debug("  Failed to resolve PDF URL: %s", e)
        return None


# Below this many characters (whitespace stripped) on the pages read, a PDF has
# no text layer: a scanned document, which no rerun will read.
MIN_PDF_TEXT_CHARS = 100

# fetch_pdf_text statuses. FETCH_UNREADABLE is permanent (the same bytes give
# the same text); FETCH_FAILED covers everything that may pass on a rerun
# (resolution, HTTP status, a non-PDF response, a parse error).
FETCH_OK = "ok"
FETCH_UNREADABLE = "no_text"
FETCH_FAILED = "no_pdf"


def fetch_pdf_text(session: requests.Session, url: str, max_pages: int = DEFAULT_MAX_PAGES) -> tuple[Optional[str], str]:
    """Download a PDF from ASX and extract its text: (text, status).

    FETCH_OK: text is the pages read. FETCH_UNREADABLE: the PDF was fetched but
    carries under MIN_PDF_TEXT_CHARS characters (a scanned document); text is
    what little was read, stripped. FETCH_FAILED: text is None.

    If the URL is an ASX displayAnnouncement URL, first resolves to the real
    PDF URL at announcements.asx.com.au.
    """
    try:
        # Resolve the actual PDF URL if needed
        pdf_url = url
        if "displayAnnouncement.do" in url:
            resolved = resolve_asx_pdf_url(session, url)
            if resolved:
                pdf_url = resolved
                log.debug("  Resolved to: %s", pdf_url)
            else:
                log.warning("  Could not resolve PDF URL")
                return None, FETCH_FAILED

        resp = session.get(pdf_url, timeout=60)
        if resp.status_code != 200:
            log.warning("  HTTP %d for %s", resp.status_code, pdf_url)
            return None, FETCH_FAILED

        if resp.content[:5] != b"%PDF-":
            log.warning("  Not a PDF response")
            return None, FETCH_FAILED

        # Extract text with pymupdf
        doc = fitz.open(stream=resp.content, filetype="pdf")
        pages_text = []
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            pages_text.append(page.get_text())
        doc.close()

        text = "\n\n".join(pages_text)
        if len(text.strip()) < MIN_PDF_TEXT_CHARS:
            log.warning("  Very little text extracted (%d chars): no text layer", len(text))
            return text.strip(), FETCH_UNREADABLE

        return text, FETCH_OK

    except Exception as e:
        log.warning("  PDF download/extract failed: %s", e)
        return None, FETCH_FAILED


def download_pdf_text(session: requests.Session, url: str, max_pages: int = DEFAULT_MAX_PAGES) -> Optional[str]:
    """The PDF's text (fetch_pdf_text), or None when it could not be read for
    any reason."""
    text, status = fetch_pdf_text(session, url, max_pages=max_pages)
    return text if status == FETCH_OK else None


def read_first_available(
    session: requests.Session,
    report: dict,
    max_pages: int,
    record_unreadable: Callable[[dict, int], None],
) -> tuple[Optional[dict], Optional[str], str]:
    """The first of `report` and its report["fallbacks"] (the company's next
    unextracted documents, order_extraction_targets) whose PDF yields text:
    (document, text, FETCH_OK).

    A document with no text layer is passed to record_unreadable(document,
    text_length), which writes its marker row, so selection moves past it for
    good. A download that fails otherwise writes nothing: the next run retries
    it. Either way the next fallback is tried in the same run, so one document
    that cannot be read never blocks the company's other statutory document.

    (None, None, status) when none yields text: FETCH_UNREADABLE when a marker
    was written, else FETCH_FAILED."""
    status = FETCH_FAILED
    for i, doc in enumerate([report, *(report.get("fallbacks") or ())]):
        text, fetched = fetch_pdf_text(session, doc["url"], max_pages=max_pages)
        if fetched == FETCH_OK:
            if i:
                log.info("  %s: fell back to %s (%s)", doc["stock_code"], doc["url"], (doc.get("title") or "")[:60])
            return doc, text, FETCH_OK
        if fetched == FETCH_UNREADABLE:
            record_unreadable(doc, len(text or ""))
            status = FETCH_UNREADABLE
    return None, None, status


# --- Grounding (contract 6.1) -------------------------------------------------

# Classes whose whole point is a number. Each must carry a value attribute, and
# every value attribute present must be a number written inside the aligned
# span of the document.
NUMERIC_CLASSES = frozenset({"revenue", "net_profit", "eps", "dividend", "cash_flow", "ebitda"})
VALUE_KEYS = ("value_millions", "value_cents")

EXTRACTION_TEXT_CHARS = 50000

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
# A thousands separator: a comma (or thin / narrow no-break space) between a
# digit and exactly three digits.
_THOUSANDS_SEP_RE = re.compile(r"(?<=\d)[,\u2009\u202F](?=\d{3}(?!\d))")
_PLAIN_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?|\.\d+")


def canonical_number(value: str) -> Optional[str]:
    """A plain decimal spelling of a value attribute, or None when it is not a
    plain number: wrapping brackets, a leading sign, a leading "$" and
    thousands separators removed, insignificant zeros dropped ("3,847" ->
    "3847", "-12.50" -> "12.5", "($612)" -> "612", "0.40" -> "0.4").
    "3.8 billion", "4-6" or "n/a" are not plain numbers."""
    if not isinstance(value, str):
        return None
    t = value.strip()
    if t.startswith("(") and t.endswith(")"):
        t = t[1:-1].strip()
    t = t.lstrip("+-\u2212").strip()
    t = t.lstrip("$").strip()
    t = _THOUSANDS_SEP_RE.sub("", t)
    if not _PLAIN_NUMBER_RE.fullmatch(t):
        return None
    whole, _, frac = t.partition(".")
    whole = whole.lstrip("0") or "0"
    frac = frac.rstrip("0")
    return whole + ("." + frac if frac else "")


def numbers_in(span: str) -> set:
    """Every number written in span, canonical (thousands separators joined)."""
    joined = _THOUSANDS_SEP_RE.sub("", span or "")
    return {canonical_number(m.group(0)) for m in _NUMBER_RE.finditer(joined)}


def value_in_span(value: Any, span: str) -> bool:
    """The value's digits are a number written inside the aligned span. A
    rounded or rescaled value ("5" for "$5.142 billion", "3800" for "$3.8
    billion") is not: withheld rather than guessed."""
    c = canonical_number(value) if isinstance(value, str) else None
    return c is not None and c in numbers_in(span)


def _alignment_value(status: Any) -> Optional[str]:
    v = getattr(status, "value", status)
    return v if isinstance(v, str) else None


def ground_extraction(ext: Any, text: str, denylist: extraction_trust.FewShotDenylist = FEWSHOT_DENYLIST) -> tuple[Optional[dict], str]:
    """(record, reason) for one langextract Extraction against the text it was
    extracted from. record is None unless reason == "kept".

    Reasons: unaligned (no char_interval, an alignment status outside the four
    aligned values, or offsets outside the text), fewshot_echo, no_value (a
    numeric class without a value attribute), value_not_in_span."""
    ci = getattr(ext, "char_interval", None)
    start = getattr(ci, "start_pos", None) if ci is not None else None
    end = getattr(ci, "end_pos", None) if ci is not None else None
    status = _alignment_value(getattr(ext, "alignment_status", None))
    if (
        start is None
        or end is None
        or status not in extraction_trust.ALIGNED_STATUSES
        or not (0 <= int(start) < int(end) <= len(text))
    ):
        return None, "unaligned"
    start, end = int(start), int(end)

    ext_text = getattr(ext, "extraction_text", "") or ""
    if ext_text in denylist:
        return None, "fewshot_echo"

    cls = getattr(ext, "extraction_class", "") or ""
    attrs = dict(getattr(ext, "attributes", None) or {})
    span = text[start:end]
    present = [k for k in VALUE_KEYS if k in attrs]
    if cls in NUMERIC_CLASSES and not present:
        return None, "no_value"
    for k in present:
        if not value_in_span(attrs[k], span):
            return None, "value_not_in_span"

    return {
        "class": cls,
        "text": ext_text,
        "attributes": attrs,
        extraction_trust.KEY_ALIGNMENT: status,
        extraction_trust.KEY_CHAR_START: str(start),
        extraction_trust.KEY_CHAR_END: str(end),
    }, "kept"


def ground_extractions(extractions: Iterable[Any], text: str) -> tuple[list[dict], Counter]:
    """Grounded records for storage, plus a Counter of reasons."""
    kept: list[dict] = []
    reasons: Counter = Counter()
    for ext in extractions or []:
        record, reason = ground_extraction(ext, text)
        reasons[reason] += 1
        if record is not None:
            kept.append(record)
    return kept, reasons


def extract_financial_data(
    text: str,
    stock_code: str,
    model_id: str = "gemini-2.5-flash",
    usage: Optional[TokenUsage] = None,
    model: Any = None,
) -> list[dict]:
    """Grounded financial extractions from report text via langextract.

    The model is a BudgetedGemini (thinking off, tokens summed into `usage`)
    unless a pre-built `model` is passed (tests). Unaligned, echoed or
    value-mismatched extractions are dropped before they are returned, so []
    means the model answered and nothing was grounded.

    Raises ModelError when the model could not answer: any exception out of
    lx.extract (langextract raises InferenceRuntimeError for an API error that
    outlasted its retries, a blocked response or one with no text) or out of
    building the model. One failed chunk fails the document: its other chunks'
    extractions are not stored as if they were the whole document."""
    if len(text) > EXTRACTION_TEXT_CHARS:
        text = text[:EXTRACTION_TEXT_CHARS]

    try:
        if model is None:
            from budgeted_gemini import build_budgeted_model

            model = build_budgeted_model(model_id, EXTRACTION_EXAMPLES, usage=usage)
        result = lx.extract(
            text_or_documents=text,
            prompt_description=EXTRACTION_PROMPT,
            examples=EXTRACTION_EXAMPLES,
            model=model,
            use_schema_constraints=False,  # the model already carries the example schema
            extraction_passes=1,
            max_workers=1,
            max_char_buffer=2000,
            show_progress=False,
        )
    except Exception as e:  # noqa: BLE001 - every failure here is the model's, and none may pass as "nothing grounded"
        raise ModelError(f"langextract failed for {stock_code}: {e}") from e

    raw = list(getattr(result, "extractions", None) or [])
    kept, reasons = ground_extractions(raw, text)
    dropped = {k: v for k, v in reasons.items() if k != "kept"}
    if dropped:
        log.info("  Grounding for %s: kept %d of %d, dropped %s", stock_code, len(kept), len(raw), dropped)
    return kept


def extractions_to_metrics(extractions: list[dict]) -> dict:
    """Convert extraction records to the stored metrics dict: class -> entry, or
    class -> [entries] when a class occurs more than once. An entry is the
    attributes, then source_text, then (for grounded records) the provenance
    string attributes alignment / char_start / char_end."""
    metrics: dict = {}
    for ext in extractions:
        cls = ext["class"]
        attrs = ext.get("attributes") or {}
        entry = {
            k: v
            for k, v in attrs.items()
            if k != extraction_trust.KEY_SOURCE_TEXT and not extraction_trust.is_provenance_key(k)
        }
        entry[extraction_trust.KEY_SOURCE_TEXT] = ext["text"]
        for k in (extraction_trust.KEY_ALIGNMENT, extraction_trust.KEY_CHAR_START, extraction_trust.KEY_CHAR_END):
            if k in ext:
                entry[k] = str(ext[k])
        if cls in metrics:
            # Keep both if there are multiple (e.g., multiple revenue figures)
            if isinstance(metrics[cls], list):
                metrics[cls].append(entry)
            else:
                metrics[cls] = [metrics[cls], entry]
        else:
            metrics[cls] = entry

    return metrics


DIGEST_MODEL = "gemini-2.5-flash"

# §6.3(b) The digest is generated from raw report text even when langextract finds
# no structured metric table (most "results presentations" lack a clean table but
# still state the headline numbers in prose). Give the model a wider text window so
# it can find figures on its own, and tell it how to behave when metrics are empty.
DIGEST_TEXT_CHARS = 16000
MIN_DIGEST_CHARS = 400  # below this the PDF text is too thin to summarise meaningfully

DIGEST_PROMPT = """You are summarising an ASX-listed company's financial report or results document for a retail investor.
In 2-3 plain-English sentences, lead with the headline result (revenue and net profit direction with % change),
then the dividend, then any guidance. Be concrete with the numbers.
Prefer the figures in the extracted metrics JSON when present. If the metrics JSON is empty, read the figures
directly from the report text excerpt. If the document states no financial results at all (e.g. it is a cover
note or administrative document), set confidence below 0.3 and concisely summarise what the document covers.
Output STRICT JSON: {"digest": "...", "confidence": 0.0-1.0, "key_takeaways": ["...", "..."]}"""


def digest_config(genai_types: Any) -> Any:
    """The digest call's GenerateContentConfig: thinking off, like the
    extraction calls."""
    return genai_types.GenerateContentConfig(
        system_instruction=DIGEST_PROMPT,
        temperature=0.2,
        thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
    )


def summarize_report(
    metrics: dict,
    page_text: str,
    model_id: str = DIGEST_MODEL,
    usage: Optional[TokenUsage] = None,
    client: Any = None,
) -> dict:
    """Generate a plain-English digest of the financial report using a single Gemini call.

    The metrics the prompt sees pass the trust funnel first: entries that are
    not grounded (unaligned, or a few-shot echo stored by an older run) are
    dropped and the provenance keys are stripped. Thinking is off and the
    response's usage_metadata is added to `usage`.

    Returns a dict with keys: digest (str), confidence (float), key_takeaways (list[str]).
    When the model answered but not with the JSON asked for, returns
    digest="" confidence=0.0 key_takeaways=[].

    Raises ModelError when the model could not answer: the API call failed,
    the response was blocked or carried no text, or there is no SDK or key to
    call it with. An empty digest is never returned for a call that did not
    happen.
    """
    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError as e:
        raise ModelError(f"google-genai is not available: {e}") from e

    if client is None:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY")
        if not api_key:
            raise ModelError("no GEMINI_API_KEY / LANGEXTRACT_API_KEY set for the digest call")
    else:
        api_key = None

    prompt_metrics = extraction_trust.trusted_metrics(metrics, FEWSHOT_DENYLIST)
    metrics_json = json.dumps(prompt_metrics, indent=2)
    # Limit page text to stay within token budget (wider window when there are no
    # structured metrics, since the model must find the figures in prose itself).
    truncated_text = page_text[:DIGEST_TEXT_CHARS] if page_text else ""

    user_content = (
        f"## Extracted metrics (JSON)\n{metrics_json}\n\n"
        f"## Report text excerpt\n{truncated_text}"
    )

    try:
        if client is None:
            client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=model_id,
            contents=user_content,
            config=digest_config(genai_types),
        )
    except Exception as e:  # noqa: BLE001 - any API failure is a model error
        raise ModelError(f"digest call failed: {e}") from e
    # A response that is then rejected (blocked, no text) was still billed.
    if usage is not None:
        usage.add(getattr(response, "usage_metadata", None))
    try:
        raw = (response.text or "").strip()
    except Exception as e:  # noqa: BLE001 - an SDK that cannot read its own response
        raise ModelError(f"digest response unreadable: {e}") from e
    if not raw:
        raise ModelError("digest response carried no text (blocked or empty)")

    return parse_digest(raw)


def parse_digest(raw: str) -> dict:
    """The digest dict from a model's answer text; an empty digest (confidence
    0) when the answer is not the JSON asked for."""
    # Strip markdown fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw or "")
    raw = re.sub(r"\s*```$", "", raw)
    raw = raw.strip()

    try:
        parsed = json.loads(raw)
        return {
            "digest": str(parsed.get("digest", "")),
            "confidence": float(parsed.get("confidence", 0.0)),
            "key_takeaways": list(parsed.get("key_takeaways", [])),
        }
    except (ValueError, TypeError, AttributeError) as e:
        log.warning("  Digest JSON parse failed: %s (raw: %.200s)", e, raw)
        return {"digest": "", "confidence": 0.0, "key_takeaways": []}


def summarize_report_openrouter(
    metrics: dict,
    page_text: str,
    client: Any,
    model_id: str,
    usage: Optional[TokenUsage] = None,
) -> dict:
    """summarize_report through OpenRouter (direct_extract.OpenRouter): the
    same prompt, trust funnel, text window and output contract. Raises
    ModelError when the model could not answer."""
    import direct_extract

    prompt_metrics = extraction_trust.trusted_metrics(metrics, FEWSHOT_DENYLIST)
    truncated_text = page_text[:DIGEST_TEXT_CHARS] if page_text else ""
    try:
        raw = direct_extract.summarize(
            client, model_id, DIGEST_PROMPT, json.dumps(prompt_metrics, indent=2), truncated_text, usage=usage
        )
    except direct_extract.ModelCallError as e:
        raise ModelError(f"digest call failed: {e}") from e
    return parse_digest(raw)


def upload_raw_text_to_gcs(stock_code: str, report_url: str, text: str) -> Optional[str]:
    """Upload raw page text to GCS and return the gs:// URI.

    Bucket: shorted-financial-reports-prod (from env GCS_REPORTS_BUCKET or default).
    Object path: digests/<stock_code>/<sha1-of-report_url>.txt

    Returns the gs:// URI on success, None on failure (best-effort; never raises).
    """
    bucket_name = os.environ.get("GCS_REPORTS_BUCKET", "shorted-financial-reports-prod")
    url_sha1 = hashlib.sha1(report_url.encode()).hexdigest()
    blob_path = f"digests/{stock_code}/{url_sha1}.txt"
    gcs_uri = f"gs://{bucket_name}/{blob_path}"

    try:
        from google.cloud import storage as gcs
        client = gcs.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(text, content_type="text/plain; charset=utf-8")
        log.info("  Uploaded raw text to %s", gcs_uri)
        return gcs_uri
    except Exception as e:
        log.warning("  GCS upload failed (non-fatal): %s", e)
        return None


def download_text_from_gcs(gcs_uri: str) -> Optional[str]:
    """Fetch previously-stored raw page text from a gs:// URI (written by
    upload_raw_text_to_gcs). Used by the digest backfill so it can re-summarise
    existing rows without re-downloading the PDF (older 2024 ASX announcement
    URLs no longer resolve). Returns None on any failure.
    """
    if not gcs_uri or not gcs_uri.startswith("gs://"):
        return None
    try:
        from google.cloud import storage as gcs
        without_scheme = gcs_uri[len("gs://"):]
        bucket_name, _, blob_path = without_scheme.partition("/")
        if not bucket_name or not blob_path:
            return None
        client = gcs.Client()
        blob = client.bucket(bucket_name).blob(blob_path)
        text = blob.download_as_text()
        return text if text and text.strip() else None
    except Exception as e:  # noqa: BLE001
        log.debug("  GCS text fetch failed for %s: %s", gcs_uri, e)
        return None


def store_extraction(
    conn,
    report: dict,
    metrics: dict,
    raw_text_length: int,
    dry_run: bool = False,
    digest_result: Optional[dict] = None,
    raw_text_gcs_url: Optional[str] = None,
    document_meta: Optional[dict] = None,
    write_document_meta: bool = False,
):
    """Store extraction results in the database (one statement, committed).

    document_meta is written only when write_document_meta is True (the
    column exists; see document_meta_column_exists) and a meta dict was
    computed. On conflict the fresh computation replaces the stored one.
    """
    if dry_run:
        log.info("  [DRY RUN] Would store %d metrics for %s", len(metrics), report["stock_code"])
        if digest_result:
            log.info("  [DRY RUN] Digest: %.120s", digest_result.get("digest", ""))
        if document_meta is not None:
            log.info("  [DRY RUN] document_meta: %s", json.dumps(document_meta))
        return

    dr = digest_result or {}
    columns = [
        "stock_code", "report_url", "report_type", "report_title", "report_date",
        "metrics", "raw_text_length", "extracted_at",
        "digest", "digest_confidence", "digest_model", "raw_text_gcs_url",
    ]
    values = [
        report["stock_code"],
        report["url"],
        report["type"],
        report["title"],
        report["date"] or None,
        json.dumps(metrics),
        raw_text_length,
        datetime.utcnow(),
        dr.get("digest") or None,
        # Only persist confidence alongside an actual digest; a 0.0 from a failed
        # digest call must stay NULL so it isn't confused with a genuine low-confidence one.
        dr.get("confidence") if (dr.get("digest") and dr.get("confidence") is not None) else None,
        DIGEST_MODEL if dr.get("digest") else None,
        raw_text_gcs_url,
    ]
    updates = [
        "metrics", "raw_text_length", "extracted_at",
        "digest", "digest_confidence", "digest_model", "raw_text_gcs_url",
    ]
    if write_document_meta and document_meta is not None:
        columns.append("document_meta")
        values.append(json.dumps(document_meta))
        updates.append("document_meta")

    sql = (
        "INSERT INTO financial_report_extractions ("
        + ", ".join(columns)
        + ") VALUES ("
        + ", ".join(["%s"] * len(columns))
        + ") ON CONFLICT (report_url) DO UPDATE SET "
        + ", ".join(f"{c} = EXCLUDED.{c}" for c in updates)
    )
    cur = conn.cursor()
    try:
        cur.execute(sql, values)
    finally:
        cur.close()
    if not conn.autocommit:
        conn.commit()


def store_unreadable(conn, report: dict, text_length: int, dry_run: bool = False):
    """The marker row for a document whose PDF has no text layer (fetch_pdf_text
    FETCH_UNREADABLE, a scanned document): metrics '{}', no digest, no
    document_meta, raw_text_length the few characters read. That length is
    always under MIN_PDF_TEXT_CHARS, which no extracted row can have, so it is
    what marks the row. Selection skips any URL with a row, so the company's
    next document is chosen from now on; the digest backfill skips markers.
    Delete the row to try the document again (for example once the PDF is
    re-lodged with text)."""
    log.warning("  %s: %s has no text layer; recording it as unreadable", report["stock_code"], report["url"])
    store_extraction(conn, report, {}, text_length, dry_run)


def ensure_table(conn):
    """Create the extraction results table if it doesn't exist."""
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS financial_report_extractions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            stock_code VARCHAR(50) NOT NULL,
            report_url TEXT NOT NULL UNIQUE,
            report_type VARCHAR(50),
            report_title TEXT,
            report_date DATE,
            metrics JSONB NOT NULL DEFAULT '{}',
            raw_text_length INTEGER,
            extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fre_stock_code ON financial_report_extractions(stock_code);
        CREATE INDEX IF NOT EXISTS idx_fre_report_date ON financial_report_extractions(report_date DESC);
        CREATE INDEX IF NOT EXISTS idx_fre_report_type ON financial_report_extractions(report_type);
        """
    )
    conn.commit()
    cur.close()


def process_report_text(
    report: dict,
    text: str,
    model_id: str,
    usage: Optional[TokenUsage] = None,
    model: Any = None,
    digest_client: Any = None,
    direct: Any = None,
) -> tuple[dict, Optional[dict], dict, str]:
    """Everything the model and the regexes produce for one downloaded report:
    (metrics, digest_result, document_meta, outcome). No database access, so
    no connection is involved while the model runs. outcome is ok /
    digest_only / no_metrics / digest_error.

    Raises ModelError when the model failed and nothing trustworthy is left to
    store: the extraction call failed, or it grounded nothing and the digest
    call failed too. The caller must then write no row, so the next run
    retries the document. When metrics were grounded but the digest call
    failed, the outcome is digest_error: the metrics are returned with digest
    None, stored with digest NULL, and --backfill-digests summarises them
    later.

    direct: a direct_extract.DirectExtractor. When given, the metrics come from
    one validated call per document with consensus (direct_extract) instead of
    langextract, and the digest goes through the same OpenRouter client and
    primary model."""
    meta = extract_document_meta(text)
    if direct is not None:
        import direct_extract

        try:
            extractions = direct.extract(text[:EXTRACTION_TEXT_CHARS], report["stock_code"], usage=usage)
        except direct_extract.ModelCallError as e:
            raise ModelError(f"direct extraction failed for {report['stock_code']}: {e}") from e
    else:
        extractions = extract_financial_data(text, report["stock_code"], model_id=model_id, usage=usage, model=model)
    metrics = extractions_to_metrics(extractions) if extractions else {}
    if metrics:
        log.info("  %s: %d metric types: %s", report["stock_code"], len(metrics), ", ".join(metrics.keys()))
    elif len(text) < MIN_DIGEST_CHARS:
        return {}, None, meta, "no_metrics"
    # §6.3(b) Decouple the digest from metric extraction: with no metrics still
    # summarise from raw text (most results documents state numbers in prose).
    try:
        if direct is not None:
            digest = summarize_report_openrouter(metrics, text, direct.client, direct.primary, usage=usage)
        else:
            digest = summarize_report(metrics, text, model_id=model_id, usage=usage, client=digest_client)
    except ModelError as e:
        if not metrics:
            raise
        log.warning("  %s: digest failed (%s); storing the metrics with no digest for --backfill-digests",
                    report["stock_code"], e)
        return metrics, None, meta, "digest_error"
    if not metrics:
        return {}, digest, meta, ("digest_only" if digest.get("digest") else "no_metrics")
    return metrics, digest, meta, "ok"


def main():
    parser = argparse.ArgumentParser(description="Extract financial data from ASX reports using langextract")
    parser.add_argument("--mode", choices=["top50", "codes", "all"], default="top50")
    parser.add_argument("--codes", type=str, default="", help="Comma-separated stock codes")
    parser.add_argument("--limit", type=int, default=0, help="Max total reports to process (0=unlimited)")
    parser.add_argument("--recent", type=int, default=0, help="Max reports per company considered (0=unlimited, e.g. 2=latest annual+half-year)")
    parser.add_argument("--model", type=str, default="gemini-2.5-flash", help="LLM model ID")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between PDF downloads (seconds)")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Max PDF pages to extract text from")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to database")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    original_limit = args.limit
    args.limit, _ = resolve_gemini_run_budget(
        limit=args.limit,
        workers=1,
        default_max_items=10,
        default_max_workers=1,
    )
    if args.limit != original_limit:
        log.warning("Gemini run budget capped --limit from %s to %s", original_limit, args.limit)

    codes = [c.strip().upper() for c in args.codes.split(",") if c.strip()] if args.codes else []
    mode = "codes" if codes else args.mode

    # Autocommit: selection and every write are single statements, and no
    # transaction may stay open across a PDF download or a model call.
    conn = get_db_connection(autocommit=True)
    write_meta = document_meta_column_exists(conn)
    if not write_meta:
        log.warning("financial_report_extractions.document_meta is absent (migration 000132); not writing it this run")

    if mode == "all":
        reports = select_extraction_targets(conn, recent=args.recent or 2, limit=args.limit)
    else:
        reports = get_reports_to_process(conn, mode, codes, args.limit, recent=args.recent)
    log.info("Found %d reports to process (mode=%s)", len(reports), mode)

    if not reports:
        log.info("Nothing to process")
        conn.close()
        return

    # Create a shared HTTP session for PDF downloads
    session = requests.Session()
    session.headers.update(ASX_HEADERS)

    run_usage = TokenUsage()
    counts: Counter = Counter()
    consecutive_model_errors = 0

    def record_unreadable(doc: dict, text_length: int) -> None:
        store_unreadable(conn, doc, text_length, args.dry_run)

    for i, report in enumerate(reports):
        if i > 0:
            time.sleep(args.delay)

        log.info(
            "[%d/%d] %s: %s (%s)",
            i + 1,
            len(reports),
            report["stock_code"],
            report["title"][:60],
            report["type"],
        )
        started = time.monotonic()
        report_usage = TokenUsage(parent=run_usage)

        doc, text, fetched = read_first_available(session, report, args.max_pages, record_unreadable)
        if text is None:
            counts[fetched] += 1
            continue
        log.info("  Extracted %d chars of text", len(text))

        try:
            metrics, digest, meta, outcome = process_report_text(doc, text, args.model, usage=report_usage)
        except ModelError as e:
            counts[MODEL_ERROR] += 1
            consecutive_model_errors += 1
            log.warning("  %s: model error, not stored (the next run retries it): %s", doc["stock_code"], e)
            if consecutive_model_errors >= MAX_CONSECUTIVE_MODEL_ERRORS:
                log.error("%d consecutive model errors: stopping; %d reports not started",
                          consecutive_model_errors, len(reports) - i - 1)
                break
            continue
        consecutive_model_errors = 0
        raw_text_gcs_url = upload_raw_text_to_gcs(doc["stock_code"], doc["url"], text)
        store_extraction(
            conn, doc, metrics, len(text), args.dry_run,
            digest_result=digest, raw_text_gcs_url=raw_text_gcs_url,
            document_meta=meta, write_document_meta=write_meta,
        )
        counts[outcome] += 1
        log.info(
            "  %s done in %.1fs (%s) tokens: %s",
            doc["stock_code"], time.monotonic() - started, outcome, report_usage.summary(),
        )

    log.info("Done! %s", dict(counts))
    log.info("Gemini tokens this run: %s", run_usage.summary())
    conn.close()
    if counts[MODEL_ERROR]:
        log.error("%d model errors: those documents were not stored and the next run retries them", counts[MODEL_ERROR])
        sys.exit(1)


if __name__ == "__main__":
    main()
