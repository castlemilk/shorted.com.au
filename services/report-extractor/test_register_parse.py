"""Tests for the deterministic register parser.

The geometry in these fixtures is transcribed from real documents (word x/y
positions printed straight out of pymupdf), so a passing test means the parser
handles the actual form, not an idealised one.

The source PDFs are NOT committed — the licence permits extracted facts, not a
mirror — so the whole-document golden set runs only when a local cache is
present and skips otherwise. See docs/feature/politicians/architecture.md.
"""

from __future__ import annotations

import json
import os
import unittest
from datetime import date
from pathlib import Path

from register_parse import (
    Band,
    Word,
    assign_columns,
    cell_text,
    column_origins,
    is_column_header,
    page_bands,
    parse_alteration_page,
    parse_form_date,
    parse_item_tables,
)
from register_schema import (
    CHANGE_ADDITION,
    CHANGE_DELETION,
    HOLDER_DEPENDENT,
    HOLDER_SELF,
    HOLDER_SPOUSE,
    HOLDER_UNSPECIFIED,
)


def W(x, y, text):
    """A word at (x, y). Width is estimated; only the left edge matters."""
    return Word(x0=x, y0=y, x1=x + 6.0 * len(text), y1=y + 10.0, text=text)


def band(*words):
    ws = sorted(words, key=lambda w: w.x0)
    return Band(y=ws[0].y0, words=ws)


def line(y, *pairs):
    return band(*[W(x, y, t) for x, t in pairs])


class FakePage:
    """Minimal pymupdf page stand-in for page_bands()."""

    class Rect:
        def __init__(self, h):
            self.width, self.height = 595.0, h

    def __init__(self, words, height=842.0):
        self._words = words
        self.rect = FakePage.Rect(height)

    def get_text(self, kind="text"):
        if kind == "words":
            return [(w.x0, w.y0, w.x1, w.y1, w.text, 0, 0, 0) for w in self._words]
        return " ".join(w.text for w in self._words)


# ---------------------------------------------------------------------------
# Band clustering
# ---------------------------------------------------------------------------


class TestPageBands(unittest.TestCase):
    def test_words_on_one_visual_line_form_one_band(self):
        page = FakePage([W(41, 190.8, "Self"), W(101, 190.8, "Not"), W(119, 190.8, "Applicable")])
        bands = page_bands(page)
        self.assertEqual(len(bands), 1)
        self.assertEqual(bands[0].text, "Self Not Applicable")

    def test_sub_point_offsets_do_not_split_a_line(self):
        """Regression. A real column header measured 'Details' at y=498.5 and
        'Item' at y=499.7. Bucketing with round(y/3) put them in different
        buckets, so only one column origin survived and the row's cells were
        welded together."""
        page = FakePage([W(392, 498.5, "Details"), W(100, 499.7, "Item")])
        bands = page_bands(page)
        self.assertEqual(len(bands), 1, "a 1.2pt offset must not split a line")
        self.assertEqual(bands[0].text, "Item Details")

    def test_separate_lines_stay_separate(self):
        page = FakePage([W(41, 190.0, "Self"), W(41, 224.0, "Spouse/")])
        self.assertEqual(len(page_bands(page)), 2)

    def test_footer_page_number_is_dropped(self):
        """Guard 3: a bare page number otherwise merges into the last row."""
        page = FakePage([W(41, 190.0, "Self"), W(294, 793.0, "7")], height=842.0)
        bands = page_bands(page)
        self.assertEqual(len(bands), 1)
        self.assertNotIn("7", bands[0].text)


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------


