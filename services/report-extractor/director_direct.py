"""Appendix 3Y extraction through OpenRouter, validated, with consensus.

The same shape as direct_extract.py (financial reports): a primary model
(DeepSeek v4 Flash) and a checker (the cheapest Gemini, 2.5 Flash-Lite) read
the notice independently; every answer is validated against the document in
code; the trade is written only when the two agree on who, which way and how
many (and, when either states one, how much), or when an arbiter (Gemini 2.5
Flash) makes a two-of-three majority. Anything else is `disputed` and not
written.

Validation (validate_trade), per answer:
  * the director's name is in the notice: every name token of 2+ letters
    appears as a word (honorifics dropped, case- and accent-insensitive);
  * each change row's quantity is a number written in the notice, and its
    consideration too when given (so a sum is computed here, never by the
    model);
  * a notice the model says is not an Appendix 3Y, or with no identifiable
    director, is `not_3y` — a real outcome, recorded so it is not retried.

A model that cannot answer raises ModelCallError, which the job counts as
model_error: NOT recorded as an attempt (so the next run retries it) and
fails the run when systemic. The July-September 2026 outage recorded every
failed call as no_extract and then skipped those notices for 30 days.
"""
from __future__ import annotations

import logging
import re
import threading
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Optional

import direct_extract as dx

log = logging.getLogger(__name__)

TEXT_CHARS = 8000  # 3Y notices are short forms; the old path used 6000

SYSTEM_PROMPT = """You read an ASX "Appendix 3Y — Change of Director's Interest Notice" for a database that publishes director trades. A wrong trade is far worse than none.

Return ONLY a JSON object:
{
  "is_appendix_3y": true | false,
  "director_name": "the director's full name exactly as written on the form (a person, never the company); null if none",
  "changes": [
    {
      "direction": "acquired" | "disposed",
      "number": "number of securities as written in the notice (digits and separators only)",
      "consideration": "the consideration box for THIS change copied as written, e.g. '$57,062.70', '$4.0035 per share', 'Nil'; null if not stated",
      "security_class": "e.g. Ordinary fully paid shares, Performance rights, Options",
      "nature": "short phrase, e.g. On-market purchase, On-market sale, Exercise of options, Vesting of performance rights, Off-market transfer, Participation in placement",
      "interest": "direct" | "indirect",
      "date": "YYYY-MM-DD of the change, or null"
    }
  ]
}

Rules:
1. One entry per change actually reported in Part 1 (direct/indirect interest) of the form. Do not add up rows, do not include holdings before or after the change, and do not include Part 2 (contracts) or Part 3 (closed period) text.
2. number and consideration must be copied from the notice exactly; never compute a price x quantity yourself. Keep words like 'per share' or 'average price' that say the amount is per security.
3. If the form reports no change (e.g. "Nil"), return an empty changes list.
4. If the document is not an Appendix 3Y, set is_appendix_3y false and changes [].
"""

_HONORIFICS = {"mr", "mrs", "ms", "miss", "dr", "prof", "sir", "dame", "hon", "the", "am", "ao", "ac", "oam", "jr", "sr"}
_NAME_TOKEN_RE = re.compile(r"[a-z]{2,}")


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower()


def name_tokens(name: str) -> list[str]:
    return [t for t in _NAME_TOKEN_RE.findall(_fold(name)) if t not in _HONORIFICS]


def name_in_text(name: str, text: str) -> bool:
    toks = name_tokens(name)
    if len(toks) < 2:  # a surname alone could be anyone
        return False
    words = set(_NAME_TOKEN_RE.findall(_fold(text)))
    return all(t in words for t in toks)


def same_person(a: str, b: str) -> bool:
    """Same director: one name's tokens contain the other's (middle names and
    initials vary between readings), with the surname (last token) equal."""
    x, y = name_tokens(a), name_tokens(b)
    if len(x) < 2 or len(y) < 2 or x[-1] != y[-1]:
        return False
    return set(x) <= set(y) or set(y) <= set(x)


def title_case(name: str) -> str:
    """The name as written, honorifics dropped. Only an ALL-CAPS name is
    re-cased (each hyphen / apostrophe segment capitalised): re-casing a name
    written normally mangles it ("McTaggart" -> "Mctaggart", "St-Germain" ->
    "St-germain")."""
    toks = [t for t in re.split(r"\s+", (name or "").strip()) if t and t.strip(".").lower() not in _HONORIFICS]
    if any(c.islower() for c in "".join(toks)):
        return " ".join(toks)

    def seg(w: str) -> str:
        return w if len(w.strip(".")) <= 1 else w[:1].upper() + w[1:].lower()

    return " ".join(re.sub(r"[^-'’]+", lambda m: seg(m.group(0)), t) for t in toks)


