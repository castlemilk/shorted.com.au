"""Deterministic parser for born-digital register-of-interests statements.

Pure and importable: no I/O, no database, no network. Takes a pymupdf document
and returns the artifact structure that extract_register.py persists.

# Why geometry rather than text

`page.get_text()` flattens the three-holder table into a stream where a value
cannot be attributed to its holder. The form is a real table and the word
bounding boxes recover it exactly. Measured layout of a born-digital House page:

    y= 76.34 x0= 35.5  3. Real estate, including the location (suburb or area only)…
    y=116.66 x0=100.1  Location                Purpose for which owned      <- column header
    y=134.99 x0= 40.9  Self      Greenvale,@100  VIC@151   Residential@333
    y=168.38 x0= 40.9  Spouse/   Not@100 Applicable@118   Not@333 Applicable@350
    y=183.46 x0= 40.9  Partner                                              <- label continuation
    y=201.78 x0= 40.9  Dependent Not@100 Applicable@118   Not@333 Applicable@350
    y=216.85 x0= 40.9  Children                                             <- label continuation

Item headings sit at x≈35, the column header at x≈100, holder labels at x≈41,
and value columns at stable origins derived from the header band.

# The three guards, each found by a parser that lacked it

1. Items must be segmented FIRST. Without an item boundary the last holder row
   swallows the NEXT item's column-header band, because that band sits right of
   the label column and looks exactly like a wrapped value.
2. The column-header band must be consumed as a header, not as a value.
3. Footers must be dropped, or a bare page number merges into the last row.

# Form variants

Three geometries share this file:

  base statement       item headings + column header + three holder rows
  alteration (48P)     ADDITION/DELETION at x≈100, holder rows at x≈41
  alteration (47P)     ADDITION/DELETION at x≈41, rows are "12. Label | Details",
                       with NO holder rows at all — hence holder='unspecified'

Design notes: docs/feature/politicians/architecture.md
"""

from __future__ import annotations

import bisect
import difflib
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Iterable, Optional

from register_schema import (
    CHANGE_ADDITION,
    CHANGE_DECLARED,
    CHANGE_DELETION,
    HOLDER_DEPENDENT,
    HOLDER_SELF,
    HOLDER_SPOUSE,
    HOLDER_UNSPECIFIED,
    ITEM_LABELS,
    STATEMENT_ALTERATION,
    STATEMENT_BASE,
    is_nil_value,
)

# --- geometry tuning ------------------------------------------------------

# Words within this many points vertically belong to the same visual line.
BAND_TOLERANCE_PT = 3.0

# Anything below this fraction of page height is chrome (page number, footer).
FOOTER_ZONE = 0.93

# Item headings are flush left; holder labels are indented slightly.
ITEM_HEADING_X_MAX = 38.0

# The boundary between the holder-label column and the value columns.
#
# FIXED, never derived from the column header. The 47th-Parliament form puts its
# header text at x≈121 while the values sit at x≈112, so deriving the boundary
# from the header (origins[0] - 5) pushed it to 116 and silently dropped the
# first word of every cell — turning "Not Applicable" into "Applicable" and
# "X Pty Ltd" into "Ltd". Holder labels start at x≈41 and the longest
# ("Dependent") ends well before 95.
LABEL_X_MAX = 95.0

# How far a value band may sit ABOVE its holder label before the layout is
# treated as centred-label rather than top-aligned.
CENTRED_LABEL_TOLERANCE_PT = 6.0

# --- table row rules ------------------------------------------------------
#
# The born-digital form draws its tables, so the row boundaries are LITERALLY
# ON THE PAGE and do not have to be inferred from label positions. That matters
# because the 48P form centres a holder label against its own cell: when the
# cell wraps to three lines and the label to two, the label's first line sits
# BELOW the cell's first line, and a parser that attributes by "most recent
# label wins" hands that first line to the previous holder. Measured on
# Templeman_48P item 2.i, where Spouse/partner's "The Nirvana Trust" was welded
# onto Self, producing "The Nirvana Trust The Nirvana Trust".
#
# A drawn rule at y=322.32 separates the two rows with 16pt of margin above and
# 2pt below — an exact answer where nearest-label arithmetic was a coin flip.
RULE_MAX_THICKNESS_PT = 2.0   # thicker than this is a fill, not a rule
RULE_MIN_SEGMENT_PT = 20.0    # ignore tick marks and column-divider stubs
RULE_SAME_Y_PT = 1.5          # segments this close vertically are one rule
RULE_MIN_SPAN_PT = 200.0      # a row rule spans the table, not one cell

# --- patterns -------------------------------------------------------------