class TestColumns(unittest.TestCase):
    def test_origins_split_on_header_vocabulary_not_gaps(self):
        """Real item-2 header. The gap between 'company' and 'Nature' is ~11pt
        while gaps *within* a column run 3-10pt, so no gap threshold separates
        them — but each column starts with a vocabulary word."""
        header = line(
            380.8,
            (100, "Name"), (129, "of"), (141, "trust/nominee"), (209, "company"),
            (265, "Nature"), (298, "of"), (310, "its"), (324, "operation"),
            (415, "Beneficial"), (463, "interests"),
        )
        self.assertEqual(column_origins(header), [100, 265, 415])

    def test_multiword_header_is_one_column(self):
        header = line(116.66, (100, "Location"), (333, "Purpose"), (360, "for"), (395, "which"), (430, "owned"))
        self.assertEqual(column_origins(header), [100, 333])

    def test_header_detection_requires_every_column_to_be_vocabulary(self):
        header = line(380.8, (100, "Name"), (265, "Nature"), (415, "Beneficial"))
        data = line(399.1, (100, "Not"), (118, "Applicable"), (265, "Not"), (283, "Applicable"))
        self.assertTrue(is_column_header(header, 95.0))
        self.assertFalse(is_column_header(data, 95.0), "'Not Applicable' is data, not a header")

    def test_a_row_carrying_a_holder_label_is_never_a_header(self):
        row = line(222.25, (41, "Self"), (100, "Item"), (392, "Details"))
        self.assertFalse(is_column_header(row, 95.0))

    def test_assign_columns_preserves_lines_per_cell(self):
        origins = [100, 333]
        cells = assign_columns([W(100, 1, "Greenvale,"), W(151, 1, "VIC"), W(333, 1, "Residential")], origins)
        self.assertEqual(cell_text(cells[0]), "Greenvale, VIC")
        self.assertEqual(cell_text(cells[1]), "Residential")


# ---------------------------------------------------------------------------
# Base statement tables
# ---------------------------------------------------------------------------


def real_estate_page():
    """Item 3 exactly as measured in Abdo_48P page 3."""
    return [
        line(76.34, (35.5, "3."), (53, "Real"), (80, "estate,"), (120, "including"), (170, "the"), (190, "location")),
        line(116.66, (100.1, "Location"), (333, "Purpose"), (380, "for"), (400, "which"), (430, "owned")),
        line(134.99, (40.9, "Self"), (100, "Greenvale,"), (151, "VIC"), (333, "Residential")),
        line(168.38, (40.9, "Spouse/"), (100, "Not"), (118, "Applicable"), (333, "Not"), (350, "Applicable")),
        line(183.46, (40.9, "Partner")),
        line(201.78, (40.9, "Dependent"), (100, "Not"), (118, "Applicable"), (333, "Not"), (350, "Applicable")),
        line(216.85, (40.9, "Children")),
    ]


