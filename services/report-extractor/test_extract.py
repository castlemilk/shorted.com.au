#!/usr/bin/env python3
"""Tests for the financial-report extractor (extract.py).

Covers the §6.3 title noise filter and digest constants, and the contract 6.1
changes (docs/plans/fundamentals-coverage.md): the synthetic few-shot example
(byte-for-byte the extractiontrust JSON mirror), grounding (unaligned,
few-shot echo, value-not-in-span), the provenance string attributes, the
digest call's thinking config, token accounting and trust funnel, and the
document_meta write. Heavy third-party deps are stubbed only when absent
(extractor_test_support); tests that need a real library skip without it.

Run:  python -m pytest test_extract.py -q     (or)   python test_extract.py
"""
import importlib
import json
import os
import sys
from contextlib import contextmanager
from types import SimpleNamespace

from extractor_test_support import fixture_path, stub_missing_deps

stub_missing_deps()

import extract  # noqa: E402
import extraction_trust  # noqa: E402
from token_usage import TokenUsage  # noqa: E402

try:
    import pytest  # noqa: E402
except ImportError:  # the __main__ runner below works without pytest
    pytest = None


# --- §6.3(a) legacy title noise-filter ---------------------------------------

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

# Genuine financial statements/results AND presentations: KEPT by the legacy
# filter (selection now uses is_results_document, which drops presentations).
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
    assert extract.is_financial_report_title("Full Year Results Presentation") is True


def test_keep_override_beats_noise_for_compound_titles():
    assert extract.is_financial_report_title("Appendix 4E Full Year Results — Media Release") is True
    assert extract.is_financial_report_title("Half Year Results Media Release") is False


def test_selection_uses_the_statutory_classifier():
    # Contract 6.1 targeting: presentations, Form 20-F, Pillar 3, webcasts and
    # transcripts never reach Gemini, whatever the legacy filter says.
    for title in [
        "FY26 Results Presentation",
        "2026 US Annual Report (Form 20-F)",
        "Half Year Basel III Pillar 3 Disclosure",
        "FY26 Results Webcast and Conference Call Details",
        "Half Year Results Briefing Transcript",
    ]:
        assert extract.is_results_document(title) is False, title
    raw = json.dumps([
        {"source": "asx_announcements", "type": "annual_results", "title": "Appendix 4E and Annual Report", "url": "u1", "date": "2026-08-20"},
        {"source": "asx_announcements", "type": "annual_results", "title": "FY26 Results Presentation", "url": "u2", "date": "2026-08-20"},
        {"source": "asx_announcements", "type": "quarterly_report", "title": "Appendix 4D", "url": "u3", "date": "2026-08-20"},
        {"source": "company_website", "type": "annual_report", "title": "Annual Report 2026", "url": "u4", "date": "2026-08-20"},
        {"source": "asx_announcements", "type": "annual_report", "title": "Annual Report 2026", "url": "", "date": "2026-08-20"},
    ])
    got = extract._parse_financial_reports("XYZ", raw)
    assert [r["url"] for r in got] == ["u1"]
    assert extract._parse_financial_reports("XYZ", "not json") == []


# --- §6.3(b) digest constants -------------------------------------------------

def test_digest_window_widened_and_threshold_present():
    assert 16000 <= extract.DIGEST_TEXT_CHARS <= 20000
    assert extract.MIN_DIGEST_CHARS > 0
    assert "metrics JSON is empty" in extract.DIGEST_PROMPT


