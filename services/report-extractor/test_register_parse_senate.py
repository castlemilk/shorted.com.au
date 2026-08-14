"""Tests for the Senate volume splitter and base-table parser.

Geometry transcribed from real volumes (word x/y straight out of pymupdf), per
the same convention as test_register_parse.py: a passing test means the parser
handles the actual form. Source PDFs are NOT committed (licence: extracted
facts only), so whole-volume goldens run only against a local cache.
"""

from __future__ import annotations

import unittest
from datetime import date

from register_parse import Band, Word
from register_parse_senate import (
    find_header_block,
    page_statement_kind,
    parse_senate_base_items,
)
from register_schema import (
    HOLDER_UNSPECIFIED,
    STATEMENT_ALTERATION,
    STATEMENT_BASE,
)


def W(x, y, text):
    return Word(x0=x, y0=y, x1=x + 6.0 * len(text), y1=y + 10.0, text=text)


def band(*words):
    ws = sorted(words, key=lambda w: w.x0)
    return Band(y=ws[0].y0, words=ws)


def line(y, *pairs):
    return band(*[W(x, y, t) for x, t in pairs])


# Transcribed from the July 2025 Volume 1 (Allman-Payne base statement,
# page 4): header block labels at x=56.7, values at x=155.9.
HEADER_BANDS = [
    line(34.7, (503.6, "Form"), (531.4, "A")),
    line(197.7, (56.7, "Surname:"), (155.9, "Allman-Payne")),
    line(219.9, (56.7, "Other"), (83.2, "names:"), (155.9, "Penny")),
    line(242.0, (56.7, "State/Territory:"), (155.9, "Queensland")),
    line(264.1, (56.7, "Date:"), (155.9, "14/08/2025")),
]

# Alteration header (August–December 2025 volume, page 2): the running page
# header reads "Form A – Alteration".
ALTERATION_HEADER_BANDS = [
    line(33.2, (450.2, "Form"), (478.0, "A"), (487.9, "–"), (496.3, "Alteration")),
    line(196.3, (56.6, "Surname:"), (161.6, "Allman-Payne")),
    line(218.5, (56.6, "Other"), (83.2, "names:"), (161.6, "Penny")),
    line(240.6, (56.6, "State/Territory:"), (161.6, "Queensland")),
    line(262.8, (56.6, "Date:"), (161.6, "12/11/2025")),
]


class HeaderBlockTest(unittest.TestCase):
    def test_reads_the_full_block(self):
        block = find_header_block(HEADER_BANDS)
        self.assertIsNotNone(block)
        self.assertEqual(block.surname, "Allman-Payne")
        self.assertEqual(block.other_names, "Penny")
        self.assertEqual(block.state, "Queensland")
        self.assertEqual(block.lodged, date(2025, 8, 14))
        self.assertTrue(block.date_is_stated)

    def test_continuation_page_has_no_block(self):
        bands = [
            line(34.7, (503.6, "Form"), (531.4, "A")),
            line(93.3, (56.7, "3."), (76.5, "Real"), (103.0, "estate")),
        ]
        self.assertIsNone(find_header_block(bands))

    def test_prose_mentioning_surname_does_not_open_a_block(self):
        # A value or note that happens to contain the word, indented into the
        # value region, must not split a statement in two.
        bands = [line(93.3, (155.9, "Surname:"), (200.0, "Smith"))]
        self.assertIsNone(find_header_block(bands))

    def test_ocr_damaged_label_still_matches(self):
        bands = [line(196.3, (56.6, "Sumame:"), (161.6, "Hanson"))]
        block = find_header_block(bands)
        self.assertIsNotNone(block)
        self.assertEqual(block.surname, "Hanson")

    def test_empty_value_still_opens_a_statement(self):
        # A scan whose OCR missed the name: the statement is real, identity is
        # simply withheld.
        bands = [line(196.3, (56.6, "Surname:"))]
        block = find_header_block(bands)
        self.assertIsNotNone(block)
        self.assertEqual(block.surname, "")


class StatementKindTest(unittest.TestCase):
    def test_base(self):
        self.assertEqual(page_statement_kind(HEADER_BANDS), STATEMENT_BASE)

    def test_alteration(self):
        self.assertEqual(
            page_statement_kind(ALTERATION_HEADER_BANDS), STATEMENT_ALTERATION
        )


# Transcribed from July 2025 Volume 1, page 5 (Allman-Payne): item 3 with a
# drawn rule ABOVE the header and one BELOW the row block — two properties
# share one rule slot, so they are ONE row with two declared_lines.
ITEM3_PAGE = [
    (
        5,
        [
            line(93.3, (56.7, "3."), (76.5, "Real"), (103.0, "estate,"), (141.1, "including")),
            line(108.5, (76.6, "owned")),
            line(158.1, (56.7, "Location"), (305.4, "Purpose"), (343.9, "for"), (358.4, "which"), (386.4, "owned")),
            line(176.3, (56.7, "South"), (85.6, "Gladstone,"), (136.8, "Queensland"), (305.4, "Residential")),
            line(191.4, (56.7, "Cleveland,"), (106.7, "Queensland"), (305.4, "Investment"), (357.0, "(former"), (392.0, "home)")),
        ],
        [150.1, 171.3, 228.5],
    )
]


