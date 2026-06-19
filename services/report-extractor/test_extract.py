#!/usr/bin/env python3
"""Tests for the report-extractor's §6.3 report-selection + digest changes.

Focused on the pure logic that gates which announcements become financial-report
digests (the title noise-filter) plus the digest constants. Heavy third-party deps
(langextract, pymupdf, psycopg2, requests, google-genai) are stubbed when absent so
the test runs locally; CI installs the real deps and uses them instead.

Run:  python -m pytest test_extract.py -q     (or)   python test_extract.py
"""
import sys
import types


def _stub_missing_deps() -> None:
    """Inject minimal stand-ins for heavy deps so `import extract` works locally.

    Only used when the real module is not importable — CI uses the real libraries.
    extract.py touches these at *module load*:
      - langextract: lx.data.ExampleData(...) / lx.data.Extraction(...)
      - the rest are only referenced inside functions, so bare module stubs suffice.
    """
    def _ensure(name: str, module: types.ModuleType) -> None:
        try:
            __import__(name)
        except Exception:  # noqa: BLE001 - any import failure → use the stub
            sys.modules[name] = module

    # langextract with a `data` namespace exposing the two dataclass-like callables.
    lx = types.ModuleType("langextract")
    data = types.ModuleType("langextract.data")

    class _Example:  # accepts whatever kwargs extract.py passes
        def __init__(self, *args, **kwargs):
            self.args, self.kwargs = args, kwargs

    data.ExampleData = _Example
    data.Extraction = _Example
    lx.data = data
    sys.modules.setdefault("langextract", lx) if "langextract" not in sys.modules else None
    try:
        __import__("langextract")
    except Exception:  # noqa: BLE001
        sys.modules["langextract"] = lx
        sys.modules["langextract.data"] = data

    _ensure("fitz", types.ModuleType("fitz"))
    _ensure("psycopg2", types.ModuleType("psycopg2"))
    _ensure("psycopg2.extras", types.ModuleType("psycopg2.extras"))
    _ensure("requests", types.ModuleType("requests"))


_stub_missing_deps()

import extract  # noqa: E402


# --- §6.3(a) title noise-filter ------------------------------------------------

# Real-world headlines the ASX crawler over-classifies as results/reports.
# These should be DROPPED (not surfaced as financial-report digests).
NOISE_TITLES = [
    "Half Year Results Media Release",
    "FY24 Full Year Results - Media Announcement",
    "Annual Results - Letter to Shareholders",
    "Chairman's Letter",
    "CEO Letter to Securityholders",
    "Chairman's Address - Annual General Meeting",
    "CEO Address",
    "Notice of Annual General Meeting",
    "Notice of Meeting and Proxy Form",
    "Cleansing Notice",
    "Trading Halt",
    "Suspension from Quotation",
    "Appendix 3Y - Change of Director's Interest",
    "Change of Director's Interest Notice",
    "Becoming a Substantial Holder",
    "Ceasing to be a Substantial Holder",
    "Change in Substantial Holding",
    "On-Market Buy-Back Notice",
    "Chairwoman's Letter",  # alternation must cover 'woman', not just 'man'/'person'
]

# Genuine financial statements/results AND presentations — these should be KEPT
# (presentations are intentionally retained; the digest reads numbers from prose).
KEEP_TITLES = [
    "Appendix 4E and Full Year Financial Report",
    "Appendix 4D and Half Year Report",
    "Half Year Results Announcement",
    "Annual Report 2024",
    "Full Year Results Investor Presentation",
    "Half Year Results Presentation",
    "Preliminary Final Report",
    "Annual Financial Report",
    "FY24 Results Presentation",
    # Compound titles: a genuine statutory filing whose headline ALSO mentions an
    # accompanying media release/letter must survive (keep-override beats noise).
    "Appendix 4E Full Year Results — Media Release",
    "Appendix 4D and Half Year Report - Media Release",
    "Half Year Financial Report and Chairman's Letter",
    "",  # empty title → cannot judge → keep
    "   ",
]


def test_noise_titles_are_dropped():
    for title in NOISE_TITLES:
        assert extract.is_financial_report_title(title) is False, f"should drop: {title!r}"


def test_real_reports_and_presentations_are_kept():
    for title in KEEP_TITLES:
        assert extract.is_financial_report_title(title) is True, f"should keep: {title!r}"


def test_presentation_is_not_treated_as_noise():
    # Explicit guard for the design decision: presentations are KEPT.
    assert extract.is_financial_report_title("Full Year Results Presentation") is True


# --- §6.3(b) digest constants --------------------------------------------------

def test_digest_window_widened_and_threshold_present():
    # Lower bound: wide enough to find figures in prose. Upper bound: guard against a
    # token/cost blow-up in the concurrent backfill (16k chars × N workers per batch).
    assert 16000 <= extract.DIGEST_TEXT_CHARS <= 20000
    assert extract.MIN_DIGEST_CHARS > 0
    # Prompt must instruct the model to read figures from text when metrics are empty.
    assert "metrics JSON is empty" in extract.DIGEST_PROMPT


def test_keep_override_beats_noise_for_compound_titles():
    # Explicit guard for the §6.3 review finding: a statutory form name overrides noise.
    assert extract.is_financial_report_title("Appendix 4E Full Year Results — Media Release") is True
    # Pure noise (no statutory signal) is still dropped.
    assert extract.is_financial_report_title("Half Year Results Media Release") is False


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
