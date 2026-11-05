"""Withheld substantial holding notices, read by a model under the extractor's consensus.

The parser (services/jobs/internal/jobs/ownership, notice.go) withholds a notice it cannot
read: no_text (a scan), no_voting_power, or no_holder. This module offers those notices to a
second reader, built the way director_direct.py and direct_extract.py are built:

  * PRIMARY (deepseek/deepseek-v4-flash) and CHECKER (google/gemini-2.5-flash-lite) read the
    notice independently; ARBITER (google/gemini-2.5-flash) decides a disagreement; no
    two-of-three majority is withheld.
  * A text-layer PDF is read as its first TEXT_PAGES pages of text. A scan (the first page
    holds fewer than MIN_TEXT_CHARS characters of text layer) is rasterised and sent as
    page images read by two vision models (SCAN_PRIMARY_MODEL, SCAN_CHECKER_MODEL; the text
    primary is text-only, and there is no arbiter); both must state the same figures and holder,
    since no quote of a scan can be located in its text.
  * Every answer is VALIDATED in code (validate_notice) before it can count as a reading:
    the form agrees with the ASX headline; the holder is named in the notice and is not a
    placeholder (the parser's placeholder rules, ported from notice.go); each stated figure
    has a quote that is in the text and contains the number; a change notice (604) states
    both percentages; a 603 states the present figure; a 605 states the previous figure and
    is the only form that ceases a holding; the votes fit ASIC's share count as at the
    notice's date with the parser's own tolerance (notices.go votesConsistent: a ratio in
    [0.5, 2]).
  * A model that cannot answer raises direct_extract.ModelCallError. The notice is then NOT
    recorded as an attempt (the next run retries it), and the run exits 1 when the model
    errors look systemic.

Writing (write_recovered / record_read): a recovered notice is upserted into
substantial_holder_notices with read_by = 'model' and the parser's current parser_version, and
only where no row exists or the existing row was itself read by a model. The attempt row becomes
outcome 'parsed', read_by 'model'. A withheld second read keeps the parser's outcome and gets
read_by 'model' and a detail beginning "model:", so the notice is not offered again.

Run (the financial-report-extractor job, by hand or as a Cloud Run job argument):
  DATABASE_URL=... OPENROUTER_API_KEY=... python extract_reports_concurrent.py --notices \
      [--limit N] [--workers 4] [--budget-min 90] [--since 2026-01-01] [--no-dry-run]
Dry run is the default: it prints what it would write and writes nothing.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import requests

import direct_extract as dx
import director_direct as dd
from dataclasses import replace

log = logging.getLogger("notice_direct")

# notice.go's noticeParserVersion: a row the parser wrote carries it, and a model's write carries
# the same, so the Go pass's refusal rule treats a model-read row as current. test_notice_direct
# reads the Go constant and fails when the two drift.
NOTICE_PARSER_VERSION = 3

# A scan is sent as page images, so its two readers must accept images. The text primary
# (dx.PRIMARY_MODEL) is text-only on OpenRouter (input_modalities: text), so a scan never goes to
# it: its readers are these two vision models, and a disagreement is withheld, with no arbiter
# (a third read by one of the two would not be independent). test_notice_direct pins this.
SCAN_PRIMARY_MODEL = "google/gemini-2.5-flash-lite"
SCAN_CHECKER_MODEL = "google/gemini-2.5-flash"

FORMS = ("603", "604", "605")
TEXT_PAGES = 4
TEXT_CHARS = 16000
SCAN_PAGES = 4
MIN_TEXT_CHARS = 100          # a page with less text layer than this is a scan (the spec's rule)
FIVE_PCT = 4.95               # the parser's threshold: 4.995% rounds to 5.00 and is substantial
MAX_CHANGE_POINTS = 50        # a change of over 50 points is not one a register shows (parser: changeOver50)
VOTES_RATIO_LOW, VOTES_RATIO_HIGH = 0.5, 2.0   # notices.go votesConsistent
# notices.go nameTails (in order): the boilerplate that follows a holder's name in section 1.
# test_notice_direct.py parses the Go list and fails when this copy drifts.
NAME_TAILS = (
    " and its related bodies corporate", " and its related body corporate", " and related bodies corporate",
    " and its associates", " and its affiliates", " and affiliates", " and its subsidiaries",
    " and subsidiaries", " and its controlled entities", " and controlled entities",
    " and its controlled bodies corporate", " and each of its", " and each of the related", " on behalf of",
    " in its capacity as", " as trustee for", " as responsible entity", " (", ";",
    " and its subsidiary companies", " and each of ", " and each other entity", " and the entities listed",
    " and the other entities", " and entities listed", " - a subsidiary of", " a subsidiary of", "__",
    " and its entities",
)
NO_SHARE_COUNT_OUTCOME = "invalid_no_share_count"  # extract()'s outcome when no count is on record
MAX_SYSTEMIC_ERRORS = 5       # the run exits 1 at this many model errors (or 3 at a fifth of the calls)

SYSTEM_PROMPT = """You read an ASX substantial holding notice (Form 603, 604 or 605) for a database that publishes who holds what in ASX companies. A wrong figure is far worse than a missing one.

