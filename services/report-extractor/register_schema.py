"""Shared constants and the artifact schema for register-of-interests extraction.

The Registers of Members' and Senators' Interests use one 14-item form across
both chambers. Each item is a table with three holder rows (Self /
Spouse-Partner / Dependent children).

EDITORIAL (docs/influence-editorial-standards.md rule 5): the registers disclose
WHAT is held, NEVER quantity or value. No field in this schema records an
amount, and none may be added. If a cell appears to contain a figure it is
transcribed verbatim into `declared_text` and flagged with `contains_amount` for
review — a flag, never a number.

Design notes: docs/politician-register-architecture.md
"""

from __future__ import annotations

# Bump MAJOR when a consumer of the artifact must change. register_extractions is
# UNIQUE on (content_sha256, extractor_version, tier), so a bump coexists with
# the previous artifact rather than destroying it.
SCHEMA_VERSION = "1.0.0"
EXTRACTOR_NAME = "register_parse"

# --- classification -------------------------------------------------------

# A page below this many extractable characters holds no readable content.
#
# Grounded in measurement, not taste: born-digital House pages run 380-860
# chars/page and scanned ones run 0-46. 44P sits at 0, 45P at 35-46, and the
# scanned pages inside Albanese_48P at ~7. 120 sits in the empty middle of that
# gap with room on both sides.
SCAN_PAGE_CHAR_THRESHOLD = 120

# A low-character page is only a SCAN if there is actually an image to read.
# Otherwise it is a blank continuation page and there is nothing to extract.
#
# This distinction is worth real money and was measured, not assumed. Every
# born-digital House statement carries a full-bleed letterhead image, so
# "has an image" alone marks every blank page as a scan — which would have sent
# ~1,000 empty pages to the vision tier across the corpus.
#
# Across a 10-document sample plus a known scan, the two populations separated
# unanimously:
#
#   blank continuation page   image coverage 0.84, 1 text block (the page number)
#   true scanned page         image coverage 1.00, 0 text blocks
#
# 0.95 sits in the gap.
FULL_BLEED_COVERAGE = 0.95

PAGE_KIND_TEXT = "text"
PAGE_KIND_SCAN = "scan"
PAGE_KIND_BLANK = "blank"

# Document-level classification, derived from the per-page verdicts. A document
# is 'mixed' when it holds both readable and scanned pages — not an edge case:
# Albanese_48P is a scan inside an otherwise all-text parliament, and the whole
# 47th Parliament is mixed. Dispatch is therefore per PAGE, and this label is
# only a summary.
TEXT_CLASS_TEXT = "text"
TEXT_CLASS_SCAN = "scan"
TEXT_CLASS_MIXED = "mixed"

# --- the form -------------------------------------------------------------

# Canonical item labels, keyed by item number. Headings are boilerplate and may
# be matched loosely; VALUES are never fuzzy-matched.
ITEM_LABELS: dict[int, str] = {
    1: "Shareholdings in public and private companies",
    2: "Family and business trusts and nominee companies",
    3: "Real estate",
    4: "Registered directorships of companies",
    5: "Partnerships",
    6: "Liabilities",
    7: "Bonds, debentures and like investments",
    8: "Savings or investment accounts",
    9: "Other assets",
    10: "Other substantial sources of income",
    11: "Gifts",
    12: "Sponsored travel or hospitality",
    13: "Office holder or financial contributor",
    14: "Other interests",
}

# The two items that carry the joins the product is built on.
ITEM_SHAREHOLDINGS = 1
ITEM_REAL_ESTATE = 3
ITEM_DIRECTORSHIPS = 4

HOLDER_SELF = "self"
HOLDER_SPOUSE = "spouse_partner"
HOLDER_DEPENDENT = "dependent_children"
HOLDER_UNSPECIFIED = "unspecified"

HOLDERS = (HOLDER_SELF, HOLDER_SPOUSE, HOLDER_DEPENDENT, HOLDER_UNSPECIFIED)

CHANGE_DECLARED = "declared"
CHANGE_ADDITION = "addition"
CHANGE_DELETION = "deletion"

STATEMENT_BASE = "base"
STATEMENT_ALTERATION = "alteration"

TIER_DETERMINISTIC = "deterministic"
TIER_VISION = "vision"
TIER_HYBRID = "hybrid"

# Cell values meaning "nothing declared". Stored rather than dropped: "declared
# nothing under item 1" is a fact, and it is also the anti-signal proving the
# parser actually saw the item (see the register_extraction_stats view).
NIL_VALUES = frozenset(
    {
        "",
        "-",
        "--",
        "n/a",
        "na",
        "nil",
        "none",
        "not applicable",
        "notapplicable",
    }
)


def is_nil_value(text: str) -> bool:
    """True when a cell means 'nothing declared'."""
    normalised = " ".join((text or "").split()).strip().lower().rstrip(".")
    return normalised in NIL_VALUES


def classify_page(char_count: int, image_coverage: float = 0.0, text_blocks: int = 0) -> str:
    """Per-page verdict. Dispatch is per page, never per document.

    A page with enough extractable text is TEXT. Below that it is SCAN when
    there is evidence of an unreadable image, else BLANK.

    The scan test is an OR of two signals rather than an AND, deliberately. The
    two failure modes are not symmetric: calling a blank page a scan wastes one
    cheap vision call, while calling a scanned page blank silently LOSES a
    member's declared interests. So we err toward reading it.
    """
    if char_count >= SCAN_PAGE_CHAR_THRESHOLD:
        return PAGE_KIND_TEXT
    if image_coverage >= FULL_BLEED_COVERAGE or text_blocks == 0:
        return PAGE_KIND_SCAN
    return PAGE_KIND_BLANK


def classify_document(page_kinds: list[str]) -> tuple[str, int, int]:
    """Summarise per-page verdicts into (text_class, scan_pages, blank_pages).

    Blank pages are excluded from the text-vs-scan judgement entirely: a
    born-digital statement whose only non-text pages are blank continuation
    pages is 'text', not 'mixed'. Counting them would have marked every single
    House document 'mixed'.

    A document with no pages at all is 'scan' — zero extractable text is exactly
    what a scan looks like, and calling it text would silently skip the vision
    tier.
    """
    if not page_kinds:
        return TEXT_CLASS_SCAN, 0, 0

    scan_pages = sum(1 for k in page_kinds if k == PAGE_KIND_SCAN)
    blank_pages = sum(1 for k in page_kinds if k == PAGE_KIND_BLANK)
    text_pages = sum(1 for k in page_kinds if k == PAGE_KIND_TEXT)

    if scan_pages == 0:
        return TEXT_CLASS_TEXT, 0, blank_pages
    if text_pages == 0:
        return TEXT_CLASS_SCAN, scan_pages, blank_pages
    return TEXT_CLASS_MIXED, scan_pages, blank_pages
