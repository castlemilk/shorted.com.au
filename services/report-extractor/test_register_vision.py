#!/usr/bin/env python3
"""Vision-tier tests that never spawn `agy`.

Everything here is pure: payload folding, JSON extraction, the gates, and the
argv safety assertion. The live-model path is exercised separately by an
operator run, because CI has no `agy` binary and must never depend on one.
"""

import unittest

from register_schema import (
    CHANGE_DECLARED,
    HOLDER_DEPENDENT,
    HOLDER_SELF,
    HOLDER_SPOUSE,
)
from register_vision import (
    VisionError,
    agy_argv,
    build_prompt,
    extract_json_object,
    to_parsed,
    vision_gates,
)


class TestArgvSafety(unittest.TestCase):
    def test_never_disables_the_approval_gate(self):
        """--dangerously-skip-permissions turns off agy's own tool-approval gate.

        It is blocked by this environment's safety classifier, and using it to run
        a model over untrusted scanned documents would be wrong regardless. This
        test exists so nobody "fixes" a permission prompt by reaching for it.
        """
        argv = agy_argv("prompt", "/tmp/x", "gemini-3.6-flash-low")
        joined = " ".join(argv)
        self.assertNotIn("dangerously", joined)
        self.assertNotIn("skip-permissions", joined)
        self.assertIn("--sandbox", argv)

    def test_pins_model_and_workdir(self):
        argv = agy_argv("p", "/tmp/work", "gemini-3.5-flash-low")
        self.assertEqual(argv[0], "agy")
        self.assertIn("-p", argv)
        self.assertIn("--model", argv)
        self.assertIn("gemini-3.5-flash-low", argv)
        self.assertIn("--add-dir", argv)
        self.assertIn("/tmp/work", argv)


class TestPrompt(unittest.TestCase):
    def test_lists_every_image_and_forbids_numeric_fields(self):
        prompt = build_prompt(["/tmp/a.png", "/tmp/b.png"])
        self.assertIn("/tmp/a.png", prompt)
        self.assertIn("/tmp/b.png", prompt)
        self.assertIn("TWO", prompt)
        # Rule 5 must be stated to the model, not just enforced afterwards.
        self.assertIn("never how much", prompt)
        self.assertIn("Do NOT create any numeric field", prompt)
        # The sub-table clause is what got item 2's 2.i/2.ii right in the probe.
        self.assertIn("2.i and 2.ii", prompt)


class TestJsonExtraction(unittest.TestCase):
    def test_plain_object(self):
        self.assertEqual(extract_json_object('{"rows":[]}'), {"rows": []})

    def test_tolerates_fence_and_preamble(self):
        raw = 'Here is the result:\n```json\n{"rows":[{"item_no":1}]}\n```\n'
        self.assertEqual(extract_json_object(raw), {"rows": [{"item_no": 1}]})

    def test_tolerates_trailing_prose(self):
        raw = '{"rows":[{"item_no":3}]}\nLet me know if you need more.'
        self.assertEqual(extract_json_object(raw), {"rows": [{"item_no": 3}]})

    def test_empty_and_junk_raise(self):
        for bad in ["", "   ", "no json here"]:
            with self.assertRaises(VisionError):
                extract_json_object(bad)


