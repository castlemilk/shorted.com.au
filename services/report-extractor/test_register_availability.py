#!/usr/bin/env python3
"""Unreachable bytes are not a fact about a document.

On 2026-09-15 an unscoped `--stage extract` run reached 84 vision-tier documents
from parliaments 44-47 whose storage_uri points at an operator volume that was
not mounted. Every one was marked extract_status='failed', which is one
`register-load` away from PURGING the published declarations of 84 members:
purgeNonExtractedStatements deletes the rows of any document that is not
'extracted'.

Nothing about those documents had changed. The disk was not mounted.

That is the conflation #576 removed from the price backfill — "we could not ask"
recorded as "there is nothing there" — reappearing one layer down. These tests
pin the distinction at the only place it can be enforced: open_document raises
DocumentUnavailable for anything it could not READ, and each stage loop leaves
the status columns alone when it sees one.
"""

import ast
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

SOURCE = Path(__file__).resolve().parent / "extract_register.py"


def _function(name: str) -> ast.FunctionDef:
    tree = ast.parse(SOURCE.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found")


def _handlers(func: ast.FunctionDef) -> list[ast.ExceptHandler]:
    return [n for n in ast.walk(func) if isinstance(n, ast.ExceptHandler)]


class OpenDocumentSignalsUnavailability(unittest.TestCase):
    """The classifier of last resort: what open_document raises decides
    whether a status column moves."""

    def test_missing_local_file_is_unavailable_not_a_failure(self):
        from extract_register import DocumentUnavailable, open_document

        missing = "file:///Volumes/gamma-systems-2/shorted-crawl/aph-register/nope.pdf"
        with self.assertRaises(DocumentUnavailable):
            open_document(missing)

    def test_absent_storage_uri_is_unavailable(self):
        from extract_register import DocumentUnavailable, open_document

        with self.assertRaises(DocumentUnavailable):
            open_document("")

    def test_a_real_but_unparseable_file_is_NOT_unavailable(self):
        """A document we could read and could not parse is a genuine failure,
        and must keep marking the document — otherwise a corrupt PDF would sit
        in the queue forever looking like a mount problem."""
        from extract_register import DocumentUnavailable, open_document

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(b"this is not a pdf")
            path = tmp.name
        try:
            with self.assertRaises(Exception) as caught:
                open_document("file://" + path)
            self.assertNotIsInstance(caught.exception, DocumentUnavailable)
        finally:
            os.unlink(path)


class StageLoopsLeaveStatusAloneWhenUnavailable(unittest.TestCase):
    """Each stage must catch DocumentUnavailable BEFORE the generic handler,
    and must not call a mark_*_failed from that branch."""

    def _unavailable_handler(self, func_name: str) -> ast.ExceptHandler:
        handlers = _handlers(_function(func_name))
        names = []
        for h in handlers:
            if isinstance(h.type, ast.Name):
                names.append(h.type.id)
        self.assertIn(
            "DocumentUnavailable",
            names,
            f"{func_name} does not handle DocumentUnavailable: an unreachable "
            f"document would be recorded as a failed one",
        )
        for h in handlers:
            if isinstance(h.type, ast.Name) and h.type.id == "DocumentUnavailable":
                return h
        raise AssertionError("unreachable")

    def _calls(self, node: ast.AST) -> list[str]:
        return [
            n.func.id
            for n in ast.walk(node)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        ]

    def test_classify_does_not_mark_an_unreachable_document(self):
        handler = self._unavailable_handler("run_classify")
        self.assertNotIn("mark_classify_failed", self._calls(handler))

    def test_extract_does_not_mark_an_unreachable_document(self):
        handler = self._unavailable_handler("run_extract")
        self.assertNotIn(
            "mark_extract_failed",
            self._calls(handler),
            "marking here downgrades an already-extracted document, and "
            "register-load purges the rows of anything not 'extracted'",
        )

    def test_vision_does_not_mark_an_unreachable_document(self):
        handler = self._unavailable_handler("run_vision")
        self.assertNotIn("mark_extract_failed", self._calls(handler))

    def test_unavailable_is_caught_before_the_generic_handler(self):
        """Ordering is the whole guard: `except Exception` first would swallow
        DocumentUnavailable and mark the document anyway."""
        for name in ("run_classify", "run_extract", "run_vision"):
            with self.subTest(stage=name):
                handlers = _handlers(_function(name))
                order = [
                    h.type.id
                    for h in handlers
                    if isinstance(h.type, ast.Name) and h.type.id in ("DocumentUnavailable", "Exception")
                ]
                self.assertIn("DocumentUnavailable", order)
                self.assertLess(
                    order.index("DocumentUnavailable"),
                    order.index("Exception"),
                    f"{name} catches Exception before DocumentUnavailable",
                )


if __name__ == "__main__":
    unittest.main()
