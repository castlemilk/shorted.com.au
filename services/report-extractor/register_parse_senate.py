"""Deterministic parser for Senate register-of-interests tabled volumes.

One PDF is a VOLUME: dozens of senators' statements bound together, sorted by
surname. There are no per-senator PDFs (see architecture.md §1.3), so identity
cannot come from the manifest hint the way it does for House documents — each
statement carries its own header block:

    Surname:            Allman-Payne
    Other names:        Penny
    State/Territory:    Queensland
    Date:               14/08/2025

and the splitter anchors on THAT block. It must not anchor on "Form A": that is
a running page header repeated on every page of a statement (§2.7 — measured
180 bare "Form A" lines against 55 Surname blocks in the 2025 volume), so using
it as the delimiter shatters each statement into fragments.

# The senate base form has NO holder rows

Unlike the House form's Self / Spouse-Partner / Dependent children rows, the
Senate Form A tables put values straight under the column header:

    3.  Real estate, including the location (suburb or area only) and the
        purpose for which it is owned
        Location                     Purpose for which owned
        South Gladstone, Queensland  Residential
        Cleveland, Queensland        Investment (former home)

so every row is holder='unspecified' — publishing a guessed holder under a
named person is worse than not splitting (the same reasoning as the House
centred-label quarantine).

Alteration statements reuse parse_alteration_page unchanged: the Senate
alteration table ("Item number | Details" with Addition/Deletion sections) is
the same shape as the 47P House variant it already handles.

Scanned pages inside a volume go through the same per-page OCR path the House
parser uses (Apple Vision boxes into the same geometry parser), with fuzzy
header matching scoped to those pages only.

Design notes: docs/feature/politicians/architecture.md §1.3, §2.7
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from register_parse import (
    Band,
    Item,
    ParsedDocument,
    Row,
    Statement,
    assign_columns,
    cell_text,
    column_origins,
    is_column_header,
    is_nil_value,
    merge_cells,
    page_bands,
    page_row_rules,
    parse_alteration_page,
    rule_slot,
    AMOUNT_RE,
    OCR_DPI_DEFAULT,
)
from register_schema import (
    CHANGE_DECLARED,
    HOLDER_UNSPECIFIED,
    ITEM_LABELS,
    PAGE_KIND_SCAN,
    STATEMENT_ALTERATION,
    STATEMENT_BASE,
    classify_page,
)

log = logging.getLogger("register_parse_senate")

# --- statement header block ------------------------------------------------

# The labels are typed boilerplate and may be matched loosely (the standing
# rule: headings loose, values never). OCR renders "Surname:" as "Sumame:"
# often enough that exact matching would drop whole statements from scanned
# volumes — an unsplit statement is invisible, not just imperfect.
SURNAME_LABEL_RE = re.compile(r"^s[uv]r?n?[a-z]*ames?\s*:?$", re.I)
OTHER_NAMES_LABEL_RE = re.compile(r"^other$", re.I)
STATE_LABEL_RE = re.compile(r"^state/?(territory)?\s*:?$", re.I)
DATE_LABEL_RE = re.compile(r"^date\s*:?$", re.I)
ALTERATION_HEADER_RE = re.compile(r"alterat", re.I)
FORM_HEADER_RE = re.compile(r"^form\b", re.I)

DATE_VALUE_RE = re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b")

# The gap between a header label and its value column (labels end ~x=121,
# values start ~x=156-162 across observed volumes).
HEADER_VALUE_X_MIN = 130.0

# Item headings: "3." at the table's left margin, heading text indented right
# of it. Values share the same left margin, so the number alone is not enough —
# the heading keyword guard below does the real work.
ITEM_NO_RE = re.compile(r"^(\d{1,2})\.$")
ITEM_NO_GLUED_RE = re.compile(r"^(\d{1,2})\.(.+)$")

# Keywords that prove a "NN." band is the form's own item heading rather than a
# declared value that happens to start with a number. Headings are boilerplate;
# matching them by keyword is the same licence the House parser takes with
# ITEM_LABELS. Values are NEVER matched loosely.
SENATE_ITEM_KEYWORDS: dict[int, tuple[str, ...]] = {
    1: ("shareholding",),
    2: ("trust", "nominee"),
    3: ("real estate",),
    4: ("directorship",),
    5: ("partnership",),
    6: ("liabilit",),
    7: ("bonds", "debenture"),
    8: ("savings", "investment account"),
    9: ("other assets",),
    10: ("income",),
    11: ("gifts",),
    12: ("travel", "hospitality"),
    13: ("office holder", "donating", "contributor"),
    14: ("other interests", "conflict"),
}

# Sub-table markers inside item 2. Their explanatory sentences are indented
# into the value region, so without consuming them they parse as values.
SUBITEM_RE = re.compile(r"^\((i{1,3}|iv)\)$", re.I)

# Header words the Senate form uses that the shared vocabulary lacks
# ("Detail of gifts" — singular). Kept LOCAL to this parser: the shared
# COLUMN_HEADER_TOKENS is pinned by the House golden set.
SENATE_HEADER_WORD_RE = re.compile(r"^detail\b", re.I)

# The writable Form A template's own boilerplate, seen inside otherwise-typed
# statements (measured on Hanson 2025: an "Example—AMP, Telstra, XYZ Pty Ltd"
# line before every table, a leftover "JANUARY TO JUNE 2014" running header on
# every page, and "(Note: …)" guidance lines). All are the FORM talking, not
# the senator declaring — reading one as a value publishes boilerplate as a
# fact about a named person. Boilerplate may be matched loosely; values never.
TEMPLATE_PERIOD_RE = re.compile(r"^[A-Z]{3,9}\s+TO\s+[A-Z]{3,9}\s+\d{4}$")
EXAMPLE_LINE_RE = re.compile(r"^example\s*[-–—]?", re.I)
NOTE_LINE_RE = re.compile(r"^\(note\b", re.I)


def _is_senate_header(band: Band, fuzzy: bool) -> bool:
    if is_column_header(band, 0.0, fuzzy=fuzzy):
        return True
    # Single-column senate headers like "Detail of gifts".
    return bool(band.words) and SENATE_HEADER_WORD_RE.match(band.words[0].text) is not None


def _senate_origins(band: Band, fuzzy: bool) -> list[float]:
    from register_parse import looks_like_column_header

    origins = [
        w.x0
        for w in band.words
        if looks_like_column_header(w.text, fuzzy) or SENATE_HEADER_WORD_RE.match(w.text)
    ]
    if origins:
        return origins
    return column_origins(band, fuzzy=fuzzy)


@dataclass
class HeaderBlock:
    surname: str = ""
    other_names: str = ""
    state: str = ""
    lodged: Optional[date] = None
    date_is_stated: bool = False


def _value_of(band: Band) -> str:
    return " ".join(w.text for w in band.words if w.x0 >= HEADER_VALUE_X_MIN).strip()


def find_header_block(bands: list[Band]) -> Optional[HeaderBlock]:
    """The Surname / Other names / State / Date block that opens a statement.

    Returns None when the page has no Surname label — a continuation page.
    A Surname label with an empty value cell still opens a statement (a scan
    whose OCR missed the name): the statement is real, its identity is simply
    unresolved, and withholding identity is the correct failure mode.
    """
    block: Optional[HeaderBlock] = None
    for band in bands:
        if not band.words:
            continue
        first = band.words[0]
        # Header labels sit at the form's left margin. Anything indented is a
        # value or prose mentioning the word.
        if first.x0 > 90.0:
            continue
        token = first.text
        if SURNAME_LABEL_RE.match(token) and "other" not in token.lower():
            if block is None:
                block = HeaderBlock()
            if not block.surname:
                block.surname = _value_of(band)
        elif block is not None and OTHER_NAMES_LABEL_RE.match(token):
            if not block.other_names:
                block.other_names = _value_of(band)
        elif block is not None and STATE_LABEL_RE.match(token):
            if not block.state:
                block.state = _value_of(band)
        elif block is not None and DATE_LABEL_RE.match(token):
            m = DATE_VALUE_RE.search(_value_of(band))
            if m and block.lodged is None:
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if y < 100:
                    y += 2000 if y < 70 else 1900
                try:
                    block.lodged = date(y, mo, d)
                    block.date_is_stated = True
                except ValueError:
                    pass
    return block


def page_statement_kind(bands: list[Band]) -> str:
    """base | alteration, read from the page's running "Form A" header."""
    for band in bands[:3]:
        if FORM_HEADER_RE.match(band.words[0].text) or "form" in band.text.lower()[:20]:
            if ALTERATION_HEADER_RE.search(band.text):
                return STATEMENT_ALTERATION
            return STATEMENT_BASE
    # No legible page header: assume base; the header block still splits
    # correctly and an alteration misfiled as base over-reports nothing (its
    # rows still carry addition/deletion change types when parsed as one).
    return STATEMENT_BASE