Return ONLY a JSON object:
{
  "is_substantial_holder_notice": true | false,
  "holder_name": "the substantial holder named in section 1, copied exactly as written (a person or entity, never the company); null if none",
  "form": "603" | "604" | "605" | null,
  "previous_pct": number | null,
  "previous_votes": integer | null,
  "present_pct": number | null,
  "present_votes": integer | null,
  "event_date": "YYYY-MM-DD" | null,
  "ceased": true | false,
  "quotes": {
    "holder_name": "the words of the notice that name the holder",
    "previous_pct": "the words that state the previous percentage",
    "previous_votes": "the words that state the previous number of votes",
    "present_pct": "the words that state the present percentage",
    "present_votes": "the words that state the present number of votes",
    "event_date": "the words that state the date of the change"
  }
}

Rules:
1. Form 603 (becoming a substantial holder): present figures only. Form 604 (change in a substantial holding): both previous and present. Form 605 (ceasing to be a substantial holder): previous is stated, present may be absent, and ceased is true. Only a 605 has ceased true.
2. Copy every figure from the voting power table of the notice exactly as written. Never compute a figure, never add rows together, and never take a figure from an annexure, a covering letter or a contract.
3. For every figure, quote the exact words of the notice that state it (at most 200 characters, verbatim). A figure with no quote is null.
4. If the document is not a substantial holding notice, set is_substantial_holder_notice to false and every other field to null.
5. If the voting power is not stated in the notice itself, leave its figures null.
"""

SCAN_USER_MESSAGE = "The notice is a scanned document; the page images follow. Read them."

_PLACEHOLDER_POINTERS = {
    "see", "refer", "attached", "attachment", "attachments", "annexed", "enclosed", "herewith", "below",
    "above", "annex", "annexe", "annexure", "annexures", "appendix", "appendices", "schedule", "schedules",
    "per", "applicable", "na", "n/a",
}
_PLACEHOLDER_GLUE = {
    "a", "an", "the", "as", "to", "in", "of", "and", "or", "on", "at", "for", "by", "from", "with", "is",
    "are", "its", "their", "this", "these", "those", "other", "others", "each", "all", "any", "please", "not",
    "listed", "details", "detail", "following", "follows", "including", "subsidiaries", "subsidiary",
    "entities", "entity", "associates", "affiliates", "related", "bodies", "corporate", "controlled",
    "companies", "holder", "holders", "list", "lists", "register", "statement", "statements", "copy",
    "copies", "page", "pages", "section", "form", "notice", "number", "numbers", "name", "names",
}
_PLACEHOLDER_LEADS = {"refer", "annexure", "annexures", "appendix", "appendices"}
_LABEL_PHRASES = [
    "name", "names", "this notice", "is given by", "substantial holder", "notice of",
    "form 603", "form 604", "form 605", "acn/arsn", "holder became", "holder ceased", "there was a change",
]
_LABEL_RES = [re.compile(r"(?:^|[^\w])" + re.escape(p) + r"(?:$|[^\w])") for p in _LABEL_PHRASES]
_TOKEN_RE = re.compile(r"[^\W\d_]+|\d+")
_LEGAL_SUFFIXES = {
    "pty", "ltd", "limited", "inc", "llc", "plc", "lp", "llp", "ag", "sa", "nv", "bv", "corporation",
    "corp", "co", "the", "atf", "acn",
}


# --- names --------------------------------------------------------------------------


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower()


def clean_name(raw: Any) -> str:
    """The holder's name as the notice states it, with the stray punctuation a model or a
    text layer leaves at its edges removed. Never re-cased: the name is the notice's own."""
    s = " ".join(str(raw or "").split())
    return s.strip(" :;,.-\"'()")


def placeholder_reason(name: str) -> str:
    """Why a section 1 name is a placeholder, or "" for a holder. A port of notice.go
    placeholderReason: a pointer where the name belongs ("SEE ANNEXURE 1", "N/A"), a name
    that opens with a pointer, a form phrase, or nothing but single letters and labels."""
    if not name or not name.strip():
        return ""
    lower = " ".join(name.split()).lower()
    words = lower.split()
    tokens: list[str] = []
    for w in words:
        if w.strip(".,;:()[]\"'") == "n/a":
            tokens.append("n/a")
            continue
        tokens.extend(re.findall(r"[^\W_]+", w))
    tokens = _join_split_pointers(tokens)
    pointer = _pointer_only(tokens)
    if pointer:
        return f"matches {pointer!r}"
    lead = _leading_pointer(tokens)
    if lead:
        return f"opens with {lead!r}"
    if len(words) <= 3 and any(t in ("schedule", "schedules") for t in tokens):
        return 'matches "schedule" in a name of three words or fewer'
    for rx, phrase in zip(_LABEL_RES, _LABEL_PHRASES):
        if rx.search(lower):
            return f"contains {phrase!r}"
    letters = re.findall(r"[^\W\d_]+", lower)
    if not letters:
        return "no letter in it"
    if any(len(w) > 1 for w in letters):
        return ""
    return "every word is a single letter"


def _is_label(t: str) -> bool:
    return len(t) == 1 or t.strip("0123456789") == ""