ITEM_HEADING_RE = re.compile(r"^(\d{1,2})\.\s*(.*)$")
HOLDER_PATTERNS = (
    (re.compile(r"^self\b", re.I), HOLDER_SELF),
    (re.compile(r"^spouse\b|^spouse/", re.I), HOLDER_SPOUSE),
    (re.compile(r"^dependent\b", re.I), HOLDER_DEPENDENT),
)
# Second physical line of a wrapped holder label.
HOLDER_CONTINUATION_RE = re.compile(r"^(partner|children)\b", re.I)

BASE_FORM_RE = re.compile(r"statement of registrable interests", re.I)
ALTERATION_FORM_RE = re.compile(r"notification of alteration", re.I)
SECTION_ADDITION_RE = re.compile(r"^addition\b", re.I)
SECTION_DELETION_RE = re.compile(r"^deletion\b", re.I)
COLUMN_HEADER_TOKENS = re.compile(
    r"^(location|name|nature|type|item|details|purpose|activities|body|creditor|beneficial|beneficiary)\b",
    re.I,
)

# OCR-tolerant header matching, SCOPED TO THE OCR PATH BY AN EXPLICIT FLAG.
#
# column_origins() derives the value-column x-origins FROM the header band, and on
# an OCR'd scan the headers are exactly what Tesseract garbles worst — measured on
# Gosling_48P p2, typed values came through exactly ("Ludmilla, NT", "Not
# Applicable" x7) while headers read "inchiding", "aapptieable", "hotding". With
# strict matching a scan yields 6 of 14 items and welds items 9-11 onto item 8.
#
# A fuzzy variant (difflib against the vocabulary at ratio >= 0.72) was tried and
# REVERTED: it correctly rejects every data-row word ("applicable" 0.40, "not"
# 0.44) but it also matches real born-digital header words like "subsidiary"
# against "beneficiary", adding spurious column origins and changing the
# born-digital parse — the golden set caught it.
#
# So fuzzy matching must be scoped to the OCR path ONLY, threaded as a flag
# through column_origins/is_column_header and their two callers. Until then, an
# OCR'd document must not be published: see docs/feature/politicians/architecture.md.
COLUMN_HEADER_VOCAB = (
    "location", "name", "nature", "type", "item", "details", "purpose",
    "activities", "body", "creditor", "beneficial", "beneficiary",
)
# 0.72 accepts OCR damage ("purpese", "Iocation", "creditcr") and rejects every
# data-row word we measured: "applicable" 0.40, "not" 0.44, "spouse" 0.62.
COLUMN_HEADER_FUZZ = 0.72


def looks_like_column_header(text: str, fuzzy: bool = False) -> bool:
    """True when a word starts a table column header.

    fuzzy=False is EXACT and is what the born-digital path uses. Turning fuzz on
    for born-digital text changes the parse: "subsidiary" matches "beneficiary"
    at >=0.72, which adds a spurious column origin and re-splits real headers —
    the golden set caught exactly that. So fuzz is only ever enabled for OCR,
    where the header is damaged and the alternative is losing the table entirely.

    Fuzzy-matching a HEADING is consistent with this parser's standing rule:
    headings are boilerplate we already know and may be matched loosely; VALUES
    never are, because a wrong value is a wrong fact about a named person.
    """
    if COLUMN_HEADER_TOKENS.match(text):
        return True
    if not fuzzy:
        return False
    word = re.sub(r"[^a-z]", "", (text or "").casefold())
    if len(word) < 4:
        return False
    return any(
        difflib.SequenceMatcher(None, word, v).ratio() >= COLUMN_HEADER_FUZZ
        for v in COLUMN_HEADER_VOCAB
    )


DATE_LABEL_RE = re.compile(r"(submitted\s+date|signed|date)\s*:?", re.I)
DATE_VALUE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")
PROCESSED_RE = re.compile(r"^processed\b", re.I)
# Editorial rule 5: we never CREATE a numeric field, but when the source itself
# states a figure (item 11 gifts sometimes read "(valued at $620.40)") the text
# is kept verbatim and flagged for review. Expected rate is near zero; a spike
# in the vision tier means the model is hallucinating numbers.
AMOUNT_RE = re.compile(r"\$\s?\d")

# Tesseract DPI for scanned pages. 200 measured best on the register's scans:
# 150 over-reported "Not Applicable" (8 vs a true 7 on Gosling_48P p2) while 200
# and 400 both matched truth exactly, and 200 is the cheaper of the two.
OCR_DPI_DEFAULT = 200


@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str


@dataclass
class Band:
    """One visual line of a page."""

    y: float
    words: list[Word]

    @property
    def x0(self) -> float:
        return self.words[0].x0 if self.words else 0.0

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


