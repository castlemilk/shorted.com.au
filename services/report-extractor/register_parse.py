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

Design notes: docs/politician-register-architecture.md
"""

from __future__ import annotations

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
DATE_LABEL_RE = re.compile(r"(submitted\s+date|signed|date)\s*:?", re.I)
DATE_VALUE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")
PROCESSED_RE = re.compile(r"^processed\b", re.I)
# Editorial rule 5: we never CREATE a numeric field, but when the source itself
# states a figure (item 11 gifts sometimes read "(valued at $620.40)") the text
# is kept verbatim and flagged for review. Expected rate is near zero; a spike
# in the vision tier means the model is hallucinating numbers.
AMOUNT_RE = re.compile(r"\$\s?\d")


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


def page_bands(page) -> list[Band]:
    """Cluster a page's words into visual lines, dropping footer chrome."""
    height = page.rect.height or 1.0
    cutoff = height * FOOTER_ZONE

    raw = [
        Word(x0, y0, x1, y1, text)
        for x0, y0, x1, y1, text, *_ in page.get_text("words")
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


def holder_of(token: str) -> Optional[str]:
    for pattern, holder in HOLDER_PATTERNS:
        if pattern.match(token):
            return holder
    return None


# ---------------------------------------------------------------------------
# Column model
# ---------------------------------------------------------------------------


def column_origins(header: Band, gap_pt: float = 25.0) -> list[float]:
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
    origins = [w.x0 for w in header.words if COLUMN_HEADER_TOKENS.match(w.text)]
    if origins:
        return origins

    origins = []
    prev_x1: Optional[float] = None
    for w in header.words:
        if prev_x1 is None or (w.x0 - prev_x1) > gap_pt:
            origins.append(w.x0)
        prev_x1 = w.x1
    return origins


def is_column_header(band: Band, label_x_max: float, gap_pt: float = 25.0) -> bool:
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

    return bool(columns) and all(COLUMN_HEADER_TOKENS.match(c) for c in columns)


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


def parse_item_tables(bands_by_page: list[tuple[int, list[Band]]], change_type: str = CHANGE_DECLARED) -> tuple[list[Item], list[str]]:
    """Parse numbered item tables with three holder rows.

    Items are segmented before rows are read (guard 1); the column-header band
    is consumed as a header (guard 2); footers were already dropped (guard 3).
    """
    items: list[Item] = []
    warnings: list[str] = []

    current: Optional[Item] = None
    origins: list[float] = []
    label_x_max = LABEL_X_MAX
    pending_cells: list[list[str]] = []
    pending_holder: Optional[str] = None
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
        for band in bands:
            first = band.words[0]
            token = first.text

            # --- item boundary -------------------------------------------
            heading = ITEM_HEADING_RE.match(token)
            if heading and first.x0 <= ITEM_HEADING_X_MAX:
                ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_cells, pending_holder = [], None
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
            if is_column_header(band, label_x_max):
                ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_cells, pending_holder = [], None
                origins = column_origins(band)
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
                ordinal = _flush(current, pending_cells, pending_holder, change_type, page_no, ordinal)
                pending_holder = holder
                pending_cells = assign_columns([w for w in band.words if w.x0 > label_x_max], origins)
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

            if pending_holder is not None:
                values = [w for w in band.words if w.x0 > label_x_max]
                if values:
                    pending_cells = merge_cells(pending_cells, assign_columns(values, origins))

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


def parse_alteration_page(page_no: int, bands: list[Band]) -> tuple[list[Item], Optional[date], bool]:
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

        if is_column_header(band, 0.0):
            commit()
            origins = column_origins(band)
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


def parse_house_document(doc, skip_pages: Optional[set[int]] = None) -> ParsedDocument:
    """Parse a born-digital House member statement.

    One PDF holds the member's base Statement of Registrable Interests followed
    by every dated Notification of Alteration they lodged — so a single document
    yields the full event stream for that parliament.
    """
    skip_pages = skip_pages or set()
    out = ParsedDocument()

    pages: list[tuple[int, list[Band], Optional[str]]] = []
    for index in range(doc.page_count):
        page_no = index + 1
        if page_no in skip_pages:
            continue
        bands = page_bands(doc[index])
        if not bands:
            continue
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
            items, warnings = parse_item_tables(group)
            statement.items = items
            statement.warnings.extend(warnings)
            joined = " ".join(b.text for _, bands in group for b in bands)
            statement.lodged_date, statement.date_is_stated = parse_form_date(joined)
        else:
            for page_no, bands in group:
                items, lodged, stated = parse_alteration_page(page_no, bands)
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