@dataclass
class Trade:
    director_name: str
    trade_type: str          # buy | sell | exercise_options
    shares: int
    total_value: Optional[float]
    trade_date: Optional[str]
    model: str

    @property
    def price(self) -> Optional[float]:
        return round(self.total_value / self.shares, 4) if self.total_value and self.shares else None


_PER_UNIT_RE = re.compile(r"(?:c\b|cents?\b|¢)?\s*(?:per\b|each\b|/\s*(?:share|security|unit|sh)\b|average\s+price)", re.IGNORECASE)
_NIL_RE = re.compile(r"^\s*(?:nil|null|none|n/?a|not\s+applicable|no\s+consideration|\$?0(?:\.0+)?)\b", re.IGNORECASE)
_MONEY_RE = re.compile(r"\$\s*(\d[\d,]*(?:\.\d+)?|\.\d+)|(\d[\d,]*(?:\.\d+)?)")
_CENTS_RE = re.compile(r"^\s*(?:c\b|cents?\b|¢)", re.IGNORECASE)
PRICE_BOUNDS = (1e-5, 1e4)  # dollars per security a real ASX trade can carry


def parse_consideration(v: Any, number: float, text_numbers: set[str]) -> tuple[Optional[float], str]:
    """Total dollars for one change, from the model's copy of the form's
    consideration box: nil -> None; a total ("$57,062.70") as written; a
    per-security price ("$4.0035 per ordinary share", "$3.51 average price")
    times the change's quantity, computed HERE. The number itself must be
    written in the notice. An implausible implied price drops the value (the
    trade still stands). Returns (value, reason); reason is "" when fine."""
    if v is None:
        return None, ""
    s = str(v).strip()
    if not s or _NIL_RE.match(s):
        return None, ""
    dollars = [m for m in _MONEY_RE.finditer(s) if m.group(1)]
    if len(dollars) > 1 and not re.search(r"\(\s*\$", s):
        # Several lots at several prices ("50,976 - $0.05 per option ...
        # 204,024 - $0.06 per option"): not one figure; withheld, not summed.
        return None, "several_amounts"
    if dollars:
        m = dollars[0]
    else:
        bare = list(_MONEY_RE.finditer(s))
        if len(bare) != 1:
            return None, "" if not bare else "several_amounts"
        m = bare[0]
    raw = m.group(1) or m.group(2)
    c = dx.canonical(raw)
    if c is None or c not in text_numbers:
        return None, "not_in_notice"
    amount = float(c)
    if _CENTS_RE.match(s[m.end():]):
        amount /= 100
    # Per-security only when the wording follows THIS figure ("$4.0035 per
    # share"), or the box calls it an average price before it. "$250,002.00
    # ($4.25 per option)" is a total with the price beside it.
    per_unit = bool(_PER_UNIT_RE.match(s[m.end():m.end() + 30].lstrip(" )"))) or bool(
        re.search(r"average\s+price|price\s+per", s[:m.start()], re.IGNORECASE))
    total = amount * number if per_unit else amount
    if number and not (PRICE_BOUNDS[0] <= total / number <= PRICE_BOUNDS[1]):
        return None, "implausible_price"
    return round(total, 2), ""


_EXERCISE_RE = re.compile(r"exercis|vest|conversion\s+of|converted|lapse", re.IGNORECASE)
_ORDINARY_RE = re.compile(r"ordinary|\bshares?\b|\bfpo\b|stapled|\bunits?\b|securities", re.IGNORECASE)
_DERIVATIVE_RE = re.compile(r"option|right|warrant|convertible|note", re.IGNORECASE)
_SALE_RE = re.compile(r"\bsale\b|\bsold\b|\bsell|\bdisposal\b|\bdisposed\b", re.IGNORECASE)
_PURCHASE_RE = re.compile(r"\bpurchase|\bbought\b|\bbuy\b|\bacquisition\b|subscri|placement|entitlement", re.IGNORECASE)


def _first_amount(box: str) -> Optional[float]:
    """The first figure in a consideration box, as a total (no per-unit maths)."""
    m = next((x for x in _MONEY_RE.finditer(box) if x.group(1)), None) or _MONEY_RE.search(box)
    c = dx.canonical((m.group(1) or m.group(2))) if m else None
    return float(c) if c else None