@dataclass
class Row:
    holder: str
    change_type: str
    ordinal: int
    declared_text: str
    secondary_text: str = ""
    tertiary_text: str = ""
    is_nil: bool = False
    page_no: int = 0
    # Physical lines of the primary cell, preserved because the form lists one
    # property (or one company) per line and the resolvers need to try each.
    declared_lines: list[str] = field(default_factory=list)
    contains_amount: bool = False


@dataclass
class Item:
    item_no: int
    item_label: str
    page_no: int
    rows: list[Row] = field(default_factory=list)


@dataclass
class Statement:
    ordinal: int
    kind: str
    page_from: int
    page_to: int
    lodged_date: Optional[date] = None
    date_is_stated: bool = False
    items: list[Item] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParsedDocument:
    statements: list[Statement] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    pages_attributed: int = 0


# ---------------------------------------------------------------------------
# Band extraction
# ---------------------------------------------------------------------------


def page_bands(page, textpage=None, words=None) -> list[Band]:
    """Cluster a page's words into visual lines, dropping footer chrome.

    textpage is an OPTIONAL pymupdf TextPage. It must be passed explicitly for an
    OCR'd scan: get_textpage_ocr() returns a separate object and does NOT replace
    the page's default text layer, so a bare page.get_text("words") on a scan
    returns 0 words (measured) and the parser silently finds nothing.
    """
    height = page.rect.height or 1.0
    cutoff = height * FOOTER_ZONE

    raw = [
        Word(x0, y0, x1, y1, text)
        # `words` lets an OCR backend inject positioned text directly, bypassing
        # MuPDF entirely — Apple Vision produces its own boxes. Otherwise: pass the
        # textpage kwarg only when there IS one, so the born-digital path and its
        # test doubles keep calling get_text("words") with no extra arguments.
        for x0, y0, x1, y1, text, *_ in (
            words
            if words is not None
            else page.get_text("words", textpage=textpage)
            if textpage is not None
            else page.get_text("words")
        )
        if text.strip() and y0 < cutoff  # drop the page-number footer
    ]
    if not raw:
        return []

    # Cluster by PROXIMITY, not by bucketing y into fixed slots. Fixed buckets
    # split a line whenever it straddles a boundary: a real column header read
    # "Details" at y=498.5 and "Item" at y=499.7, which round(y/3) puts in
    # different buckets — losing one of the two column origins and silently
    # welding the row's cells together.
    bands: list[Band] = []
    current: list[Word] = []
    anchor = 0.0
    for w in sorted(raw, key=lambda w: (w.y0, w.x0)):
        if current and (w.y0 - anchor) > BAND_TOLERANCE_PT:
            bands.append(Band(y=anchor, words=sorted(current, key=lambda w: w.x0)))
            current, anchor = [w], w.y0
        else:
            if not current:
                anchor = w.y0
            current.append(w)
    if current:
        bands.append(Band(y=anchor, words=sorted(current, key=lambda w: w.x0)))
    return bands


def page_row_rules(page) -> list[float]:
    """The y of every horizontal rule that spans a table on this page.

    Returns [] for anything without vector drawings — a scan, an OCR'd page, a
    test double — and the caller then behaves exactly as it did before rules
    existed. That is deliberate: the rules make attribution EXACT where they are
    present and change nothing where they are not.

    A rule is drawn as several segments, one per column, because the column
    dividers interrupt it. Segments at the same y are summed and the group is
    kept only if it spans most of the table; that rejects a single cell's
    underline and the column dividers themselves (which are tall, not thin).
    """
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001 - no drawings on a scan, and that is fine
        return []

    spans: dict[float, float] = {}
    for item in drawings:
        rect = item.get("rect") if isinstance(item, dict) else None
        if rect is None:
            continue
        height = rect.y1 - rect.y0
        width = rect.x1 - rect.x0
        if height > RULE_MAX_THICKNESS_PT or width < RULE_MIN_SEGMENT_PT:
            continue
        y = (rect.y0 + rect.y1) / 2.0
        key = next(
            (k for k in spans if abs(k - y) <= RULE_SAME_Y_PT),
            y,
        )
        spans[key] = spans.get(key, 0.0) + width

    return sorted(y for y, span in spans.items() if span >= RULE_MIN_SPAN_PT)


def rule_slot(rules: list[float], y: float) -> int:
    """Which band between two rules a y falls in. 0 for every y when there are
    no rules, so a ruleless page keeps its original single-slot behaviour."""
    return bisect.bisect_right(rules, y) if rules else 0


def holder_of(token: str) -> Optional[str]:
    for pattern, holder in HOLDER_PATTERNS:
        if pattern.match(token):
            return holder
    return None