def _heading_of(band: Band) -> Optional[tuple[int, float]]:
    """(item_no, text_x0) when a band opens 'NN. <heading text>'."""
    first = band.words[0]
    if first.x0 > 90.0:
        return None
    m = ITEM_NO_RE.match(first.text)
    if m:
        rest_x0 = band.words[1].x0 if len(band.words) > 1 else first.x0
        return int(m.group(1)), rest_x0
    m = ITEM_NO_GLUED_RE.match(first.text)
    if m:
        return int(m.group(1)), first.x0
    return None


def _is_item_heading(band: Band, item_no: int, fuzzy: bool) -> bool:
    """Keyword guard: the band (which may be only the first line of a wrapped
    heading) must mention the form's own words for that item.

    On an OCR page (fuzzy=True) a sequential item number is accepted on its
    own: OCR damage hits exactly the boilerplate the keywords live in, and the
    ascending-number constraint already excludes almost every value row.
    """
    keywords = SENATE_ITEM_KEYWORDS.get(item_no)
    if not keywords:
        return False
    text = band.text.lower()
    if any(k in text for k in keywords):
        return True
    return fuzzy


def parse_senate_base_items(
    pages: list[tuple[int, list[Band], list[float]]],
    fuzzy_pages: Optional[set[int]] = None,
) -> tuple[list[Item], list[str]]:
    """Parse the 14 holder-less item tables of one senate base statement.

    Row grouping uses the form's own drawn rules where present (one rule slot =
    one row, lines inside it preserved as declared_lines — the House parser's
    guard 4). On ruleless pages (scans) a band with first-column content opens
    a row and later column-only bands extend it.
    """
    fuzzy_pages = fuzzy_pages or set()
    items: list[Item] = []
    warnings: list[str] = []

    current: Optional[Item] = None
    origins: list[float] = []
    awaiting_header = True
    pending_cells: list[list[str]] = []
    pending_slot: Optional[int] = None
    pending_page = 0
    ordinal = 0
    last_item_no = 0

    def flush() -> None:
        nonlocal pending_cells, pending_slot, ordinal
        if current is None or not pending_cells:
            pending_cells, pending_slot = [], None
            return
        primary = cell_text(pending_cells[0] if pending_cells else [])
        secondary = cell_text(pending_cells[1]) if len(pending_cells) > 1 else ""
        tertiary = cell_text(pending_cells[2]) if len(pending_cells) > 2 else ""
        if not (primary or secondary or tertiary):
            pending_cells, pending_slot = [], None
            return
        current.rows.append(
            Row(
                holder=HOLDER_UNSPECIFIED,
                change_type=CHANGE_DECLARED,
                ordinal=ordinal,
                declared_text=primary,
                secondary_text=secondary,
                tertiary_text=tertiary,
                is_nil=is_nil_value(primary) and (is_nil_value(secondary) if secondary else True),
                page_no=pending_page,
                declared_lines=[l for l in (pending_cells[0] if pending_cells else []) if l],
                contains_amount=bool(AMOUNT_RE.search(" ".join([primary, secondary, tertiary]))),
            )
        )
        ordinal += 1
        pending_cells, pending_slot = [], None

    for page_no, bands, rules in pages:
        fuzzy = page_no in fuzzy_pages
        for band in bands:
            if not band.words:
                continue
            first = band.words[0]
            slot = rule_slot(rules, band.y) if rules else None

            # --- item boundary ------------------------------------------
            heading = _heading_of(band)
            if heading is not None:
                item_no, _ = heading
                if 1 <= item_no <= 14 and item_no > last_item_no and _is_item_heading(band, item_no, fuzzy):
                    flush()
                    current = Item(
                        item_no=item_no,
                        item_label=ITEM_LABELS.get(item_no, band.text),
                        page_no=page_no,
                    )
                    items.append(current)
                    last_item_no = item_no
                    origins, awaiting_header, ordinal = [], True, 0
                    continue

            if current is None:
                continue

            # The running "Form A" page header and template boilerplate.
            if FORM_HEADER_RE.match(first.text) and band.y < 60.0:
                continue
            text = band.text.strip()
            if (
                TEMPLATE_PERIOD_RE.match(text)
                or EXAMPLE_LINE_RE.match(text)
                or NOTE_LINE_RE.match(text)
            ):
                continue

            # Sub-table marker "(i)" / "(ii)": its explanatory sentence runs
            # into the value region, so consume until the sub-table's own
            # column header.
            if SUBITEM_RE.match(first.text) and first.x0 < 110.0:
                flush()
                awaiting_header = True
                continue

            # --- column header ------------------------------------------
            if _is_senate_header(band, fuzzy):
                flush()
                origins = _senate_origins(band, fuzzy)
                awaiting_header = False
                continue

            # Wrapped heading / explanatory text before the table starts.
            if awaiting_header:
                continue
            if not origins:
                continue

            # --- value row ----------------------------------------------
            cells = assign_columns(band.words, origins)
            has_primary = bool(cells and cells[0])
            if rules:
                if pending_cells and pending_slot == slot:
                    pending_cells = merge_cells(pending_cells, cells)
                else:
                    flush()
                    pending_cells, pending_slot, pending_page = cells, slot, page_no
            else:
                if has_primary or not pending_cells:
                    flush()
                    pending_cells, pending_slot, pending_page = cells, None, page_no
                else:
                    pending_cells = merge_cells(pending_cells, cells)

        # A page boundary inside an item: keep the open row open — cells wrap
        # across pages — but rules are per-page, so the slot resets.
        pending_slot = None

    flush()
    if not items:
        warnings.append("no_items_parsed")
    return items, warnings


