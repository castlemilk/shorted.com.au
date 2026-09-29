"""Direct extraction: one model call per document, validated, with consensus.

Replaces langextract's chunked extraction for the financial-report job.
Measured 2026-09-29 (PR #658, bench_gold.py) on 16 results filings, scoring the
revenue / NPAT / EPS the picks job reads against verified reference answers:
langextract + gemini-2.5-flash found 56-59% of them with 10 wrong values; one
call per document with the whole text found 94-100%. langextract re-sends the
prompt and example with every 2,000-char chunk (2.5x the input tokens) and
loses a figure whenever its label and number fall in different chunks.

Pipeline for one document:

  1. PRIMARY (deepseek/deepseek-v4-flash via OpenRouter) and CHECKER (the
     cheapest Gemini, google/gemini-2.5-flash-lite) each answer the same strict
     JSON prompt independently.
  2. Every figure either model returns is VALIDATED here, deterministically
     (validate_figure): its quote must be found in the document (which gives
     the char offsets stored as provenance), its value must be a number
     written inside that quote, its unit must be one we can scale, and it must
     not be the old few-shot example. What fails is dropped and counted.
  3. CONSENSUS per figure (reconcile): a primary figure the checker confirms
     (same metric, same value after unit normalisation) is stored. When they
     disagree, an ARBITER (google/gemini-2.5-flash) answers the same prompt and
     the value two of three models agree on is stored; with no majority the
     figure is WITHHELD — "withhold rather than guess", the rule every
     published number here follows. A figure only the primary found is stored
     as primary_only unless --strict-consensus.

Stored shape is unchanged (extract.extractions_to_metrics): class ->
{value_millions | value_cents | value_dollars, period, source_text,
alignment, char_start, char_end, ...}. Two things are now RIGHT that the
langextract path got wrong for whole-dollar and thousands filings:
value_millions is in millions (the picks job checks it against the quote's
own scale: filings_values.go filingMoney), and per-share figures written in
dollars are stored as value_dollars. New attributes: unit (as written), basis
(statutory / underlying), consensus (agree / majority / primary_only) and
models.

Transport is plain HTTPS via requests (already a dependency). Every response's
token counts and OpenRouter's billed cost go into the run's TokenUsage.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import requests

import extraction_trust
from token_usage import TokenUsage

log = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
PRIMARY_MODEL = "deepseek/deepseek-v4-flash"
CHECKER_MODEL = "google/gemini-2.5-flash-lite"
ARBITER_MODEL = "google/gemini-2.5-flash"

# Same text window the langextract path used (extract.EXTRACTION_TEXT_CHARS).
TEXT_CHARS = 50000

MONEY_METRICS = ("revenue", "net_profit", "ebitda", "operating_cash_flow")
PER_SHARE_METRICS = ("eps", "dividend")
METRICS = MONEY_METRICS + PER_SHARE_METRICS

# Stored class for each prompt metric. cash_flow is the stored vocabulary's
# name for operating cash flow (extract.EXTRACTION_EXAMPLES).
STORED_CLASS = {"operating_cash_flow": "cash_flow"}

MONEY_UNITS = {"dollars": 1e-6, "thousands": 1e-3, "millions": 1.0, "billions": 1e3}
PER_SHARE_UNITS = ("cents", "dollars")

# Values within this relative tolerance are the same figure (a "$25.0m"
# headline and a 25,040 thousand table line).
SAME_FIGURE_TOLERANCE = 0.005

SYSTEM_PROMPT = """You extract reported financial figures from ASX company filings for a database that publishes them. A wrong number is far worse than a missing one.