def _value(v: Any, text_numbers: set[str]) -> tuple[Optional[float], str]:
    """(float, "") for a number written in the notice; (None, "") for null/nil;
    (None, reason) when it is a number the notice does not contain."""
    if v is None or (isinstance(v, str) and v.strip().lower() in ("", "nil", "null", "n/a", "none")):
        return None, ""
    c = dx.canonical(str(v))
    if c is None:
        return None, "unparseable"
    if c not in text_numbers:
        return None, "not_in_notice"
    return float(c), ""


def validate_trade(answer: dict, text: str, model: str) -> tuple[Optional[Trade], str]:
    if not isinstance(answer, dict) or not answer:
        return None, "malformed"
    if answer.get("is_appendix_3y") is False:
        return None, "not_3y"
    name = str(answer.get("director_name") or "").strip()
    if not name:
        return None, "not_3y"
    if not name_in_text(name, text):
        return None, "name_not_in_notice"
    numbers = dx.numbers_in(text)
    raw_changes = [ch for ch in (answer.get("changes") or []) if isinstance(ch, dict)]
    # How often each consideration box was copied: one box the model repeated
    # onto several lots (shares + free options, shares + the rights converted)
    # is ONE figure, not one per lot.
    box_count = Counter(str(ch.get("consideration") or "").strip() for ch in raw_changes)
    lots = []  # (direction, number, value or None, value_problem)
    options = False
    dates = []
    for ch in raw_changes:
        n, why = _value(ch.get("number"), numbers)
        if why:
            return None, f"number_{why}"
        if n is None:
            continue
        direction = str(ch.get("direction") or "").lower()
        if not direction.startswith(("acq", "dis")):
            return None, "no_direction"
        nature = str(ch.get("nature") or "")
        if direction.startswith("acq") and _SALE_RE.search(nature):
            return None, "direction_conflicts_with_nature"
        if direction.startswith("dis") and _PURCHASE_RE.search(nature):
            return None, "direction_conflicts_with_nature"
        box = str(ch.get("consideration") or "").strip()
        v, vwhy = parse_consideration(ch.get("consideration"), n, numbers)
        if box and box_count[box] > 1:
            if v is not None and v != _first_amount(box):
                v, vwhy = None, "shared_per_unit_price"  # one price over several lots: which lots?
        ordinary = bool(_ORDINARY_RE.search(str(ch.get("security_class") or ""))) and not _DERIVATIVE_RE.search(str(ch.get("security_class") or ""))
        lots.append((direction[:3], n, v, vwhy, box, ordinary))
        if _EXERCISE_RE.search(nature):
            options = True
        if ch.get("date"):
            dates.append(str(ch["date"]))
    acquired = sum(n for d, n, *_ in lots if d == "acq")
    disposed = sum(n for d, n, *_ in lots if d == "dis")
    if acquired == 0 and disposed == 0:
        return Trade(title_case(name), "buy", 0, None, min(dates) if dates else None, model), "kept"
    side = "acq" if acquired >= disposed else "dis"
    trade_type = "buy" if side == "acq" else "sell"
    if options:
        trade_type = "exercise_options"
    mine = [lot for lot in lots if lot[0] == side]
    shared_with_dropped = False
    if any(lot[5] for lot in mine) and not all(lot[5] for lot in mine):
        # Shares beside options or rights (free attaching options in an
        # entitlement offer): the traded quantity is the ordinary shares.
        dropped_boxes = {lot[4] for lot in mine if not lot[5] and lot[4]}
        mine = [lot for lot in mine if lot[5]]
        # A consideration box that also covered the dropped lots is not the
        # shares' own price: withhold the value.
        shared_with_dropped = any(lot[4] in dropped_boxes for lot in mine)
    priced = [lot for lot in mine if lot[2] is not None]
    if priced and len(priced) < len(mine) and not any(lot[3] for lot in mine):
        # A priced trade beside unpriced movements (an off-market transfer to
        # a related entity): the trade is the priced lots, so shares and
        # price describe the same securities.
        mine = priced
    shares = sum(n for _, n, *_ in mine)
    valueless = shared_with_dropped or any(lot[3] for lot in mine) or (priced and len(priced) < len(mine))
    seen_boxes, value = set(), 0.0
    for _, _, v, _, box, _ in priced:
        if box and box_count[box] > 1:
            if box in seen_boxes:
                continue  # the same total copied onto another lot: count it once
            seen_boxes.add(box)
        value += v
    have_value = bool(priced)
    date = min(dates) if dates and all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in dates) else None
    total = round(value, 2) if have_value and not valueless else None
    return Trade(title_case(name), trade_type, int(shares), total, date, model), "kept"