# ---------------------------------------------------------------------------
# Column model
# ---------------------------------------------------------------------------


def column_origins(header: Band, gap_pt: float = 25.0, fuzzy: bool = False) -> list[float]:
    """Derive value-column x-origins from a column-header band.

    Split on the header VOCABULARY rather than on horizontal gaps. Gaps do not
    work: in item 2's header

        Name of trust/nominee company | Nature of its operation | Beneficial interests

    the gap between "company" and "Nature" is ~11pt while gaps *within* a
    column run 3-10pt — there is no threshold that separates them. But every
    column reliably STARTS with a word from the form's small header vocabulary
    ("Name", "Nature", "Beneficial", "Location", "Purpose", "Item", "Details",
    "Activities", "Body", …) and no continuation word is in it, so splitting on
    those words recovers the origins exactly.

    Falls back to gap-based splitting when the vocabulary finds nothing, so an
    unfamiliar header still yields a single usable column.
    """
    origins = [w.x0 for w in header.words if looks_like_column_header(w.text, fuzzy)]
    if origins:
        return origins

    origins = []
    prev_x1: Optional[float] = None
    for w in header.words:
        if prev_x1 is None or (w.x0 - prev_x1) > gap_pt:
            origins.append(w.x0)
        prev_x1 = w.x1
    return origins


def is_column_header(band: Band, label_x_max: float, gap_pt: float = 25.0, fuzzy: bool = False) -> bool:
    """True when a band is a table's column-header row.

    EVERY column must start with header vocabulary. Requiring all of them (not
    just the first) is what separates

        Name of trust/nominee company | Nature of its operation | Beneficial interests

    from a data row like

        Not Applicable | Not Applicable | Not Applicable

    Item 2 makes this load-bearing: it has TWO sub-tables, so a second header
    appears mid-item. A parser that only accepts a header immediately after the
    item heading treats the second one as a wrapped value and silently welds it
    onto the preceding row.
    """
    words = [w for w in band.words if w.x0 > label_x_max]
    if not words:
        return False
    # A holder label anywhere in the band means this is a data row.
    if any(holder_of(w.text) for w in band.words):
        return False

    columns: list[str] = []
    prev_x1: Optional[float] = None
    for w in words:
        if prev_x1 is None or (w.x0 - prev_x1) > gap_pt:
            columns.append(w.text)
        prev_x1 = w.x1

    return bool(columns) and all(looks_like_column_header(c, fuzzy) for c in columns)


def assign_columns(words: Iterable[Word], origins: list[float]) -> list[list[str]]:
    """Bucket words into columns by their left edge.

    Returns one LIST OF LINES per column, not one string. Physical line
    structure inside a cell is load-bearing and must survive to the resolvers:
    the real-estate cell lists one property per line, so flattening

        Warragul
        Port Melbourne

    into "Warragul Port Melbourne" produces a locality that matches no suburb
    at all, silently losing both. The parser deliberately does NOT try to guess
    which line breaks are wrapping and which are separate entries — that is
    genuinely ambiguous ("Superannuation - Public Sector Superannuation" /
    "Accumulation Plan" is one value) — so it preserves the evidence and lets
    the location and security resolvers try both readings.
    """
    if not origins:
        return [[" ".join(w.text for w in words)]] if words else [[]]
    cells: list[list[str]] = [[] for _ in origins]
    for w in words:
        idx = 0
        for i, origin in enumerate(origins):
            # A small tolerance absorbs kerning and italic overhang.
            if w.x0 >= origin - 4.0:
                idx = i
        cells[idx].append(w.text)
    return [[" ".join(c).strip()] if c else [] for c in cells]


def merge_cells(target: list[list[str]], addition: list[list[str]]) -> list[list[str]]:
    """Append a continuation band's cells as NEW lines in the matching columns."""
    out = [list(c) for c in target]
    for i, lines in enumerate(addition):
        if not lines:
            continue
        if i >= len(out):
            out.extend([[] for _ in range(i - len(out) + 1)])
        out[i].extend(line for line in lines if line)
    return out


def cell_text(cell: list[str]) -> str:
    """Flatten a cell's lines for display."""
    return " ".join(line for line in cell if line).strip()


def cell_at(cells: list[list[str]], index: int) -> list[str]:
    return cells[index] if index < len(cells) else []


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------