Return ONLY a JSON object:
{
  "document": {
    "is_results_document": true | false,
    "company": "company name as written",
    "period": "the document's own reporting period, e.g. 'full year ended 30 June 2026' or 'half-year ended 31 December 2025'",
    "currency": "ISO code of the reporting currency, e.g. AUD, USD",
    "reporting_unit": "dollars" | "thousands" | "millions" | "billions" | null
  },
  "figures": [
    {
      "metric": "revenue" | "net_profit" | "eps" | "dividend" | "ebitda" | "operating_cash_flow",
      "value": "the number EXACTLY as written in the quote: digits, decimal point and thousands separators only; prefix '-' when it is a loss, an outflow or a negative per-share amount",
      "unit": "dollars" | "thousands" | "millions" | "billions" for money; "cents" | "dollars" for eps and dividend,
      "basis": "statutory" | "underlying",
      "period": "the period this figure is for, same form as document.period",
      "quote": "a SHORT verbatim excerpt copied character-for-character from the text: the label and the number together (at most ~200 characters). For a table row, the row label and the number, plus the column heading that states the unit if the row does not."
    }
  ]
}

Rules — every figure must satisfy all of them, otherwise leave it out:
1. The WHOLE GROUP only. Never a segment, division, brand, region, joint venture or per-asset figure.
2. The document's OWN, most recent period only. Never a prior-period comparative ('pcp', '2025' column in a 2026 report), a forecast, guidance or a pro-forma.
3. Stated in the text. Never calculate, add up, annualise or infer a figure.
4. revenue: statutory revenue (or total revenue / revenue from ordinary activities). Not 'sales' of one segment, not gross profit, not 'other income'.
5. net_profit: statutory net profit (or loss) after tax attributable to members (owners) of the parent. Not EBIT, EBITDA, profit before tax, 'profit from operations', total comprehensive income, or an underlying / normalised / pro-forma figure (give those only with basis 'underlying'). A loss is negative.
6. eps: basic earnings per share for the period; a diluted EPS may be given as a second eps figure whose quote says 'diluted'. A loss per share is negative.
7. dividend: dividends per share declared for the period (one figure per dividend; interim and final are separate figures).
8. ebitda and operating_cash_flow: include only when stated; mark basis 'underlying' when the text says underlying, normalised or adjusted.
9. unit must be what the text says: a table headed $'000 is thousands; '$8,927,346' is dollars; '$45.2m' is millions; '12.5c' or '12.5 cents' is cents; '$0.125 per share' is dollars.
10. If the document is not a statement of financial results (a notice, a cover letter, an NTA update, a presentation with no results), set is_results_document false and return no figures.
11. At most one figure per metric and basis, except dividend.
"""


class ModelCallError(Exception):
    """A model call that could not produce an answer (HTTP error after
    retries, blocked or empty response)."""


# --- transport -------------------------------------------------------------


@dataclass
class OpenRouter:
    """Thread-safe OpenRouter chat client. One requests.Session per thread."""

    api_key: str
    timeout: float = 180.0
    max_attempts: int = 5
    referer: str = "https://shorted.com.au"
    title: str = "shorted-report-extractor"
    _tl: threading.local = field(default_factory=threading.local, repr=False)
    # Models that refused reasoning OFF and were switched to effort=minimal.
    _min_reasoning: set = field(default_factory=set, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _session(self) -> requests.Session:
        s = getattr(self._tl, "session", None)
        if s is None:
            s = requests.Session()
            self._tl.session = s
        return s

    def chat(self, model: str, system: str, user: str, usage: Optional[TokenUsage] = None,
             temperature: float = 0.0) -> str:
        """The assistant message content. Raises ModelCallError."""
        with self._lock:
            reasoning = {"effort": "minimal"} if model in self._min_reasoning else {"enabled": False}
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "reasoning": reasoning,
            "usage": {"include": True},
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": self.referer,
            "X-Title": self.title,
        }
        last = ""
        for attempt in range(self.max_attempts):
            try:
                resp = self._session().post(OPENROUTER_URL, json=body, headers=headers, timeout=self.timeout)
            except requests.RequestException as e:
                last = f"transport: {type(e).__name__}"
                time.sleep(min(2 ** attempt, 20))
                continue
            if resp.status_code == 200:
                try:
                    data = resp.json()
                except ValueError:
                    last = "non-JSON response body"
                    time.sleep(min(2 ** attempt, 20))
                    continue
                if usage is not None:
                    usage.add_openai(data.get("usage"))
                if data.get("error"):
                    last = f"provider error: {str(data['error'])[:200]}"
                    time.sleep(min(2 ** attempt, 20))
                    continue
                try:
                    content = data["choices"][0]["message"]["content"] or ""
                except (KeyError, IndexError, TypeError):
                    content = ""
                if not content.strip():
                    last = "empty response"
                    time.sleep(min(2 ** attempt, 20))
                    continue
                return content
            text = resp.text[:300]
            if resp.status_code == 400 and "reasoning" in text.lower() and "mandatory" in text.lower():
                # This model cannot run with reasoning off: use the least it allows.
                with self._lock:
                    self._min_reasoning.add(model)
                body["reasoning"] = {"effort": "minimal"}
                continue
            last = f"HTTP {resp.status_code}: {text}"
            if resp.status_code in (401, 402, 403):
                break  # a key or credit problem: retrying cannot help
            if resp.status_code in (408, 429) or resp.status_code >= 500:
                time.sleep(min(5 * (attempt + 1), 30))
                continue
            break
        raise ModelCallError(f"{model}: {last}")


# --- validation --------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
_COMPREHENSIVE_RE = re.compile(r"comprehensive", re.IGNORECASE)
_DILUTED_RE = re.compile(r"\bdiluted\b", re.IGNORECASE)
_BASIC_RE = re.compile(r"\bbasic\b", re.IGNORECASE)

# Figures the picks job reads (filingMetricClasses): an underlying reading of
# one of these is stored under its own class so it can never be taken for the
# statutory figure (fundamentals-coverage gate 5 is the second line of defence).
PICKS_METRICS = ("revenue", "net_profit", "eps")
_NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?|\.\d+")


def canonical(value: str) -> Optional[str]:
    """Plain decimal spelling of a number string with sign, $, thousands
    separators and insignificant zeros removed; None when not a number."""
    t = (value or "").strip().replace(",", "").replace("$", "").replace(" ", "")
    t = t.strip("()").lstrip("+-−")
    if not re.fullmatch(r"\d+(?:\.\d+)?|\.\d+", t):
        return None
    if "." in t:
        t = t.rstrip("0").rstrip(".")
    t = t.lstrip("0") or "0"
    if t.startswith("."):
        t = "0" + t
    return t


def numbers_in(span: str) -> set[str]:
    return {c for c in (canonical(m.group(0)) for m in _NUM_RE.finditer(span or "")) if c}


def locate(quote: str, text: str) -> Optional[tuple[int, int, str]]:
    """(start, end, alignment) of quote in text. Exact first; then allowing any
    run of whitespace in either to match any run in the other (PDF text breaks
    lines inside table rows), which is reported as match_fuzzy. None when the
    quote is not in the document."""
    q = (quote or "").strip()
    if len(q) < 4:
        return None
    i = text.find(q)
    if i >= 0:
        return i, i + len(q), "match_exact"
    parts = [re.escape(p) for p in _WS_RE.split(q) if p]
    if not parts:
        return None
    m = re.search(r"\s*".join(parts), text)
    if m:
        return m.start(), m.end(), "match_fuzzy"
    return None


_LABEL_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’]+")
LABEL_WINDOW = 300  # max chars between a table row's label and its figure


def locate_gapped(quote: str, value: str, text: str) -> Optional[tuple[int, int, str]]:
    """Fallback for table rows quoted with columns skipped ("Revenue ... 25,040")
    or label and number reversed ("77.9¢ EARNINGS PER SHARE"): the value, spelled
    exactly as in the quote, must occur in the document with the quote's first
    label words (in order) within LABEL_WINDOW chars before or after it. The
    stored span is the DOCUMENT's text from label to number, never the model's
    paraphrase. Reported as match_lesser (a partial alignment)."""
    spelled = next((m.group(0) for m in _NUM_RE.finditer(quote or "") if canonical(m.group(0)) == canonical(value)), None)
    words = [w for w in _LABEL_WORD_RE.findall(re.sub(r"\.{2,}|…", " ", quote or "")) if len(w) >= 3][:3]
    if spelled is None or not words:
        return None
    label_re = re.compile(r"\W+(?:\w+\W+){0,2}".join(re.escape(w) for w in words), re.IGNORECASE)
    best = None
    for m in re.finditer(r"(?<![\d.,])" + re.escape(spelled) + r"(?![\d])", text):
        lo, hi = max(0, m.start() - LABEL_WINDOW), min(len(text), m.end() + LABEL_WINDOW)
        for lm in label_re.finditer(text, lo, hi):
            start, end = min(lm.start(), m.start()), max(lm.end(), m.end())
            if best is None or end - start < best[1] - best[0]:
                best = (start, end)
    return (best[0], best[1], "match_lesser") if best else None


# The words a figure's own quote must contain for its metric: a deterministic
# check that the model filed the number under the right label (an NTA "per
# unit" is not net profit; "Operating profit" is not revenue).
LABEL_REQUIRED = {
    "revenue": re.compile(r"revenue|sales|turnover|income", re.IGNORECASE),
    "net_profit": re.compile(r"profit|loss|npat|earnings|result", re.IGNORECASE),
    "eps": re.compile(r"earnings|eps|loss\s+per|per\s+share|per\s+security|cps", re.IGNORECASE),
    "dividend": re.compile(r"dividend|distribution|dps", re.IGNORECASE),
    "ebitda": re.compile(r"ebitda", re.IGNORECASE),
    "operating_cash_flow": re.compile(r"cash", re.IGNORECASE),
}
LABEL_FORBIDDEN = {
    "revenue": re.compile(r"other\s+income|gross\s+profit|\bprofit\b", re.IGNORECASE),
    "net_profit": re.compile(r"before\s+tax|\bpbt\b|\bebit|operating\s+profit|gross\s+profit", re.IGNORECASE),
    "eps": re.compile(r"\bnta\b|net\s+tangible|\bnav\b", re.IGNORECASE),
}


# Table unit headings, exactly as the picks job recognises them
# (services/jobs/internal/jobs/picks/filings_values.go millionsMarkerRe /
# thousandsMarkerRe). Go RE2 and Python agree on this syntax.
MILLIONS_MARKER_RE = re.compile(r"\$\s?m\b|\$\s?million\b|\(\s?\$?m\s?\)|\$['’]?m\b|\bm\$|\bin millions\b", re.IGNORECASE)
THOUSANDS_MARKER_RE = re.compile(r"\$\s?['’]?000\b|\$000s?\b|\bin thousands\b|\(\s?\$?['’]000\s?\)", re.IGNORECASE)
_SCALE_AFTER_RE = re.compile(r"^\s*(?:billion|bn|b|million|mn|mill|m|thousand|k)\b", re.IGNORECASE)
HEADING_LOOKBACK = 400  # how far above a table row its unit heading may sit


def widen_to_heading(start: int, end: int, text: str, unit: str) -> tuple[int, int, bool]:
    """A bare table figure ("Revenue ... 63.4") carries no scale, and the picks
    job rightly withholds a figure whose scale it cannot read from its own
    quote. When the table's unit heading ("$m", "$'000") sits within
    HEADING_LOOKBACK chars above the row, say the same unit the model
    reported, and no other heading intervenes, extend the stored span back to
    include it. The span stays contiguous document text; nothing is invented.
    Returns (start, end, widened)."""
    marker = {"millions": MILLIONS_MARKER_RE, "thousands": THOUSANDS_MARKER_RE}.get(unit)
    span = text[start:end]
    if marker is None or MILLIONS_MARKER_RE.search(span) or THOUSANDS_MARKER_RE.search(span):
        return start, end, False
    lo = max(0, start - HEADING_LOOKBACK)
    window = text[lo:start]
    hits = list(marker.finditer(window))
    other = THOUSANDS_MARKER_RE if unit == "millions" else MILLIONS_MARKER_RE
    if not hits:
        return start, end, False
    last = hits[-1]
    if any(o.start() > last.start() for o in other.finditer(window)):
        return start, end, False  # a nearer heading says the other unit
    return lo + last.start(), end, True


@dataclass
class Figure:
    """One validated figure, ready to store or compare."""

    metric: str
    value_written: str      # as written, signed ("-39.4", "8927346")
    unit: str
    basis: str
    period: str
    quote: str              # the document's own text at [start, end)
    start: int
    end: int
    alignment: str
    model: str

    @property
    def negative(self) -> bool:
        return self.value_written.startswith("-")

    def normalised(self) -> float:
        """Millions for money, cents for per-share figures; signed."""
        v = float(canonical(self.value_written) or 0)
        v = -v if self.negative else v
        if self.metric in MONEY_METRICS:
            return v * MONEY_UNITS[self.unit]
        return v * 100 if self.unit == "dollars" else v

    @property
    def diluted(self) -> bool:
        return self.metric == "eps" and bool(_DILUTED_RE.search(self.quote)) and not _BASIC_RE.search(self.quote)

    def key(self) -> tuple[str, str, bool]:
        return self.metric, self.basis, self.diluted

    def stored_class(self) -> str:
        if self.metric in PICKS_METRICS and self.basis == "underlying":
            return f"underlying_{self.metric}"
        if self.diluted:
            return "diluted_eps"
        return STORED_CLASS.get(self.metric, self.metric)

    def to_record(self, consensus: str, models: list[str]) -> dict:
        attrs: dict[str, str] = {"period": self.period, "unit": self.unit, "basis": self.basis,
                                 "consensus": consensus, "models": ",".join(models)}
        if self.metric in MONEY_METRICS:
            attrs["value_millions"] = _fmt(self.normalised())
        elif self.unit == "dollars":
            attrs["value_dollars"] = _fmt(self.normalised() / 100)
        else:
            attrs["value_cents"] = _fmt(self.normalised())
        return {
            "class": self.stored_class(),
            "text": self.quote,
            "attributes": attrs,
            extraction_trust.KEY_ALIGNMENT: self.alignment,
            extraction_trust.KEY_CHAR_START: str(self.start),
            extraction_trust.KEY_CHAR_END: str(self.end),
        }


def _fmt(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def validate_figure(raw: Any, text: str, model: str,
                    denylist: Optional[extraction_trust.FewShotDenylist] = None) -> tuple[Optional[Figure], str]:
    """(figure, "kept") or (None, reason). Deterministic; no model involved."""
    if not isinstance(raw, dict):
        return None, "malformed"
    metric = str(raw.get("metric") or "").strip().lower()
    if metric not in METRICS:
        return None, "unknown_metric"
    unit = str(raw.get("unit") or "").strip().lower()
    if metric in MONEY_METRICS and unit not in MONEY_UNITS:
        return None, "bad_unit"
    if metric in PER_SHARE_METRICS and unit not in PER_SHARE_UNITS:
        return None, "bad_unit"
    value = str(raw.get("value") if raw.get("value") is not None else "").strip()
    c = canonical(value)
    if c is None:
        return None, "no_value"
    basis = str(raw.get("basis") or "statutory").strip().lower()
    if basis not in ("statutory", "underlying"):
        basis = "statutory"
    period = str(raw.get("period") or "").strip()
    if not period:
        return None, "no_period"
    found = locate(str(raw.get("quote") or ""), text) or locate_gapped(str(raw.get("quote") or ""), value, text)
    if found is None:
        return None, "quote_not_in_document"
    start, end, alignment = found
    quote = text[start:end]
    if len(quote) > 600:
        return None, "quote_too_long"
    if c not in numbers_in(quote):
        return None, "value_not_in_quote"
    if metric in MONEY_METRICS and _bare_figure(quote, c):
        start, end, widened = widen_to_heading(start, end, text, unit)
        if widened:
            quote = text[start:end]
            alignment = "match_greater"  # the stored span is larger than the model's quote
    if metric == "net_profit" and _COMPREHENSIVE_RE.search(quote):
        return None, "comprehensive_income"
    if not LABEL_REQUIRED[metric].search(quote):
        return None, "label_mismatch"
    if metric in LABEL_FORBIDDEN and LABEL_FORBIDDEN[metric].search(quote):
        return None, "label_mismatch"
    if denylist is not None and quote in denylist:
        return None, "fewshot_echo"
    negative = value.lstrip().startswith(("-", "−", "(")) and not value.strip() == "-"
    written = ("-" if negative else "") + c
    return Figure(metric, written, unit, basis, period, quote, start, end, alignment, model), "kept"


def _bare_figure(quote: str, c: str) -> bool:
    """The quoted number has no scale of its own: no scale word after it, no
    unit heading in the quote, and too few digits to be read as whole
    dollars."""
    if MILLIONS_MARKER_RE.search(quote) or THOUSANDS_MARKER_RE.search(quote):
        return False
    for m in _NUM_RE.finditer(quote):
        if canonical(m.group(0)) == c:
            if _SCALE_AFTER_RE.match(quote[m.end():]):
                return False
            return len(c.split(".")[0]) < 7
    return False


def parse_answer(content: str) -> dict:
    """The JSON object in a model's answer ({} when there is none)."""
    s = (content or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        parsed = json.loads(s[i: j + 1])
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


# --- consensus -----------------------------------------------------------------


def same_figure(a: Figure, b: Figure) -> bool:
    if a.metric != b.metric or a.negative != b.negative:
        return False
    x, y = a.normalised(), b.normalised()
    if x == y:
        return True
    return abs(x - y) <= SAME_FIGURE_TOLERANCE * max(abs(x), abs(y))


@dataclass
class Answer:
    model: str
    is_results: Optional[bool]
    figures: list[Figure]
    rejected: Counter
    raw: list = field(default_factory=list)  # the model's figures before validation


def reconcile(primary: Answer, checker: Optional[Answer],
              arbiter: Optional[Callable[[], Optional[Answer]]], strict: bool = False
              ) -> tuple[list[dict], Counter]:
    """Stored records and outcome counts for one document.

    For each primary figure: confirmed by the checker -> agree. The checker
    gives a different value for the same metric and basis -> ask the arbiter
    (lazily, once per document); a value two of the three share -> majority,
    else withheld. The checker has nothing for that metric and basis ->
    primary_only (withheld under strict). A checker figure the primary lacks is
    not stored: it is one cheap model's unconfirmed reading.
    """
    out: list[dict] = []
    counts: Counter = Counter()
    if checker is None:
        for f in primary.figures:
            out.append(f.to_record("unchecked", [primary.model]))
            counts["unchecked"] += 1
        return out, counts

    arbiter_answer: Optional[Answer] = None
    arbiter_asked = False

    for f in primary.figures:
        peers = [g for g in checker.figures if g.key() == f.key()]
        if any(same_figure(f, g) for g in peers):
            out.append(f.to_record("agree", [primary.model, checker.model]))
            counts["agree"] += 1
            continue
        if not peers:
            # The checker has nothing for this metric and basis to contradict it.
            if strict:
                counts["withheld_unconfirmed"] += 1
            else:
                out.append(f.to_record("primary_only", [primary.model]))
                counts["primary_only"] += 1
            continue
        # A real disagreement: ask the arbiter.
        if not arbiter_asked:
            arbiter_asked = True
            arbiter_answer = arbiter() if arbiter else None
        votes = [g for g in (arbiter_answer.figures if arbiter_answer else []) if g.key() == f.key()]
        if any(same_figure(f, g) for g in votes):
            out.append(f.to_record("majority", [primary.model, arbiter_answer.model]))
            counts["majority_primary"] += 1
            continue
        winner = next((g for g in peers if any(same_figure(g, v) for v in votes)), None)
        if winner is not None:
            out.append(winner.to_record("majority", [checker.model, arbiter_answer.model]))
            counts["majority_checker"] += 1
            continue
        counts["withheld_disagreement"] += 1
        log.info("  withheld %s/%s: %s says %s, %s says %s%s", f.metric, f.basis, primary.model, f.value_written,
                 checker.model, [g.value_written for g in peers],
                 f", {arbiter_answer.model} says {[g.value_written for g in votes]}" if arbiter_answer else "")
    return out, counts


# --- the extractor ----------------------------------------------------------------


@dataclass
class DirectExtractor:
    """extract(text, code, usage) -> grounded records in the stored shape."""

    client: OpenRouter
    primary: str = PRIMARY_MODEL
    checker: Optional[str] = CHECKER_MODEL
    arbiter: Optional[str] = ARBITER_MODEL
    strict: bool = False
    denylist: Optional[extraction_trust.FewShotDenylist] = None
    stats: Counter = field(default_factory=Counter)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def ask(self, model: str, text: str, code: str, usage: Optional[TokenUsage]) -> Answer:
        user = f"ASX code: {code}\n\nTEXT OF THE FILING:\n{text[:TEXT_CHARS]}"
        answer = parse_answer(self.client.chat(model, SYSTEM_PROMPT, user, usage=usage))
        figures, rejected = [], Counter()
        for raw in answer.get("figures") or []:
            fig, reason = validate_figure(raw, text[:TEXT_CHARS], model, self.denylist)
            if fig is None:
                rejected[reason] += 1
            else:
                figures.append(fig)
        doc = answer.get("document") if isinstance(answer.get("document"), dict) else {}
        is_results = doc.get("is_results_document")
        raw = [r for r in (answer.get("figures") or []) if isinstance(r, dict)]
        return Answer(model, is_results if isinstance(is_results, bool) else None, figures, rejected, raw)

    def extract(self, text: str, code: str, usage: Optional[TokenUsage] = None) -> list[dict]:
        """Raises ModelCallError when the PRIMARY cannot answer (the document is
        then not stored and the next run retries it). A checker or arbiter
        failure degrades to primary_only for the figures it would have judged,
        and is counted."""
        primary = self.ask(self.primary, text, code, usage)
        checker = None
        if self.checker:
            try:
                checker = self.ask(self.checker, text, code, usage)
            except ModelCallError as e:
                log.warning("  %s: checker %s failed (%s); figures stored unchecked", code, self.checker, e)
                self._count("checker_failed")

        def arbiter() -> Optional[Answer]:
            if not self.arbiter:
                return None
            try:
                return self.ask(self.arbiter, text, code, usage)
            except ModelCallError as e:
                log.warning("  %s: arbiter %s failed (%s); disagreements withheld", code, self.arbiter, e)
                self._count("arbiter_failed")
                return None

        records, counts = reconcile(primary, checker, arbiter, strict=self.strict)
        rejected = primary.rejected + (checker.rejected if checker else Counter())
        with self._lock:
            self.stats.update(counts)
            self.stats.update({f"rejected_{k}": v for k, v in rejected.items()})
        if counts or rejected:
            log.info("  %s: consensus %s; validation dropped %s", code, dict(counts), dict(rejected))
        return records

    def _count(self, k: str) -> None:
        with self._lock:
            self.stats[k] += 1


def summarize(client: OpenRouter, model: str, system_prompt: str, metrics_json: str, page_text: str,
              usage: Optional[TokenUsage] = None) -> str:
    """The digest call through OpenRouter; returns the raw answer text."""
    user = f"## Extracted metrics (JSON)\n{metrics_json}\n\n## Report text excerpt\n{page_text}"
    return client.chat(model, system_prompt, user, usage=usage, temperature=0.2)


def from_env() -> Optional[DirectExtractor]:
    """A DirectExtractor configured from the environment, or None without a key.

    OPENROUTER_API_KEY            required
    EXTRACTOR_PRIMARY_MODEL       default deepseek/deepseek-v4-flash
    EXTRACTOR_CHECKER_MODEL       default google/gemini-2.5-flash-lite ("" disables consensus)
    EXTRACTOR_ARBITER_MODEL       default google/gemini-2.5-flash ("" withholds every disagreement)
    EXTRACTOR_STRICT_CONSENSUS    "true" withholds figures the checker did not confirm
    """
    key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if not key:
        return None
    env = os.environ.get
    return DirectExtractor(
        client=OpenRouter(api_key=key),
        primary=env("EXTRACTOR_PRIMARY_MODEL", PRIMARY_MODEL) or PRIMARY_MODEL,
        checker=env("EXTRACTOR_CHECKER_MODEL", CHECKER_MODEL) or None,
        arbiter=env("EXTRACTOR_ARBITER_MODEL", ARBITER_MODEL) or None,
        strict=(env("EXTRACTOR_STRICT_CONSENSUS", "") or "").lower() in ("1", "true", "yes"),
    )