def same_trade(a: Trade, b: Trade) -> bool:
    """Who, which way and how many agree. The dollar value is settled
    separately (agreed_value): readings that agree on the trade but not on its
    value store the trade with no value, never a value one model chose."""
    return same_person(a.director_name, b.director_name) and a.trade_type == b.trade_type and a.shares == b.shares


def same_value(x: Optional[float], y: Optional[float]) -> bool:
    if x is None or y is None:
        return False
    hi = max(abs(x), abs(y))
    return x == y or abs(x - y) <= dx.SAME_FIGURE_TOLERANCE * hi


def agreed(a: Trade, b: Trade) -> Trade:
    """a, with total_value kept only when b's reading gives the same value."""
    if same_value(a.total_value, b.total_value):
        return a
    return Trade(a.director_name, a.trade_type, a.shares, None, a.trade_date or b.trade_date, a.model)


@dataclass
class DirectorExtractor:
    client: dx.OpenRouter
    primary: str = dx.PRIMARY_MODEL
    checker: Optional[str] = dx.CHECKER_MODEL
    arbiter: Optional[str] = dx.ARBITER_MODEL
    stats: Counter = field(default_factory=Counter)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def read(self, model: str, text: str, usage=None) -> tuple[Optional[Trade], str]:
        answer = dx.parse_answer(self.client.chat(model, SYSTEM_PROMPT, text[:TEXT_CHARS], usage=usage))
        return validate_trade(answer, text[:TEXT_CHARS], model)

    def extract(self, text: str, usage=None) -> tuple[Optional[Trade], str]:
        """(trade, outcome). outcome: agree | majority | unchecked | not_3y |
        disputed | invalid_<reason>. Raises dx.ModelCallError when the primary
        cannot answer."""
        p, why = self.read(self.primary, text, usage)
        if p is None and why == "not_3y":
            return None, self._count("not_3y")
        if not self.checker:
            return (p, self._count("unchecked")) if p else (None, self._count(f"invalid_{why}"))
        try:
            c, cwhy = self.read(self.checker, text, usage)
        except dx.ModelCallError as e:
            log.warning("  checker %s failed (%s)", self.checker, e)
            self._count("checker_failed")
            return (p, self._count("unchecked")) if p else (None, self._count(f"invalid_{why}"))
        if p and c and same_trade(p, c):
            return agreed(p, c), self._count("agree")
        if p is None and c is None:
            return None, self._count(f"invalid_{why}" if why != "not_3y" else "not_3y")
        a, awhy = None, ""
        if self.arbiter:
            try:
                a, awhy = self.read(self.arbiter, text, usage)
            except dx.ModelCallError as e:
                log.warning("  arbiter %s failed (%s)", self.arbiter, e)
                self._count("arbiter_failed")
                awhy = "error"
        for cand, other in ((p, c), (c, p)):
            if cand and a and same_trade(cand, a):
                # Two of three: the value too needs two readings that agree.
                value_from = a if same_value(cand.total_value, a.total_value) else other
                return agreed(cand, value_from) if value_from else agreed(cand, a), self._count("majority")
        # Nothing CONTRADICTS the primary (the other readers produced no valid
        # trade at all, e.g. malformed JSON): keep it as unconfirmed with no
        # value. A reader that returned a DIFFERENT valid trade is a dispute.
        if p and c is None and a is None and cwhy != "not_3y" and awhy != "not_3y":
            return Trade(p.director_name, p.trade_type, p.shares, None, p.trade_date, p.model), self._count("unconfirmed")
        log.info("  disputed: %s=%s %s=%s %s=%s", self.primary, _brief(p, why), self.checker, _brief(c, cwhy),
                 self.arbiter, _brief(a, awhy))
        return None, self._count("disputed")

    def _count(self, k: str) -> str:
        with self._lock:
            self.stats[k] += 1
        return k


def _brief(t: Optional[Trade], why: str) -> str:
    return f"{t.director_name}/{t.trade_type}/{t.shares}/{t.total_value}" if t else f"<{why}>"


def from_env() -> Optional[DirectorExtractor]:
    base = dx.from_env()
    if base is None:
        return None
    return DirectorExtractor(client=base.client, primary=base.primary, checker=base.checker, arbiter=base.arbiter)
