"""financial_report_extractions.document_meta: what a document says about itself.

Design contract: docs/plans/fundamentals-coverage.md section 2.5 (the closed
vocabulary) and 6.1 (the producer). Everything here is a deterministic regular
expression over the raw text of the pages read; no model is involved, and an
absent key means absent (never a guess).

The rules are the ones recorded in the shared fixture
services/pkg/extractiontrust/testdata/document_meta_cases.json, which
test_document_meta.py derives every case from. The Go side
(extractiontrust.ParseDocumentMeta) validates what this module writes;
validate_document_meta() below is its mirror, applied before a value is stored
so an out-of-vocabulary value never reaches the column.

  currency  presentation statement "(presented|expressed|reported|stated) in
            <US|United States|Australian|New Zealand|Canadian> dollars"
            (optionally "in thousands of|millions of ... dollars"); with no
            such statement, a currency-prefixed unit header (US$, A$, AU$, NZ$,
            C$ before million / billion / '000 / m / bn). Two distinct
            currencies at the winning level: omitted. A bare "$" never sets a
            currency.
  units     unit statements: "[prefix]$ million", "$m", "$M", "$bn",
            "$ billion", "$'000", "$000", "(in) thousands of ... dollars",
            "nearest dollar" / "whole dollars" (units), and "nearest thousand
            dollars" / "nearest million dollars". Exactly one distinct value
            across the pages read, else omitted. A figure such as "$412.6m" is
            not a unit statement.
  entity    the value of a "Name of entity" line; else the name immediately
            before "ABN" on the same line; else omitted.
  abn       "ABN" then 11 digits grouped 2-3-3-3, emitted "NN NNN NNN NNN",
            only when the checksum passes.
  period_end / period_type
            the first "(half-year|half year|six months|financial year|year|
            twelve months) ended <d Month yyyy>"; half-year and six months are
            half, the rest annual. "as at <date>" is not a period end.
  report_kind
            the first match in this order: Appendix 4E, Appendix 4D, Annual
            Report, half-year / interim financial report, results / profit
            announcement; else "other" when the document names itself a
            presentation, Pillar 3 disclosure, transcript or webcast.

This module has no third-party dependencies.
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Mapping

from extraction_trust import fold

# --- closed vocabulary (extractiontrust/documentmeta.go) ---------------------

UNITS = ("units", "thousands", "millions", "billions")
PERIOD_TYPES = ("annual", "half")
REPORT_KINDS = (
    "appendix_4e",
    "appendix_4d",
    "annual_report",
    "half_year_report",
    "results_announcement",
    "other",
)

# Active ISO 4217 codes (fund and precious-metal codes excluded), copied from
# extractiontrust's iso4217 list.
ISO_4217 = frozenset("""AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD
BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK
DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF
IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP
LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN
NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR
SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD
TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG""".split())

MAX_FREE_TEXT_CHARS = 200  # extractiontrust.maxFreeTextRunes

_ABN_CANONICAL = re.compile(r"^\d{2} \d{3} \d{3} \d{3}$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ABN_WEIGHTS = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)


def valid_abn(s: str) -> bool:
    """extractiontrust.ValidABN: canonical "NN NNN NNN NNN" spelling and the
    ABN checksum (first digit minus 1, weights 10, 1, 3, ..., 19, sum % 89)."""
    if not isinstance(s, str) or not _ABN_CANONICAL.match(s):
        return False
    digits = s.replace(" ", "")
    if digits[0] == "0":
        return False
    total = 0
    for i, ch in enumerate(digits):
        d = int(ch)
        if i == 0:
            d -= 1
        total += d * _ABN_WEIGHTS[i]
    return total % 89 == 0


def _valid_iso_date(s: str) -> bool:
    if not isinstance(s, str) or not _ISO_DATE.match(s):
        return False
    try:
        return _dt.date.fromisoformat(s).isoformat() == s
    except ValueError:
        return False


def _free_text(v: Any) -> str:
    if not isinstance(v, str) or not v.strip() or len(v) > MAX_FREE_TEXT_CHARS:
        return ""
    return v


def validate_document_meta(raw: Mapping[str, Any] | None) -> dict[str, str]:
    """Mirror of extractiontrust.ParseDocumentMeta: every out-of-vocabulary or
    malformed field is dropped (not corrected), evidence without its value is
    dropped, non-string values are absent, unknown keys are ignored."""
    if not isinstance(raw, Mapping):
        return {}

    def s(key: str) -> str:
        v = raw.get(key)
        return v if isinstance(v, str) else ""

    out: dict[str, str] = {}
    if s("currency") in ISO_4217:
        out["currency"] = s("currency")
        ev = _free_text(raw.get("currency_evidence"))
        if ev:
            out["currency_evidence"] = ev
    if s("units") in UNITS:
        out["units"] = s("units")
        ev = _free_text(raw.get("units_evidence"))
        if ev:
            out["units_evidence"] = ev
    entity = _free_text(raw.get("entity"))
    if entity:
        out["entity"] = entity
    if valid_abn(s("abn")):
        out["abn"] = s("abn")
    if _valid_iso_date(s("period_end")):
        out["period_end"] = s("period_end")
    if s("period_type") in PERIOD_TYPES:
        out["period_type"] = s("period_type")
    if s("report_kind") in REPORT_KINDS:
        out["report_kind"] = s("report_kind")
    return out


# --- currency ----------------------------------------------------------------

_CURRENCY_WORDS = {
    "us": "USD",
    "united states": "USD",
    "australian": "AUD",
    "new zealand": "NZD",
    "canadian": "CAD",
}

# "(presented|expressed|reported|stated) in [thousands of|millions of]
# <currency> dollars". Matched on the original text so the evidence is verbatim.
_CURRENCY_STATEMENT_RE = re.compile(
    r"\b(?:presented|expressed|reported|stated)\s+in\s+(?:(?:thousands|millions)\s+of\s+)?"
    r"(?P<cur>US|United\s+States|Australian|New\s+Zealand|Canadian)\s+dollars\b",
    re.IGNORECASE,
)

_CURRENCY_PREFIXES = {"US": "USD", "AU": "AUD", "A": "AUD", "NZ": "NZD", "C": "CAD"}

# A dollar unit header, optionally currency-prefixed: "US$ Million", "$M",
# "$'000", "(A$ million)", "US$bn". The prefix is case-sensitive (upper case);
# the unit word is not. A digit right after the "$" makes it a figure
# ("$412.6m"), and so does a digit group after the unit ("$000,000").
_UNIT_HEADER_RE = re.compile(
    r"(?<![A-Za-z0-9$])(?P<prefix>(?-i:US|AU|NZ|A|C))?\$[ \t\u00A0]?"
    r"(?P<unit>['\u2019]?000(?:['\u2019]?s)?|millions?|mn|m|billions?|bn)"
    r"(?![A-Za-z0-9]|[.,]\d)",
    re.IGNORECASE,
)

# --- units -------------------------------------------------------------------

_UNIT_PHRASES = [
    # "(in) thousands of [currency] dollars"
    (
        re.compile(
            r"(?:\bin\s+|\()(?P<ev>thousands\s+of\s+(?:(?:US|United\s+States|Australian|New\s+Zealand|Canadian)\s+)?dollars)\b",
            re.IGNORECASE,
        ),
        "thousands",
    ),
    (re.compile(r"\b(?P<ev>nearest\s+thousand\s+dollars)\b", re.IGNORECASE), "thousands"),
    (re.compile(r"\b(?P<ev>nearest\s+million\s+dollars)\b", re.IGNORECASE), "millions"),
    (re.compile(r"\b(?P<ev>nearest\s+dollar)\b", re.IGNORECASE), "units"),
    (re.compile(r"\b(?P<ev>whole\s+dollars)\b", re.IGNORECASE), "units"),
]


def _unit_of(token: str) -> str:
    t = token.lower()
    if "000" in t:
        return "thousands"
    if t.startswith("b"):
        return "billions"
    return "millions"


def _collapse(s: str) -> str:
    return " ".join(s.split())


def _currency(text: str) -> tuple[str, str] | None:
    statements = [
        (m.start(), _CURRENCY_WORDS[_collapse(m.group("cur")).lower()], _collapse(m.group(0)))
        for m in _CURRENCY_STATEMENT_RE.finditer(text)
    ]
    if not statements:
        statements = [
            (m.start(), _CURRENCY_PREFIXES[m.group("prefix")], _collapse(m.group(0)))
            for m in _UNIT_HEADER_RE.finditer(text)
            if m.group("prefix")
        ]
    if not statements:
        return None
    if len({code for _, code, _ in statements}) != 1:
        return None  # two distinct currencies at the winning level
    _, code, evidence = min(statements)
    return code, evidence


def _units(text: str) -> tuple[str, str] | None:
    found = [(m.start(), _unit_of(m.group("unit")), _collapse(m.group(0))) for m in _UNIT_HEADER_RE.finditer(text)]
    for pattern, unit in _UNIT_PHRASES:
        found.extend((m.start("ev"), unit, _collapse(m.group("ev"))) for m in pattern.finditer(text))
    if not found or len({unit for _, unit, _ in found}) != 1:
        return None
    _, unit, evidence = min(found)
    return unit, evidence


# --- entity and ABN ----------------------------------------------------------

_ABN_RE = re.compile(r"\bABN\b[ \t:.]*(\d{2})[ \t]?(\d{3})[ \t]?(\d{3})[ \t]?(\d{3})(?!\d)")
_NAME_OF_ENTITY_RE = re.compile(r"(?im)^[ \t]*name\s+of\s+entity\b[ \t]*[:\-]?[ \t]*(?P<value>[^\n]*)$")
_REGISTRATION_TAIL_RE = re.compile(r"[ \t,(]+\(?(?:ABN|ACN|ARSN|ARBN)\b.*$")
# A name found on the line after a bare "Name of entity" label must at least end
# like a company: a guess at a table cell is worse than no entity.
_CORPORATE_TAIL_RE = re.compile(
    r"\b(?:limited|ltd\.?|trust|fund|group|holdings|corporation|company|plc|inc\.?|n\.v\.|reit|bank)$",
    re.IGNORECASE,
)
_TRIM_CHARS = " \t,;:-(\u00A0"


def _clean_entity(value: str) -> str:
    value = _REGISTRATION_TAIL_RE.sub("", value)
    value = _collapse(value).strip(_TRIM_CHARS)
    if not value or len(value) > MAX_FREE_TEXT_CHARS:
        return ""
    if not value[0].isalnum():
        return ""
    return value


def _entity(folded: str) -> str:
    m = _NAME_OF_ENTITY_RE.search(folded)
    if m:
        same_line = _clean_entity(m.group("value"))
        if same_line:
            return same_line
        # "Name of entity" alone on its line (a form's table cell): take the
        # next non-empty line, only when it reads as a company name.
        for line in folded[m.end():].split("\n"):
            if not line.strip():
                continue
            candidate = _clean_entity(line)
            if candidate and _CORPORATE_TAIL_RE.search(candidate) and "entity" not in candidate.lower():
                return candidate
            break
    abn = _ABN_RE.search(folded)
    if abn:
        line_start = folded.rfind("\n", 0, abn.start()) + 1
        before = folded[line_start:abn.start()]
        name = _collapse(before).strip(_TRIM_CHARS)
        if name and not re.search(r"'s$", name) and len(name) <= MAX_FREE_TEXT_CHARS and name[0].isalnum():
            return name
    return ""


def _abn(folded: str) -> str:
    m = _ABN_RE.search(folded)
    if not m:
        return ""
    abn = " ".join(m.groups())
    return abn if valid_abn(abn) else ""


# --- period ------------------------------------------------------------------

_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))

_PERIOD_RE = re.compile(
    r"\b(?P<kind>half[\s-]?year|six\s+months|financial\s+year|twelve\s+months|12\s+months|year)"
    r"\s+ended\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month>" + _MONTH_ALT + r")\.?,?\s+(?P<year>\d{4})\b",
    re.IGNORECASE,
)


def _period(folded: str) -> tuple[str, str] | None:
    m = _PERIOD_RE.search(folded)
    if not m:
        return None
    try:
        end = _dt.date(int(m.group("year")), _MONTHS[m.group("month").lower()], int(m.group("day")))
    except ValueError:
        return None  # an impossible date is withheld, never the next match
    kind = m.group("kind").lower()
    period_type = "half" if kind.startswith("half") or kind.startswith("six") else "annual"
    return end.isoformat(), period_type


# --- report kind -------------------------------------------------------------

_REPORT_KIND_RULES = [
    (re.compile(r"\bappendix\s*4e\b", re.IGNORECASE), "appendix_4e"),
    (re.compile(r"\bappendix\s*4d\b", re.IGNORECASE), "appendix_4d"),
    (re.compile(r"\bannual\s+report\b", re.IGNORECASE), "annual_report"),
    (
        re.compile(r"\bhalf[\s-]?year\s+(?:financial\s+)?report\b|\binterim\s+financial\s+report\b", re.IGNORECASE),
        "half_year_report",
    ),
    (
        re.compile(
            r"\bresults?\s+announcement\b|\bprofit\s+announcement\b|\bresults\s+for\s+announcement\s+to\s+the\s+market\b",
            re.IGNORECASE,
        ),
        "results_announcement",
    ),
    (re.compile(r"\bpresentation\b|\bpillar\s*(?:3|iii)\b|\btranscript\b|\bwebcast\b", re.IGNORECASE), "other"),
]


def _report_kind(folded: str) -> str:
    for pattern, kind in _REPORT_KIND_RULES:
        if pattern.search(folded):
            return kind
    return ""


# --- entry point -------------------------------------------------------------


def extract_document_meta(text: str) -> dict[str, str]:
    """document_meta for a document's raw text (the pages read). Only keys the
    text supports are present; the result is already validated against the
    closed vocabulary. An empty dict means nothing was found."""
    if not text:
        return {}
    folded = fold(text).replace("\u00A0", " ")
    meta: dict[str, str] = {}

    cur = _currency(text)
    if cur:
        meta["currency"], meta["currency_evidence"] = cur
    units = _units(text)
    if units:
        meta["units"], meta["units_evidence"] = units
    entity = _entity(folded)
    if entity:
        meta["entity"] = entity
    abn = _abn(folded)
    if abn:
        meta["abn"] = abn
    period = _period(folded)
    if period:
        meta["period_end"], meta["period_type"] = period
    kind = _report_kind(folded)
    if kind:
        meta["report_kind"] = kind
    return validate_document_meta(meta)
