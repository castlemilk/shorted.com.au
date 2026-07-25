"""Tests for register-of-interests page classification.

The numbers here are measurements from the real corpus, not invented fixtures.
See docs/politician-register-architecture.md §2.
"""

import unittest

from register_schema import (
    FULL_BLEED_COVERAGE,
    ITEM_LABELS,
    PAGE_KIND_BLANK,
    PAGE_KIND_SCAN,
    PAGE_KIND_TEXT,
    SCAN_PAGE_CHAR_THRESHOLD,
    TEXT_CLASS_MIXED,
    TEXT_CLASS_SCAN,
    TEXT_CLASS_TEXT,
    classify_document,
    classify_page,
    is_nil_value,
)

# Measured profiles.
BLANK_PAGE = dict(char_count=1, image_coverage=0.84, text_blocks=1)  # page number only
SCAN_PAGE = dict(char_count=0, image_coverage=1.00, text_blocks=0)  # 300dpi raster
TEXT_PAGE = dict(char_count=893, image_coverage=0.84, text_blocks=9)


class TestClassifyPage(unittest.TestCase):
    def test_readable_page_is_text(self):
        self.assertEqual(classify_page(**TEXT_PAGE), PAGE_KIND_TEXT)
        # Born-digital House pages measure 380-860 chars/page.
        self.assertEqual(classify_page(380, 0.84, 5), PAGE_KIND_TEXT)

    def test_full_bleed_raster_with_no_glyphs_is_a_scan(self):
        self.assertEqual(classify_page(**SCAN_PAGE), PAGE_KIND_SCAN)

    def test_blank_continuation_page_is_not_a_scan(self):
        """The expensive mistake: every born-digital statement carries a
        letterhead image, so 'has an image' marks every blank page for OCR."""
        self.assertEqual(classify_page(**BLANK_PAGE), PAGE_KIND_BLANK)

    def test_scan_detection_errs_toward_reading(self):
        """Calling a blank page a scan wastes one cheap vision call; calling a
        scanned page blank silently loses a member's declared interests. So
        either signal alone is enough to route a page to vision."""
        # Full-bleed image but some stray OCR glyphs.
        self.assertEqual(classify_page(3, 1.00, 2), PAGE_KIND_SCAN)
        # No glyphs at all, image not full-bleed.
        self.assertEqual(classify_page(0, 0.10, 0), PAGE_KIND_SCAN)

    def test_threshold_boundaries(self):
        self.assertEqual(classify_page(SCAN_PAGE_CHAR_THRESHOLD, 1.0, 0), PAGE_KIND_TEXT)
        self.assertEqual(classify_page(SCAN_PAGE_CHAR_THRESHOLD - 1, 1.0, 0), PAGE_KIND_SCAN)
        # The letterhead sits below the full-bleed cutoff; a scan sits above.
        self.assertLess(0.84, FULL_BLEED_COVERAGE)
        self.assertGreaterEqual(1.00, FULL_BLEED_COVERAGE)

    def test_real_45p_and_44p_scan_measurements(self):
        # 44P pages carry no text layer at all; 45P carries 35-46 chars.
        self.assertEqual(classify_page(0, 1.0, 0), PAGE_KIND_SCAN)
        self.assertEqual(classify_page(46, 1.0, 0), PAGE_KIND_SCAN)


class TestClassifyDocument(unittest.TestCase):
    def test_blank_pages_do_not_make_a_document_mixed(self):
        """Regression: counting blank pages as scans marked every single House
        document 'mixed' and would have sent ~1,000 empty pages to Gemini."""
        kinds = [PAGE_KIND_TEXT] * 10 + [PAGE_KIND_BLANK]
        text_class, scans, blanks = classify_document(kinds)
        self.assertEqual(text_class, TEXT_CLASS_TEXT)
        self.assertEqual(scans, 0)
        self.assertEqual(blanks, 1)

    def test_all_scan_document(self):
        # 44P statements are wholly scanned.
        text_class, scans, blanks = classify_document([PAGE_KIND_SCAN] * 8)
        self.assertEqual(text_class, TEXT_CLASS_SCAN)
        self.assertEqual(scans, 8)
        self.assertEqual(blanks, 0)

    def test_mixed_document(self):
        """Albanese_48P: a scan sitting inside an otherwise all-text parliament.
        This is why dispatch is per page, not per document."""
        kinds = [PAGE_KIND_SCAN] * 14 + [PAGE_KIND_TEXT] * 2
        text_class, scans, blanks = classify_document(kinds)
        self.assertEqual(text_class, TEXT_CLASS_MIXED)
        self.assertEqual(scans, 14)

    def test_empty_document_is_a_scan_not_text(self):
        """Zero extractable text is what a scan looks like. Calling it text
        would silently skip the vision tier and drop the document."""
        text_class, scans, blanks = classify_document([])
        self.assertEqual(text_class, TEXT_CLASS_SCAN)
        self.assertEqual((scans, blanks), (0, 0))

    def test_scan_plus_blank_only_is_a_scan(self):
        text_class, scans, blanks = classify_document([PAGE_KIND_SCAN] * 3 + [PAGE_KIND_BLANK])
        self.assertEqual(text_class, TEXT_CLASS_SCAN)
        self.assertEqual((scans, blanks), (3, 1))


class TestNilDetection(unittest.TestCase):
    def test_recognises_the_form_wording(self):
        for value in ["Not Applicable", "not applicable", "NIL", "None", "N/A", "-", ""]:
            self.assertTrue(is_nil_value(value), value)
        # Trailing full stops and stray whitespace are common in the source.
        self.assertTrue(is_nil_value("  Not Applicable.  "))

    def test_does_not_swallow_real_declarations(self):
        for value in ["BHP", "Greenvale, VIC", "Commonwealth Bank", "None of the above holdings"]:
            self.assertFalse(is_nil_value(value), value)


class TestFormConstants(unittest.TestCase):
    def test_all_fourteen_items_are_defined(self):
        self.assertEqual(sorted(ITEM_LABELS), list(range(1, 15)))

    def test_the_two_join_items_are_where_we_think(self):
        self.assertIn("Shareholdings", ITEM_LABELS[1])
        self.assertIn("Real estate", ITEM_LABELS[3])


if __name__ == "__main__":
    unittest.main()