class TestBaseStatementTables(unittest.TestCase):
    def test_three_holder_rows_with_wrapped_labels(self):
        items, warnings = parse_item_tables([(3, real_estate_page())])
        self.assertEqual(warnings, [])
        self.assertEqual(len(items), 1)
        rows = items[0].rows
        self.assertEqual(items[0].item_no, 3)
        self.assertEqual([r.holder for r in rows], [HOLDER_SELF, HOLDER_SPOUSE, HOLDER_DEPENDENT])
        self.assertEqual(rows[0].declared_text, "Greenvale, VIC")
        self.assertEqual(rows[0].secondary_text, "Residential")
        self.assertFalse(rows[0].is_nil)
        self.assertTrue(rows[1].is_nil)

    def test_nil_rows_are_kept(self):
        """'Declared nothing under item 1' is a fact, and it is the anti-signal
        proving the parser saw the item at all (register_extraction_stats)."""
        items, _ = parse_item_tables([(3, real_estate_page())])
        self.assertEqual(len(items[0].rows), 3)
        self.assertEqual(sum(1 for r in items[0].rows if r.is_nil), 2)

    def test_multiline_cell_keeps_one_entry_per_line(self):
        """Real: Aldred_48P declares 'Warragul' and 'Port Melbourne'. Flattening
        them yields a locality that matches no suburb, losing both."""
        page = [
            line(76.0, (35.5, "3."), (53, "Real"), (80, "estate")),
            line(116.0, (100, "Location"), (333, "Purpose")),
            line(135.0, (40.9, "Self"), (100, "Warragul"), (333, "Residential")),
            line(150.0, (100, "Port"), (120, "Melbourne")),
        ]
        items, _ = parse_item_tables([(3, page)])
        self.assertEqual(items[0].rows[0].declared_lines, ["Warragul", "Port Melbourne"])

    def test_item_boundary_stops_the_previous_row_swallowing_the_next_header(self):
        """Guard 1. Without item segmentation the dependent-children row eats
        the following item's column header, because that band sits right of the
        label column and looks exactly like a wrapped value."""
        page = real_estate_page() + [
            line(272.56, (35.5, "4."), (53, "Registered"), (110, "directorships")),
            line(312.88, (100.2, "Name"), (140, "of"), (160, "company"), (333, "Activities")),
            line(331.21, (40.9, "Self"), (100, "Not"), (118, "Applicable")),
        ]
        items, _ = parse_item_tables([(1, page)])
        self.assertEqual([i.item_no for i in items], [3, 4])
        self.assertNotIn("Name", items[0].rows[-1].declared_text)
        self.assertNotIn("company", items[0].rows[-1].secondary_text)

    def test_second_sub_table_header_is_not_treated_as_a_value(self):
        """Guard 2, item 2 flavour: item 2 has TWO sub-tables, so a header
        appears mid-item. Accepting a header only right after the item heading
        welds the second header onto the preceding row."""
        page = [
            line(328.4, (35, "2."), (53, "Family"), (91, "and"), (114, "business"), (165, "trusts")),
            line(380.8, (100, "Name"), (265, "Nature"), (415, "Beneficial")),
            line(399.1, (41, "Self"), (100, "Not"), (118, "Applicable"), (265, "Not"), (283, "Applicable"), (415, "Not"), (432, "Applicable")),
            line(559.6, (100, "Name"), (263, "Nature"), (411, "Beneficiary")),
            line(577.9, (41, "Self"), (100, "Not"), (118, "Applicable"), (263, "Not"), (281, "Applicable"), (411, "Not"), (429, "Applicable")),
        ]
        items, _ = parse_item_tables([(2, page)])
        self.assertEqual(len(items), 1)
        rows = items[0].rows
        self.assertEqual(len(rows), 2, "two sub-tables, one Self row each")
        for r in rows:
            self.assertEqual(r.declared_text, "Not Applicable")
            self.assertEqual(r.secondary_text, "Not Applicable")
            self.assertEqual(r.tertiary_text, "Not Applicable")

    def test_sub_item_explanatory_note_does_not_weld_onto_the_last_row(self):
        """Regression, measured on 436 of 455 born-digital documents.

        Item 2's SECOND sub-table is introduced by the form's own note ("ii. in
        which the Member, the Member's spouse, or a child who is wholly or
        mainly dependent…"). Its lines are indented to x≈55-78 and run right
        past the value column, so a parser that continues a cell from any band
        with words right of the label boundary appends the whole paragraph to
        the last row of the FIRST sub-table — publishing
        "Not Applicable the Member, the Member's spouse…" as a dependent
        child's declaration under a named member.
        """
        page = [
            line(210.82, (35.4, "2."), (56.6, "List"), (79.3, "family"), (136.8, "business"), (187.6, "trusts")),
            line(275.68, (113.8, "Name"), (268.2, "Nature"), (424.2, "Beneficial")),
            line(306.04, (41.4, "Self"), (113.5, "The"), (133.1, "Nirvana"), (169.4, "Trust")),
            line(369.76, (41.4, "Dependent"), (113.8, "Not"), (131.6, "Applicable")),
            line(381.88, (41.4, "children")),
            # The form's note for sub-table ii — prose, not a value.
            line(415.24, (55.4, "ii."), (78.0, "in"), (120.7, "the"), (138.5, "Member,"), (311.4, "child")),
            line(427.36, (78.0, "Member"), (135.1, "support,"), (197.4, "trustee"), (270.2, "including")),
        ]
        items, _ = parse_item_tables([(2, page)])
        dependent = items[0].rows[-1]
        self.assertEqual(dependent.declared_text, "Not Applicable")
        self.assertTrue(dependent.is_nil, "a nil row must stay nil, not absorb the form's note")

    def test_a_centred_holder_label_claims_the_line_above_it(self):
        """Regression, measured on Templeman_47P item 2.i.

        The form centres a holder label against its own cell. Where the cell
        wraps to three lines and the label to two, the label's first line sits
        BELOW the cell's first line — so "most recent label wins" hands
        Spouse/partner's first trust to Self, yielding
        "The Nirvana Trust The Nirvana Trust" for Self and dropping it from the
        spouse. The table's DRAWN row rule at y=322.32 separates the two rows
        exactly, so nothing has to be inferred from label positions.
        """
        page = [
            line(210.82, (35.4, "2."), (56.6, "List"), (79.3, "family"), (136.8, "business"), (187.6, "trusts")),
            line(275.68, (113.8, "Name"), (268.2, "Nature"), (424.2, "Beneficial")),
            line(306.04, (41.4, "Self"), (113.5, "The"), (133.1, "Nirvana"), (169.4, "Trust"), (267.6, "Family"), (423.4, "Yes")),
            line(324.56, (113.5, "The"), (133.1, "Nirvana"), (169.4, "Trust"), (267.6, "Family"), (423.4, "Yes")),
            line(331.84, (41.4, "Spouse/")),
            line(339.56, (113.5, "Project"), (146.5, "Tableland"), (267.6, "Unit"), (423.4, "Unit")),
            line(343.96, (41.4, "partner")),
            line(369.76, (41.4, "Dependent"), (113.8, "Not"), (131.6, "Applicable")),
        ]
        rules = {2: [273.6, 304.08, 322.32, 367.8, 398.28]}
        items, _ = parse_item_tables([(2, page)], rules_by_page=rules)
        rows = items[0].rows
        self.assertEqual([r.holder for r in rows], [HOLDER_SELF, HOLDER_SPOUSE, HOLDER_DEPENDENT])
        self.assertEqual(rows[0].declared_lines, ["The Nirvana Trust"])
        self.assertEqual(
            rows[1].declared_lines,
            ["The Nirvana Trust", "Project Tableland"],
            "the line above a centred label belongs to that label's row",
        )

    def test_without_drawn_rules_attribution_is_unchanged(self):
        """The rules are an ADDITION, never a dependency: a scan, an OCR'd page
        and every geometry fixture here carry none, and must parse exactly as
        they did before rules existed."""
        items, warnings = parse_item_tables([(3, real_estate_page())], rules_by_page={})
        with_rules, _ = parse_item_tables([(3, real_estate_page())])
        self.assertEqual(warnings, [])
        self.assertEqual(
            [(r.holder, r.declared_text) for r in items[0].rows],
            [(r.holder, r.declared_text) for r in with_rules[0].rows],
        )

    def test_no_items_warns(self):
        _, warnings = parse_item_tables([(1, [line(100, (300, "nothing"), (350, "useful"))])])
        self.assertIn("no_items_parsed", warnings)