def parse_form_date(text: str) -> tuple[Optional[date], bool]:
    """Pull a dd/mm/yyyy date off a form.

    Returns (date, is_stated). is_stated is False when no legible date exists —
    the read path must then render an unknown date rather than infer one.
    """
    match = DATE_VALUE_RE.search(text or "")
    if not match:
        return None, False
    day, month, year = (int(g) for g in match.groups())
    if year < 100:
        year += 2000
    try:
        return date(year, month, day), True
    except ValueError:
        # Real forms carry transpositions and OCR noise; a bad date is not a
        # reason to drop the whole statement.
        return None, False


def parse_iso_or_form_date(text: str) -> tuple[Optional[date], bool]:
    d, ok = parse_form_date(text)
    if ok:
        return d, ok
    for fmt in ("%d %B %Y", "%d %b %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(" ".join((text or "").split()), fmt).date(), True
        except ValueError:
            continue
    return None, False


# ---------------------------------------------------------------------------
# Item table parsing (base statement geometry)
# ---------------------------------------------------------------------------


def _flush(item: Optional[Item], cells: list[list[str]], holder: Optional[str], change_type: str, page_no: int, ordinal: int) -> int:
    """Commit a pending row onto an item. Returns the next ordinal."""
    if item is None or holder is None:
        return ordinal
    lines = cell_at(cells, 0)
    declared = cell_text(lines)
    secondary = cell_text(cell_at(cells, 1))
    tertiary = cell_text(cell_at(cells, 2))
    if not declared and not secondary and not tertiary:
        return ordinal
    item.rows.append(
        Row(
            holder=holder,
            change_type=change_type,
            ordinal=ordinal,
            declared_text=declared,
            secondary_text=secondary,
            tertiary_text=tertiary,
            declared_lines=[l for l in lines if l],
            contains_amount=bool(AMOUNT_RE.search(declared)),
            # Nil rows are KEPT: "declared nothing under item 1" is a fact, and
            # it is the anti-signal proving the parser saw the item at all.
            is_nil=is_nil_value(declared),
            page_no=page_no,
        )
    )
    return ordinal + 1


def parse_item_tables(
    bands_by_page: list[tuple[int, list[Band]]],
    change_type: str = CHANGE_DECLARED,
    fuzzy: bool = False,
    rules_by_page: Optional[dict[int, list[float]]] = None,
) -> tuple[list[Item], list[str]]:
    """Parse numbered item tables with three holder rows.

    Items are segmented before rows are read (guard 1); the column-header band
    is consumed as a header (guard 2); footers were already dropped (guard 3);
    and a band never crosses a drawn row rule into the previous holder's cell
    (guard 4 — see page_row_rules). rules_by_page is optional and an empty map
    reproduces the pre-rules behaviour exactly.
    """
    items: list[Item] = []
    warnings: list[str] = []
    rules_by_page = rules_by_page or {}

    current: Optional[Item] = None
    origins: list[float] = []
    label_x_max = LABEL_X_MAX
    pending_cells: list[list[str]] = []
    pending_holder: Optional[str] = None
    # Which gap between drawn rules the open row lives in. None until a band
    # opens one; a band from a different slot can never join it.
    pending_slot: Optional[int] = None
    ordinal = 0
    awaiting_header = False
    # Layout probe: in the 48P/46P form a holder label is top-aligned with its
    # block, so values never precede the first label. The 47P form centres the
    # label against a multi-line block, which this parser cannot attribute
    # correctly — those documents are flagged rather than guessed at.
    first_value_y: Optional[float] = None
    first_label_y: Optional[float] = None
    centred_layout = False
    header_open = False

    for page_no, bands in bands_by_page:
        rules = rules_by_page.get(page_no, [])
        for band in bands:
            first = band.words[0]
            token = first.text
            # None on a page with no drawn rules (a scan, an OCR'd page, a test
            # double): every slot comparison below then short-circuits on
            # `rules` and the pre-rules behaviour is reproduced exactly.
            slot = rule_slot(rules, band.y) if rules else None

            # --- item boundary -------------------------------------------
            heading = ITEM_HEADING_RE.match(token)
            if heading and first.x0 <= ITEM_HEADING_X_MAX:
                ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_cells, pending_holder, pending_slot = [], None, None
                item_no = int(heading.group(1))
                if 1 <= item_no <= 14:
                    current = Item(
                        item_no=item_no,
                        item_label=ITEM_LABELS.get(item_no, band.text),
                        page_no=page_no,
                    )
                    items.append(current)
                    origins, ordinal, awaiting_header = [], 0, True
                    first_value_y, first_label_y = None, None
                else:
                    current = None
                continue

            if current is None:
                continue

            # --- column header -------------------------------------------
            # Accepted ANYWHERE inside an item, not only straight after the
            # heading: item 2 has two sub-tables and therefore two headers.
            if is_column_header(band, label_x_max, fuzzy=fuzzy):
                ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_cells, pending_holder, pending_slot = [], None, None
                origins = column_origins(band, fuzzy=fuzzy)
                # NEVER raise the boundary: see LABEL_X_MAX. In the 47P form the
                # header sits RIGHT of the values, so origins[0]-5 would push the
                # boundary past the value column and eat the first word of every
                # cell.
                if origins:
                    label_x_max = min(LABEL_X_MAX, origins[0] - 5.0)
                awaiting_header = False
                header_open = True
                continue

            # A column header can WRAP: item 2 reads "Name of trust/nominee" on
            # one line and "company" on the next. "company" is not header
            # vocabulary, so without this the continuation looks like a value —
            # which flagged 24 correctly-parsed 48P documents as centred-layout.
            if (
                header_open
                and first.x0 > label_x_max
                and not any(w.text[:1].isupper() for w in band.words)
            ):
                continue

            # --- holder row ----------------------------------------------
            holder = holder_of(token) if first.x0 <= label_x_max else None
            if holder:
                header_open = False
                if first_label_y is None:
                    first_label_y = band.y
                    if first_value_y is not None and first_label_y - first_value_y > CENTRED_LABEL_TOLERANCE_PT:
                        centred_layout = True
                # A label that shares its slot with lines already read is a
                # CENTRED label: the cell's first line(s) sit above the label
                # word, inside the same drawn row. Those lines are held with no
                # holder (see the value branch below) and are claimed here — they
                # are this holder's, not the previous holder's.
                carried = pending_cells if (rules and pending_holder is None and pending_slot == slot) else []
                if not carried:
                    ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_holder = holder
                pending_slot = slot
                values = assign_columns([w for w in band.words if w.x0 > label_x_max], origins)
                pending_cells = merge_cells(carried, values) if carried else values
                awaiting_header = False
                continue

            # --- wrapped value (and wrapped holder labels) ---------------
            # A band beginning "Partner" or "Children" is the second physical
            # line of a holder label — but it can ALSO carry the wrapped tail of
            # the previous row's value, because the two sit at nearly the same
            # y. Dropping the whole band loses that tail, so only the label word
            # itself is discarded (it is left of label_x_max anyway).
            # Only bands AFTER the column header count as values. The item
            # heading's own wrapped description ("(i) in which a beneficial
            # interest is held, indicating…") also extends right of the label
            # column, and counting it flagged 144 of 150 correctly-parsed 48P
            # documents as centred-layout.
            if (
                not awaiting_header
                and origins
                and first_value_y is None
                and any(w.x0 > label_x_max for w in band.words)
            ):
                first_value_y = band.y
                header_open = False

            # ONLY a band that begins in the value columns, or the second
            # physical line of a holder label, may extend a cell. Without this
            # the form's own explanatory note for item 2's second sub-table
            # ("ii. in which the Member, the Member's spouse, or a child who is
            # wholly or mainly dependent…") welds itself onto the last row of
            # the FIRST sub-table, because its lines are indented to x≈55-78 and
            # run right past the value column. Measured: 437 rows across 436 of
            # 455 born-digital documents, every one of them a nil row rendered
            # as "Not Applicable the Member, the Member's spouse…".
            if first.x0 <= label_x_max and not HOLDER_CONTINUATION_RE.match(token):
                continue

            values = [w for w in band.words if w.x0 > label_x_max]
            if not values:
                continue
            cells = assign_columns(values, origins)
            if rules and origins:
                if pending_slot == slot and (pending_holder is not None or pending_cells):
                    # Same drawn row: a wrapped line of the open cell, or another
                    # line of a cell whose centred label has not appeared yet.
                    # Both ACCUMULATE — a cell can have several lines above its
                    # label (measured: four, on Wilson_45P item 1).
                    pending_cells = merge_cells(pending_cells, cells)
                else:
                    # A different drawn row. Hold the lines with NO holder: if
                    # this row's label is centred it is still to come and the
                    # holder branch above claims them. If none comes they are
                    # dropped rather than attributed to whichever holder happened
                    # to be open — an omission is recoverable, a holding filed
                    # under the wrong person is not.
                    ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                    pending_holder = None
                    pending_slot = slot
                    pending_cells = cells
            elif pending_holder is not None:
                pending_cells = merge_cells(pending_cells, cells)

    _flush(current, pending_cells, pending_holder, change_type, 0, ordinal)

    if not items:
        warnings.append("no_items_parsed")
    if centred_layout:
        # Holder labels are vertically centred against multi-line blocks (the
        # 47P form). This parser attributes values by label order, so it would
        # silently mis-assign a member's holdings between Self / Spouse /
        # Dependent children. A known gap is recoverable; wrong attribution
        # published under a named person is not.
        warnings.append("centred_label_layout")
    return items, warnings


# ---------------------------------------------------------------------------
# Alteration parsing
# ---------------------------------------------------------------------------


def parse_alteration_page(page_no: int, bands: list[Band], fuzzy: bool = False) -> tuple[list[Item], Optional[date], bool]:
    """Parse one alteration form.

    Handles both observed variants:

      47P  ADDITION / "Item Details" at x≈41, rows read "12. Travel or
           hospitality | Tickets to …" with NO holder rows, so holder is
           'unspecified'.
      48P  ADDITION / "Item Details" at x≈100 with Self / Spouse-Partner /
           Dependent Children rows beneath at x≈41.
    """
    items: dict[tuple[int, str], Item] = {}
    ordinals: dict[tuple[int, str], int] = {}
    change_type = CHANGE_ADDITION
    origins: list[float] = []
    label_x_max = 95.0
    # 47P forms have no holder rows at all, so rows stay 'unspecified' until a
    # holder label proves otherwise.
    current_holder = HOLDER_UNSPECIFIED
    pending: Optional[tuple[int, str, list[list[str]]]] = None  # (item_no, holder, cells)
    lodged, stated = None, False

    def commit() -> None:
        nonlocal pending
        if pending is None:
            return
        item_no, holder, cells = pending
        pending = None
        lines = cells[-1] if cells else []
        detail = cell_text(lines)
        if not detail.strip():
            return
        key = (item_no, change_type)
        item = items.get(key)
        if item is None:
            item = Item(item_no=item_no, item_label=ITEM_LABELS.get(item_no, ""), page_no=page_no)
            items[key] = item
        n = ordinals.get(key, 0)
        ordinals[key] = n + 1
        item.rows.append(
            Row(
                holder=holder,
                change_type=change_type,
                ordinal=n,
                declared_text=detail,
                is_nil=is_nil_value(detail),
                page_no=page_no,
                declared_lines=[l for l in lines if l],
                contains_amount=bool(AMOUNT_RE.search(detail)),
            )
        )

    def item_start(band: Band) -> Optional[tuple[int, list[list[str]]]]:
        """A row opening with 'NN.' in the Item column."""
        cells = assign_columns([w for w in band.words if w.x0 > label_x_max], origins)
        head = cell_text(cell_at(cells, 0))
        if not head:
            return None
        m = ITEM_HEADING_RE.match(head)
        if not m:
            return None
        item_no = int(m.group(1))
        if not 1 <= item_no <= 14:
            return None
        return item_no, cells

    for band in bands:
        first = band.words[0]
        token = first.text
        text = band.text

        if SECTION_ADDITION_RE.match(token):
            commit()
            change_type = CHANGE_ADDITION
            origins, current_holder = [], HOLDER_UNSPECIFIED
            continue
        if SECTION_DELETION_RE.match(token):
            commit()
            change_type = CHANGE_DELETION
            origins, current_holder = [], HOLDER_UNSPECIFIED
            continue

        if is_column_header(band, 0.0, fuzzy=fuzzy):
            commit()
            origins = column_origins(band, fuzzy=fuzzy)
            if origins:
                label_x_max = min(95.0, origins[0] - 5.0)
            continue

        if DATE_LABEL_RE.search(text) or PROCESSED_RE.match(token):
            found, ok = parse_form_date(text)
            # Keep the EARLIEST stated date: "Submitted Date" precedes
            # "Processed by Registrar", and the member's own submission is the
            # event, not the clerk's handling of it.
            if ok and (not stated or (found and lodged and found < lodged)):
                lodged, stated = found, True
            continue

        # A holder label opens a BLOCK, not a single row: under one "Self" there
        # can be several item rows, each starting with its own "NN.".
        holder = holder_of(token) if first.x0 <= label_x_max else None
        if holder:
            commit()
            current_holder = holder
            started = item_start(band)
            if started:
                item_no, cells = started
                pending = (item_no, current_holder, cells[1:] or [[]])
            continue

        started = item_start(band)
        if started:
            commit()
            item_no, cells = started
            pending = (item_no, current_holder, cells[1:] or [[]])
            continue

        # Wrapped continuation of whichever row is open. A band starting
        # "Partner"/"Children" falls through to here on purpose: it is the
        # second line of a holder label, but it often also carries the wrapped
        # tail of the previous row's value at nearly the same y.
        if pending is not None:
            values = [w for w in band.words if w.x0 > label_x_max]
            if values:
                item_no, holder_v, cells = pending
                addition = assign_columns(values, origins)
                pending = (item_no, holder_v, merge_cells(cells, addition[1:] or addition))

    commit()
    return list(items.values()), lodged, stated


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------


def page_form_kind(bands: list[Band]) -> Optional[str]:
    """Which form (if any) this page starts."""
    text = " ".join(b.text for b in bands[:12])
    if ALTERATION_FORM_RE.search(text):
        return STATEMENT_ALTERATION
    if BASE_FORM_RE.search(text):
        return STATEMENT_BASE
    return None


def parse_house_document(
    doc,
    skip_pages: Optional[set[int]] = None,
    ocr: bool = False,
    ocr_dpi: int = OCR_DPI_DEFAULT,
    ocr_backend: str = "vision",
) -> ParsedDocument:
    """Parse a House member statement.

    One PDF holds the member's base Statement of Registrable Interests followed
    by every dated Notification of Alteration they lodged — so a single document
    yields the full event stream for that parliament.

    ocr=True runs each page through Tesseract (via MuPDF) first, which lets the
    SAME geometry parser read a scanned document. Measured on Gosling_48P — a
    0-chars/page scan — Tesseract at 200dpi recovered every typed value exactly.
    That keeps scans on the deterministic path instead of an LLM: no quota, no
    per-token cost, ~0.8s/page against ~14s, and no hallucination surface at all.
    """
    skip_pages = skip_pages or set()
    out = ParsedDocument()

    pages: list[tuple[int, list[Band], Optional[str]]] = []
    rules_by_page: dict[int, list[float]] = {}
    for index in range(doc.page_count):
        page_no = index + 1
        if page_no in skip_pages:
            continue
        page = doc[index]
        textpage = None
        ocr_words = None
        if ocr:
            try:
                if ocr_backend == "vision":
                    # Apple Vision: reads item NUMBERS correctly, which Tesseract
                    # does not (it renders "1." as "4,"). See register_ocr.py.
                    from register_ocr import page_ocr_words

                    ocr_words = [w.as_tuple() for w in page_ocr_words(page, dpi=ocr_dpi)]
                else:
                    textpage = page.get_textpage_ocr(flags=0, dpi=ocr_dpi, full=True)
            except Exception as exc:  # noqa: BLE001
                # A page we cannot OCR stays unattributed, which lowers page
                # coverage and quarantines the document — never published empty.
                out.warnings.append(f"ocr_failed:page_{page_no}")
                logging.getLogger("register_parse").warning(
                    "OCR failed on page %d: %s", page_no, exc
                )
        bands = page_bands(page, textpage=textpage, words=ocr_words)
        if not bands:
            continue
        # Rules come from the PDF's own vectors, so an OCR'd page contributes
        # none and falls back to label-order attribution unchanged.
        if not ocr:
            found = page_row_rules(page)
            if found:
                rules_by_page[page_no] = found
        pages.append((page_no, bands, page_form_kind(bands)))

    if not pages:
        out.warnings.append("no_readable_pages")
        return out

    # Group pages into statements: a form marker opens one, later pages continue
    # it until the next marker.
    groups: list[tuple[str, list[tuple[int, list[Band]]]]] = []
    for page_no, bands, kind in pages:
        if kind is not None or not groups:
            groups.append((kind or STATEMENT_BASE, []))
        groups[-1][1].append((page_no, bands))

    for ordinal, (kind, group) in enumerate(groups):
        page_from = group[0][0]
        page_to = group[-1][0]
        statement = Statement(ordinal=ordinal, kind=kind, page_from=page_from, page_to=page_to)

        if kind == STATEMENT_BASE:
            items, warnings = parse_item_tables(group, fuzzy=ocr, rules_by_page=rules_by_page)
            statement.items = items
            statement.warnings.extend(warnings)
            joined = " ".join(b.text for _, bands in group for b in bands)
            statement.lodged_date, statement.date_is_stated = parse_form_date(joined)
        else:
            for page_no, bands in group:
                items, lodged, stated = parse_alteration_page(page_no, bands, fuzzy=ocr)
                statement.items.extend(items)
                if stated and (not statement.date_is_stated or (lodged and statement.lodged_date and lodged < statement.lodged_date)):
                    statement.lodged_date, statement.date_is_stated = lodged, True

        out.statements.append(statement)
        out.pages_attributed += len(group)

    return out


def item_row_count(parsed: ParsedDocument, item_no: Optional[int] = None, include_nil: bool = True) -> int:
    """Count parsed rows, optionally for one item. Used by the QA gates."""
    total = 0
    for statement in parsed.statements:
        for item in statement.items:
            if item_no is not None and item.item_no != item_no:
                continue
            for row in item.rows:
                if include_nil or not row.is_nil:
                    total += 1
    return total