class BaseItemsTest(unittest.TestCase):
    def test_two_column_table_with_rules(self):
        items, warnings = parse_senate_base_items(ITEM3_PAGE)
        self.assertEqual(warnings, [])
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item.item_no, 3)
        self.assertEqual(len(item.rows), 1)  # one rule slot = one row
        row = item.rows[0]
        self.assertEqual(row.holder, HOLDER_UNSPECIFIED)
        self.assertEqual(
            row.declared_lines,
            ["South Gladstone, Queensland", "Cleveland, Queensland"],
        )
        self.assertIn("Residential", row.secondary_text)
        self.assertFalse(row.is_nil)

    def test_ruleless_page_splits_on_first_column(self):
        pages = [(5, ITEM3_PAGE[0][1], [])]
        items, _ = parse_senate_base_items(pages)
        self.assertEqual(len(items[0].rows), 2)
        self.assertEqual(items[0].rows[0].declared_text, "South Gladstone, Queensland")
        self.assertEqual(items[0].rows[1].declared_text, "Cleveland, Queensland")

    def test_nil_row(self):
        pages = [
            (
                4,
                [
                    line(295.6, (56.7, "4."), (76.5, "Registered"), (137.0, "directorships"), (210.2, "of"), (223.7, "companies")),
                    line(345.2, (56.7, "Name"), (83.7, "of"), (94.7, "company"), (305.4, "Activities"), (350.0, "of"), (360.0, "company")),
                    line(366.4, (56.7, "Not"), (73.2, "Applicable"), (305.4, "Not"), (322.0, "Applicable")),
                ],
                [],
            )
        ]
        items, _ = parse_senate_base_items(pages)
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].rows[0].is_nil)

    def test_template_boilerplate_is_not_a_value(self):
        # The writable Form A template ships an "Example—…" line before every
        # table and a leftover period header on every page (measured on the
        # Hanson 2025 statement). Neither is the senator declaring anything.
        pages = [
            (
                74,
                [
                    line(404.7, (56.6, "1."), (76.4, "Shareholdings"), (156.8, "in"), (169.6, "public")),
                    line(460.2, (56.6, "Example—AMP,"), (140.0, "Telstra,"), (185.0, "XYZ"), (210.0, "Pty"), (230.0, "Ltd")),
                    line(484.7, (56.6, "Name"), (83.0, "of"), (95.0, "company")),
                    line(502.7, (56.6, "BCB"), (80.0, "Coal")),
                ],
                [],
            ),
            (
                75,
                [
                    line(51.9, (56.6, "JANUARY"), (110.0, "TO"), (130.0, "JUNE"), (165.0, "2014")),
                    line(523.4, (56.6, "Webjet")),
                ],
                [],
            ),
        ]
        items, _ = parse_senate_base_items(pages)
        texts = [r.declared_text for i in items for r in i.rows]
        self.assertEqual(texts, ["BCB Coal", "Webjet"])

    def test_singular_detail_header_is_a_header(self):
        # "Detail of gifts" — singular, absent from the shared vocabulary.
        pages = [
            (
                7,
                [
                    line(482.7, (56.7, "11."), (76.5, "Gifts"), (95.8, "valued"), (125.0, "at")),
                    line(623.5, (56.7, "Detail"), (90.0, "of"), (100.0, "gifts")),
                    line(644.7, (56.7, "Not"), (73.2, "Applicable")),
                ],
                [],
            )
        ]
        items, _ = parse_senate_base_items(pages)
        self.assertEqual(len(items), 1)
        self.assertEqual(len(items[0].rows), 1)
        self.assertTrue(items[0].rows[0].is_nil)

    def test_value_starting_with_a_number_is_not_a_heading(self):
        # A declared value like "7. Eleven Pty Ltd" must not open item 7: item
        # numbers ascend and the keyword guard requires the form's own words.
        pages = [
            (
                4,
                [
                    line(329.6, (56.7, "1."), (76.5, "Shareholdings"), (156.8, "in"), (169.6, "public")),
                    line(394.4, (56.7, "Name"), (83.7, "of"), (94.7, "company")),
                    line(415.6, (56.7, "7."), (70.0, "Eleven"), (110.0, "Pty"), (130.0, "Ltd")),
                ],
                [],
            )
        ]
        items, _ = parse_senate_base_items(pages)
        self.assertEqual([i.item_no for i in items], [1])
        self.assertEqual(items[0].rows[0].declared_text, "7. Eleven Pty Ltd")


if __name__ == "__main__":
    unittest.main()