# ---------------------------------------------------------------------------
# Alteration forms
# ---------------------------------------------------------------------------


class TestAlteration48P(unittest.TestCase):
    """48P variant: ADDITION at x≈100, holder rows at x≈41, and one holder can
    head SEVERAL item rows. Geometry from Abdo_48P page 7."""

    def page(self):
        return [
            line(165.39, (35.5, "I"), (42, "wish"), (67, "to"), (79, "notify"), (108, "an"), (123, "alteration")),
            line(187.67, (100.2, "ADDITION")),
            line(202.71, (100.2, "Item"), (392, "Details")),
            line(222.25, (41.2, "Self"), (100, "9."), (111, "Other"), (138, "Assets"), (394, "Superannuation"), (466, "-"), (472, "AustralianSuper")),
            line(252.39, (100.2, "12."), (116, "Travel"), (146, "Or"), (160, "Hospitality"), (394, "Qantas"), (429, "Chairmans"), (479, "Lounge")),
            line(264.46, (391.5, "membership")),
            line(312.68, (100.2, "11."), (116, "Gifts"), (394, "ETU"), (417, "contribution"), (470, "to"), (481, "catering")),
            line(324.76, (391.5, "(valued"), (440, "at"), (460, "$620.40)")),
            line(397.37, (41.2, "Spouse/")),
            line(412.44, (41.2, "Partner")),
            line(521.39, (35.5, "Submitted"), (92, "Date:"), (123, "18/08/2025")),
        ]

    def test_one_holder_heads_several_item_rows(self):
        items, lodged, stated = parse_alteration_page(7, self.page())
        by_item = {i.item_no: i for i in items}
        self.assertEqual(sorted(by_item), [9, 11, 12])
        self.assertEqual(by_item[9].rows[0].declared_text, "Superannuation - AustralianSuper")
        self.assertEqual(by_item[12].rows[0].declared_text, "Qantas Chairmans Lounge membership")
        for item in items:
            for row in item.rows:
                self.assertEqual(row.holder, HOLDER_SELF)
                self.assertEqual(row.change_type, CHANGE_ADDITION)
        self.assertEqual((lodged, stated), (date(2025, 8, 18), True))

    def test_a_stated_amount_is_transcribed_verbatim_and_flagged(self):
        """Editorial rule 5: never create a numeric field. Item 11 gifts
        sometimes state a value; it stays inside the text and raises a review
        flag instead."""
        items, _, _ = parse_alteration_page(7, self.page())
        gift = next(i for i in items if i.item_no == 11).rows[0]
        self.assertIn("$620.40", gift.declared_text)
        self.assertTrue(gift.contains_amount)

    def test_addition_and_deletion_are_distinct_events(self):
        page = self.page() + [
            line(600.0, (100.0, "DELETION")),
            line(615.0, (100.0, "Item"), (332, "Details")),
            line(630.0, (41.2, "Self"), (100, "9."), (111, "Other"), (138, "Assets"), (332, "Superannuation"), (404, "-"), (410, "AMP")),
        ]
        items, _, _ = parse_alteration_page(8, page)
        deletions = [r for i in items for r in i.rows if r.change_type == CHANGE_DELETION]
        self.assertEqual(len(deletions), 1)
        self.assertEqual(deletions[0].declared_text, "Superannuation - AMP")