class TestToParsed(unittest.TestCase):
    """Folded from the REAL payload the probe returned for Gosling_48P page 2.

    Item 2 legitimately has two sub-tables (2.i and 2.ii), so six rows for item 2
    is correct — verified against the page image. A dedupe that collapsed them
    would silently drop half of a member's trust disclosures.
    """

    PAYLOAD = [
        {"page_no": 1, "item_no": 1, "holder": "self", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 1, "holder": "spouse/partner", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 1, "holder": "dependent children", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "self", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "spouse/partner", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "dependent children", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "self", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "spouse/partner", "declared_text": "Not Applicable"},
        {"page_no": 1, "item_no": 2, "holder": "dependent children", "declared_text": "Not Applicable"},
        {
            "page_no": 1, "item_no": 3, "holder": "self",
            "declared_text": "Ludmilla, NT", "secondary_text": "Family Home",
        },
        {
            "page_no": 1, "item_no": 3, "holder": "spouse/partner",
            "declared_text": "Same as above", "secondary_text": "Jointly own the family home above",
        },
        {"page_no": 1, "item_no": 3, "holder": "dependent children", "declared_text": "Not Applicable"},
    ]

    def setUp(self):
        self.parsed = to_parsed(self.PAYLOAD, page_offset=0, page_count=6, pages_read=1)

    def test_single_base_statement(self):
        self.assertEqual(len(self.parsed.statements), 1)
        self.assertEqual(self.parsed.statements[0].kind, "base")
        # The scanned form's date lives in a signature block we do not parse. An
        # unknown start must stay unknown, never be back-filled.
        self.assertFalse(self.parsed.statements[0].date_is_stated)
        self.assertIsNone(self.parsed.statements[0].lodged_date)

    def test_sub_tables_are_preserved_not_deduped(self):
        items = {i.item_no: i for i in self.parsed.statements[0].items}
        self.assertEqual(len(items[1].rows), 3)
        self.assertEqual(len(items[2].rows), 6, "2.i + 2.ii must both survive")
        self.assertEqual(len(items[3].rows), 3)
        self.assertEqual([r.ordinal for r in items[2].rows], [0, 1, 2, 3, 4, 5])

    def test_holders_map_to_canonical_values(self):
        items = {i.item_no: i for i in self.parsed.statements[0].items}
        self.assertEqual(
            [r.holder for r in items[3].rows],
            [HOLDER_SELF, HOLDER_SPOUSE, HOLDER_DEPENDENT],
        )

    def test_nil_rows_are_stored_not_dropped(self):
        """A nil row proves the tier SAW the item. Dropping it makes 'we did not
        read this' indistinguishable from 'the member declared nothing'."""
        items = {i.item_no: i for i in self.parsed.statements[0].items}
        self.assertTrue(all(r.is_nil for r in items[1].rows))
        self.assertEqual(len(items[1].rows), 3)

    def test_real_values_carried_through(self):
        items = {i.item_no: i for i in self.parsed.statements[0].items}
        self.assertEqual(items[3].rows[0].declared_text, "Ludmilla, NT")
        self.assertEqual(items[3].rows[0].secondary_text, "Family Home")
        self.assertFalse(items[3].rows[0].is_nil)

    def test_no_amount_flagged(self):
        rows = [r for i in self.parsed.statements[0].items for r in i.rows]
        self.assertFalse(any(r.contains_amount for r in rows))

    def test_unknown_item_numbers_dropped(self):
        """An item_no we cannot trust would attach a real declaration to the
        wrong item of the form, so the row is dropped rather than guessed."""
        parsed = to_parsed(
            [{"page_no": 1, "item_no": 99, "holder": "self", "declared_text": "x"}],
            page_offset=0, page_count=1, pages_read=1,
        )
        self.assertEqual(parsed.statements, [])


class TestContainsAmount(unittest.TestCase):
    def test_computed_from_our_transcription_not_the_model(self):
        """The model is never asked for this boolean — a model opinion where we
        need a measurement. A printed figure is transcribed verbatim and flagged
        here, so a spike is a hallucination signal rather than data."""
        parsed = to_parsed(
            [
                {"page_no": 1, "item_no": 9, "holder": "self", "declared_text": "Loan of $250,000"},
                {"page_no": 1, "item_no": 9, "holder": "spouse/partner", "declared_text": "Shares in CBA"},
            ],
            page_offset=0, page_count=1, pages_read=1,
        )
        rows = parsed.statements[0].items[0].rows
        self.assertTrue(rows[0].contains_amount)
        self.assertFalse(rows[1].contains_amount)
        # And no numeric field was invented anywhere.
        self.assertFalse(hasattr(rows[0], "amount"))


