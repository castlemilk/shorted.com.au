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
  entity    what the document says about ITSELF, never about another entity:
            the value of the first "Name of entity" field (the label optionally
            numbered as a form's item, "1. Name of Entity") that is not another
            entity's (a field under a control gained or lost, associates or
            joint ventures heading, or carrying that section's labels:
            _describes_another_entity; a numbered label's own line names the
            entity only when it ends like a company, else it is the item's
            heading or a contents entry and the search goes on); else the name
            immediately before "ABN" on the same line (an auditor's skipped, a
            trust's responsible entity naming the trust after it); else the
            name on the line above a registration number alone on its line
            ("Vitura Health Limited" over "ACN 629 071 594"): the first that
            ends like a company, has no "entity" in it, has a token that is
            neither a legal form nor an industry word, is not an auditor's,
            does not start with its role ("Trustee: ...") and has none of a
            role label ("MANAGER OF THE COMPANY"; "Responsible entity of"
            introduces the name under it instead), another registration line
            (a list of entities) or a "Name of entity" label above it, and is
            not a labelled name ("Entity name: X") under a control gained or
            lost heading; when a responsible entity's letterhead names its
            trust right after its own registration and licence lines ("...
            AFSL 246996 / Responsible entity of / Charter Hall Retail REIT /
            ABN 34 357 213 849"), the trust; else omitted. A former name in
            brackets after the name ("Ocean Sciences Ltd (formerly BPH Global
            Ltd)", "(Formerly: X)") is kept with it, so a renamed company's
            report matches the name on record, old or new; never after a Pty
            Ltd's or Proprietary Limited's name (a proprietary company is never
            the listed entity), and a value that starts with a former name
            states no name, whatever follows it. A document that predates a
            rename and states only the old name for itself (NS1's 1H FY26
            Appendix 4D, as Harvest Technology Group; TSR's half-year report,
            as South Harz Potash, its proposed new name only in the directors'
            prose) fails the entity check against the new name on record and
            stays withheld: withhold rather than guess. That reaches further
            than such a document: EntityMatches runs at read time against the
            company-metadata name current then, so a rename after extraction
            withholds every stored document of the company that states an
            entity, unless it carries "(formerly ...)", which one stored before
            the rename cannot. These rules raise the stored texts with a stated
            entity from 664 to 1,380 of 2,693 (2026-10-13), so the next rename
            withholds more of a company's history, picks' filing-only halves
            included. The follow-up is a reader-side identity check: a stated
            entity accepted when document_meta.abn equals the ABN of a matched
            filing of the same code, or when it matches one of the code's
            former names. Not a name: a report title, with or without its year
            ("ANNUAL FINANCIAL REPORT 2026"), a phone number, a sentence about
            the release or the listing rules; a leading "Name:" or "of" is not
            part of one.
  abn       "ABN" then 11 digits grouped 2-3-3-3, emitted "NN NNN NNN NNN",
            only when the checksum passes.
  period_end / period_type
            the document's OWN period, from a period phrase "<kind> ended <d
            Month yyyy>" (half-year, "half- year", six months, financial year,
            year, twelve / 12 months, a "half-year period" or "12-month
            period"; half-year and six months are half, the rest annual) or a
            range "<d1> to <d2>" or "<d1> - <d2>" ending on d2: half or annual
            by its span, about 6 or 12 months give or take a week, which a
            kind word before it must agree with; a range that runs backwards,
            spans anything else or has an impossible date states no period,
            and the search goes on. Its reporting-period statement decides:
            the phrase or range right after "(current / financial) reporting
            period" or "current period" (with only "(RP)", ":", "-", "is",
            "covers", "being", "for the" between them, and "from" before a
            range, or the label alone over its value on the next non-empty
            line), when the label's line holds nothing before it but an item
            number ("1.", "Item 1", "A.", "(a)"), a bullet, a form feed,
            "The", "This" or "Details of (the)", never after "previous",
            "prior", "comparative", "corresponding" or "preceding reporting
            period", and never a label over its value in a table's header row
            (another period's label alone on the line above it, another
            period on the line after its value). Without one, the latest
            month a phrase ends in ("<kind> ended <d1> to <d2>" ending on d2),
            the month's first phrase giving the day and the type most of its
            phrases give (the first's on a tie), skipping a phrase that ends on
            or after the report date (extract_document_meta's report_date, when
            given) and one its line introduces as the comparison ("Previous
            corresponding period: year ended ...", "compared with the half-year
            ended ...") or as still to be reported ("to be disclosed in the
            financial report for the half-year ended ...", with a report date
            only for a period that ended 6 or more months before it), so a
            prior period named first (a dividend for the prior year) or a
            later one named ahead no longer decides; in a document lodged more
            than 7 months after that latest month, the month the most phrases
            end in instead (the later on a tie). "as at <date>" is not a
            period end; an impossible end in the phrase the period is read
            from withholds the period.
  report_kind
            the first match in this order anywhere in the pages read:
            Appendix 4E, Appendix 4D, Annual Report, half-year / interim
            financial report, results / profit announcement. Then the
            document's head (its first five non-empty lines, each starting
            within the first 400 characters): "other" when a head line that
            reads as a heading, not a sentence, NAMES the document a
            presentation, Pillar 3 disclosure, transcript or webcast; else
            results_announcement for "results release" or "full year results"
            / "half year results" (never "half year results presentation /
            briefing / webcast / call"). A mention anywhere else
            ("presentation currency", "basis of presentation", "a results
            presentation and webcast will be held") is not a name:
            report_kind is then absent and the title decides downstream.

This module has no third-party dependencies.
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Mapping

from extraction_trust import fold, normalise

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
    entity = clean_entity(_free_text(raw.get("entity")))
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
# The label may carry the form's item number ("1. Name of Entity", "10.1 Name of
# entity."): SRJ's own Appendix 4D (idsId=03131807) numbers it, so its entity
# was read from the next, unnumbered field, in its loss of control section
# ("SRJ Technology Limited", a former subsidiary).
_NAME_OF_ENTITY_RE = re.compile(
    r"(?im)^[ \t]*(?P<item>\d{1,2}(?:\.\d{1,2})*\.?[ \t]+)?name\s+of\s+entity\b[ \t]*[:\-]?[ \t]*(?P<value>[^\n]*)$"
)
_REGISTRATION_TAIL_RE = re.compile(r"[ \t,(]+\(?(?:ABN|ACN|ARSN|ARBN)\b.*$", re.ASCII)
# A name found on the line after a bare "Name of entity" label must at least end
# like a company: a guess at a table cell is worse than no entity.
_CORPORATE_TAIL_RE = re.compile(
    r"\b(?:limited|ltd\.?|trust|fund|group|holdings|corporation|company|plc|inc\.?|n\.v\.|reit|bank)$",
    re.IGNORECASE,
)
_TRIM_CHARS = " \t,;:-(.\u00A0"

# clean_entity's rules, pattern for pattern the same as extractiontrust's
# cleanEntity (Go): the read side applies them to every stored entity, so a
# row written before a rule existed is read the way a new one is written.
# A generic label or a connective before the name: AKG's "Name: Academies
# Australasia Group Limited", CPU's notice of meeting ("The Annual General
# Meeting / of Computershare Limited / ABN 71 005 485 825"). A role label
# ("Trustee: Perpetual Trust Services Limited") is never stripped: the name
# after it is another organisation's.
_LEADING_LABEL_RE = re.compile(r"(?i)^(?:(?:company|entity)\s+)?name\s*:\s*|^of\s+", re.ASCII)
_RESPONSIBLE_ENTITY_OF_RE = re.compile(r"(?i)^the\s+responsible\s+entity\s+of\s+(.+?)\s+is\s+(.+)$", re.ASCII)
_GENERIC_SCHEME_RE = re.compile(r"(?i)^(?:the\s+)?(?:registered\s+)?(?:scheme|fund|trust|company)$", re.ASCII)
_DIRECTORS_OF_RE = re.compile(r"(?i)^(?:the\s+)?directors\s+of\s+", re.ASCII)
_SENTENCE_END_RE = re.compile(r"[a-z]{4,}\.\s+[A-Z]", re.ASCII)
_TRAILING_PAREN_RE = re.compile(r"\s*\([^()]*\)\s*$", re.ASCII)
# ...except a former name: BP8's own FY26 annual report (idsId=03145583) reads
# "Ocean Sciences Ltd (formerly BPH Global Ltd)" over "ABN 57 009 104 330", and
# the company on record is still "Bph Global". Without the bracket the entity
# check withheld the company's own report; with it EntityMatches accepts the old
# name or the new one. It is kept after the name, whatever other trailing
# brackets are cut ("Altoro Metals Limited (ASX:ARO) (formerly Variscan Mines
# Limited)" is "Altoro Metals Limited (formerly Variscan Mines Limited)"), and
# with a colon too ("(Formerly: CHPT EX 3 Trust)", CHC's control lost table).
_FORMER_NAME_RE = re.compile(
    r"(?i)\s*\(\s*(?:formerly|previously)(?:\s+known\s+as)?(?:\s*:\s*|\s+)[^()\s][^()]*\)\s*$", re.ASCII
)
# A value that starts with a former-name bracket states no name, whatever
# follows it, a label before it ("Name:", "of"), the trim's characters
# ("- (formerly", ", (formerly") or a second bracket included. The trim would
# leave the fragment "formerly BPH Global Ltd)", which the entity check matches
# to Bph Global and withholds against Ocean Sciences, from "(formerly BPH
# Global Ltd), ABN 57 009 104 330" under "Ocean Sciences Ltd" (the ABN rule
# reads only the ABN's own line) or from "(formerly BPH Global Ltd) (ASX:
# BP8)".
_LEADING_FORMER_NAME_RE = re.compile(r"(?i)^[\s,;:.(-]*\(\s*(?:formerly|previously)\b", re.ASCII)
# ...but never after a proprietary company's name, short or long ("Pty Ltd",
# "Pty. Limited", "Proprietary Limited"). A Pty Ltd is never the listed entity,
# and its old name would lend it another company's words: a subsidiary's own
# accounts as "Sturt Exploration Pty Ltd (formerly Axiant Resources Exploration
# Pty Ltd)" would pass the entity check against Axiant Resources, where AXR's
# filing of Sturt's accounts (idsId=03133576) is withheld. The name is trimmed
# first, so a full stop after "Ltd" is gone.
_PROPRIETARY_RE = re.compile(r"(?i)\b(?:pty\.?|proprietary)\s*(?:ltd|limited)$", re.ASCII)
# Not a name: a registration number or exchange code, a web or email address,
# a street address or phone number (SWM's own FY25 Appendix 4E is withheld on
# prod by the entity "T +61 2 8777 7777 /"), a legal form alone, a form's label,
# a sentence about the release or the ASX's rules ("Authorised for release by:
# the Board of Ampol Limited", "to the ASX under Listing Rule 4.3A"), a
# document's own title, with or without its year (BLG's annual report runs
# "ANNUAL FINANCIAL REPORT 2026  ABN 20 116 825 793" along its pages, so the
# title was read as the entity before its ABN).
_NOT_A_NAME_RES = [
    re.compile(r"(?i)^(?:abn|acn|arsn|arbn|asx)\b", re.ASCII),
    re.compile(r"(?i)www\.|https?:|@|\.com\b", re.ASCII),
    re.compile(r"(?i)\b(?:level|suite|unit|floor)\s+\d|\b\d+[a-z]?\s*/\s*\d+\s+[a-z]|\b(?:nsw|vic|qld|wa|sa|tas|act|nt|new\s+south\s+wales|victoria|queensland|western\s+australia|south\s+australia|tasmania|australian\s+capital\s+territory|northern\s+territory)[\s,]+\d{4}\b|\bt:\s*\+?\d", re.ASCII),
    re.compile(r"(?i)^(?:t|tel|telephone|ph|phone)\b[\s.:]*[+(]?\d", re.ASCII),
    re.compile(r"(?i)^(?:the\s+)?(?:company|limited|ltd|pty\.?\s*ltd|plc|inc|nl|corporation|group|holdings?)$", re.ASCII),
    re.compile(r"(?i)\bgroup\s+of\s+entities\b|\bname\s+of\s+entity\b|\bover\s+which\s+control\b", re.ASCII),
    re.compile(r"(?i)^authori[sz]ed\s+for\s+release\b|\blisting\s+rules?\b", re.ASCII),
    re.compile(r"(?i)^(?:(?:fy\s?)?(?:\d{2}){1,2}\s+)?(?:(?:annual|half[\s-]?year(?:ly)?|interim|preliminary\s+final|financial)\s+(?:financial\s+)?report|appendix\s*4[cde]|directors'?\s+report)(?:\s*-?\s*(?:(?:fy\s?)?(?:\d{2}){1,2}(?:[-/](?:\d{2}){1,2})?|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}))?$", re.ASCII),
]


def clean_entity(value: Any) -> str:
    """A stated entity reduced to the name it states, or "" when it states none
    (extractiontrust.cleanEntity, rule for rule).

    A letterhead is cut at its first separator ("Klevo Group Ltd |Suite 102,
    ..."), a registration-number tail and a leading "Name:" or "of" are
    dropped; "The Responsible Entity of X is Y" is the scheme X, or Y when X is
    only "the Scheme"; "The directors of Y" is Y; a sentence's tail is cut away
    ("... the portfolio. RAM Property Funds Management Limited"), and so are
    trailing parentheticals, except a former name ("(formerly X)", "(previously
    known as X)", "(Formerly: X)"), which stays after the name unless that is a
    Pty Ltd's (or Proprietary Limited's); a value that starts with a former
    name, behind a "Name:" or "of" too, states no name, whatever follows it.
    What is left is dropped when it is not a name (_NOT_A_NAME_RES). The name
    of another organisation (an auditor, a responsible entity) is kept: it says
    the document may not be the company's, and the entity check then withholds
    it."""
    if not isinstance(value, str):
        return ""
    for sep in ("|", "\u2022"):
        value = value.split(sep, 1)[0]
    value = _REGISTRATION_TAIL_RE.sub("", _collapse(value))
    if _LEADING_FORMER_NAME_RE.match(value):
        return ""  # "(formerly BPH Global Ltd), ": the trim below would leave "formerly ...)"
    value = value.strip(_TRIM_CHARS)
    value = _LEADING_LABEL_RE.sub("", value)
    if _LEADING_FORMER_NAME_RE.match(value):
        return ""  # "Name: (formerly BPH Global Ltd) ...": the same, behind a label
    m = _RESPONSIBLE_ENTITY_OF_RE.match(value)
    if m:
        scheme = m.group(1).strip(_TRIM_CHARS)
        value = m.group(2) if _GENERIC_SCHEME_RE.match(scheme) else re.sub(r"(?i)^the\s+", "", scheme)
    value = _DIRECTORS_OF_RE.sub("", value)
    ends = list(_SENTENCE_END_RE.finditer(value))
    if ends:
        value = value[ends[-1].end() - 1:]
    former = ""
    while True:
        paren = _TRAILING_PAREN_RE.search(value)
        if not paren:
            break
        if not former and _FORMER_NAME_RE.match(paren.group(0)):
            former = paren.group(0).strip()
        value = value[:paren.start()]
    value = value.strip(_TRIM_CHARS)
    if not value:
        return ""  # nothing left, or only a former name: no name of its own
    if not value[0].isalnum() or any(rx.search(value) for rx in _NOT_A_NAME_RES):
        return ""
    if former and not _PROPRIETARY_RE.search(value):
        value += " " + former
    return value if len(value) <= MAX_FREE_TEXT_CHARS else ""


# An auditor's report or independence declaration carries the audit firm's own
# ABN, and is often the first ABN in an annual report's opening pages (on prod,
# 2026-10-11: PricewaterhouseCoopers, BDO Audit, Grant Thornton Audit, Moore
# Australia Audit, RSM Australia Partners). It is never the reporting entity,
# so the search moves on to the next ABN.
_AUDITOR_RE = re.compile(
    r"(?i)\baudit\b|pricewaterhousecoopers|\bdeloitte\b|\bkpmg\b|\bernst\s*&\s*young\b|\bgrant\s+thornton\b"
    r"|\bbdo\b|\brsm\s+australia\b|\bpitcher\s+partners\b|\bhlb\s+mann\s+judd\b|\bmoore\s+australia\b"
    r"|\bnexia\b|\bhall\s+chadwick\b|\bwilliam\s+buck\b|\bcrowe\b|\bpkf\b|\bchartered\s+accountants\b",
    re.ASCII,
)
# "Equity Trustees Limited ABN 46 004 031 298, the Responsible Entity of
# Dominion Income Trust 1": a trust's documents are lodged by its responsible
# entity, whose name precedes the ABN; the trust is named after it.
_RESPONSIBLE_ENTITY_FOR_RE = re.compile(
    r"(?i)^[\s,)]*(?:as\s+)?(?:the\s+)?responsible\s+entity\s+(?:of|for)\s+(?:the\s+)?(?P<scheme>[^\n,;(]+)",
    re.ASCII,
)


# A "Name of entity" field about ANOTHER entity: Appendix 4E / 4D's sections on
# entities over which control was gained or lost and on associates and joint
# ventures, and the tables companies draw for them. VIT's own Appendix 4E
# (idsId=03130179) was read as "Cortexa Pty Ltd" from "the Company gained or
# lost control over the following entities: / Name of entity / Cortexa Pty Ltd
# / Control gained or lost / Lost", and withheld as another company's. Two
# places say so, and either is enough:
#   the heading: the _FOREIGN_HEADING_LINES non-empty lines before the label's
#     line ("Control gained over entities", "Loss of control over entities",
#     "Details of associates and joint venture entities", "the Group ceased to
#     have control over the following subsidiary")
#   the field: the label's line and the _FOREIGN_FIELD_LINES non-empty lines
#     after it carry that section's own labels ("Name of entity (or group of
#     entities)", "Control gained or lost", "Date control lost", "Date of the
#     gain or loss of control", "Ownership interest", "% holding", "Country of
#     incorporation")
# The reporting entity's own field ("Name of entity / X Limited / ABN /
# Reporting period") carries neither; "X Limited and its controlled entities"
# is not "control gained". Over the 2,086 stored texts (2026-10-13) this skips
# 55 of the 56 such fields and none of the 393 own ones (the one kept, DXS's
# joint venture table with its heading 6 lines up, has "%" as its value, so
# nothing is read from it).
_FOREIGN_HEADING_LINES = 3
_FOREIGN_FIELD_LINES = 2
_FOREIGN_HEADING_RE = re.compile(
    r"(?i)\bcontrol\s+(?:has\s+been\s+|have\s+been\s+|was\s+|were\s+)?(?:gained|lost|obtained)\b"
    r"|\b(?:gain(?:ed)?|los[st]|loss|change[ds]?|cease[ds]?)\s+(?:or\s+(?:lost|loss)\s+)?(?:of\s+|in\s+|to\s+have\s+)?control\b"
    r"|\bcontrol\s+over\b"
    # "Details of associates and joint venture entities", "Details of joint
    # ventures", "Investments in associates": never the bare word, which names
    # companies too (Associate Global Partners Limited).
    r"|\b(?:details\s+of|investments?\s+in)\s+(?:investments?\s+in\s+)?(?:associates?|joint\s+ventures?)\b"
    r"|\b(?:associates?|joint\s+ventures?)\s+(?:and|&)\s+(?:joint\s+ventures?|associates?)\b",
    re.ASCII,
)
_FOREIGN_FIELD_RE = re.compile(
    r"(?i)\(\s*or\s+group\s+of\s+entities\s*\)|\bover\s+which\s+control\b"
    r"|\bcontrol\s+(?:was\s+|has\s+been\s+)?(?:gained|lost|obtained|gain)\b"
    r"|\bdate\s+(?:of\s+|that\s+)?(?:the\s+)?(?:gain|loss|change\s+(?:in|of)\s+control|control)\b"
    r"|\b(?:gain|loss)\s+of\s+control\b"
    r"|%\s*holding\b|\bholding\s*%|\bpercentage\s+(?:of\s+)?(?:holding|held|interest|ownership)\b"
    r"|\bownership\s+(?:interest|%)|\binterest\s+(?:acquired|held)\b"
    r"|\b(?:country|place)\s+of\s+(?:business|incorporation)\b",
    re.ASCII,
)

# A registration number alone on its line: a cover or a corporate directory
# sets the entity's name on the line above it ("Vitura Health Limited / ACN 629
# 071 594", "Lowell Resources Fund / ARSN 093 363 896"). A name before an ACN,
# ARSN or ARBN on the same line is NOT read the way one before an ABN is: it is
# as often another company, one stapled entity of several or one named in prose
# ("NewPeak announced the acquisition of Goldstrike Mining Pty Ltd ACN 629 011
# 196"), and over the stored texts (2026-10-13) that rule withheld 19 documents
# wrongly.
_LONE_REGISTRATION_RE = re.compile(
    r"(?im)^[ \t]*(?:ABN|ACN|ARSN|ARBN)\b[ \t:.]*\d{2,3}[ \t]?\d{3}[ \t]?\d{3}(?:[ \t]?\d{3})?[ \t.,;]*$"
)
# A directory lists other organisations the same way, each under its role:
# CDM's annual report has "MANAGER OF THE COMPANY / Cadence Asset Management
# Pty Limited / ABN: 68 106 551 062". A name under a role label is skipped, and
# so is a name line that starts with its role ("Trustee: Perpetual Trust
# Services Limited"); a search for role words inside the name would skip
# Corporate Travel Management Limited's own. A label that is only a role and its
# preposition introduces the subject instead, so the name under it is read: a
# trust's letterhead sets "Responsible entity of" over the trust's own name.
# Not "... (the Responsible Entity), a wholly owned subsidiary of" (NSR's
# directory), which names the role-holder.
_ROLE_WORDS = (
    r"manager|management|registry|registrar|custodian|trustee|responsible\s+entity|auditors?|solicitors?|"
    r"lawyers?|bankers?|administrator|secretary|promoter|adviser|advisor|underwriter|lead\s+manager|operator|"
    r"investment\s+manager|share\s+registry|legal"
)
_ROLE_LABEL_RE = re.compile(r"(?i)\b(?:" + _ROLE_WORDS + r")\b")
_ROLE_PREFIX_RE = re.compile(r"(?i)^\s*(?:the\s+)?(?:(?:company|joint|legal|tax)\s+)?(?:" + _ROLE_WORDS + r")s?\s*(?::|-\s)")
_ROLE_OF_RE = re.compile(r"(?i)^\s*(?:the\s+)?(?:" + _ROLE_WORDS + r")\s+(?:of|for)\s*:?\s*$")
# ...and so is a name with a registration line above it: one of a list of
# entities (MGX's subsidiaries, "GERALDTON BULK HANDLING / PTY LTD / ABN: 45 100
# 105 388 / BROCKMAN MINERALS PTY LTD / ABN: 75 094 634 401"). The line must
# START with the number: a list entry with its number on the same line
# ("Geraldton Bulk Handling Pty Ltd ACN 100 105 388") is not a list marker, and
# the name under it is read, for the entity check to decide.
_REGISTRATION_LINE_RE = re.compile(r"(?i)(?:ABN|ACN|ARSN|ARBN)\b")

# A responsible entity's letterhead names the trust after its own registration
# and licence lines. CQR's own 1H FY26 results (idsId=03057412) read "Charter
# Hall / Retail Management Limited / ACN 069 709 468 / AFSL 246996 / Responsible
# entity of / Charter Hall Retail REIT / ABN 34 357 213 849" and were withheld
# as the responsible entity's. The trust is the entity when the phrase stands
# alone on its line and the name after it has its own registration line, or
# when the phrase names it ("as responsible entity of X", "in its capacity as
# responsible entity for X"), the way the ABN rule's _RESPONSIBLE_ENTITY_FOR_RE
# reads "X ABN ... as responsible entity for Y". A responsible entity whose
# letterhead names no trust stays the entity, and is withheld: MRE's disclosure
# (idsId=03144652) names its fund on a subject line of its own, "Metrics Real
# Estate Multi-Strategy Fund (ASX: MRE)" (text line 19), after the letterhead's
# address and the ASX addressee block, which this rule rightly does not read.
_REGISTRATION_OR_LICENCE_LINE_RE = re.compile(
    r"(?i)^\s*(?:(?:ABN|ACN|ARSN|ARBN|(?:AFSL|AFS\s+licence)(?:\s+no\.?)?)[\s:.]*\d[\d ]*[\s,;|]*)+$", re.ASCII
)
_RESPONSIBLE_ENTITY_LINE_RE = re.compile(r"(?i)^\s*(?:the\s+)?responsible\s+entity\s+(?:of|for)\s*:?\s*$", re.ASCII)
_AS_RESPONSIBLE_ENTITY_RE = re.compile(
    r"(?i)^\s*(?:as|in\s+its\s+capacity\s+as)\s+(?:the\s+)?responsible\s+entity\s+(?:of|for)\s+(?:the\s+)?"
    r"(?P<scheme>[^\n,;(]+)",
    re.ASCII,
)
# How far a letterhead runs: up to five registration and licence lines, the
# phrase, the trust and the trust's own registration line.
_RESPONSIBLE_ENTITY_LINES = 8

# extractiontrust/entity.go's entityStopTokens (legal forms and connectives) and
# entityGenericTokens (industry words), copied: test_document_meta.py diffs them
# against the Go source. A name with no token outside both names no one: the
# second line of BMR's wrapped cover name ("COVERllymore / Resources Limited /
# ACN 632 893 611") is "Resources Limited".
ENTITY_STOP_TOKENS = frozenset(
    "limited ltd plc inc incorporated corporation corp co company nl pty the of and group"
    " holdings holding trust fund fpo stapled securities abn".split()
)
ENTITY_GENERIC_TOKENS = frozenset(
    "australia australian resources energy minerals mining metals gold lithium oil gas capital"
    " technologies technology tech health healthcare international global pacific investments"
    " investment property properties industries bank financial services solutions systems"
    " exploration asia new zealand".split()
)
_ENTITY_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")


def _identifying_tokens(name: str) -> list[str]:
    """extractiontrust.entityTokens: the name normalised, apostrophes removed,
    split on anything not alphanumeric, legal forms and connectives dropped."""
    return [
        t for t in _ENTITY_TOKEN_SPLIT_RE.split(normalise(name).replace("'", ""))
        if t and t not in ENTITY_STOP_TOKENS
    ]


def _lines_before(text: str, pos: int, n: int) -> list[str]:
    """The last n non-empty lines before the line pos is on, in document order."""
    lines: list[str] = []
    end = text.rfind("\n", 0, pos)  # the newline that ends the line before
    while end >= 0 and len(lines) < n:
        start = text.rfind("\n", 0, end) + 1
        if text[start:end].strip():
            lines.append(text[start:end])
        end = start - 1
    return lines[::-1]


def _lines_after(text: str, pos: int, n: int) -> list[str]:
    """The first n non-empty lines after the line pos is on."""
    lines: list[str] = []
    start = text.find("\n", pos) + 1  # 0: no line after
    while start > 0 and len(lines) < n:
        end = text.find("\n", start)
        line = text[start:] if end < 0 else text[start:end]
        if line.strip():
            lines.append(line)
        start = end + 1
    return lines


def _describes_another_entity(folded: str, m: re.Match) -> bool:
    """Whether the "Name of entity" field m names another entity than the
    reporting one (_FOREIGN_HEADING_RE before it, _FOREIGN_FIELD_RE on it)."""
    heading = "\n".join(_lines_before(folded, m.start(), _FOREIGN_HEADING_LINES))
    if _FOREIGN_HEADING_RE.search(heading):
        return True
    field = "\n".join([folded[m.start():m.end()]] + _lines_after(folded, m.end(), _FOREIGN_FIELD_LINES))
    return bool(_FOREIGN_FIELD_RE.search(field))


def _entity(folded: str) -> str:
    return _entity_of_field(folded) or _entity_before_abn(folded) or _entity_above_registration(folded)


def _ends_like_a_company(name: str) -> bool:
    """_CORPORATE_TAIL_RE on the name itself, a former name after it aside."""
    return bool(_CORPORATE_TAIL_RE.search(_FORMER_NAME_RE.sub("", name)))


def _entity_of_field(folded: str) -> str:
    """The value of the reporting entity's own "Name of entity" field."""
    for m in _NAME_OF_ENTITY_RE.finditer(folded):
        if _describes_another_entity(folded, m):
            continue  # another entity's field: the next field, then the ABN rule
        same_line = clean_entity(m.group("value"))
        if same_line:
            if not m.group("item") or _ends_like_a_company(same_line):
                return same_line
            # A numbered line whose words are not a company's name is the
            # item's heading or a contents entry ("1. Name of entity and
            # reporting period 2"), not the field.
            continue
        # "Name of entity" alone on its line (a form's table cell): take the
        # next non-empty line, only when it reads as a company name.
        following = _lines_after(folded, m.end(), 1)
        candidate = clean_entity(following[0]) if following else ""
        if candidate and _ends_like_a_company(candidate) and "entity" not in candidate.lower():
            return candidate
        break  # the reporting entity's field, stating no name: the ABN rule
    return ""


def _entity_before_abn(folded: str) -> str:
    """The name immediately before the first ABN that is not an auditor's (for a
    trust's responsible entity, the trust named after it), or "" when that ABN
    has none."""
    for abn in _ABN_RE.finditer(folded):
        line_end = folded.find("\n", abn.end())
        trust = _RESPONSIBLE_ENTITY_FOR_RE.match(folded[abn.end():line_end if line_end >= 0 else len(folded)])
        if trust:
            scheme = clean_entity(trust.group("scheme"))
            if scheme and not _GENERIC_SCHEME_RE.match(scheme):
                return scheme
        line_start = folded.rfind("\n", 0, abn.start()) + 1
        before = _collapse(folded[line_start:abn.start()]).strip(_TRIM_CHARS)
        if re.search(r"'s$", before):
            return ""  # a possessive before the ABN is prose, not a name
        # Untrimmed, so clean_entity sees a former name's bracket whole.
        name = clean_entity(folded[line_start:abn.start()])
        if name and _AUDITOR_RE.search(name):
            continue
        return name
    return ""


def _names_a_company(name: str) -> bool:
    """A name read above a registration line: it ends like a company, is not a
    form's label (no "entity" in it), and has a token that is neither a legal
    form nor an industry word (a former name after it aside)."""
    current = _FORMER_NAME_RE.sub("", name)
    return bool(
        name
        and _CORPORATE_TAIL_RE.search(current)
        and "entity" not in name.lower()
        and any(t not in ENTITY_GENERIC_TOKENS for t in _identifying_tokens(current))
    )


def _is_role_label(label: str) -> bool:
    """A label naming the organisation under it by its role ("MANAGER OF THE
    COMPANY", "The Responsible Entity of The Fund"), not one that introduces
    its subject ("Responsible entity of")."""
    return bool(_ROLE_LABEL_RE.search(label)) and not _ROLE_OF_RE.match(label)


def _trust_of_responsible_entity(folded: str, pos: int) -> str:
    """The trust a responsible entity's letterhead names after the
    registration line ending at pos, or "" when it names none."""
    after = _lines_after(folded, pos, _RESPONSIBLE_ENTITY_LINES)
    i = 0
    while i < len(after) and _REGISTRATION_OR_LICENCE_LINE_RE.match(after[i]):
        i += 1
    if i == len(after):
        return ""
    phrase = _AS_RESPONSIBLE_ENTITY_RE.match(after[i])
    if phrase:
        scheme = clean_entity(phrase.group("scheme"))
    elif (
        _RESPONSIBLE_ENTITY_LINE_RE.match(after[i])
        and i + 2 < len(after)
        and _LONE_REGISTRATION_RE.match(after[i + 2])
    ):
        scheme = clean_entity(after[i + 1])
    else:
        return ""
    return scheme if scheme and not _GENERIC_SCHEME_RE.match(scheme) else ""


def _entity_above_registration(folded: str) -> str:
    """The name on the line above a registration number alone on its line: the
    first, in document order, that _names_a_company, is not an auditor's, does
    not start with its role and is neither under a role label, nor a "Name of
    entity" field's value (rule 1's to read or skip), nor a labelled name under
    a control gained or lost heading, nor one of a list of entities; for a
    responsible entity, the trust its letterhead names after it. VIT's own
    Appendix 4E states no ABN; its cover has "Vitura Health Limited / ACN 629
    071 594". A subsidiary's own accounts name the subsidiary (AXR filed Sturt
    Exploration Pty Ltd's), which the entity check then withholds."""
    for m in _LONE_REGISTRATION_RE.finditer(folded):
        above = _lines_before(folded, m.start(), 2)
        if not above:
            continue
        name = clean_entity(above[-1])
        label = above[0].strip() if len(above) == 2 else ""
        if name and _AUDITOR_RE.search(name):
            continue  # an auditor's number, as in the ABN rule
        if _ROLE_PREFIX_RE.match(above[-1]) or _is_role_label(label):
            continue
        if _REGISTRATION_LINE_RE.match(label) or _NAME_OF_ENTITY_RE.match(label):
            continue
        # "Control lost over entities / Entity name: Cortexa Pty Ltd / ACN 123
        # 456 789": the label clean_entity strips is that section's field, not
        # a letterhead's (AKG's "Company details / Name: Academies Australasia
        # Group Limited / ABN: 93 000 003 725" is its own).
        context = _lines_before(folded, m.start(), _FOREIGN_HEADING_LINES + 1)
        if _LEADING_LABEL_RE.match(context[-1].strip()) and _FOREIGN_HEADING_RE.search("\n".join(context[:-1])):
            continue
        if _names_a_company(name):
            return _trust_of_responsible_entity(folded, m.end()) or name
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

# "half- year" and "half - year" are half-years too: NWH's, NXT's and VGN's 1H26
# reports (idsId=03061986, 03065047, 03066107) spell it so, and read as annual
# from the "year ended" left after it. With no hyphen, "half" and "year" are a
# line break apart at most, with any other space between (QBE's 1H26 4D,
# idsId=03125036, sets "Half Year" with U+202F): "the first half" over a blank
# line and "Year ended 30 June 2026" is a year, and so is "half" at the foot
# of a page over "year ended" at the top of the next (extract.py joins pages
# with a blank line).
_PERIOD_KIND = (
    r"(?P<kind>half(?:\s*-\s*|[^\S\n]*\n?[^\S\n]*)year(?:\s+period)?|(?:six|twelve|12)[\s-]+months?(?:\s+period)?"
    r"|financial\s+year|year)"
)


def _date_pattern(suffix: str) -> str:
    """A "d Month yyyy" date, its groups day<suffix>, month<suffix>, year<suffix>."""
    return (r"(?P<day" + suffix + r">\d{1,2})(?:st|nd|rd|th)?\s+(?P<month" + suffix + r">" + _MONTH_ALT
            + r")\.?,?\s+(?P<year" + suffix + r">\d{4})")


# A period phrase: "<kind> ended <d Month yyyy>". "half-year period" and
# "six-month" / "12-month period" are kinds too: AVE's own 1H26 Appendix 4D
# (idsId=03130095) names its half only as "the half-year period ended 30 June
# 2026", so its comparatives ("(half-year ended 30 June 2025: $560,069)") and the
# prior year of an R&D refund were all it was read by. "ending" is a forecast's,
# "as at" a balance date's. "<kind> ended <d1> to <d2>" is a range, which ends
# its period on d2 only when it is one half or one year (_period_of): GNG's FY26
# accounts (idsId=03128898) state their year only as "the financial year ended
# 1 July 2025 to 30 June 2026 (FY26)", and its first day was once read as the
# period's end, while CM8's half-year report heads a section "Comparison of
# half-year ended 31 December 2025 to 31 December 2024", which runs backwards and
# states no period. A dash is the same range, forwards ("year ended 1 July 2025
# - 30 June 2026"; fold() makes an en or em dash one) or backwards ("Year ended
# 30 June 2026 - 30 June 2025", which states none, like CM8's), whichever side
# of the dash its line breaks (CBO's and AI1's stored texts wrap ranges before
# it). Any other date that runs on into "to <day Month>" or "- <day Month>" is
# not an end, so a phrase over a bulleted date ("- 15 March 2026: payment
# date") states no period, a range that is no half or year, unless that date
# falls a half or a year later, when it is read as the end (no stored text is
# either, 2026-10-13).
_PHRASE_RANGE_SEP = r"(?:\s+to\s+|\s*-\s*)"
_PERIOD_RE = re.compile(
    r"\b" + _PERIOD_KIND + r"\s+ended\s+(?:" + _date_pattern("_start") + _PHRASE_RANGE_SEP + r")?" + _date_pattern("")
    + r"\b(?!" + _PHRASE_RANGE_SEP + r"\d{1,2}(?:st|nd|rd|th)?\s+(?:" + _MONTH_ALT + r")\b)",
    re.IGNORECASE,
)
# A reporting-period statement's value may be the range itself, its kind before
# it or not: "Current period / From 1 August 2025 to 31 July 2026", "The
# reporting period is from 1 July 2025 to 31 December 2025", "Reporting period:
# / For the half-year from 1 July 2025 to 31 December 2025", "Current reporting
# period: / 01 July 2025 - 30 June 2026". 62 of the stored texts (2026-10-13)
# state their own period so, and 14 their previous period.
_RANGE_RE = re.compile(
    r"(?:" + _PERIOD_KIND + r"\s+)?(?:from\s+)?" + _date_pattern("_start") + r"\s*(?:to|-)\s*"
    + _date_pattern("") + r"\b",
    re.IGNORECASE,
)
# A range is one period when it runs forward a half or a year, 182 or 365 days
# give or take a week: an inclusive range ("1 July 2025 to 30 June 2026") is a
# day short, a 52- or 53-week year ("30 June 2025 to 28 June 2026", WOW's FY26
# Appendix 4E, idsId=03130111) a day or two short or five over.
_SPAN_DAYS = (("half", 182), ("annual", 365))
_SPAN_TOLERANCE_DAYS = 7

# The document's own reporting-period statement: an Appendix 4D or 4E item
# ("Reporting period: half-year ended 31 December 2025", "Current reporting
# period - twelve months ended 30 June 2026", "Reporting Period (RP): Financial
# year ended 30 June 2026"), the label over its value on the next non-empty line
# ("Current reporting period:" / "Half-year ended 31 December 2025"), or the
# sentence that states it. VIT's own FY26 Appendix 4E (idsId=03130179) states
# "1. The reporting period covers the year ended 30 June 2026." after a dividend
# "in respect of the year ended 30 June 2025", and the first period named was
# taken as its own, so latest_filing and picks gate 4 dropped its FY26 results as
# another period's. Between the label and the period only a qualifier in
# brackets ("(RP)", "("current period")", a footnote's "[1]"), the label's ":" or
# "-" and the statement's words ("is", "being", "covers", "for", "the"): a
# sentence that only mentions the reporting period states none ("during the
# Reporting Period, or the half-year ended 30 June 2025 (the 'Prior
# Corresponding Period')", 29M's 1H26 Appendix 4D, idsId=03130836). "Current
# period" is the same label: NHC's FY26 Appendix 4E (idsId=03139480) states its
# year only as "Current period / From 1 August 2025 to 31 July 2026", as 19 other
# stored texts state theirs, and 8 more label a period phrase so (2026-10-13).
_REPORTING_PERIOD_RE = re.compile(
    r"(?P<label>\b(?:(?:(?:current|financial)\s+)?reporting|current)\s+period\b)"
    r"(?:[ \t]*(?:\([^()\n]{1,30}\)|\[\d{1,2}\]))?"
    r"[ \t]*[:\-]?(?:[ \t]*\n\s*[:\-]?)?[ \t]*"
    r"(?:(?:is|being|covers|for|the)[ \t]+)*",
    re.IGNORECASE,
)
# The label stands alone on its line, or after no more than an item number
# ("1.", "1.1", "1)", "(1)", "1:", "Item 1", "Item 1 -", a letter's "A.", "a)"
# or "(a)", a roman numeral's "ii." or "(iv)"), a bullet ("-", "*", U+2022,
# U+00B7), a form feed, "The" / "This" or "Details of (the)": a line of prose
# that ends in "the reporting period" ("Dividends paid during the reporting
# period:") over a prior year's dividend line ("For the year ended 30 June 2025
# final dividend of 5.0 cents") states no period. All 459 statements over a
# phrase in the stored texts (2026-10-13) start their line so; five sentences
# over a range do not ("This Appendix 4E covers the reporting period from 1
# July 2025 to 30 June 2026"), and each of those documents gives the same
# period elsewhere. None of the stored statements over a period starts with a
# letter, "Item", a bullet or a form feed; a form's layout may. Other bullet
# glyphs ("o", U+25AA, ">") are not read.
_STATEMENT_LEAD_RE = re.compile(
    r"(?i)[ \t\f]*(?:(?:(?:item[ \t]+)?\d{1,2}(?:\.\d{1,2})*[.):]?|\(\d{1,2}\)|(?:[a-z]|[ivx]{2,4})[.)]"
    r"|\((?:[a-z]|[ivx]{2,4})\))(?:[ \t]+-)?[ \t]+|[-*\u2022\u00b7][ \t]*)?"
    r"(?:(?:the|this)[ \t]+|details[ \t]+of(?:[ \t]+the)?[ \t]+)?"
)
# ...and never another period's: "The previous reporting period covers the year
# ended 30 June 2025" (VIT's next line), "Previous corresponding reporting
# period:", "Comparative reporting period:", or a label wrapped after its first
# words.
_OTHER_PERIOD_LABEL_RE = re.compile(r"(?i)\b(?:previous|prior|comparative|corresponding|preceding)\s+$")
# A label over its value on the next line is not read when it is a table's
# header row: the line above it is another period's label with no value of its
# own ("Previous corresponding period", never "Corresponding period" alone),
# and the line after its value starts with another, the row of values in the
# labels' order ("Previous corresponding period / Current period / Year ended
# 30 June 2025 / Year ended 30 June 2026"). Read, it gave the prior year. A
# wrapped heading over "Reporting period:", its value, and then "Previous
# corresponding period: Year ended 30 June 2024" is no header row: that line
# starts with a label. Both conditions are needed:
# ADH's FY26 Appendix 4E (idsId=03128778) wraps its item 1 heading ("DETAILS OF
# THE CURRENT REPORTING PERIOD AND THE PRIOR / CORRESPONDING PERIOD") right
# above "Current period:", over its own value, then "Prior corresponding
# period:" and that one's; wrapped a word earlier, the line above it would read
# as a label. Of the 429 next-line statements over a period in the stored texts
# (2026-10-13), ADH's is the only one under such a heading tail, and none is in
# a header row.
_OTHER_PERIOD_LABEL_LINE_RE = re.compile(
    r"(?i)[ \t\f]*(?:previous|prior|comparative|preceding)(?:[ \t]+corresponding)?(?:[ \t]+(?:reporting|financial))?"
    r"[ \t]+period(?:[ \t]*\([^()\n]{1,30}\))?[ \t]*[:\-]?[ \t]*"
)
# What a value row may start with before its period: what the statement's own
# value may (_REPORTING_PERIOD_RE's tail: ": ", "- the ", "For the ").
_VALUE_ROW_LEAD_RE = re.compile(r"(?i)[:\-]?\s*(?:(?:is|being|covers|for|the)\s+)*")
# A period phrase its line introduces as the comparison, within the 80
# characters before it and with no clause break between, is never the
# document's own. NHC's FY26 Appendix 4E (idsId=03139480) gives its year only as
# "From 1 August 2025 to 31 July 2026"; its one period phrase is "the previous
# comparative period being the full year ended 31 July 2025". Santos's 2025
# Appendix 4E (idsId=03061561) has only "Comparisons are made to the financial
# year ended 31 December 2024". Both were read as their own period; now neither
# states one, and the readers place it from the report date.
_COMPARATIVE_LEAD_RE = re.compile(
    r"(?i)\b(?:previous|prior|comparative|corresponding|preceding|pcp|comparisons?|compared\s+(?:with|to)"
    r"|versus|vs)\b\.?[^\n.,;]*$"
)
# ...nor one it says is still to be reported, once that period ended long
# before the document was lodged. VIG's FY2025 annual report (idsId=03144078,
# lodged 25 September 2026) says "year ended 30 June 2025" four times, and its
# events after the reporting period close "to be disclosed in the financial
# report for the half-year ended 31 December 2025", the latest period it names,
# which was read as its own. Of every period phrase in the stored texts
# (2026-10-13), only that one has such a lead ("will be paid for the year
# ended", a dividend for the document's own year, is not one). A document
# lodged on time comes within about 3 months of its period's end and may name
# its own period only so ("Further details will be included in the financial
# report for the half-year ended 31 December 2025"), so with a report date the
# lead counts only for a period that ended at least _STILL_TO_COME_MIN_MONTHS
# calendar months before it (VIG's half ended 9 before); without one it always
# counts. So a late document is kept from a later period only when that period
# ended so long before it: VIG's report lodged in May 2026 would read the half
# (no stored text is such a document, 2026-10-13).
_STILL_TO_COME_LEAD_RE = re.compile(
    r"(?i)\b(?:to|will)\s+be\s+(?:disclosed|reported|included|presented|released|lodged|recogni[sz]ed)\b"
    r"[^\n.,;]*$"
)
_STILL_TO_COME_MIN_MONTHS = 6
_COMPARATIVE_LEAD_CHARS = 80
# A document lodged long after its period, more than _LATE_DOCUMENT_MONTHS
# calendar months after the latest month a period phrase ends in, names later
# periods that have ended too: an FY2025 annual report lodged in September 2026
# that raised capital "during the half-year ended 31 December 2025". Its own
# period is then the month the most phrases end in (_period).
_LATE_DOCUMENT_MONTHS = 7


def _report_date(value: Any) -> _dt.date | None:
    """extract_document_meta's report_date: a datetime.date (a datetime's date)
    or an ISO "YYYY-MM-DD" string; anything else is no report date."""
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    if _valid_iso_date(value):
        return _dt.date.fromisoformat(value)
    return None


def _months_before(end: tuple[int, ...], before: tuple[int, ...]) -> int:
    """Calendar months from a period's end (year, month[, day]) to the report
    date, the day aside."""
    return (before[0] - end[0]) * 12 + before[1] - end[1]


def _raw_end(m: re.Match) -> tuple[int, int, int]:
    """A period phrase's end as written, (year, month, day), a real date or not."""
    return int(m.group("year")), _MONTHS[m.group("month").lower()], int(m.group("day"))


def _period_type(m: re.Match) -> str:
    kind = m.group("kind").lower()
    return "half" if kind.startswith("half") or kind.startswith("six") else "annual"


def _period_of(m: re.Match) -> tuple[tuple[int, int, int], str] | None:
    """The end (as written) and type a period phrase or range states, or None
    for a range that is not one half or one year, or whose kind word says
    otherwise ("half-year ended 1 July 2025 to 30 June 2026")."""
    end = _raw_end(m)
    kind = _period_type(m) if m.group("kind") else ""
    if not m.group("year_start"):
        return end, kind
    try:
        start = _dt.date(int(m.group("year_start")), _MONTHS[m.group("month_start").lower()], int(m.group("day_start")))
        days = (_dt.date(*end) - start).days
    except ValueError:
        return None  # an impossible date: no span to judge
    span = next((t for t, d in _SPAN_DAYS if abs(days - d) <= _SPAN_TOLERANCE_DAYS), "")
    if not span or kind not in ("", span):
        return None
    return end, span


def _own_period_statement(folded: str, before: tuple[int, int, int] | None) -> tuple[tuple[int, int, int], str] | None:
    """The end and type of the first reporting-period statement whose period
    ends before `before` (the report date; None: any)."""
    for m in _REPORTING_PERIOD_RE.finditer(folded):
        line_start = folded.rfind("\n", 0, m.start()) + 1
        if not _STATEMENT_LEAD_RE.fullmatch(folded, line_start, m.start()):
            continue
        if _OTHER_PERIOD_LABEL_RE.search(folded[max(0, m.start() - 40):m.start()]):
            continue
        value = _PERIOD_RE.match(folded, m.end()) or _RANGE_RE.match(folded, m.end())
        if value and "\n" in folded[m.end("label"):m.end()] and _in_a_header_row(folded, m.start(), value.end()):
            continue  # its value is the other period's
        period = _period_of(value) if value else None
        if period and (before is None or period[0] < before):
            return period
    return None


def _in_a_header_row(folded: str, label_pos: int, value_end: int) -> bool:
    """Whether a label over its value on the next line is in a table's header
    row (_OTHER_PERIOD_LABEL_LINE_RE): another period's label alone on the line
    above it, and the line after its value starting with another period phrase
    or range."""
    above = _lines_before(folded, label_pos, 1)
    if not above or not _OTHER_PERIOD_LABEL_LINE_RE.fullmatch(above[0]):
        return False
    after = _lines_after(folded, value_end, 1)
    if not after:
        return False
    row = after[0].strip()
    row = row[_VALUE_ROW_LEAD_RE.match(row).end():]  # "For the year ended ...", "- the year ended ..."
    return bool(_PERIOD_RE.match(row) or _RANGE_RE.match(row))


def _introduced_as_another_period(folded: str, m: re.Match, before: tuple[int, int, int] | None) -> bool:
    """Whether the line of the period phrase m introduces it as the comparison,
    or as a period still to be reported that ended _STILL_TO_COME_MIN_MONTHS
    or more before `before` (the report date; None: any)."""
    line_start = folded.rfind("\n", 0, m.start()) + 1
    lead = folded[max(line_start, m.start() - _COMPARATIVE_LEAD_CHARS):m.start()]
    if _COMPARATIVE_LEAD_RE.search(lead):
        return True
    return bool(_STILL_TO_COME_LEAD_RE.search(lead)) and (
        before is None or _months_before(_raw_end(m), before) >= _STILL_TO_COME_MIN_MONTHS
    )


def _period(folded: str, report_date: _dt.date | None = None) -> tuple[str, str] | None:
    """The document's own period end and type: its reporting-period
    statement's, else the latest month a period phrase ends in. A phrase that
    ends on or after the report date is never the document's own (a results
    document reports a period that ended before it was lodged): a forecast's
    "for the year ended 31 December 2026" (NIC's 1H26 report,
    idsId=03130351), an auditor's "for the half-year ended 13 March 2026", the
    date it signed (BGD's 1H26 report, idsId=03072033, lodged that day)."""
    before = (report_date.year, report_date.month, report_date.day) if report_date else None
    period = _own_period_statement(folded, before)
    if period is None:
        phrases = []
        for p in _PERIOD_RE.finditer(folded):
            found = _period_of(p)
            if found and (before is None or found[0] < before) and not _introduced_as_another_period(folded, p, before):
                phrases.append(found)
        if not phrases:
            return None
        # Ends compare by month, so a slip in the day never outranks the month
        # written correctly: C7A's FY26 annual report (idsId=03146180) lists
        # "Statement of Cash Flows for the Year Ended 31 June 2026" among four
        # "Year Ended 30 June 2026". The month's first phrase gives the day.
        months = [end[:2] for end, _ in phrases]
        latest = max(months)
        # A late document's own period is the one it names most
        # (_LATE_DOCUMENT_MONTHS): an FY2025 annual report lodged on 25
        # September 2026 that names "year ended 30 June 2025" twice and
        # "during the half-year ended 31 December 2025, the Company raised $2.0
        # million" once is the year's. A tie still reads the later month: with
        # each named once ("On 27 February 2026 the Company released its
        # results for the half-year ended 31 December 2025") it reads the half.
        # The rule does not know the document's kind: a late half-year report
        # that names the prior year more often than its half reads the year
        # (no stored text is one, 2026-10-13).
        if before is not None and _months_before(latest, before) > _LATE_DOCUMENT_MONTHS:
            latest = max(set(months), key=lambda month: (months.count(month), month))
        same_month = [found for found in phrases if found[0][:2] == latest]
        # The type most of them give, the first one's when as many give each:
        # SGR's FY26 Appendix 4E (idsId=03133185) sets a "Half year ended" table
        # header over "30 June 2026" before five "year ended 30 June 2026".
        types = [period_type for _, period_type in same_month]
        period = same_month[0][0], max(dict.fromkeys(types), key=types.count)
    end, period_type = period
    try:
        return _dt.date(*end).isoformat(), period_type
    except ValueError:
        return None  # an impossible date is withheld, never another phrase's


# --- report kind -------------------------------------------------------------

# Statutory kinds, tried in this order over every page read.
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
]

# The document's head: where it names itself. Lines that START within the
# first _HEAD_CHARS characters, at most _HEAD_LINES non-empty ones.
_HEAD_CHARS = 400
_HEAD_LINES = 5

# Results-announcement phrases that count only in the head: a results release
# names itself "FY26 Full Year Results" or "Results Release" at the top, while
# a presentation's slides say "our half year results" throughout. A results
# presentation, briefing, webcast or call is not a results announcement.
_HEAD_RESULTS_RE = re.compile(
    r"\bresults?\s+release\b"
    r"|\b(?:full|half)[\s-]?year\s+results\b"
    r"(?!\s+(?:investor\s+|analyst\s+)?(?:presentation|briefing|webcast|call|teleconference|transcript)s?\b)",
    re.IGNORECASE,
)

# "other": the head names the document a presentation, a Pillar 3 disclosure,
# a transcript or a webcast. "presentation" needs a qualifier that makes it
# the document ("Investor Presentation", "FY26 Results Presentation"), so
# "presentation currency" and "basis of presentation" never match. A
# transcript or webcast is the heading's last word ("Earnings Call Transcript",
# "FY26 Results Webcast", optionally followed by a date), or a transcript
# leads it ("Transcript: FY26 results briefing"), so "Webcast details" and
# "Results webcast: 10am" do not name the document.
_MONTH_WORDS = (
    r"(?:january|february|march|april|may|june|july|august|september|october|november|december"
    r"|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)"
)
_HEADING_DATE_TAIL = r"(?:\s*[-:|,]?\s*(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:" + _MONTH_WORDS + r"\s+)?\d{4})?[\s.]*$"
_OTHER_HEADING_RE = re.compile(
    r"\b(?:investor|results?|earnings|briefing|analysts?|strategy|agm"
    r"|full[\s-]?year|half[\s-]?year|interim|fy\s?\d{2,4}|hy\s?\d{2,4}"
    r"|[12]h\s?(?:fy)?\s?\d{2,4}|h[12]\s?(?:fy)?\s?\d{2,4})\s+presentation\b"
    r"|\bpresentation\s+to\s+(?:investors|analysts|shareholders)\b"
    r"|\bpillar\s*(?:3|iii)\b"
    r"|\b(?:transcript|webcast)s?" + _HEADING_DATE_TAIL
    + r"|^(?:\w+\s+){0,2}transcripts?\s*[-:|]",
    re.IGNORECASE,
)
# A line that reads as a sentence is prose about something, not the
# document's own heading: a verb or connective no heading carries ("may" is
# left out: it is also a month), or a sentence boundary inside the line.
_PROSE_WORDS_RE = re.compile(
    r"\b(?:will|would|shall|can|is|are|was|were|be|been|being|has|have|had|held|hosts?|hosted|hosting"
    r"|see|refer|refers|referred|accompany|accompanies|accompanying|conjunction|available|attached|join"
    r"|listen|register|access|via|please|following|follows|provided|included|released|lodged)\b",
    re.IGNORECASE,
)
# Case-sensitive: a full stop then a capital starts a new sentence ("Results
# announcement. A webcast follows."); "Aug. 2026" does not.
_SENTENCE_BOUNDARY_RE = re.compile(r"[.!?;]\s+[A-Z]")
_MAX_HEADING_CHARS = 100
_MAX_HEADING_WORDS = 12


def _head_lines(folded: str) -> list[str]:
    """The document's first non-empty lines (whitespace collapsed): each starts
    within the first _HEAD_CHARS characters, at most _HEAD_LINES of them. A line
    is taken whole, so a sentence is never cut into something that reads as a
    heading."""
    lines: list[str] = []
    offset = 0
    for raw in folded.split("\n"):
        if offset >= _HEAD_CHARS or len(lines) >= _HEAD_LINES:
            break
        offset += len(raw) + 1
        line = " ".join(raw.split())
        if line:
            lines.append(line)
    return lines


def _is_heading(line: str) -> bool:
    return (
        len(line) <= _MAX_HEADING_CHARS
        and len(line.split()) <= _MAX_HEADING_WORDS
        and not _PROSE_WORDS_RE.search(line)
        and not _SENTENCE_BOUNDARY_RE.search(line)
    )


def _names_itself_other(head: list[str]) -> bool:
    return any(_OTHER_HEADING_RE.search(line) and _is_heading(line) for line in head)


def _report_kind(folded: str) -> str:
    for pattern, kind in _REPORT_KIND_RULES:
        if pattern.search(folded):
            return kind
    head = _head_lines(folded)
    # The head's own name first: "FY26 Full Year Results Presentation" over a
    # "Full year results for the year ended ..." subtitle beneath it.
    if _names_itself_other(head):
        return "other"
    if any(_HEAD_RESULTS_RE.search(line) for line in head):
        return "results_announcement"
    return ""


# --- entry point -------------------------------------------------------------


def extract_document_meta(text: str, report_date: _dt.date | str | None = None) -> dict[str, str]:
    """document_meta for a document's raw text (the pages read). Only keys the
    text supports are present; the result is already validated against the
    closed vocabulary. An empty dict means nothing was found.

    report_date is the day the document was lodged, a datetime.date (a
    datetime's date) or an ISO "YYYY-MM-DD" string; anything else is ignored.
    A period that ends on or after it is not the document's own. Pass it
    whenever it is known: without it every period phrase counts, a forecast's
    "year ended 30 June 2027" included."""
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
    period = _period(folded, _report_date(report_date))
    if period:
        meta["period_end"], meta["period_type"] = period
    kind = _report_kind(folded)
    if kind:
        meta["report_kind"] = kind
    return validate_document_meta(meta)