def _join_split_pointers(tokens: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(tokens):
        step = 1
        for k in (3, 2):
            if i + k <= len(tokens):
                joined = "".join(tokens[i:i + k])
                if joined in _PLACEHOLDER_POINTERS:
                    out.append(joined)
                    step = k
                    break
        if step == 1:
            out.append(tokens[i])
        i += step
    return out


def _pointer_only(tokens: list[str]) -> str:
    best = ""
    for t in tokens:
        if t in _PLACEHOLDER_POINTERS:
            if len(t) > len(best):
                best = t
        elif t in _PLACEHOLDER_GLUE or _is_label(t):
            continue
        else:
            return ""
    return best


def _leading_pointer(tokens: list[str]) -> str:
    for t in tokens:
        if t in _PLACEHOLDER_GLUE or _is_label(t):
            continue
        return t if t in _PLACEHOLDER_LEADS else ""
    return ""


def tidy_holder_name(name: str) -> str:
    """notices.go / registry.go tidyHolderName: the name cut at its first boilerplate tail."""
    s = (name or "").strip()
    lower = s.lower()
    cut = len(s)
    for t in NAME_TAILS:
        i = lower.find(t)
        if i > 2 and i < cut:
            cut = i
    return s[:cut].strip().rstrip(" ,.:-")


def holder_key(name: str) -> str:
    """The grouping key of an institution-less holder, as the Go registry's holderKey: the
    tidied name, folded, with legal suffixes removed from both ends. "" when nothing is left."""
    words = re.findall(r"[^\W_]+", _fold(tidy_holder_name(name)).replace("&", " and ").replace("'", "").replace("’", ""))
    while words and words[-1] in _LEGAL_SUFFIXES:
        words.pop()
    while words and words[0] in _LEGAL_SUFFIXES:
        words.pop(0)
    return "name:" + " ".join(words) if words else ""


def institution_index(rows: list[tuple[str, str, list[str]]]) -> dict[str, str]:
    """Folded name or alias -> institution slug, for every name held by one institution only."""
    seen: dict[str, set[str]] = {}
    for slug, name, aliases in rows:
        for label in [name, *aliases]:
            k = " ".join(re.findall(r"[^\W_]+", _fold(label)))
            if k:
                seen.setdefault(k, set()).add(slug)
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1}


def name_in_text(name: str, text: str) -> bool:
    """Every name word (honorifics dropped) appears as a word of the notice's text."""
    toks = dd.name_tokens(name)
    if not toks:
        return False
    words = set(re.findall(r"[a-z]{2,}", _fold(text)))
    return all(t in words for t in toks)


# --- headline and share count ----------------------------------------------------------


def form_from_headline(headline: str) -> str:
    """The form the ASX headline names (notices.go formFromHeadline), or "" when none."""
    h = (headline or "").lower()
    if "becoming a substantial holder" in h or "initial substantial" in h:
        return "603"
    if "ceasing to be a substantial holder" in h:
        return "605"
    if "change in substantial holding" in h or "change of interests of substantial" in h:
        return "604"
    return ""


def votes_consistent(votes: Optional[int], pct: Optional[float], issued: float) -> bool:
    """notices.go votesConsistent: the share count the votes imply, over the count on issue,
    within the parser's tolerance. No votes, no percentage, or no count on issue: consistent."""
    if votes is None or pct is None or pct <= 0 or issued <= 0:
        return True
    ratio = (votes * 100.0 / pct) / issued
    return VOTES_RATIO_LOW <= ratio <= VOTES_RATIO_HIGH


def plausible_event_date(event: str, announced: str) -> str:
    """The event date when it falls in the year before the release (or the day after, for a
    timezone), as notices.go plausibleEventDate; "" otherwise."""
    import datetime as _dt

    try:
        e = _dt.date.fromisoformat(event)
        a = _dt.date.fromisoformat(announced)
    except (TypeError, ValueError):
        return ""
    if e > a + _dt.timedelta(days=1) or e < _year_before(a):
        return ""
    return event


def _year_before(a):
    """a.AddDate(-1, 0, 0) as Go computes it: 29 February of a leap year normalises to 1 March
    of the year before (Go's time package carries the overflowing day into March)."""
    import datetime as _dt

    try:
        return a.replace(year=a.year - 1)
    except ValueError:
        return _dt.date(a.year - 1, 3, 1)


# --- validation -----------------------------------------------------------------------


@dataclass
class Notice:
    form: str
    holder_name: str
    holder_key: str
    institution_slug: Optional[str]
    event_date: Optional[str]
    previous_pct: Optional[float]
    present_pct: Optional[float]
    previous_votes: Optional[int]
    present_votes: Optional[int]
    ceased: bool
    model: str = ""

    def figures(self) -> tuple:
        return (self.form, self.holder_name, _r(self.previous_pct), _r(self.present_pct),
                self.previous_votes, self.present_votes, self.ceased)


