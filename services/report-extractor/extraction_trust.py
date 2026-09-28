"""Python port of the trust rules in services/pkg/extractiontrust (Go).

Design contract: docs/plans/fundamentals-coverage.md, sections 4.1 and 6.1.
The Go package is the ONE trust funnel for every reader of
financial_report_extractions; this module ports the parts the extractor itself
applies before a row is written or a digest prompt is built:

  - normalise(): the comparison form of a quote or a headline (typographic
    punctuation folded to ASCII, invisible characters removed, lower case,
    whitespace collapsed). Mirrors extractiontrust.Normalise.
  - is_results_document(): the statutory-results headline classifier, ported
    pattern for pattern from extractiontrust.IsResultsDocument. The shared
    fixture services/pkg/extractiontrust/testdata/results_titles.json pins both
    languages (test_extraction_trust.py and results_titles_test.go).
  - FewShotDenylist / grounded_entry(): an entry the extractor could not align,
    or whose quote is a few-shot example text (old or new), is not trusted.
    Never a value match.
  - strip_provenance(): the alignment bookkeeping (alignment, char_start,
    char_end) never reaches an LLM prompt.

Every pattern here is copied from the Go source unchanged and compiled with
re.ASCII, so \\b and \\s mean what they mean in Go's RE2.

This module has no third-party dependencies.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Sequence

# --- normalise ---------------------------------------------------------------

# Mirrors extractiontrust.foldReplacer exactly: typographic punctuation onto its
# ASCII form, invisible characters deleted.
_FOLD = {
    # Single quotes, apostrophes and primes.
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'", "\u2032": "'", "\u00B4": "'",
    # Double quotes and double primes.
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"', "\u2033": '"', "\u00AB": '"', "\u00BB": '"',
    # Hyphens, dashes and the minus sign.
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-",
    "\u2212": "-", "\uFE58": "-", "\uFE63": "-", "\uFF0D": "-",
    # Ellipsis.
    "\u2026": "...",
    # Invisible characters: zero-width space/joiners, word joiner, BOM, soft hyphen.
    "\u200B": "", "\u200C": "", "\u200D": "", "\u2060": "", "\uFEFF": "", "\u00AD": "",
}
_FOLD_TABLE = str.maketrans(_FOLD)


def fold(s: str) -> str:
    """Typographic punctuation folded to ASCII and invisible characters removed
    (no case or whitespace change)."""
    return (s or "").translate(_FOLD_TABLE)


def normalise(s: str) -> str:
    """extractiontrust.Normalise: fold, lower-case, collapse whitespace, trim."""
    return " ".join(fold(s).lower().split())


# --- is_results_document -----------------------------------------------------

REPORT_KIND_APPENDIX_4E = "appendix_4e"
REPORT_KIND_APPENDIX_4D = "appendix_4d"
REPORT_KIND_ANNUAL_REPORT = "annual_report"
REPORT_KIND_HALF_YEAR_REPORT = "half_year_report"
REPORT_KIND_RESULTS_ANNOUNCEMENT = "results_announcement"
REPORT_KIND_OTHER = "other"

STATUTORY_REPORT_KINDS = frozenset({
    REPORT_KIND_APPENDIX_4E,
    REPORT_KIND_APPENDIX_4D,
    REPORT_KIND_ANNUAL_REPORT,
    REPORT_KIND_HALF_YEAR_REPORT,
    REPORT_KIND_RESULTS_ANNOUNCEMENT,
})

# Period words that introduce a results headline (Go: periodWords).
_PERIOD_WORDS = (
    r"(?:full[\s-]?year|half[\s-]?year(?:ly)?|interim|fy\s?\d{2,4}|hy\s?\d{2,4}"
    r"|[12]h\s?(?:fy)?\s?\d{2,4}|h[12]\s?(?:fy)?\s?\d{2,4})"
)

# Go: resultsTitlePatterns.
RESULTS_TITLE_PATTERNS = [
    r"\bappendix\s*4[de]\b",
    r"\bresults?\s+for\s+announcement\s+to\s+the\s+market\b",
    r"\bpreliminary\s+final\b",
    r"\bannual\s+(?:financial\s+)?report\b",
    r"\b(?:half[\s-]?year(?:ly)?|interim|yearly)\s+(?:financial\s+)?report\b",
    r"\b" + _PERIOD_WORDS + r"\b[^.]{0,40}\b(?:results?|financial\s+statements?|accounts)\b",
    r"\bresults?\s+(?:release|announcement|summary)\b",
    r"\bfinancial\s+(?:report|statements?)\b",
    r"\bresults?\b[^.]{0,30}\bfor\s+(?:the\s+)?(?:(?:financial\s+)?year|half[\s-]?year|half|six\s+months|twelve\s+months|12\s+months|period)\b",
    r"\bprofit\s+announcement\b",
]

# Go: strongStatutoryPatterns.
STRONG_STATUTORY_PATTERNS = [
    r"\bappendix\s*4[de]\b",
    r"\bresults?\s+for\s+announcement\s+to\s+the\s+market\b",
    r"\bpreliminary\s+final\b",
    r"\bresults?\s+(?:release|announcement|summary)\b",
    r"\bfinancial\s+report\s+for\b",
    r"\b(?:half[\s-]?year(?:ly)?|interim)\s+(?:financial\s+)?report\b",
    r"\bannual\s+financial\s+report\b",
]

# Go: hardExclusionPatterns.
HARD_EXCLUSION_PATTERNS = [
    r"\bpillar\s*(?:3|iii)\b",
    r"\bbasel\b",
    r"\baps\s*330\b",
    r"\bitems?\s+impacting\b",
    r"\b20-?f\b",
    r"\bwebcasts?\b",
    r"\btranscripts?\b",
    r"\binvestor\s+(?:day|days|briefing|strategy\s+day)\b",
    r"\bcapital\s+markets?\s+day\b",
    r"\bstrategy\s+day\b",
    r"\bbriefings?\b",
    r"\b(?:discussion|investor|data|analyst)\s+pack\b",
    r"\bdata\s*book\b",
    r"\bfact\s*sheet\b",
    r"\bagm\s+(?:address|speech|presentation)\b",
    r"\b(?:chair(?:man|woman|person)?|ceo|md|managing\s+director)(?:'s|s'|s)?\s+(?:agm\s+)?(?:address|speech)\b",
    r"\baddress\s+to\s+(?:share|security|unit)\s?holders\b",
    r"\bresults?\s+of\s+(?:the\s+)?(?:\d{4}\s+)?(?:annual\s+general\s+|general\s+|extraordinary\s+general\s+|extraordinary\s+)?meeting\b",
    r"^notice\s+of\b",
    r"\bresults?\s+(?:announcement\s+|release\s+)?dates?\b",
    r"^(?:update\s*-\s*)?dividend/distribution\b",
    r"^confirmation\s+of\b.*\bdividend\b",
    r"\b(?:dividend|distribution)\s+(?:notice|reinvestment)\b",
]

# Go: presentationPatterns (excluded unless an Appendix 4D/4E is named).
PRESENTATION_PATTERNS = [
    r"\bpresentations?\b",
    r"\bslides?\b",
]

# Go: softExclusionPatterns (excluded unless a strong statutory marker).
SOFT_EXCLUSION_PATTERNS = [
    r"\bwebinars?\b",
    r"\bconference\s+call\b",
    r"\bdial[-\s]?in\b",
    r"\bto\s+present\b",
    r"\bregistration\s+details\b",
]

_FLAGS = re.IGNORECASE | re.ASCII


def _join(patterns: Sequence[str]) -> re.Pattern[str]:
    return re.compile("(?:" + ")|(?:".join(patterns) + ")", _FLAGS)


_RESULTS_TITLE_RE = _join(RESULTS_TITLE_PATTERNS)
_STRONG_STATUTORY_RE = _join(STRONG_STATUTORY_PATTERNS)
_HARD_EXCLUSION_RE = _join(HARD_EXCLUSION_PATTERNS)
_PRESENTATION_RE = _join(PRESENTATION_PATTERNS)
_SOFT_EXCLUSION_RE = _join(SOFT_EXCLUSION_PATTERNS)
_APPENDIX_4DE_RE = re.compile(r"\bappendix\s*4[de]\b", _FLAGS)
_QUARTERLY_RE = re.compile(
    r"\bquarterly\b|\bquarter\b|\bappendix\s*4c\b|\b4c\b|\b[1-4]q\s?(?:fy)?\s?\d{2,4}\b|\bq[1-4]\b"
    r"|\bactivit(?:y|ies)\s+(?:report|statement|update)\b",
    _FLAGS,
)


def is_results_document(title: str, report_kind: str = "") -> bool:
    """extractiontrust.IsResultsDocument, rule for rule.

    The title decides; report_kind (document_meta.report_kind, "" when absent)
    can only veto ("other") or stand in for a missing title (a statutory kind).
    """
    kind = (report_kind or "").strip().lower()
    if kind == REPORT_KIND_OTHER:
        return False
    t = normalise(title)
    if t == "":
        return kind in STATUTORY_REPORT_KINDS
    if _HARD_EXCLUSION_RE.search(t):
        return False
    if _PRESENTATION_RE.search(t) and not _APPENDIX_4DE_RE.search(t):
        return False
    if _QUARTERLY_RE.search(t) and not _APPENDIX_4DE_RE.search(t):
        return False
    if _SOFT_EXCLUSION_RE.search(t) and not _STRONG_STATUTORY_RE.search(t):
        return False
    return _RESULTS_TITLE_RE.search(t) is not None


# --- few-shot denylist -------------------------------------------------------

# The example extract.py's EXTRACTION_EXAMPLES carried until contract 6.1,
# VERBATIM (including the line break inside the revenue sentence). Measured on
# prod 2026-09-28 the model echoed it back for BHP, CBA, DRO, EDV and MSB, so its
# texts stay on the denylist permanently. Mirrors extractiontrust's
# oldFewShotExample. It is data for the denylist only: never a prompt example.
RETIRED_FEWSHOT_TEXT = """Revenue from continuing operations for the half year ended 31 December 2024
was $5,142 million, an increase of 8% on the prior corresponding period.
Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp.
Basic earnings per share was 94.2 cents.
The Board declared an interim dividend of 45 cents per share, fully franked.
Operating cash flow was $2,156 million.
EBITDA was $2,891 million, representing a margin of 56.2%.
FY2025 guidance: Revenue growth of 6-8% expected."""

RETIRED_FEWSHOT_EXTRACTION_TEXTS = (
    "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
    "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp",
    "Basic earnings per share was 94.2 cents",
    "interim dividend of 45 cents per share, fully franked",
    "Operating cash flow was $2,156 million",
    "EBITDA was $2,891 million, representing a margin of 56.2%",
    "FY2025 guidance: Revenue growth of 6-8% expected",
)

_SENTENCE_END = re.compile(r"\.\s+")


def fewshot_key(s: str) -> str:
    """extractiontrust.fewShotKey: normalise, then drop trailing sentence
    punctuation and spaces."""
    return normalise(s).rstrip(" .;:,")


def fewshot_texts(text: str, extraction_texts: Iterable[str]) -> list[str]:
    """extractiontrust.fewShotTexts: every extraction text, then each sentence
    of the document not already listed, then the whole document; duplicates
    (by fewshot_key) dropped, first occurrence kept."""
    out: list[str] = []
    seen: set[str] = set()

    def add(s: str) -> None:
        s = s.strip()
        k = fewshot_key(s)
        if not k or k in seen:
            return
        seen.add(k)
        out.append(s)

    for t in extraction_texts:
        add(t)
    collapsed = " ".join(text.split())
    for sentence in _SENTENCE_END.split(collapsed):
        sentence = sentence.strip()
        if not sentence:
            continue
        if not sentence.endswith("."):
            sentence += "."
        add(sentence)
    add(collapsed)
    return out


class FewShotDenylist:
    """The texts of every few-shot example the extractor has ever prompted with
    (extractiontrust.IsFewShotText). Built from (text, extraction_texts) pairs."""

    def __init__(self, examples: Iterable[tuple[str, Sequence[str]]]):
        self._keys: set[str] = set()
        self.texts: list[str] = []
        for text, extraction_texts in examples:
            for t in fewshot_texts(text, extraction_texts):
                self.texts.append(t)
                k = fewshot_key(t)
                if k:
                    self._keys.add(k)

    def __contains__(self, source_text: object) -> bool:
        if not isinstance(source_text, str):
            return False
        k = fewshot_key(source_text)
        return bool(k) and k in self._keys


# --- grounding and provenance ------------------------------------------------

KEY_SOURCE_TEXT = "source_text"
KEY_ALIGNMENT = "alignment"
KEY_CHAR_START = "char_start"
KEY_CHAR_END = "char_end"
PROVENANCE_KEYS = frozenset({KEY_ALIGNMENT, KEY_CHAR_START, KEY_CHAR_END})

# langextract alignment_status values that mean "found in the document".
ALIGNED_STATUSES = frozenset({"match_exact", "match_greater", "match_lesser", "match_fuzzy"})


def is_provenance_key(k: str) -> bool:
    return k in PROVENANCE_KEYS


def grounded_entry(entry: Mapping[str, Any], denylist: FewShotDenylist) -> bool:
    """extractiontrust.GroundedEntry: a present "alignment" must be a string in
    ALIGNED_STATUSES, and the quote must not be a few-shot example text. Legacy
    entries without "alignment" pass the alignment half."""
    if KEY_ALIGNMENT in entry:
        a = entry[KEY_ALIGNMENT]
        if not isinstance(a, str) or a.strip() not in ALIGNED_STATUSES:
            return False
    text = entry.get(KEY_SOURCE_TEXT)
    return (text if isinstance(text, str) else "") not in denylist


def strip_provenance(entry: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of entry without the provenance keys (the input is not changed)."""
    return {k: v for k, v in entry.items() if not is_provenance_key(k)}


def trusted_metrics(metrics: Mapping[str, Any] | None, denylist: FewShotDenylist) -> dict[str, Any]:
    """The metrics dict an LLM prompt may see: entries failing grounded_entry
    dropped, provenance keys stripped, a class left with no entry removed. The
    stored shape (class -> entry, or class -> [entries]) is kept."""
    out: dict[str, Any] = {}
    for cls, value in (metrics or {}).items():
        entries = value if isinstance(value, list) else [value]
        kept = [strip_provenance(e) for e in entries if isinstance(e, Mapping) and grounded_entry(e, denylist)]
        if not kept:
            continue
        out[cls] = kept if isinstance(value, list) else kept[0]
    return out