@contextmanager
def _patched_env(**values):
    original = {k: os.environ.get(k) for k in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_gemini_run_budget_caps_unbounded_limits_and_workers():
    with _patched_env(GEMINI_MAX_RUN_ITEMS=None, GEMINI_MAX_RUN_WORKERS=None):
        limit, workers = extract.resolve_gemini_run_budget(
            limit=0,
            workers=8,
            default_max_items=25,
            default_max_workers=2,
        )
    assert limit == 25
    assert workers == 2


def test_gemini_run_budget_honours_explicit_env_caps():
    with _patched_env(GEMINI_MAX_RUN_ITEMS="7", GEMINI_MAX_RUN_WORKERS="1"):
        limit, workers = extract.resolve_gemini_run_budget(
            limit=500,
            workers=6,
            default_max_items=25,
            default_max_workers=2,
        )
    assert limit == 7
    assert workers == 1


def test_production_run_budget_matches_terraform():
    # module.report_extractor sets GEMINI_MAX_RUN_ITEMS = reports_limit (120)
    # and GEMINI_MAX_RUN_WORKERS = 4, in step with --limit 120 --workers 4.
    with _patched_env(GEMINI_MAX_RUN_ITEMS="120", GEMINI_MAX_RUN_WORKERS="4"):
        assert extract.resolve_gemini_run_budget(120, 4, 10, 2) == (120, 4)


def test_max_pages_default_is_eight():
    assert extract.DEFAULT_MAX_PAGES == 8


# --- synthetic few-shot example (contract 6.1) --------------------------------

def _example_as_dict(example):
    return {
        "text": example.text,
        "extractions": [
            {
                "extraction_class": e.extraction_class,
                "extraction_text": e.extraction_text,
                "attributes": dict(e.attributes),
            }
            for e in example.extractions
        ],
    }


def test_fewshot_example_is_the_extractiontrust_mirror():
    path = fixture_path("fewshot_example.json")
    if not path.exists():
        if pytest:
            pytest.skip("services/pkg/extractiontrust is not in this checkout")
        return
    mirror = json.loads(path.read_text(encoding="utf-8"))
    assert len(extract.EXTRACTION_EXAMPLES) == 1
    got = _example_as_dict(extract.EXTRACTION_EXAMPLES[0])
    assert got == {"text": mirror["text"], "extractions": mirror["extractions"]}
    # Class order is the stored vocabulary's order.
    assert [e["extraction_class"] for e in got["extractions"]] == [
        "revenue", "net_profit", "eps", "dividend", "cash_flow", "ebitda", "guidance",
    ]


def test_fewshot_example_is_synthetic():
    ex = extract.EXTRACTION_EXAMPLES[0]
    assert ex.text.startswith("Quokka Minerals Limited (ASX: QKA)")
    for e in ex.extractions:
        assert e.extraction_text in ex.text, e.extraction_text
        for old in ("5,142", "1,823", "94.2", "2,156", "2,891", "H1 FY2025"):
            assert old not in e.extraction_text


def test_fewshot_denylist_holds_old_and_new_examples():
    deny = extract.FEWSHOT_DENYLIST
    # The echo rows stored on prod (BHP, CBA, DRO, EDV, MSB).
    assert "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million" in deny
    assert "Basic earnings per share was 94.2 cents." in deny
    assert "interim dividend of 45 cents per share, fully franked" in deny
    # The synthetic example is denied the same way.
    assert "basic earnings per share was 48.3 cents for h1 fy2031" in deny
    assert "Quokka Minerals Limited (ASX: QKA) Appendix 4D and half year report for H1 FY2031." in deny
    # Never a value match.
    assert "Statutory NPAT2 $5,142m" not in deny
    assert "Revenue was $5,142 million" not in deny


# --- grounding (contract 6.1) -------------------------------------------------

DOC = (
    "Wombat Foods Limited FY26 results. Revenue of $3,412.6 million, up 7%. "
    "Net profit after tax was $55.1 million. Basic EPS was 12.30 cents. "
    "The loss from discontinued operations was ($8.4) million."
)


def _ext(cls, text, attrs, start=None, end=None, status="match_exact"):
    if start is None:
        start = DOC.find(text)
        end = start + len(text) if start >= 0 else None
        if start < 0:
            start = None
    return SimpleNamespace(
        extraction_class=cls,
        extraction_text=text,
        attributes=attrs,
        char_interval=None if start is None else SimpleNamespace(start_pos=start, end_pos=end),
        alignment_status=None if status is None else SimpleNamespace(value=status),
    )


def test_grounding_keeps_aligned_values_and_records_provenance():
    rec, why = extract.ground_extraction(_ext("revenue", "Revenue of $3,412.6 million", {"value_millions": "3412.6"}), DOC)
    assert why == "kept"
    assert rec["alignment"] == "match_exact"
    assert isinstance(rec["char_start"], str) and isinstance(rec["char_end"], str)
    assert DOC[int(rec["char_start"]):int(rec["char_end"])] == "Revenue of $3,412.6 million"
    # Formatting differences that are the same number.
    for value in ("3,412.6", "3412.60", "+3412.6"):
        _, why = extract.ground_extraction(_ext("revenue", "Revenue of $3,412.6 million", {"value_millions": value}), DOC)
        assert why == "kept", value
    _, why = extract.ground_extraction(_ext("eps", "Basic EPS was 12.30 cents", {"value_cents": "12.3"}), DOC)
    assert why == "kept"
    _, why = extract.ground_extraction(
        _ext("net_profit", "loss from discontinued operations was ($8.4) million", {"value_millions": "-8.4"}), DOC
    )
    assert why == "kept"


def test_grounding_drops_unaligned_extractions():
    # char_interval None: the model's text is not in the document.
    _, why = extract.ground_extraction(_ext("revenue", "Revenue of $9,999 million", {"value_millions": "9999"}), DOC)
    assert why == "unaligned"
    # An alignment status outside the four aligned values, or none.
    for status in (None, "unaligned", "", "MATCH_EXACT"):
        _, why = extract.ground_extraction(
            _ext("revenue", "Revenue of $3,412.6 million", {"value_millions": "3412.6"}, status=status), DOC
        )
        assert why == "unaligned", status
    # Offsets outside the text.
    _, why = extract.ground_extraction(
        _ext("revenue", "x", {"value_millions": "1"}, start=5, end=len(DOC) + 10), DOC
    )
    assert why == "unaligned"


def test_grounding_requires_the_value_inside_the_aligned_span():
    # NPAT is $55.1m; a rounded value is not what the span says.
    _, why = extract.ground_extraction(_ext("net_profit", "Net profit after tax was $55.1 million", {"value_millions": "55"}), DOC)
    assert why == "value_not_in_span"
    # A value found elsewhere in the document but not in ITS span.
    _, why = extract.ground_extraction(_ext("eps", "Basic EPS was 12.30 cents", {"value_cents": "55.1"}), DOC)
    assert why == "value_not_in_span"
    # A digit run that is only part of a number is not the number.
    _, why = extract.ground_extraction(_ext("revenue", "Revenue of $3,412.6 million", {"value_millions": "412.6"}), DOC)
    assert why == "value_not_in_span"
    # Not a plain number.
    _, why = extract.ground_extraction(_ext("revenue", "Revenue of $3,412.6 million", {"value_millions": "3.4 billion"}), DOC)
    assert why == "value_not_in_span"
    # A numeric class with no value at all.
    _, why = extract.ground_extraction(_ext("revenue", "Revenue of $3,412.6 million", {"period": "FY2026"}), DOC)
    assert why == "no_value"
    # A non-numeric class needs no value.
    _, why = extract.ground_extraction(_ext("guidance", "up 7%", {"range": "7%"}), DOC)
    assert why == "kept"


def test_grounding_drops_a_fewshot_echo_even_when_aligned():
    doc = "Operating cash flow was $2,156 million. Something else."
    ext = SimpleNamespace(
        extraction_class="cash_flow",
        extraction_text="Operating cash flow was $2,156 million",
        attributes={"value_millions": "2156"},
        char_interval=SimpleNamespace(start_pos=0, end_pos=38),
        alignment_status=SimpleNamespace(value="match_exact"),
    )
    assert extract.ground_extraction(ext, doc) == (None, "fewshot_echo")


def test_extractions_to_metrics_writes_string_provenance():
    records, reasons = extract.ground_extractions(
        [
            _ext("revenue", "Revenue of $3,412.6 million", {"value_millions": "3412.6", "alignment": "forged"}),
            _ext("revenue", "Revenue of $9 million", {"value_millions": "9"}),
            _ext("eps", "Basic EPS was 12.30 cents", {"value_cents": "12.30", "source_text": "forged"}),
        ],
        DOC,
    )
    assert reasons == {"kept": 2, "unaligned": 1}
    metrics = extract.extractions_to_metrics(records)
    rev = metrics["revenue"]
    assert rev["source_text"] == "Revenue of $3,412.6 million"
    assert rev["alignment"] == "match_exact"  # the model's own "alignment" never survives
    assert all(isinstance(rev[k], str) for k in ("alignment", "char_start", "char_end"))
    assert metrics["eps"]["source_text"] == "Basic EPS was 12.30 cents"
    # Every stored entry passes the Go trust funnel's rule.
    for entry in metrics.values():
        assert extraction_trust.grounded_entry(entry, extract.FEWSHOT_DENYLIST)
    # Legacy records (compare_models.py) carry no provenance.
    legacy = extract.extractions_to_metrics([{"class": "revenue", "text": "t", "attributes": {"value_millions": "1"}}])
    assert legacy == {"revenue": {"value_millions": "1", "source_text": "t"}}


def test_number_helpers():
    assert extract.canonical_number("3,847") == "3847"
    assert extract.canonical_number("0.40") == "0.4"
    assert extract.canonical_number(".5") == "0.5"
    assert extract.canonical_number("($612)") == "612"
    assert extract.canonical_number("-$3,847") == "3847"
    assert extract.canonical_number("007") == "7"
    assert extract.canonical_number("4-6") is None
    assert extract.canonical_number("3,84") is None
    assert extract.canonical_number("n/a") is None
    assert extract.canonical_number(12) is None
    assert extract.numbers_in("$3,847,123.50 and 1H25") == {"3847123.5", "1", "25"}


# --- digest (contract 6.1 thinking + tokens + trust funnel) -------------------

class _DigestModels:
    def __init__(self, text):
        self.calls = []
        self.text = text

    def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        return SimpleNamespace(
            text=self.text,
            usage_metadata=SimpleNamespace(prompt_token_count=900, candidates_token_count=60, thoughts_token_count=0),
        )


def _needs(module):
    """pytest.importorskip under pytest; under the __main__ runner, False
    (the test returns early) when the module is missing."""
    if pytest:
        pytest.importorskip(module)
        return True
    try:
        importlib.import_module(module)
        return True
    except Exception:  # noqa: BLE001
        print(f"SKIP: {module} not installed")
        return False


def test_digest_call_sets_thinking_off_counts_tokens_and_filters_metrics():
    if not _needs("google.genai"):
        return
    models = _DigestModels('```json\n{"digest": "Revenue rose.", "confidence": 0.8, "key_takeaways": ["a"]}\n```')
    client = SimpleNamespace(models=models)
    usage = TokenUsage()
    metrics = {
        "revenue": {"source_text": "Revenue of $3,412.6 million", "value_millions": "3412.6",
                    "alignment": "match_exact", "char_start": "35", "char_end": "62"},
        "net_profit": [
            {"source_text": "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", "value_millions": "1823"},
            {"source_text": "NPAT was $55.1 million", "value_millions": "55.1", "alignment": "unaligned"},
        ],
    }
    out = extract.summarize_report(metrics, DOC, usage=usage, client=client)
    assert out == {"digest": "Revenue rose.", "confidence": 0.8, "key_takeaways": ["a"]}
    call = models.calls[0]
    assert call["config"].thinking_config.thinking_budget == 0
    assert call["config"].system_instruction == extract.DIGEST_PROMPT
    # The prompt sees the grounded entry without its provenance, and neither
    # the stored few-shot echo nor the unaligned entry.
    metrics_section, excerpt = call["contents"].split("## Report text excerpt")
    assert json.loads(metrics_section.split("\n", 1)[1]) == {
        "revenue": {"source_text": "Revenue of $3,412.6 million", "value_millions": "3412.6"},
    }
    assert "char_start" not in metrics_section and "alignment" not in metrics_section
    assert "1823" not in metrics_section and "net_profit" not in metrics_section
    assert DOC in excerpt
    assert usage.snapshot() == {"responses": 1, "prompt": 900, "candidates": 60, "thoughts": 0, "total": 960}


def test_digest_failure_returns_empty_and_still_counts_tokens():
    if not _needs("google.genai"):
        return
    usage = TokenUsage()
    client = SimpleNamespace(models=_DigestModels("not json"))
    assert extract.summarize_report({}, DOC, usage=usage, client=client) == {"digest": "", "confidence": 0.0, "key_takeaways": []}
    assert usage.responses == 1


# --- store_extraction / document_meta column -----------------------------------

class _Cursor:
    def __init__(self, conn, rows=None):
        self.conn = conn
        self.rows = rows or []

    def execute(self, sql, params=None):
        self.conn.statements.append((sql, params))

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows

    def close(self):
        pass


class _Conn:
    def __init__(self, rows=None, autocommit=True):
        self.statements = []
        self.rows = rows
        self.autocommit = autocommit
        self.commits = 0

    def cursor(self, *args, **kwargs):
        return _Cursor(self, self.rows)

    def commit(self):
        self.commits += 1


REPORT = {"stock_code": "WBT", "url": "https://asx/x.pdf", "type": "annual_results", "title": "Appendix 4E", "date": "2026-08-20"}


def test_store_writes_document_meta_only_when_the_column_exists():
    meta = {"currency": "AUD", "currency_evidence": "presented in Australian dollars"}
    conn = _Conn()
    extract.store_extraction(conn, REPORT, {}, 100, document_meta=meta, write_document_meta=True)
    sql, params = conn.statements[0]
    assert "document_meta" in sql and "document_meta = EXCLUDED.document_meta" in sql
    assert json.loads(params[-1]) == meta
    assert conn.commits == 0  # autocommit: nothing to commit

    conn = _Conn(autocommit=False)
    extract.store_extraction(conn, REPORT, {}, 100, document_meta=meta, write_document_meta=False)
    sql, params = conn.statements[0]
    assert "document_meta" not in sql
    assert sql.count("%s") == len(params) == 12
    assert conn.commits == 1

    conn = _Conn()
    extract.store_extraction(conn, REPORT, {}, 100, dry_run=True, document_meta=meta, write_document_meta=True)
    assert conn.statements == []


def test_document_meta_column_probe():
    assert extract.document_meta_column_exists(_Conn(rows=[(1,)])) is True
    conn = _Conn(rows=[])
    assert extract.document_meta_column_exists(conn) is False
    sql, _ = conn.statements[0]
    assert "information_schema.columns" in sql and "'document_meta'" in sql


def test_process_report_text_runs_no_database_code():
    # The model phase (extraction, digest, document_meta) takes no connection:
    # a transaction can never be open across it.
    import inspect

    params = inspect.signature(extract.process_report_text).parameters
    assert "conn" not in params


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