class TestAlteration47P(unittest.TestCase):
    """47P variant: ADDITION at x≈41 and NO holder rows at all, so rows are
    'unspecified'. Geometry from Gorman_47P page 7."""

    def test_rows_without_holder_labels_are_unspecified(self):
        page = [
            line(201.40, (35.4, "I"), (45, "wish"), (70, "to"), (85, "notify")),
            line(223.54, (40.8, "ADDITION")),
            line(236.80, (40.8, "Item"), (232, "Details")),
            line(255.32, (40.6, "12."), (60, "Travel"), (232.2, "Tickets"), (270, "to"), (285, "the"), (305, "match")),
            line(267.44, (232.2, "from"), (260, "Seven"), (290, "West"), (320, "Media.")),
            line(424.18, (40.8, "DELETION")),
            line(627.22, (35.4, "Signed:"), (399.2, "11/08/2022")),
        ]
        items, lodged, stated = parse_alteration_page(7, page)
        self.assertEqual([i.item_no for i in items], [12])
        row = items[0].rows[0]
        self.assertEqual(row.holder, HOLDER_UNSPECIFIED)
        self.assertEqual(row.declared_text, "Tickets to the match from Seven West Media.")
        self.assertEqual((lodged, stated), (date(2022, 8, 11), True))


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------


class TestDates(unittest.TestCase):
    def test_parses_form_dates(self):
        self.assertEqual(parse_form_date("Submitted Date: 18/08/2025"), (date(2025, 8, 18), True))
        self.assertEqual(parse_form_date("Signed: Date: 1/7/22"), (date(2022, 7, 1), True))

    def test_an_illegible_date_is_reported_as_unstated_never_guessed(self):
        """date_is_stated=False carries through to the UI as an unknown date.
        Inventing one would fabricate a holding's start."""
        self.assertEqual(parse_form_date("Date: 3/41Y6"), (None, False))
        self.assertEqual(parse_form_date("Signed:"), (None, False))
        self.assertEqual(parse_form_date("Date: 45/13/2025"), (None, False))


# ---------------------------------------------------------------------------
# Whole-document golden set (skipped without a local PDF cache)
# ---------------------------------------------------------------------------


GOLDEN_DIR = Path(__file__).parent / "testdata" / "register" / "golden"
CACHE_DIR = Path(os.environ.get("REGISTER_CACHE_DIR", "/tmp/aph-register"))


class TestGoldenSet(unittest.TestCase):
    """Expectations are keyed by sha256 and stored as JSON.

    The PDFs themselves are deliberately absent: the licence allows extracted
    facts, not a mirror. Populate the cache with
    `influence-collector -mode register-fetch` to run these.
    """

    def test_golden_documents(self):
        if not GOLDEN_DIR.exists():
            self.skipTest(f"no golden expectations at {GOLDEN_DIR}")
        cases = sorted(GOLDEN_DIR.glob("*.json"))
        if not cases:
            self.skipTest("no golden expectations recorded yet")

        import fitz

        from register_parse import parse_house_document

        checked = 0
        for path in cases:
            expected = json.loads(path.read_text())
            pdf = CACHE_DIR / f"{expected['document_sha256']}.pdf"
            if not pdf.exists():
                continue
            with fitz.open(pdf) as doc:
                parsed = parse_house_document(doc)
            actual = {
                "statements": len(parsed.statements),
                "rows": sorted(
                    [s.kind, i.item_no, r.holder, r.change_type, r.declared_text]
                    for s in parsed.statements
                    for i in s.items
                    for r in i.rows
                    if not r.is_nil
                ),
            }
            self.assertEqual(actual["statements"], expected["statements"], f"{path.name}: statement count")
            self.assertEqual(actual["rows"], [list(r) for r in expected["rows"]], f"{path.name}: declared rows")
            checked += 1

        if checked == 0:
            self.skipTest(f"no golden PDFs present in {CACHE_DIR}")


if __name__ == "__main__":
    unittest.main()