def _page_kind(page) -> str:
    """Per-page text/scan/blank verdict, same signals the classify stage uses."""
    try:
        text = page.get_text() or ""
    except Exception:  # noqa: BLE001
        text = ""
    area = abs(page.rect.width * page.rect.height) or 1.0
    coverage = 0.0
    blocks = 0
    try:
        for img in page.get_image_info():
            bbox = img.get("bbox")
            if bbox:
                w = max(bbox[2] - bbox[0], 0.0)
                h = max(bbox[3] - bbox[1], 0.0)
                coverage = max(coverage, (w * h) / area)
        blocks = len(page.get_text("blocks") or [])
    except Exception:  # noqa: BLE001
        pass
    return classify_page(len(text.strip()), coverage, blocks)


def parse_senate_volume(
    doc,
    ocr: bool = True,
    ocr_dpi: int = OCR_DPI_DEFAULT,
    ocr_backend: str = "vision",
) -> ParsedDocument:
    """Parse a tabled Senate volume into per-senator statements.

    ocr=True sends pages classified as scans through the same per-page OCR the
    House parser uses, with fuzzy header matching scoped to exactly those
    pages. A page that fails OCR contributes no bands, stays unattributed, and
    drags coverage down — the partial quarantine then withholds the volume
    rather than publishing silence as absence.
    """
    out = ParsedDocument()

    # ---- read every page once -------------------------------------------
    pages: list[tuple[int, list[Band], list[float], bool]] = []
    for index in range(doc.page_count):
        page_no = index + 1
        page = doc[index]
        kind = _page_kind(page)
        textpage = None
        ocr_words = None
        used_ocr = False
        if kind == PAGE_KIND_SCAN and ocr:
            used_ocr = True
            try:
                if ocr_backend == "vision":
                    from register_ocr import page_ocr_words

                    ocr_words = [w.as_tuple() for w in page_ocr_words(page, dpi=ocr_dpi)]
                else:
                    textpage = page.get_textpage_ocr(flags=0, dpi=ocr_dpi, full=True)
            except Exception as exc:  # noqa: BLE001
                out.warnings.append(f"ocr_failed:page_{page_no}")
                log.warning("OCR failed on page %d: %s", page_no, exc)
                continue
        bands = page_bands(page, textpage=textpage, words=ocr_words)
        if not bands:
            continue
        rules = [] if used_ocr else page_row_rules(page)
        pages.append((page_no, bands, rules, used_ocr))

    if not pages:
        out.warnings.append("no_readable_pages")
        return out

    # ---- split into statements on the Surname header block ---------------
    @dataclass
    class Section:
        kind: str
        header: HeaderBlock
        pages: list[tuple[int, list[Band], list[float], bool]] = field(default_factory=list)

    sections: list[Section] = []
    for page_no, bands, rules, used_ocr in pages:
        header = find_header_block(bands)
        if header is not None:
            sections.append(Section(kind=page_statement_kind(bands), header=header))
        if not sections:
            # Cover / contents pages before the first statement.
            continue
        sections[-1].pages.append((page_no, bands, rules, used_ocr))

    if not sections:
        out.warnings.append("no_statements_found")
        return out

    # ---- parse each statement --------------------------------------------
    for ordinal, section in enumerate(sections):
        page_from = section.pages[0][0]
        page_to = section.pages[-1][0]
        statement = Statement(
            ordinal=ordinal,
            kind=section.kind,
            page_from=page_from,
            page_to=page_to,
            lodged_date=section.header.lodged,
            date_is_stated=section.header.date_is_stated,
        )
        statement.declared_surname = section.header.surname
        statement.declared_other_names = section.header.other_names
        statement.declared_state = section.header.state

        fuzzy_pages = {p for p, _, _, used in section.pages if used}
        if section.kind == STATEMENT_ALTERATION:
            for page_no, bands, _, used in section.pages:
                items, lodged, stated = parse_alteration_page(page_no, bands, fuzzy=used)
                statement.items.extend(items)
                if stated and not statement.date_is_stated:
                    statement.lodged_date, statement.date_is_stated = lodged, True
        else:
            items, warnings = parse_senate_base_items(
                [(p, b, r) for p, b, r, _ in section.pages],
                fuzzy_pages=fuzzy_pages,
            )
            statement.items = items
            statement.warnings.extend(warnings)

        out.statements.append(statement)

        # Attribute a statement's pages ONLY when its tables actually parsed.
        # Splitting is much more OCR-robust than table parsing — the 2013
        # volume split into 129 statements while yielding 27 item tables — and
        # counting split-but-unparsed pages as attributed reports ~98% coverage
        # for a volume that was barely read, sailing past the partial
        # quarantine and publishing near-empty statements under named people.
        # A base statement must surface at least half of the form's 14 item
        # tables; an alteration must yield at least one row (an alteration
        # that alters nothing does not exist — a rowless one is a parse miss).
        if section.kind == STATEMENT_ALTERATION:
            parsed_ok = any(i.rows for i in statement.items)
        else:
            parsed_ok = len(statement.items) >= 7
        if parsed_ok:
            out.pages_attributed += len(section.pages)
        else:
            statement.warnings.append("tables_unparsed")

    return out
