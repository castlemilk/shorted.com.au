"""Shared test support for the financial-report extractor tests.

stub_missing_deps() lets `import extract` work where the heavy dependencies
(langextract, pymupdf, psycopg2, requests) are not installed. Each stub is
installed ONLY when the real import fails, so wherever requirements.txt is
installed the tests run against the real libraries. Tests that need a real
library's behaviour (langextract's Gemini provider, google-genai) use
pytest.importorskip on top of this.

fixture_path() locates the shared fixtures in services/pkg/extractiontrust/
testdata (the Go trust package), which the Python and Go tests both assert.

Not a test module (pytest collects test_*.py only).
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTRACTIONTRUST_TESTDATA = HERE.parent / "pkg" / "extractiontrust" / "testdata"


def fixture_path(name: str) -> Path:
    return EXTRACTIONTRUST_TESTDATA / name


def _real(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except Exception:  # noqa: BLE001 - any import failure means "use the stub"
        return False


class _Record:
    """Stands in for lx.data.ExampleData / lx.data.Extraction: keeps its keyword
    arguments as attributes (text, extractions, extraction_class, ...)."""

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.__dict__.update(kwargs)


def stub_missing_deps() -> None:
    if not _real("langextract"):
        lx = types.ModuleType("langextract")
        data = types.ModuleType("langextract.data")
        data.ExampleData = _Record
        data.Extraction = _Record
        lx.data = data
        sys.modules["langextract"] = lx
        sys.modules["langextract.data"] = data
    for name in ("fitz", "requests"):
        if not _real(name):
            sys.modules[name] = types.ModuleType(name)
    if not _real("psycopg2"):
        pg = types.ModuleType("psycopg2")
        extras = types.ModuleType("psycopg2.extras")
        pg.extras = extras
        sys.modules["psycopg2"] = pg
        sys.modules["psycopg2.extras"] = extras