def _r(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(float(v), 4)


def _pct(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(str(v).replace("%", "").replace(",", "").strip())
    except ValueError:
        return None
    return f


def _votes(v: Any) -> Optional[int]:
    if v is None or isinstance(v, bool):
        return None
    c = dx.canonical(str(v))
    if c is None or "." in c:
        return None
    return int(c)


def date_in_quote(event: str, quote: str) -> bool:
    """The day, month and year of an ISO date each appear in the quote that states it: as
    numbers ("14/10/2026", "14 October 2026") or, for the month, by its English name."""
    import calendar
    import datetime as _dt

    try:
        d = _dt.date.fromisoformat(event)
    except (TypeError, ValueError):
        return False
    nums = set(re.findall(r"\d+", quote or ""))
    folded = _fold(quote or "")
    month_name = calendar.month_name[d.month].lower()
    return ((str(d.day) in nums or f"{d.day:02d}" in nums)
            and (str(d.month) in nums or f"{d.month:02d}" in nums or re.search(r"\b" + month_name[:3] + r"[a-z]*\b", folded) is not None)
            and str(d.year) in nums)


def validate_notice(answer: dict, text: str, *, headline: str, announced_on: str,
                    shares_on_issue: float, scan: bool, model: str = "") -> tuple[Optional[Notice], str]:
    """One reader's answer, checked in code. Returns (notice, "") or (None, reason)."""
    if not isinstance(answer, dict) or not answer:
        return None, "malformed"
    if answer.get("is_substantial_holder_notice") is False:
        return None, "not_a_notice"
    form = str(answer.get("form") or "").strip()
    if form.endswith(".0"):
        form = form[:-2]
    if form not in FORMS:
        return None, "no_form"
    expected = form_from_headline(headline)
    if not expected:
        return None, "no_headline"
    if expected != form:
        return None, "form_contradicts_headline"

    name = clean_name(answer.get("holder_name"))
    if not name:
        return None, "no_holder"
    if placeholder_reason(name):
        return None, "no_holder"
    if not scan and not name_in_text(name, text):
        return None, "name_not_in_notice"

    quotes = answer.get("quotes") if isinstance(answer.get("quotes"), dict) else {}
    prev_pct = _pct(answer.get("previous_pct"))
    pres_pct = _pct(answer.get("present_pct"))
    prev_votes = _votes(answer.get("previous_votes"))
    pres_votes = _votes(answer.get("present_votes"))
    for label, v in (("previous_pct", prev_pct), ("present_pct", pres_pct)):
        if v is not None and not (0 <= v <= 100):
            return None, f"implausible_{label}"

    # A figure a form states must be stated with its votes: notice.go withholds a notice whose
    # pair of votes and percentage is missing (no_voting_power), so a reading without the votes
    # has no share count check and is not stored.
    if form == "603":
        if pres_pct is None:
            return None, "missing_present_pct"
        if pres_votes is None:
            return None, "missing_present_votes"
        if pres_pct < FIVE_PCT:
            return None, "implausible_under_5"
        prev_pct = prev_votes = None
    elif form == "604":
        if prev_pct is None:
            return None, "missing_previous_pct"
        if pres_pct is None:
            return None, "missing_present_pct"
        if prev_votes is None:
            return None, "missing_previous_votes"
        if pres_votes is None:
            return None, "missing_present_votes"
        if prev_pct < FIVE_PCT:
            return None, "implausible_previous_under_5"
        if pres_pct < FIVE_PCT:
            return None, "under_5_in_604"
        if abs(prev_pct - pres_pct) > MAX_CHANGE_POINTS:
            return None, "change_over_50"
    else:  # 605: a holder ceasing was substantial and now is not, so its present figure is under 5 and lower
        if prev_pct is None:
            return None, "missing_previous_pct"
        if prev_pct < FIVE_PCT:
            return None, "implausible_previous_under_5"
        if pres_pct is not None and (pres_pct >= FIVE_PCT or pres_pct >= prev_pct):
            return None, "contradicts_605"
        # notice.go reads no figure from a 605 (its votes are the changes', not a holding): the
        # votes are neither quote-checked nor stored, and the percentages are not written either.
        prev_votes = pres_votes = None

    ceased = form == "605"
    if answer.get("ceased") is True and not ceased:
        return None, "ceased_outside_605"

    if not scan:
        figures = [("previous_pct", prev_pct), ("present_pct", pres_pct),
                   ("previous_votes", prev_votes), ("present_votes", pres_votes)]
        for field_name, value in figures:
            if value is None:
                continue
            quote = quotes.get(field_name)
            if not isinstance(quote, str) or len(quote.strip()) < 4:
                return None, f"no_quote_{field_name}"
            if dx.locate(quote, text) is None:
                return None, f"quote_not_in_notice_{field_name}"
            if dx.canonical(str(value)) not in dx.numbers_in(quote):
                return None, f"value_not_in_quote_{field_name}"
        if not isinstance(quotes.get("holder_name"), str) or dx.locate(quotes["holder_name"], text) is None:
            return None, "quote_not_in_notice_holder_name"

    # The votes must fit ASIC's share count. Without a count on record the check cannot run,
    # so the notice is withheld rather than validated against nothing.
    if (prev_votes is not None or pres_votes is not None) and shares_on_issue <= 0:
        return None, "no_share_count"
    if not votes_consistent(prev_votes, prev_pct, shares_on_issue):
        return None, "inconsistent_votes"
    if not votes_consistent(pres_votes, pres_pct, shares_on_issue):
        return None, "inconsistent_votes"

    # The event date is kept only when its own quote is in the text and states the date. A
    # scan has no quotes, so its date is kept only when both readers agree (same_notice).
    event = plausible_event_date(str(answer.get("event_date") or "").strip(), announced_on)
    if event and not scan:
        q = quotes.get("event_date")
        if not isinstance(q, str) or len(q.strip()) < 4 or dx.locate(q, text) is None or not date_in_quote(event, q):
            event = ""
    key = holder_key(name)
    if not key:
        return None, "no_holder"
    return Notice(form=form, holder_name=name, holder_key=key, institution_slug=None,
                  event_date=event or None, previous_pct=prev_pct, present_pct=pres_pct,
                  previous_votes=prev_votes, present_votes=pres_votes, ceased=ceased, model=model), ""


def same_notice(a: Notice, b: Notice) -> bool:
    """Two readings agree on who, which form, every figure and whether it ceased. The event date
    is not part of agreement: a disagreement on it alone drops the date (agreed), never the notice."""
    return (a.form == b.form and dd.same_person(a.holder_name, b.holder_name)
            and a.figures()[2:] == b.figures()[2:])


def agreed(a: Notice, b: Notice) -> Notice:
    """The notice two agreeing readings state: the first reader's, with the event date kept only
    when both readers state the same date (a date one reader lacks or disputes is NULL)."""
    if a.event_date != b.event_date:
        return replace(a, event_date=None)
    return a


# --- the consensus ---------------------------------------------------------------------


@dataclass
class ReadContext:
    text: str
    images: Optional[list[bytes]]
    headline: str
    announced_on: str
    shares_on_issue: float
    scan: bool
    institutions: dict[str, str] = field(default_factory=dict)


@dataclass
class NoticeExtractor:
    client: dx.OpenRouter
    primary: str = dx.PRIMARY_MODEL
    checker: Optional[str] = dx.CHECKER_MODEL
    arbiter: Optional[str] = dx.ARBITER_MODEL
    scan_primary: str = SCAN_PRIMARY_MODEL
    scan_checker: str = SCAN_CHECKER_MODEL
    stats: Counter = field(default_factory=Counter)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def read(self, model: str, ctx: ReadContext) -> tuple[Optional[Notice], str]:
        user = ctx.text[:TEXT_CHARS] if not ctx.scan else SCAN_USER_MESSAGE
        answer = dx.parse_answer(self.client.chat(model, SYSTEM_PROMPT, user, images=ctx.images))
        if not answer:
            # A reply with no JSON object is a model failure, not a reading: it is never written,
            # so the notice is offered again (the direct_extract rule for an unparseable reply).
            raise dx.ModelCallError(f"{model}: the reply holds no JSON object")
        n, why = validate_notice(answer, ctx.text, headline=ctx.headline, announced_on=ctx.announced_on,
                                 shares_on_issue=ctx.shares_on_issue, scan=ctx.scan, model=model)
        if n is not None and ctx.institutions:
            slug = ctx.institutions.get(" ".join(re.findall(r"[^\W_]+", _fold(n.holder_name))))
            if slug:
                n.holder_key, n.institution_slug = slug, slug
        return n, why

    def extract(self, ctx: ReadContext) -> tuple[Optional[Notice], str]:
        """(notice, outcome). outcome: agree | majority | disputed | not_a_notice | invalid_<reason>.
        Raises dx.ModelCallError when a reader cannot answer: the notice is then not an attempt."""
        if not self.checker:
            raise ValueError("notice_direct needs a checker model: EXTRACTOR_CHECKER_MODEL is empty")
        if ctx.scan:
            first, second, arbiter = self.scan_primary, self.scan_checker, None
        else:
            first, second, arbiter = self.primary, self.checker, self.arbiter
        p, pwhy = self.read(first, ctx)
        c, cwhy = self.read(second, ctx)
        if p and c and same_notice(p, c):
            return agreed(p, c), self._count("agree")
        if p is None and c is None:
            if pwhy == "not_a_notice" and cwhy == "not_a_notice":
                return None, self._count("not_a_notice")
            return None, self._count(f"invalid_{pwhy if pwhy != 'not_a_notice' else cwhy}")
        a, _awhy = (None, "")
        if arbiter:
            a, _awhy = self.read(arbiter, ctx)
        for cand in (p, c):
            if cand and a and same_notice(cand, a):
                return agreed(cand, a), self._count("majority")
        return None, self._count("disputed")

    def _count(self, k: str) -> str:
        with self._lock:
            self.stats[k] += 1
        return k


MODEL_KEYS = ("primary", "checker", "arbiter", "scan_primary", "scan_checker")


def model_names_from_env(environ=None) -> dict[str, Optional[str]]:
    """The five model names the consensus reads with, from the environment (the financial-report
    pass's EXTRACTOR_* names, and NOTICE_SCAN_* for the vision pair). An empty checker or arbiter is
    None. Every caller that reads, fills or scores a cache takes its names from here or passes them
    explicitly, so a cached answer is always keyed by the name the consensus asks for it under."""
    env = (os.environ if environ is None else environ).get
    return {
        "primary": env("EXTRACTOR_PRIMARY_MODEL", dx.PRIMARY_MODEL) or dx.PRIMARY_MODEL,
        "checker": env("EXTRACTOR_CHECKER_MODEL", dx.CHECKER_MODEL) or None,
        "arbiter": env("EXTRACTOR_ARBITER_MODEL", dx.ARBITER_MODEL) or None,
        "scan_primary": env("NOTICE_SCAN_PRIMARY_MODEL", SCAN_PRIMARY_MODEL) or SCAN_PRIMARY_MODEL,
        "scan_checker": env("NOTICE_SCAN_CHECKER_MODEL", SCAN_CHECKER_MODEL) or SCAN_CHECKER_MODEL,
    }


def extractor_for(client, names: dict) -> NoticeExtractor:
    """A NoticeExtractor over any client (OpenRouter, or a replay in the bench) with the given names."""
    return NoticeExtractor(client=client, primary=names["primary"], checker=names["checker"],
                           arbiter=names["arbiter"], scan_primary=names["scan_primary"],
                           scan_checker=names["scan_checker"])


def from_env() -> Optional[NoticeExtractor]:
    """A NoticeExtractor from the environment, or None without OPENROUTER_API_KEY."""
    key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if not key:
        return None
    return extractor_for(dx.OpenRouter(api_key=key), model_names_from_env())


# --- the document -------------------------------------------------------------------


class FetchError(RuntimeError):
    """The PDF could not be downloaded. Not an attempt: the notice stays pending."""


BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")


def fetch_pdf(url: str, session: Optional[requests.Session] = None) -> bytes:
    s = session or requests.Session()
    try:
        resp = s.get(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/pdf,*/*"}, timeout=60)
    except requests.RequestException as e:
        raise FetchError(f"transport: {type(e).__name__}") from e
    if resp.status_code != 200 or not resp.content.startswith(b"%PDF"):
        raise FetchError(f"HTTP {resp.status_code}")
    return resp.content


def document_text(pdf: bytes) -> tuple[str, bool, int]:
    """(text of the first TEXT_PAGES pages, is_scan, page count). A scan has a first page whose
    text layer holds fewer than MIN_TEXT_CHARS characters."""
    import pymupdf

    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        pages = doc.page_count
        first = doc[0].get_text() if pages else ""
        scan = len(first.strip()) < MIN_TEXT_CHARS
        if scan:
            return "", True, pages
        parts = [doc[i].get_text() for i in range(min(TEXT_PAGES, pages))]
    return "\n".join(parts), False, pages


def document_images(pdf: bytes, pages: int) -> list[bytes]:
    """The first SCAN_PAGES pages as PNG bytes, rasterised by register_vision.rasterise (the
    register's vision path). A temporary file holds the PDF for the rasteriser's path argument."""
    import register_vision

    with tempfile.TemporaryDirectory(prefix="notice-scan-") as tmp:
        src = os.path.join(tmp, "notice.pdf")
        with open(src, "wb") as f:
            f.write(pdf)
        rendered = register_vision.rasterise(src, list(range(1, min(SCAN_PAGES, pages) + 1)), tmp)
        out = []
        for page_no in sorted(rendered):
            with open(rendered[page_no], "rb") as f:
                out.append(f.read())
    return out


# --- selection and writing ----------------------------------------------------------------

SELECT_SQL = """
SELECT a.announcement_url, a.stock_code, a.outcome, COALESCE(a.detail, ''),
       max(ann.announcement_date)::text,
       (array_agg(ann.headline ORDER BY ann.announcement_date DESC, ann.stock_code))[1],
       cm.market_cap
FROM substantial_holder_notice_attempts a
JOIN asx_announcements ann ON ann.pdf_url = a.announcement_url
LEFT JOIN "company-metadata" cm ON cm.stock_code = a.stock_code
WHERE a.outcome IN ('no_text', 'no_voting_power', 'no_holder')
  AND a.read_by = 'parser'
  AND (%(since)s::date IS NULL OR ann.announcement_date >= %(since)s::date)
GROUP BY a.announcement_url, a.stock_code, a.outcome, a.detail, cm.market_cap
ORDER BY cm.market_cap DESC NULLS LAST, a.announcement_url
LIMIT %(limit)s
"""

SHARES_SQL = """
SELECT "TOTAL_PRODUCT_IN_ISSUE"
FROM shorts
WHERE "PRODUCT_CODE" = %s
  AND "DATE" <= %s::date + 3 AND "DATE" >= %s::date - 45
  AND "TOTAL_PRODUCT_IN_ISSUE" > 0
ORDER BY "DATE" DESC
LIMIT 1
"""

UPSERT_SQL = """
INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key,
    institution_slug, event_date, announced_on, previous_pct, present_pct, previous_votes, present_votes,
    ceased, parser_version, parsed_at, read_by)
VALUES (%s, %s, %s, %s, %s, %s, %s::date, %s::date, %s, %s, %s, %s, %s, %s, now(), 'model')
ON CONFLICT (announcement_url) DO UPDATE SET
    stock_code = EXCLUDED.stock_code, form = EXCLUDED.form, holder_name = EXCLUDED.holder_name,
    holder_key = EXCLUDED.holder_key, institution_slug = EXCLUDED.institution_slug,
    event_date = EXCLUDED.event_date, announced_on = EXCLUDED.announced_on,
    previous_pct = EXCLUDED.previous_pct, present_pct = EXCLUDED.present_pct,
    previous_votes = EXCLUDED.previous_votes, present_votes = EXCLUDED.present_votes,
    ceased = EXCLUDED.ceased, parser_version = EXCLUDED.parser_version, parsed_at = now(),
    read_by = 'model'
WHERE substantial_holder_notices.read_by = 'model'
"""


def write_recovered(cur, url: str, code: str, announced_on: str, n: Notice) -> bool:
    """Upserts a model-read notice unless a parser-read row holds the URL. True when written."""
    # A 605 stores no figures: notice.go keeps none from a cessation, and the readers only
    # use the percentages to validate and to compare the two readings.
    prev_pct, pres_pct = (None, None) if n.ceased else (n.previous_pct, n.present_pct)
    cur.execute(UPSERT_SQL, (url, code, n.form, n.holder_name, n.holder_key, n.institution_slug,
                             n.event_date, announced_on, prev_pct, pres_pct,
                             n.previous_votes, n.present_votes, n.ceased, NOTICE_PARSER_VERSION))
    if cur.rowcount == 0:
        return False
    cur.execute("""UPDATE substantial_holder_notice_attempts
                   SET outcome = 'parsed', read_by = 'model', detail = %s, attempted_at = now()
                   WHERE announcement_url = %s""",
                ("model: read by two readers, validated against the share count", url))
    return True


def record_withheld(cur, url: str, outcome: str, reason: str) -> None:
    """A withheld second read: the parser's outcome stays, the detail says a model read it."""
    cur.execute("""UPDATE substantial_holder_notice_attempts
                   SET read_by = 'model', detail = %s, attempted_at = now()
                   WHERE announcement_url = %s AND read_by = 'parser'""",
                (f"model: {reason} (parser: {outcome})", url))


def shares_on_issue(cur, code: str, on: str) -> float:
    cur.execute(SHARES_SQL, (code, on, on))
    row = cur.fetchone()
    return float(row[0]) if row else 0.0


def institution_rows(cur) -> list[tuple[str, str, list[str]]]:
    cur.execute("SELECT to_regclass('ownership_institutions') IS NOT NULL")
    if not cur.fetchone()[0]:
        return []
    cur.execute("SELECT slug, name, COALESCE(aliases, '{}') FROM ownership_institutions")
    return [(s, n, list(a)) for s, n, a in cur.fetchall()]


# --- the run --------------------------------------------------------------------------------


@dataclass
class Candidate:
    url: str
    code: str
    outcome: str
    detail: str
    announced_on: str
    headline: str
    market_cap: Optional[int]
    shares: float = 0.0  # ASIC's count on issue as at the notice's date (0 = none on record)


def systemic(errors: int, calls: int) -> bool:
    """The model is down rather than one notice being hard: 5 errors, or 3 making up a fifth
    of the calls (the financial-report pass's rule)."""
    return errors >= MAX_SYSTEMIC_ERRORS or (errors >= 3 and errors * 5 >= calls)


def run(conn, extractor: NoticeExtractor, *, limit: int, workers: int, budget_min: float,
        since: str, dry_run: bool, clock=time.monotonic) -> dict:
    """Reads the withheld notices, largest company first, within the budget. Writes only when
    not a dry run. Returns the counts; the caller decides the exit code from model_errors."""
    counts: Counter = Counter()
    with conn.cursor() as cur:
        cur.execute(SELECT_SQL, {"since": since or None, "limit": limit if limit > 0 else 10**9})
        rows = cur.fetchall()
        institutions = institution_index(institution_rows(cur))
        cands = []
        for url, code, outcome, detail, announced, headline, cap in rows:
            cands.append(Candidate(url, code, outcome, detail, announced or "", headline or "", cap,
                                   shares=shares_on_issue(cur, code, announced or "")))
    counts["selected"] = len(cands)
    log.info("selected %d withheld notices (dry_run=%s, budget %.0f min)", len(cands), dry_run, budget_min)

    start = clock()
    errors_in_row = 0
    model_calls = 0
    model_errors = 0
    pending: dict[concurrent.futures.Future, Candidate] = {}
    queue = list(cands)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        while queue or pending:
            budget_left = clock() - start < budget_min * 60
            while queue and len(pending) < max(1, workers) and budget_left and errors_in_row < MAX_SYSTEMIC_ERRORS:
                cand = queue.pop(0)
                pending[pool.submit(read_one, extractor, cand, institutions)] = cand
            if not pending:
                break
            done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                cand = pending.pop(fut)
                try:
                    res = fut.result()
                except Exception:  # a bug in one notice's read must not lose the rest of the run
                    log.exception("  read crashed: %s", cand.url)
                    counts["crashed"] += 1
                    continue
                kind = res["kind"]
                if kind not in ("fetch_failed", "no_share_count"):
                    model_calls += 1
                if kind == "model_error":
                    model_errors += 1
                    errors_in_row += 1
                    counts["model_error"] += 1
                    log.warning("  model error %s: %s", cand.url, res.get("reason"))
                    continue
                errors_in_row = 0
                if kind == "fetch_failed":
                    counts["fetch_failed"] += 1
                    continue
                if kind == "no_share_count":
                    # Our own data has no count for this date: no fetch, no model call, nothing written.
                    counts["no_share_count"] += 1
                    continue
                if kind == "withheld" and res["reason"] == NO_SHARE_COUNT_OUTCOME:
                    # A gap in our own data, not a verdict on the notice: nothing is recorded, so the
                    # notice stays pending and is read again once ASIC's count for its date lands.
                    counts["no_share_count"] += 1
                    continue
                if kind == "withheld":
                    counts[f"withheld:{res['reason']}"] += 1
                    if not dry_run:
                        with conn.cursor() as cur:
                            record_withheld(cur, cand.url, cand.outcome, res["reason"])
                        conn.commit()
                    else:
                        log.info("  [dry-run] withheld again: %s (%s)", cand.url, res["reason"])
                    continue
                n: Notice = res["notice"]
                counts[f"recovered:{res['outcome']}"] += 1
                if dry_run:
                    log.info("  [dry-run] %s %s %s %s prev=%s pres=%s votes=%s/%s ceased=%s", cand.code,
                             n.form, n.holder_name, n.holder_key, n.previous_pct, n.present_pct,
                             n.previous_votes, n.present_votes, n.ceased)
                    continue
                with conn.cursor() as cur:
                    wrote = write_recovered(cur, cand.url, cand.code, cand.announced_on, n)
                conn.commit()
                counts["written" if wrote else "kept_parser_row"] += 1
    if queue:
        # The budget ran out, or five model errors in a row stopped new work: these were never read.
        counts["not_started"] = len(queue)
    counts["model_calls"] = model_calls
    counts["model_errors"] = model_errors
    counts["systemic"] = int(systemic(model_errors, model_calls))
    counts["minutes"] = round((clock() - start) / 60, 1)
    for k, v in sorted(extractor.stats.items()):
        counts[f"consensus:{k}"] = v
    return dict(counts)


def read_one(extractor: NoticeExtractor, cand: Candidate, institutions: dict[str, str]) -> dict:
    """One candidate, end to end. Returns {"kind": ...}: recovered (with its notice), withheld
    (with the reason), fetch_failed, model_error or no_share_count. A model error is never written.
    A notice with no ASIC count on record for its date is neither fetched nor read: its votes cannot
    be checked, so nothing is written and it is offered again once a count appears. A 605 states no
    votes (validate_notice keeps none), so it needs no count and is read."""
    if cand.shares <= 0 and form_from_headline(cand.headline) != "605":
        return {"kind": "no_share_count"}
    try:
        pdf = fetch_pdf(cand.url)  # a session per fetch: requests sessions are not shared across threads
    except FetchError as e:
        return {"kind": "fetch_failed", "reason": str(e)}
    try:
        text, scan, pages = document_text(pdf)
    except Exception as e:  # a corrupt or encrypted PDF that starts %PDF: permanent, so withheld
        return {"kind": "withheld", "reason": "unreadable_pdf", "detail": type(e).__name__, "scan": False}
    try:
        images = document_images(pdf, pages) if scan else None
    except Exception as e:  # the rasteriser failing is this host's fault: retried, never recorded
        return {"kind": "fetch_failed", "reason": f"rasterise: {type(e).__name__}"}
    ctx = ReadContext(text=text, images=images, headline=cand.headline, announced_on=cand.announced_on,
                      shares_on_issue=cand.shares, scan=scan, institutions=institutions)
    try:
        notice, outcome = extractor.extract(ctx)
    except dx.ModelCallError as e:
        return {"kind": "model_error", "reason": str(e)[:300], "scan": scan}
    if notice is None:
        return {"kind": "withheld", "reason": outcome, "scan": scan}
    return {"kind": "recovered", "notice": notice, "outcome": outcome, "scan": scan}


GOLD = Path(__file__).resolve().parent / "testdata" / "notices" / "gold.json"
GOLD_PENDING = "awaiting hand reading"  # gold.json's reading_status until a person has read the notice


def gold_unread(path: Path = GOLD) -> list[str]:
    """The ids of gold-set notices no person has read yet. An entry is read when its status is
    cleared and it carries a hand reading or is recorded as withheld. A missing file is all unread."""
    if not path.exists():
        return ["gold.json missing"]
    entries = json.loads(path.read_text())["notices"]
    out = []
    for e in entries:
        read = e.get("reading_status") != GOLD_PENDING and (
            e.get("reading") is not None or e.get("withheld_expected") is True)
        if not read:
            out.append(e["id"])
    return out


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--limit", type=int, default=0, help="at most N withheld notices (0 = all)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--budget-min", type=float, default=90,
                    help="stop starting new notices after this many minutes (in-flight ones finish)")
    ap.add_argument("--since", default="", help="only notices announced on or after this date (YYYY-MM-DD)")
    ap.add_argument("--dry-run", action=argparse.BooleanOptionalAction, default=True,
                    help="print what would be written and write nothing (the default); --no-dry-run writes")
    ap.add_argument("--skip-gold-check", action="store_true",
                    help="write although testdata/notices/gold.json has notices no person has read (not for a backfill)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.dry_run and not args.skip_gold_check:
        # Spec 2.3: the gold set is read by hand before the first write, and the prompt changes only
        # against the bench. Writes wait until every gold notice has a hand reading.
        unread = gold_unread()
        if unread:
            log.error("refusing to write: %d gold notices have no hand reading (%s ...). Read them, "
                      "run bench_notices.py, or pass --skip-gold-check.", len(unread), ", ".join(unread[:3]))
            return 2

    extractor = from_env()
    if extractor is None:
        log.error("OPENROUTER_API_KEY is not set: no model can read a notice")
        return 1
    if not extractor.checker:
        log.error("EXTRACTOR_CHECKER_MODEL is empty: a notice needs two independent readers")
        return 1
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL is required")
        return 1
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        counts = run(conn, extractor, limit=args.limit, workers=args.workers, budget_min=args.budget_min,
                     since=args.since, dry_run=args.dry_run)
    finally:
        conn.close()
    for k in sorted(counts):
        log.info("%-32s %s", k, counts[k])
    return 1 if counts.get("systemic") else 0


if __name__ == "__main__":
    sys.exit(main())