class TestVisionGates(unittest.TestCase):
    def _statement_rows(self, item_count, holders, nil=False, text="CBA"):
        rows = []
        for item_no in range(1, item_count + 1):
            for holder in holders:
                rows.append(
                    {
                        "page_no": 1, "item_no": item_no, "holder": holder,
                        "declared_text": "Not Applicable" if nil else text,
                    }
                )
        return rows

    def test_sparse_base_statement_flagged(self):
        parsed = to_parsed(
            self._statement_rows(2, ["self", "spouse/partner", "dependent children"]),
            page_offset=0, page_count=10, pages_read=10,
        )
        self.assertIn("vision_base_item_sparse", vision_gates(parsed))

    def test_missing_holder_triple_flagged(self):
        """Only ever seeing 'self' means the holder rows were not read as rows."""
        parsed = to_parsed(
            self._statement_rows(10, ["self"]),
            page_offset=0, page_count=10, pages_read=10,
        )
        self.assertIn("vision_holder_triple_missing", vision_gates(parsed))

    def test_all_nil_flagged(self):
        parsed = to_parsed(
            self._statement_rows(10, ["self", "spouse/partner", "dependent children"], nil=True),
            page_offset=0, page_count=10, pages_read=10,
        )
        self.assertIn("vision_nil_saturated", vision_gates(parsed))

    def test_amount_spike_flagged(self):
        parsed = to_parsed(
            self._statement_rows(
                10, ["self", "spouse/partner", "dependent children"], text="$1,000"
            ),
            page_offset=0, page_count=10, pages_read=10,
        )
        self.assertIn("vision_amount_spike", vision_gates(parsed))

    def test_gift_and_travel_values_do_not_trip_the_gate(self):
        """Items 11 and 12 legitimately carry values — the form asks for them.

        Measured on Aly_47P: 2 of 25 rows carried an amount, both genuine
        ("total value $500", "valued at $370 ex GST"), and counting them
        quarantined a correct document at 8%. Scoring must exclude those items.
        """
        rows = self._statement_rows(
            10, ["self", "spouse/partner", "dependent children"], text="BHP"
        )
        rows += [
            {"page_no": 1, "item_no": 11, "holder": "self",
             "declared_text": "2 tickets to a ball - total value $500"},
            {"page_no": 1, "item_no": 12, "holder": "self",
             "declared_text": "Conference registration - valued at $370 ex GST"},
        ]
        parsed = to_parsed(rows, page_offset=0, page_count=12, pages_read=12)
        self.assertNotIn("vision_amount_spike", vision_gates(parsed))

        # But an amount in a HOLDINGS item is still anomalous.
        rows.append(
            {"page_no": 1, "item_no": 1, "holder": "self",
             "declared_text": "CBA shares worth $250,000"}
        )
        parsed = to_parsed(rows, page_offset=0, page_count=12, pages_read=12)
        self.assertIn("vision_amount_spike", vision_gates(parsed))

    def test_healthy_document_passes(self):
        rows = self._statement_rows(
            12, ["self", "spouse/partner", "dependent children"], text="BHP"
        )
        parsed = to_parsed(rows, page_offset=0, page_count=12, pages_read=12)
        self.assertEqual(vision_gates(parsed), [])


if __name__ == "__main__":
    unittest.main()


class TestOcrParseGates(unittest.TestCase):
    """The deterministic-on-OCR path needs its own gates: page coverage was 100%
    for a parse that found 6 of 14 items and misfiled three of them."""

    def _rows(self, item_nos):
        return [
            {"page_no": 1, "item_no": n, "holder": h, "declared_text": "BHP"}
            for n in item_nos
            for h in ("self", "spouse/partner", "dependent children")
        ]

    def test_low_recall_flagged(self):
        from register_vision import ocr_parse_gates
        parsed = to_parsed(self._rows([4, 5, 6, 7, 8, 12]), 0, 6, 6)
        gates = ocr_parse_gates(parsed)
        self.assertIn("ocr_item_recall_low", gates)
        self.assertIn("ocr_core_items_missing", gates)

    def test_missing_core_items_flagged_even_at_good_recall(self):
        """Items 1 (shareholdings) and 3 (real estate) are the two this dataset
        exists to read. Losing them is not a partial success."""
        from register_vision import ocr_parse_gates
        parsed = to_parsed(self._rows([2, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 0, 10, 10)
        gates = ocr_parse_gates(parsed)
        self.assertNotIn("ocr_item_recall_low", gates)
        self.assertIn("ocr_core_items_missing", gates)

    def test_full_parse_passes(self):
        from register_vision import ocr_parse_gates
        parsed = to_parsed(self._rows(range(1, 15)), 0, 14, 14)
        self.assertEqual(ocr_parse_gates(parsed), [])
