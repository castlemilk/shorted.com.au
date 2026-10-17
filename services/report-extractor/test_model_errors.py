"""Model failures are never stored as "nothing grounded" (review C4).

A Gemini call that fails (an API error after langextract's retries: quota,
auth, a retired model; a blocked response; a response with no text) raises
extract.ModelError. The runner then writes NO row for the document, so the
next run retries it; after MAX_CONSECUTIVE_MODEL_ERRORS in a row it starts no
new report; and the run exits non-zero after printing its counts. A digest
failure on grounded metrics stores the metrics with digest NULL for
--backfill-digests.

Also here: the unreadable-document marker and the per-company fallbacks
(review LOW: a document that can never be downloaded must not block the
company's other statutory document), and the one-off repairs
(--repair-echo-digests, --repair-document-meta).

Pure tests use fakes at the function boundary and run everywhere; the tests
that drive the real langextract / google-genai stack skip without it.
"""
import datetime as dt
import json
import logging
import re
from types import SimpleNamespace

import pytest

from extractor_test_support import stub_missing_deps

stub_missing_deps()

import extract  # noqa: E402
import extract_reports_concurrent as runner  # noqa: E402
from token_usage import TokenUsage  # noqa: E402

DOC_TEXT = (
    "Wombat Foods Limited reported revenue of $412.6 million for the year ended 30 June 2026. "
    "Net profit after tax was $55.1 million. Basic EPS was 12.3 cents. "
) * 6  # over MIN_DIGEST_CHARS, so a no-metrics document still gets a digest call

REPORT = {"stock_code": "WBT", "url": "https://asx/wbt-4e.pdf", "type": "annual_results",
          "title": "Appendix 4E", "date": "2026-08-20"}

GROUNDED = [{
    "class": "revenue",
    "text": "revenue of $412.6 million",
    "attributes": {"value_millions": "412.6"},
    "alignment": "match_exact",
    "char_start": "29",
    "char_end": "54",
}]

GOOD_DIGEST = {"digest": "Revenue rose.", "confidence": 0.8, "key_takeaways": []}


def _raise(exc):
    def f(*args, **kwargs):
        raise exc
    return f


# --- process_report_text: model failure vs nothing grounded ----------------------


def test_an_extraction_model_error_is_raised_not_stored_as_no_metrics(monkeypatch):
    digest_calls = []
    monkeypatch.setattr(extract, "extract_financial_data", _raise(extract.ModelError("404 NOT_FOUND")))
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: digest_calls.append(1) or GOOD_DIGEST)
    with pytest.raises(extract.ModelError):
        extract.process_report_text(REPORT, DOC_TEXT, "gemini-2.5-flash")
    assert digest_calls == []


def test_nothing_grounded_and_a_digest_model_error_is_a_model_error(monkeypatch):
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: [])
    monkeypatch.setattr(extract, "summarize_report", _raise(extract.ModelError("429 quota exceeded")))
    with pytest.raises(extract.ModelError):
        extract.process_report_text(REPORT, DOC_TEXT, "gemini-2.5-flash")


def test_grounded_metrics_survive_a_digest_model_error_with_no_digest(monkeypatch):
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", _raise(extract.ModelError("503 overloaded")))
    metrics, digest, meta, outcome = extract.process_report_text(REPORT, DOC_TEXT, "gemini-2.5-flash")
    assert outcome == "digest_error"
    assert digest is None  # stored as digest NULL: --backfill-digests picks it up
    assert metrics["revenue"]["value_millions"] == "412.6"


def test_nothing_grounded_is_still_no_metrics_or_digest_only(monkeypatch):
    # The model answered: an empty extraction is a real "nothing grounded".
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: [])
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    assert extract.process_report_text(REPORT, DOC_TEXT, "m")[3] == "digest_only"
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: {"digest": "", "confidence": 0.0, "key_takeaways": []})
    assert extract.process_report_text(REPORT, DOC_TEXT, "m")[3] == "no_metrics"
    # Too little text for a digest: no digest call at all.
    monkeypatch.setattr(extract, "summarize_report", _raise(AssertionError("no digest call expected")))
    metrics, digest, _, outcome = extract.process_report_text(REPORT, "short text", "m")
    assert (metrics, digest, outcome) == ({}, None, "no_metrics")


def test_grounded_metrics_with_a_digest_are_ok(monkeypatch):
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    metrics, digest, _, outcome = extract.process_report_text(REPORT, DOC_TEXT, "m")
    assert outcome == "ok" and digest == GOOD_DIGEST and "revenue" in metrics


# --- the runner's process(): a model error writes no row -------------------------


class _Stored:
    def __init__(self):
        self.rows = []
        self.connects = 0

    def conn(self):
        self.connects += 1
        return SimpleNamespace(autocommit=True, closed=False)

    def store(self, conn, report, metrics, n, dry, **kw):
        self.rows.append({"url": report["url"], "metrics": metrics, "length": n, **kw})


def _wire(monkeypatch, fetch):
    stored = _Stored()
    monkeypatch.setattr(extract, "fetch_pdf_text", fetch)
    monkeypatch.setattr(extract, "upload_raw_text_to_gcs", lambda *a, **k: None)
    monkeypatch.setattr(extract, "store_extraction", stored.store)
    monkeypatch.setattr(runner, "_conn", stored.conn)
    return stored


def _fetch_ok(session, url, max_pages=8):
    return DOC_TEXT, extract.FETCH_OK


def test_process_writes_no_row_on_a_model_error(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "process_report_text", _raise(extract.ModelError("403 PERMISSION_DENIED")))
    assert runner.process(dict(REPORT), "gemini-2.5-flash", 8, False, write_meta=True) == "model_error"
    assert stored.rows == [] and stored.connects == 0


def test_process_stores_metrics_with_a_null_digest_on_a_digest_error(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", _raise(extract.ModelError("503")))
    assert runner.process(dict(REPORT), "m", 8, False) == "digest_error"
    [row] = stored.rows
    assert row["digest_result"] is None and "revenue" in row["metrics"]


def test_process_digestless_writes_nothing_on_a_model_error(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: DOC_TEXT)
    monkeypatch.setattr(extract, "summarize_report", _raise(extract.ModelError("403")))
    row = {**REPORT, "metrics": "{}", "raw_text_gcs_url": "gs://b/x.txt"}
    assert runner.process_digestless(row, "m", 8, False) == "model_error"
    assert stored.rows == []


# --- the real langextract / google-genai stack (skips without it) -----------------


def _genai():
    pytest.importorskip("google.genai")
    pytest.importorskip("langextract.providers.gemini")
    from google.genai import errors as genai_errors

    return genai_errors


class _RaisingModels:
    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    def generate_content(self, model, contents, config):
        self.calls += 1
        raise self.exc


def _budgeted_raising(exc, usage=None):
    import budgeted_gemini

    model = budgeted_gemini.build_budgeted_model(
        "gemini-2.5-flash", extract.EXTRACTION_EXAMPLES, usage=usage, api_key="test-key"
    )
    model.max_retries = 0  # a retryable error is raised at once rather than after sleeping
    model._client = SimpleNamespace(models=_RaisingModels(exc))
    return model


@pytest.mark.parametrize("code,status", [(404, "NOT_FOUND"), (403, "PERMISSION_DENIED"), (429, "RESOURCE_EXHAUSTED")])
def test_a_gemini_api_error_through_langextract_is_a_model_error(code, status):
    genai_errors = _genai()
    exc = genai_errors.ClientError(code, {"error": {"code": code, "message": "x", "status": status}})
    model = _budgeted_raising(exc)
    with pytest.raises(extract.ModelError):
        extract.extract_financial_data(DOC_TEXT, "WBT", model=model)
    assert model._client.models.calls >= 1


def test_the_reviewers_scenario_end_to_end_stores_nothing(monkeypatch):
    # A retired model (404) through the real BudgetedGemini and lx.extract,
    # then process(): the document is not stored (before the fix it was stored
    # with metrics '{}' and outcome no_metrics, and never extracted again).
    genai_errors = _genai()
    import budgeted_gemini

    exc = genai_errors.ClientError(404, {"error": {"code": 404, "message": "gone", "status": "NOT_FOUND"}})
    monkeypatch.setattr(budgeted_gemini, "build_budgeted_model", lambda *a, **k: _budgeted_raising(exc))
    stored = _wire(monkeypatch, _fetch_ok)
    assert runner.process(dict(REPORT), "gemini-2.5-flash", 8, False, write_meta=True) == "model_error"
    assert stored.rows == []


def test_a_digest_api_error_is_a_model_error():
    _genai()
    client = SimpleNamespace(models=_RaisingModels(RuntimeError("403 PERMISSION_DENIED")))
    with pytest.raises(extract.ModelError):
        extract.summarize_report({}, DOC_TEXT, client=client)


def test_an_empty_or_blocked_digest_response_is_a_model_error_and_still_counted():
    _genai()
    usage = TokenUsage()

    class Blocked:
        def generate_content(self, model, contents, config):
            return SimpleNamespace(text=None, usage_metadata=SimpleNamespace(
                prompt_token_count=700, candidates_token_count=0, thoughts_token_count=0))

    with pytest.raises(extract.ModelError):
        extract.summarize_report({}, DOC_TEXT, usage=usage, client=SimpleNamespace(models=Blocked()))
    assert usage.prompt == 700 and usage.responses == 1


def test_a_digest_without_a_key_is_a_model_error(monkeypatch):
    _genai()
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("LANGEXTRACT_API_KEY", raising=False)
    with pytest.raises(extract.ModelError):
        extract.summarize_report({}, DOC_TEXT)


def test_a_digest_that_is_not_json_is_an_answer_not_a_model_error():
    _genai()

    class NotJson:
        def generate_content(self, model, contents, config):
            return SimpleNamespace(text="Revenue rose.", usage_metadata=None)

    out = extract.summarize_report({}, DOC_TEXT, client=SimpleNamespace(models=NotJson()))
    assert out == {"digest": "", "confidence": 0.0, "key_takeaways": []}


# --- the circuit breaker -----------------------------------------------------------


def test_the_breaker_stops_submitting_after_n_consecutive_model_errors():
    seen = []

    def worker(item):
        seen.append(item)
        return "model_error"

    counts, submitted = runner.run_with_budget(list(range(40)), worker, workers=1, budget_seconds=3600)
    assert extract.MAX_CONSECUTIVE_MODEL_ERRORS == 5
    assert submitted == 5 and seen == [0, 1, 2, 3, 4]
    assert counts == {"model_error": 5}


def test_the_breaker_counts_only_consecutive_model_errors():
    # ok resets the run; no_pdf / no_text / error made no model call and
    # neither extend nor reset it.
    script = ["model_error", "model_error", "ok", "model_error", "model_error", "model_error",
              "model_error", "no_pdf", "no_text", "error", "model_error", "ok", "ok"]

    def worker(item):
        if script[item] == "error":
            raise RuntimeError("db down")
        return script[item]

    counts, submitted = runner.run_with_budget(list(range(len(script))), worker, workers=1, budget_seconds=3600)
    assert submitted == 11  # tripped by the 5th model error in a row (item 10)
    assert counts == {"model_error": 7, "ok": 1, "no_pdf": 1, "no_text": 1, "error": 1}


def test_the_breaker_lets_in_flight_reports_finish_and_can_be_disabled():
    counts, submitted = runner.run_with_budget(list(range(30)), lambda i: "model_error", workers=3, budget_seconds=3600)
    assert 5 <= submitted < 30 and counts["model_error"] == submitted
    counts, submitted = runner.run_with_budget(
        list(range(12)), lambda i: "model_error", workers=2, budget_seconds=3600, max_consecutive_model_errors=0
    )
    assert submitted == 12 and counts == {"model_error": 12}


# --- main(): a run with model errors fails -------------------------------------------


def _main_with(monkeypatch, outcomes, argv=()):
    reports = [{**REPORT, "stock_code": f"C{i}", "url": f"u{i}"} for i in range(len(outcomes))]
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("GEMINI_MAX_RUN_ITEMS", "50")
    monkeypatch.setattr(runner, "open_selection_connection", lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(extract, "document_meta_column_exists", lambda conn: True)
    monkeypatch.setattr(extract, "extraction_attempts_column_exists", lambda conn: True)
    monkeypatch.setattr(runner, "select_reports", lambda conn, recent, limit, dry_run=False: reports)
    by_url = {r["url"]: o for r, o in zip(reports, outcomes)}
    monkeypatch.setattr(runner, "process", lambda report, **kw: by_url[report["url"]])
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--workers", "1", "--backend", "gemini", *argv])
    runner.main()


def test_openrouter_backend_refuses_to_run_without_its_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "k")  # a Gemini key does not stand in for it
    monkeypatch.setattr(runner, "open_selection_connection", lambda: pytest.fail("selected with no key"))
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--backend", "openrouter"])
    with pytest.raises(SystemExit) as exc:
        runner.main()
    assert exc.value.code == 1


def test_openrouter_backend_hands_every_worker_the_direct_extractor(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    monkeypatch.setenv("GEMINI_MAX_RUN_ITEMS", "50")
    monkeypatch.setenv("EXTRACTOR_CHECKER_MODEL", "google/gemini-2.5-flash-lite")
    monkeypatch.setattr(runner, "open_selection_connection", lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(extract, "document_meta_column_exists", lambda conn: True)
    monkeypatch.setattr(extract, "extraction_attempts_column_exists", lambda conn: True)
    monkeypatch.setattr(runner, "select_reports", lambda conn, recent, limit, dry_run=False: [REPORT])
    seen = []
    monkeypatch.setattr(runner, "process", lambda report, **kw: seen.append(kw.get("direct")) or "ok")
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--workers", "1"])
    runner.main()
    assert len(seen) == 1 and seen[0] is not None
    assert seen[0].primary == "deepseek/deepseek-v4-flash"
    assert seen[0].checker == "google/gemini-2.5-flash-lite"
    assert seen[0].denylist is extract.FEWSHOT_DENYLIST


def test_main_exits_non_zero_after_printing_the_counts_when_model_errors_are_systemic(monkeypatch, caplog):
    with caplog.at_level(logging.INFO), pytest.raises(SystemExit) as exc:
        _main_with(monkeypatch, ["ok", "model_error", "model_error", "model_error", "no_metrics"])
    assert exc.value.code == 1
    messages = [r.getMessage() for r in caplog.records]
    done = next(i for i, m in enumerate(messages) if m.startswith("DONE"))
    assert "'model_error': 3" in messages[done]
    assert any("3 model errors" in m for m in messages[done:])


def test_main_logs_but_does_not_fail_on_one_document_the_model_refuses(monkeypatch, caplog):
    # One document blocked every day must not fail every run: it is logged
    # and retried, and the run exits 0.
    outcomes = ["model_error"] + ["ok"] * 9
    with caplog.at_level(logging.INFO):
        _main_with(monkeypatch, outcomes)
    assert any("1 model errors" in r.getMessage() for r in caplog.records)


def test_model_errors_fail_run_rule():
    from collections import Counter

    assert not runner.model_errors_fail_run(Counter({"ok": 5}))
    assert not runner.model_errors_fail_run(Counter({"model_error": 1, "ok": 1}))
    assert not runner.model_errors_fail_run(Counter({"model_error": 2, "ok": 2}))
    assert runner.model_errors_fail_run(Counter({"model_error": 3, "ok": 12}))
    assert not runner.model_errors_fail_run(Counter({"model_error": 3, "ok": 13}))
    # The breaker's worth fails the run whatever the share.
    assert runner.model_errors_fail_run(Counter({"model_error": 5, "ok": 500}), max_consecutive=5)
    # Items that never called the model do not dilute the share.
    assert runner.model_errors_fail_run(Counter({"model_error": 3, "no_pdf": 100, "ok": 2}))


def test_main_exits_zero_without_model_errors(monkeypatch):
    _main_with(monkeypatch, ["ok", "no_metrics", "digest_error", "no_pdf", "no_text"])


# --- unreadable documents and per-company fallbacks -----------------------------------


def _pdf_bytes(text):
    fitz = pytest.importorskip("fitz")
    if not hasattr(fitz, "open"):
        pytest.skip("pymupdf is not installed")
    doc = fitz.open()
    page = doc.new_page()
    if text:
        page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


class _Session:
    def __init__(self, status=200, content=b""):
        self.resp = SimpleNamespace(status_code=status, content=content, text="")

    def get(self, url, timeout=None):
        return self.resp


def test_fetch_pdf_text_tells_a_scanned_pdf_from_a_failed_download():
    scanned = _pdf_bytes("")
    text, status = extract.fetch_pdf_text(_Session(content=scanned), "https://asx/x.pdf")
    assert status == extract.FETCH_UNREADABLE and len(text) < extract.MIN_PDF_TEXT_CHARS

    readable = _pdf_bytes("Revenue of $412.6 million for the year ended 30 June 2026 " * 3)
    text, status = extract.fetch_pdf_text(_Session(content=readable), "https://asx/x.pdf")
    assert status == extract.FETCH_OK and "412.6" in text

    assert extract.fetch_pdf_text(_Session(status=404), "https://asx/x.pdf") == (None, extract.FETCH_FAILED)
    assert extract.fetch_pdf_text(_Session(content=b"<html>terms</html>"), "https://asx/x.pdf") == (None, extract.FETCH_FAILED)
    # download_pdf_text keeps its old contract: text, or None.
    assert extract.download_pdf_text(_Session(content=scanned), "https://asx/x.pdf") is None


def test_order_attaches_the_companys_other_documents_as_fallbacks():
    candidates = [
        {"stock_code": "ABC", "url": "abc-h1", "title": "Appendix 4D", "date": "2026-02-20", "type": "t"},
        {"stock_code": "ABC", "url": "abc-fy", "title": "Appendix 4E", "date": "2026-08-20", "type": "t"},
        {"stock_code": "XYZ", "url": "xyz-fy", "title": "Appendix 4E", "date": "2026-08-21", "type": "t"},
    ]
    snapshot = json.dumps(candidates)
    ordered = extract.order_extraction_targets(candidates, set(), set(), {}, extract._dt.date(2026, 9, 28))
    by_code = {r["stock_code"]: r for r in ordered}
    assert by_code["ABC"]["url"] == "abc-fy" and [f["url"] for f in by_code["ABC"]["fallbacks"]] == ["abc-h1"]
    assert by_code["XYZ"]["fallbacks"] == []
    assert json.dumps(candidates) == snapshot  # the candidates are not mutated
    # recent=1: only the newest is considered, so there is nothing to fall back to.
    ordered = extract.order_extraction_targets(candidates, set(), set(), {}, extract._dt.date(2026, 9, 28), recent=1)
    assert all(r["fallbacks"] == [] for r in ordered)


def _company_report():
    older = {**REPORT, "url": "abc-h1", "title": "Appendix 4D", "date": "2026-02-20"}
    return {**REPORT, "url": "abc-fy", "fallbacks": [older]}


def test_a_scanned_document_gets_a_marker_row_and_the_next_document_is_extracted(monkeypatch):
    def fetch(session, url, max_pages=8):
        return ("Scan", extract.FETCH_UNREADABLE) if url == "abc-fy" else (DOC_TEXT, extract.FETCH_OK)

    stored = _wire(monkeypatch, fetch)
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    assert runner.process(_company_report(), "m", 8, False, write_meta=True) == "ok"
    marker, row = stored.rows
    assert marker["url"] == "abc-fy" and marker["metrics"] == {} and marker["length"] == 4
    assert marker.get("digest_result") is None and marker.get("write_document_meta") is not True
    assert row["url"] == "abc-h1" and "revenue" in row["metrics"]


def test_a_failed_download_writes_nothing_but_does_not_block_the_next_document(monkeypatch):
    def fetch(session, url, max_pages=8):
        return (None, extract.FETCH_FAILED) if url == "abc-fy" else (DOC_TEXT, extract.FETCH_OK)

    stored = _wire(monkeypatch, fetch)
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    assert runner.process(_company_report(), "m", 8, False) == "ok"
    assert [r["url"] for r in stored.rows] == ["abc-h1"]  # no row for the failed URL: retried next run


def test_when_no_document_can_be_read(monkeypatch):
    stored = _wire(monkeypatch, lambda s, url, max_pages=8: (None, extract.FETCH_FAILED))
    assert runner.process(_company_report(), "m", 8, False) == "no_pdf"
    assert stored.rows == []

    def fetch(session, url, max_pages=8):
        return ("x", extract.FETCH_UNREADABLE) if url == "abc-h1" else (None, extract.FETCH_FAILED)

    stored = _wire(monkeypatch, fetch)
    assert runner.process(_company_report(), "m", 8, False) == "no_text"
    assert [r["url"] for r in stored.rows] == ["abc-h1"]


class _SqlConn:
    """Records every statement; a SELECT returns `rows`, and every statement
    reports `rowcount` rows affected."""

    def __init__(self, rows=(), rowcount=1):
        self.statements = []
        self.autocommit = True
        self.closed = False
        self.rows = [dict(r) for r in rows]
        self.rowcount = rowcount

    def cursor(self, *a, **k):
        conn = self

        class C:
            rowcount = -1

            def execute(self, sql, params=None):
                conn.statements.append((sql, params))
                self.rowcount = conn.rowcount

            def fetchall(self):
                return [dict(r) for r in conn.rows]

            def close(self):
                pass

        return C()

    def close(self):
        self.closed = True


def test_the_marker_row_and_the_backfill_skipping_it():
    conn = _SqlConn()
    extract.store_unreadable(conn, REPORT, 12)
    sql, params = conn.statements[0]
    assert "INSERT INTO financial_report_extractions" in sql and "document_meta" not in sql
    assert json.loads(params[5]) == {} and params[6] == 12 and params[8] is None  # metrics, length, digest

    conn = _SqlConn()
    extract.store_unreadable(conn, REPORT, 12, dry_run=True)
    assert conn.statements == []

    conn = _SqlConn()
    runner.select_digestless_reports(conn, limit=10)
    sql, params = conn.statements[0]
    assert "raw_text_length IS NULL OR raw_text_length >= %s" in sql and params == (extract.MIN_PDF_TEXT_CHARS,)


# --- --repair-echo-digests (review C8): the echo entries and their digest go ------------

ECHO_TEXT = "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million"


def _echo_metrics():
    return {
        "revenue": {"source_text": ECHO_TEXT, "value_millions": "5142", "alignment": "match_exact"},
        "net_profit": [
            {"source_text": "Net profit after tax was $55.1 million", "value_millions": "55.1", "alignment": "match_exact"},
        ],
    }


def test_echo_helpers_find_and_drop_only_the_echo_entries():
    import extraction_trust

    metrics = _echo_metrics()
    assert extraction_trust.has_few_shot_entry(metrics, extract.FEWSHOT_DENYLIST)
    cleaned = extraction_trust.drop_few_shot_entries(metrics, extract.FEWSHOT_DENYLIST)
    assert "revenue" not in cleaned, "the echo class is removed"
    assert cleaned["net_profit"] == metrics["net_profit"], "everything else is kept verbatim, provenance included"
    assert not extraction_trust.has_few_shot_entry(cleaned, extract.FEWSHOT_DENYLIST)
    assert not extraction_trust.has_few_shot_entry({"x": "not an entry"}, extract.FEWSHOT_DENYLIST)


def test_select_echo_digest_reports_keeps_only_rows_with_an_echo(monkeypatch):
    rows = [
        {"stock_code": "BHP", "report_url": "u1", "report_type": "t", "report_title": "Appendix 4D",
         "report_date": "2026-02-18", "metrics": json.dumps(_echo_metrics()), "raw_text_length": 9000,
         "raw_text_gcs_url": "gs://b/1.txt"},
        {"stock_code": "WBT", "report_url": "u2", "report_type": "t", "report_title": "Appendix 4E",
         "report_date": "2026-08-20", "metrics": json.dumps({"net_profit": _echo_metrics()["net_profit"]}),
         "raw_text_length": 9000, "raw_text_gcs_url": "gs://b/2.txt"},
    ]

    class Cur:
        def execute(self, sql, params):
            assert "metrics <> '{}'::jsonb" in sql

        def fetchall(self):
            return rows

        def close(self):
            pass

    conn = SimpleNamespace(cursor=lambda **k: Cur())
    got = runner.select_echo_digest_reports(conn, 0)
    assert [r["url"] for r in got] == ["u1"]
    assert got[0]["repair_echo"] is True


def test_repair_stores_clean_metrics_and_a_new_digest(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: DOC_TEXT)
    monkeypatch.setattr(extract, "summarize_report", lambda metrics, text, **k: {"digest": "Wombat lifted profit.", "confidence": 0.9})
    row = {**REPORT, "metrics": json.dumps(_echo_metrics()), "raw_text_gcs_url": "gs://b/x.txt", "repair_echo": True}
    assert runner.process_digestless(row, "m", 8, False) == "ok_gcs"
    [saved] = stored.rows
    assert "revenue" not in saved["metrics"] and "net_profit" in saved["metrics"]
    assert saved["digest_result"]["digest"] == "Wombat lifted profit."


def test_repair_clears_the_echo_digest_even_when_no_new_digest_is_written(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: DOC_TEXT)
    monkeypatch.setattr(extract, "summarize_report", lambda metrics, text, **k: {"digest": ""})
    row = {**REPORT, "metrics": json.dumps(_echo_metrics()), "raw_text_gcs_url": "gs://b/x.txt", "repair_echo": True}
    assert runner.process_digestless(row, "m", 8, False) == "echo_cleared"
    [saved] = stored.rows
    assert "revenue" not in saved["metrics"]
    assert saved["digest_result"] is None, "stored with digest NULL, so the withheld echo digest is gone"


def test_plain_backfill_does_not_rewrite_metrics(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: DOC_TEXT)
    monkeypatch.setattr(extract, "summarize_report", lambda metrics, text, **k: {"digest": "d", "confidence": 0.9})
    row = {**REPORT, "metrics": json.dumps(_echo_metrics()), "raw_text_gcs_url": "gs://b/x.txt"}
    assert runner.process_digestless(row, "m", 8, False) == "ok_gcs"
    assert "revenue" in stored.rows[0]["metrics"], "only --repair-echo-digests drops entries"


# --- --repair-document-meta: the entity and the period read again from the stored text ---

# The stored entities and the names on record ("company-metadata".company_name)
# are prod's (2026-10-13). VIT's own Appendix 4E (idsId=03130179) was stored
# with "Cortexa Pty Ltd", the entity of its control gained or lost section,
# which fails the entity check against "Vitura Health". AXR's two "Sturt
# Exploration Pty Ltd financial statements" (a Core Lithium subsidiary's
# accounts) carry Grant Thornton's letterhead, which readers clean to "Grant
# Thornton Audit Pty Ltd" and which withholds them from Axiant Resources: the
# first version of this repair would have removed it (the text yields no
# entity) and so published them. ALK's "ACN 000 689 216 |" and BLG's "or group
# of entities)" read as no entity. The registration-line rule first read BP8's
# FY26 annual report (03145583) as the company's new name alone, "Ocean
# Sciences Ltd", which fails the check against "Bph Global": added, it
# withholds the company's own report. VIT_4E_TEXT, BLG_4E_TEXT, BP8_AR_TEXT and
# AXR_FS_TEXT stand in for documents whose name the rule reads (a "Name of
# entity" line) and that state no period; NO_ENTITY_TEXT states neither.
VIT_4E_TEXT = "Name of entity: Vitura Health Limited\nASX Appendix 4E\nResults for announcement to the Market\n"
BLG_4E_TEXT = "Name of entity: BluGlass Limited\nASX Appendix 4E\nResults for announcement to the Market\n"
BP8_AR_TEXT = "Name of entity: Ocean Sciences Ltd\nAnnual Report\n"
AXR_FS_TEXT = "Name of entity: Sturt Exploration Pty Ltd\nFinancial Statements\n"
NO_ENTITY_TEXT = "ASX Appendix 4E\nResults for announcement to the Market\n"
AXR_STORED = (
    "Grant Thornton Audit Pty Ltd ACN 130 913 594 a subsidiary or related entity of Grant Thornton Australia Limited"
)
ALK_STORED = "ACN 000 689 216 |"
BLG_STORED = "or group of entities)"

# The period, from the documents' own text (excerpts) and prod's stored rows
# (2026-10-13). VIT's 4E, in its stored order: the prior year's dividend line,
# which the rule before the reporting-period statement read as the 4E's own
# period (stored 2025-06-30), then that statement and the letterhead.
# latest_filing.go's own-period check needs VIT's newest flow period,
# 2026-06-30, so the entity alone repaired left the 4E off the stock page.
VIT_4E_FULL_TEXT = (
    "2.4\t On 22 August 2025, the Directors resolved to pay a dividend of 0.2 cents per ordinary share franked as "
    "to 100% \n"
    "in respect of the year ended 30 June 2025. The Record Date for the dividend was 8 September 2025, and the total \n"
    "1.\t The reporting period covers the year ended 30 June 2026. \n"
    "The previous reporting period covers the year ended 30 June 2025.\n"
    "2.\t Results for announcement to the Market\n"
    "1   |   VITURA HEALTH LIMITED  ASX APPENDIX 4E FOR THE YEAR ENDED 30 JUNE 2026\n"
    "ASX : VIT\nVitura Health Limited\nACN 629 071 594\nASX Appendix 4E\n"
    "Results for announcement to the Market  \nfor the year ended 30 June 2026\n"
)
VIT_STORED = {"entity": "Cortexa Pty Ltd", "period_end": "2025-06-30", "period_type": "annual",
              "report_kind": "appendix_4e"}
# GRR's 1H26 Appendix 4D (idsId=03133655) heads its period "The half year
# ending 30 June 2026", which no rule reads; it was stored with no period, so
# readers placed it from its report date and December balance date, on the
# same half.
GRR_4D_TEXT = (
    "Appendix 4D \n \nHalf year report \n \nName of entity \nGRANGE RESOURCES LIMITED \n \nABN \n80 009 132 405 \n"
    "The interim financial report for the six-month period ended 30 June 2026 has been prepared in accordance with \n"
)
GRR_STORED = {"units": "thousands", "entity": "GRANGE RESOURCES LIMITED", "report_kind": "appendix_4d",
              "units_evidence": "$’000"}
# NHC's FY26 Appendix 4E (idsId=03139480) was stored with its comparative
# year. This line alone states no period of its own, so the stored one stays
# (period kept); the whole 4E labels its year "Current period", a range the
# rule now reads (2026-07-31, like GNG's below).
NHC_4E_TEXT = ("1.\tPercentage movements relate to the previous comparative period being the full year ended "
               "31 July 2025. Highlights reflect 80 per cent interest  \n")
NHC_STORED = {"abn": "38 010 653 844", "units": "thousands", "period_end": "2025-07-31", "period_type": "annual",
              "report_kind": "appendix_4e", "units_evidence": "$000"}
# GLS's FY26 Appendix 4E (idsId=03130264) was stored with the prior year,
# GLS's newest flow period, so the stock page summarised its FY26 4E as
# FY2025's; it states its year as a range, and names it in a footnote.
GLS_4E_TEXT = (
    "The Appendix 4E is for the reporting period from 1 July 2025 to 30 June 2026. The previous corresponding "
    "period was 1 July 2024 to  \n"
    "30 June 2025.\n"
    "* Comparative basic profits per share and diluted profits per share for the year ended 30 June 2025 have "
    "been adjusted retrospectively to reflect the bonus element of the \n"
    "entitlement offer completed during the year ended 30 June 2026 in accordance with AASB 133 Earnings per "
    "Share.\n"
)
GLS_STORED = {"abn": "51 063 975 431", "units": "thousands", "period_end": "2025-06-30", "period_type": "annual",
              "report_kind": "appendix_4e", "units_evidence": "$’000"}
# NIC's 1H26 report (idsId=03130351, lodged 26 August 2026) names a sales quota
# "for the year ended 31 December 2026": its own half only with the report date.
NIC_1H_TEXT = (
    "NICKEL INDUSTRIES LIMITED \nABN 44 127 510 589 \n"
    "The Directors of Nickel Industries Limited (Nickel Industries or the Company) and its subsidiaries (the Group) "
    "submit their financial \n"
    "report for the half year ended 30 June 2026 and the Auditor’s Review Report thereon. \n"
    "The profit of the Group for the half year after providing for income tax amounted to $74,344,926 "
    "(2025 - $25,503,730).  \n"
    "In March 2026 the Hengjaya Mine received its RKAB approval for 2026 nickel ore sales, which has been increased "
    "from \n"
    "9.0 million wmt to 14.3 million wmt for the year ended 31 December 2026. \n"
)
NIC_STORED = {"abn": "44 127 510 589", "units": "millions", "entity": "NICKEL INDUSTRIES LIMITED", "currency": "USD",
              "period_end": "2026-06-30", "period_type": "half", "report_kind": "appendix_4d",
              "units_evidence": "US$m", "currency_evidence": "US$m"}
# GNG's FY26 accounts (idsId=03128898) write their year only as a range after
# "ended": stored with its first day, which the rule once read as the period's
# end; its end is the period's.
GNG_FY26_TEXT = (
    "Group” or “consolidated entity”) for the financial year ended 1 July 2025 to 30 June 2026 (FY26) and the "
    "independent\n"
)
GNG_STORED = {"abn": "12 121 542 738", "period_end": "2025-07-01", "period_type": "annual",
              "report_kind": "appendix_4e"}
# VIG's FY2025 annual report (idsId=03144078, lodged 25 September 2026) names
# its own year, and in its events after the reporting period a half it is
# still to report. A rule that took that later half (the latest month named)
# would have rewritten the correct stored 2025-06-30 in a prod dry run of this
# repair (2026-10-13); it is read as stored, and not written.
VIG_AR_TEXT = (
    "Annual Report - 30 June 2025 \n"
    "and the entities it controlled at the end of, or during, the year ended 30 June 2025. \n"
    "The acquisition was a non-adjusting event after the reporting period and therefore no adjustment was made to the "
    "FY2025 \n"
    "financial statements. The investment to be fully impaired in FY2026 and to be disclosed in the financial report "
    "for the half-year \n"
    "ended 31 December 2025. \n"
)
VIG_STORED = {"abn": "21 165 378 834", "period_end": "2025-06-30", "period_type": "annual",
              "report_kind": "annual_report"}

COMPANIES = {
    "VIT": "Vitura Health", "AXR": "Axiant Resources", "ALK": "Alkane Resources", "BLG": "Bluglass",
    "BP8": "Bph Global", "XYZ": "Xylo", "GRR": "Grange Resources Limited.", "NHC": "New Hope",
    "GLS": "L1 Global Long Short Fund", "NIC": "Nickel Industries", "GNG": "Gr Engineering Services",
    "VIG": "Victor Group Holdings",
}
EXTRACTED_AT = dt.datetime(2026, 10, 12, 14, 20, 5, 485322, tzinfo=dt.timezone.utc)  # VIT's row, as stored
VIT_REPORT_DATE = dt.date(2026, 8, 26)
GUARD = "WHERE report_url = %s AND extracted_at = %s AND document_meta = %s::jsonb"
SET_ENTITY = "document_meta = document_meta || jsonb_build_object('entity', %s::text)"
REMOVE_ENTITY = "document_meta = (document_meta - 'entity')"
SET_PERIOD = "document_meta = document_meta || jsonb_build_object('period_end', %s::text, 'period_type', %s::text)"
SET_ENTITY_AND_PERIOD = (
    "document_meta = document_meta || jsonb_build_object('entity', %s::text, 'period_end', %s::text, "
    "'period_type', %s::text)"
)
REMOVE_ENTITY_SET_PERIOD = (
    "document_meta = (document_meta - 'entity') || jsonb_build_object('period_end', %s::text, 'period_type', %s::text)"
)
_ON_RECORD = object()


def _meta_row(code, url, stored, gcs, report_date=VIT_REPORT_DATE, newest=None, annual=None, company=_ON_RECORD):
    """A selected row whose stored document_meta is the object `stored`: its
    text, and the keys the selection reads from it (None for one it does not
    state). Its company_name is the code's in COMPANIES unless one is given;
    None is a code with no "company-metadata" row (the LEFT JOIN's). newest
    and annual are the code's newest flow and latest annual period ends."""
    return {
        "stock_code": code, "report_url": url, "report_date": report_date, "document_meta": json.dumps(stored),
        "entity": stored.get("entity"), "period_end": stored.get("period_end"),
        "period_type": stored.get("period_type"), "raw_text_gcs_url": gcs, "extracted_at": EXTRACTED_AT,
        "company_name": COMPANIES.get(code) if company is _ON_RECORD else company,
        "newest_flow_period_end": newest, "latest_annual_period_end": annual,
    }


def _entity_row(code="VIT", url="vit-4e", entity="Cortexa Pty Ltd", gcs="gs://b/vit.txt", company=_ON_RECORD):
    """A selected row whose stored document_meta states `entity` (None: no
    entity) and no period."""
    return _meta_row(code, url, {} if entity is None else {"entity": entity}, gcs, company=company)


def _fetch_from(texts):
    """extract.fetch_text_from_gcs over `texts`: an object not there raises, as
    the GCS client does."""

    def fetch(uri):
        if uri not in texts:
            raise FileNotFoundError(f"404 GET {uri}: No such object")
        return texts[uri]

    return fetch


def _repair_meta(monkeypatch, rows, texts, dry_run=False, rowcount=1):
    conn = _SqlConn(rowcount=rowcount)
    monkeypatch.setattr(extract, "fetch_text_from_gcs", _fetch_from(texts))
    counts = runner.repair_document_meta(conn, rows, workers=2, dry_run=dry_run)
    return conn, counts


def _set_clause(sql):
    return " ".join(sql.split(" SET ", 1)[1].split(" WHERE ", 1)[0].split())


def _where(sql):
    return "WHERE " + sql.split(" WHERE ", 1)[1]


def _edits(conn):
    """(report_url, {key: the value written, None for a removal}, the guard's
    stored document_meta) per UPDATE."""
    out = []
    for sql, params in conn.statements:
        clause = _set_clause(sql)
        keys = re.findall(r"'(\w+)', %s::text", clause)
        edits = dict(zip(keys, params))
        if "(document_meta - 'entity')" in clause:
            edits["entity"] = None
        url, at, guard = params[len(keys):]
        assert at == EXTRACTED_AT and _where(sql) == GUARD
        out.append((url, edits, json.loads(guard)))
    return out


def _messages(caplog, level=logging.INFO):
    return [r.getMessage() for r in caplog.records if r.levelno >= level]


def _recap_header(dry_run, passes, fails, kept, changed=0, added=0, period_kept=0):
    return (
        f"Document meta repair recap{' (dry run, nothing written)' if dry_run else ''}, every line to check "
        f"against its document: entity now passes {passes}, now fails {fails}, kept {kept}; period changed "
        f"{changed}, added {added}, kept {period_kept}"
    )


def _summary(dry_run, selected, read, without_text, entity=(0, 0, 0, 0, 0), period=(0, 0, 0, 0), left_alone=0,
             outcomes=(0, 0, 0), effects=(0, 0, 0)):
    return (
        f"Document meta repair{' (dry run, nothing written)' if dry_run else ''}: {selected} rows selected, {read} "
        f"read, {without_text} without text; entity: {entity[0]} unchanged, {entity[1]} cosmetic, {entity[2]} "
        f"renamed, {entity[3]} added, {entity[4]} kept; period: {period[0]} unchanged, {period[1]} changed, "
        f"{period[2]} added, {period[3]} kept; {left_alone} left alone (guard missed); entity check: now passes "
        f"{outcomes[0]}, now fails {outcomes[1]}, no change {outcomes[2]}; own-period check: becomes the newest "
        f"period {effects[0]}, was the newest period {effects[1]}, neither {effects[2]}"
    )


def test_the_repair_texts_and_stored_entities_read_as_these_tests_assume():
    # The repair reads with the runner's own rule, and judges a change by what
    # readers see (extract.entity_readers_see, extract.period_readers_see);
    # these pin both here.
    assert runner.extract_document_meta(VIT_4E_TEXT).get("entity") == "Vitura Health Limited"
    assert runner.extract_document_meta(BLG_4E_TEXT).get("entity") == "BluGlass Limited"
    assert runner.extract_document_meta(BP8_AR_TEXT).get("entity") == "Ocean Sciences Ltd"
    assert runner.extract_document_meta(AXR_FS_TEXT).get("entity") == "Sturt Exploration Pty Ltd"
    for text in (VIT_4E_TEXT, BLG_4E_TEXT, BP8_AR_TEXT, AXR_FS_TEXT, NO_ENTITY_TEXT):
        assert "period_end" not in runner.extract_document_meta(text, VIT_REPORT_DATE)
    assert "entity" not in runner.extract_document_meta(NO_ENTITY_TEXT)
    assert extract.entity_readers_see(AXR_STORED) == "Grant Thornton Audit Pty Ltd"
    assert extract.entity_readers_see("Vitura Health Limited |") == "Vitura Health Limited"
    assert extract.entity_readers_see("Cortexa Pty Ltd") == "Cortexa Pty Ltd"
    assert extract.entity_readers_see(ALK_STORED) == ""
    assert extract.entity_readers_see(BLG_STORED) == ""
    assert extract.entity_readers_see(None) == ""

    def meta(text, report_date):
        m = runner.extract_document_meta(text, report_date)
        return m.get("entity", ""), (m.get("period_end", ""), m.get("period_type", ""))

    assert meta(VIT_4E_FULL_TEXT, VIT_REPORT_DATE) == ("Vitura Health Limited", ("2026-06-30", "annual"))
    assert meta(GRR_4D_TEXT, dt.date(2026, 8, 31)) == ("GRANGE RESOURCES LIMITED", ("2026-06-30", "half"))
    assert meta(NHC_4E_TEXT, dt.date(2026, 9, 15)) == ("", ("", ""))
    assert meta(GLS_4E_TEXT, VIT_REPORT_DATE) == ("", ("2026-06-30", "annual"))
    assert meta(NIC_1H_TEXT, VIT_REPORT_DATE) == ("NICKEL INDUSTRIES LIMITED", ("2026-06-30", "half"))
    assert meta(NIC_1H_TEXT, None)[1] == ("2026-12-31", "annual"), "without the report date, the quota's year"
    assert meta(GNG_FY26_TEXT, dt.date(2026, 8, 24)) == ("", ("2026-06-30", "annual"))
    assert meta(VIG_AR_TEXT, dt.date(2026, 9, 25)) == ("", ("2025-06-30", "annual"))
    assert extract.period_readers_see("2025-06-30", "annual") == ("2025-06-30", "annual")
    assert extract.period_readers_see(None, None) == ("", "")
    assert extract.period_readers_see("2026-06-31", "annual") == ("", "annual")
    assert extract.period_readers_see("2026-06-30", "full year") == ("2026-06-30", "")


@pytest.mark.parametrize("stored, new, change", [
    ("Vitura Health Limited", "Vitura Health Limited", runner.UNCHANGED),
    (None, "", runner.UNCHANGED),
    ("Vitura Health Limited |", "Vitura Health Limited", runner.COSMETIC),
    (ALK_STORED, "", runner.COSMETIC),
    ("Cortexa Pty Ltd", "Vitura Health Limited", runner.RENAMED),
    # Once the rule reads the name before an ACN: AXR stays withheld, under
    # the subsidiary's own name.
    (AXR_STORED, "Sturt Exploration Pty Ltd", runner.RENAMED),
    (None, "Vitura Health Limited", runner.ADDED),
    (BLG_STORED, "BluGlass Limited", runner.ADDED),
    (AXR_STORED, "", runner.KEPT),
    ("Cortexa Pty Ltd", "", runner.KEPT),
])
def test_classify_entity_change_judges_by_what_readers_see(stored, new, change):
    assert runner.classify_entity_change(stored, new) == change


@pytest.mark.parametrize("stored, new, change", [
    (("2026-06-30", "half"), ("2026-06-30", "half"), runner.PERIOD_UNCHANGED),  # NIC, read with its report date
    (("", ""), ("", ""), runner.PERIOD_UNCHANGED),
    (("2025-06-30", "annual"), ("2026-06-30", "annual"), runner.PERIOD_CHANGED),  # VIT
    (("2025-06-30", "annual"), ("2025-12-31", "half"), runner.PERIOD_CHANGED),  # AXR's 6-month accounts
    (("2025-12-31", "annual"), ("2025-12-31", "half"), runner.PERIOD_CHANGED),  # the type alone
    (("2026-06-30", ""), ("2026-06-30", "annual"), runner.PERIOD_CHANGED),
    (("", ""), ("2026-06-30", "half"), runner.PERIOD_ADDED),  # GRR
    (("", "annual"), ("2026-06-30", "annual"), runner.PERIOD_ADDED),  # a type alone states no period
    (("2025-07-31", "annual"), ("", ""), runner.PERIOD_KEPT),  # NHC
])
def test_classify_period_change_by_what_readers_see(stored, new, change):
    assert runner.classify_period_change(stored, new) == change


@pytest.mark.parametrize("before, after, company, outcome", [
    # Only a rename can make a withheld row pass: VIT's own 4E, read again.
    ("Cortexa Pty Ltd", "Vitura Health Limited", "Vitura Health", runner.NOW_PASSES),
    # A rename can withhold a published row: BP8's 4E, were it read as the
    # company's new name.
    ("BPH Global Limited", "Ocean Sciences Ltd", "Bph Global", runner.NOW_FAILS),
    # Renamed and still withheld (AXR's subsidiary accounts), or still
    # published (MFD's 4E).
    ("Grant Thornton Audit Pty Ltd", "Sturt Exploration Pty Ltd", "Axiant Resources", runner.NO_CHANGE),
    ("Mayfield Childcare 360 Pty Ltd", "MAYFIELD CHILDCARE LIMITED", "Mayfield Childcare", runner.NO_CHANGE),
    # An added name can only withhold: BP8's own annual report; any name on a
    # code with no name on record.
    ("", "Ocean Sciences Ltd", "Bph Global", runner.NOW_FAILS),
    ("", "Vitura Health Limited", None, runner.NOW_FAILS),
    ("", "Vitura Health Limited", "", runner.NOW_FAILS),
    ("", "Vitura Health Limited", "Vitura Health", runner.NO_CHANGE),
    # A kept name, and a value readers read as none removed, change nothing.
    ("Grant Thornton Audit Pty Ltd", "Grant Thornton Audit Pty Ltd", "Axiant Resources", runner.NO_CHANGE),
    ("", "", "Alkane Resources", runner.NO_CHANGE),
    ("", "", None, runner.NO_CHANGE),
])
def test_entity_check_outcome_is_what_the_gates_decide_before_and_after(before, after, company, outcome):
    assert runner.entity_check_outcome(before, after, company) == outcome


def test_own_period_end_is_latest_filings_resolver():
    # latest_filing_test.go TestResolveOwnPeriodAndCanonicalMonthEnd and
    # TestSelectLatestFiling's own-period cases, case for case.
    d = dt.date.fromisoformat
    assert runner.canonical_month_end(d("2023-07-02")) == d("2023-06-30")
    assert runner.canonical_month_end(d("2023-06-25")) == d("2023-06-30")
    assert runner.canonical_month_end(d("2026-12-31")) == d("2026-12-31")
    assert runner.own_period_end("2025-12-31", d("2026-02-18"), 6) == d("2025-12-31")
    assert runner.own_period_end("2025-09-30", d("2026-02-18"), 6) == d("2025-09-30")
    assert runner.own_period_end("", d("2026-08-19"), 12) == d("2026-06-30"), "a December filer's June end"
    assert runner.own_period_end("", d("2026-08-19"), 6) == d("2026-06-30")
    assert runner.own_period_end("", d("2026-02-18"), 6) == d("2025-12-31"), "a half-year document"
    assert runner.own_period_end("", d("2026-08-19"), None) is None, "no balance date and no meta"
    # Reported 2026-01-20 on a June balance date: the half just ended.
    assert runner.own_period_end("", d("2026-01-20"), 6) == d("2025-12-31")
    # An annual report lodged in January resolves to the half just ended.
    assert runner.own_period_end("", d("2027-01-10"), 6) == d("2026-12-31")
    # More than 5 whole months after the later end: not its own.
    assert runner.own_period_end("", d("2026-12-29"), 12) == d("2026-06-30")
    assert runner.own_period_end("", d("2026-12-30"), 12) is None


@pytest.mark.parametrize("before, after, report_date, newest, annual, effect", [
    # VIT's 4E: off the page with the prior year's period, on it with its own.
    ("2025-06-30", "2026-06-30", "2026-08-26", "2026-06-30", "2026-06-30", runner.BECOMES_NEWEST),
    # GLS's FY26 4E, summarised as FY2025 (its newest flow period) while it
    # was stored with the prior year: off the page until FY2026's figures.
    ("2025-06-30", "2026-06-30", "2026-08-26", "2025-06-30", "2025-06-30", runner.WAS_NEWEST),
    # GRR's 4D: its report date and December balance date already placed it
    # on its half, so the added period changes nothing...
    ("", "2026-06-30", "2026-08-31", "2026-06-30", "2025-12-31", runner.NEITHER),
    # ...but without a balance date the report date places nothing.
    ("", "2026-06-30", "2026-08-31", "2026-06-30", None, runner.BECOMES_NEWEST),
    # An added period that is not the one the report date gave takes the
    # document off the page.
    ("", "2025-12-31", "2026-08-31", "2026-06-30", "2025-12-31", runner.WAS_NEWEST),
    # A 52/53-week end folds onto its month.
    ("2025-06-30", "2026-06-28", "2026-08-26", "2026-06-30", "2026-06-30", runner.BECOMES_NEWEST),
    ("2026-06-28", "2026-07-02", "2026-08-26", "2026-06-30", "2026-06-30", runner.NEITHER),
    # Neither side the newest, a kept period, no flow period, no report date.
    ("2024-12-31", "2025-12-31", "2026-02-19", "2026-06-30", "2026-06-30", runner.NEITHER),
    ("2025-07-31", "2025-07-31", "2026-09-15", "2026-07-31", "2026-07-31", runner.NEITHER),
    ("2025-06-30", "2026-06-30", "2026-08-26", None, "2026-06-30", runner.NEITHER),
    ("2025-06-30", "2026-06-30", None, "2026-06-30", "2026-06-30", runner.NEITHER),
])
def test_own_period_effect_is_the_stock_pages_check_before_and_after(before, after, report_date, newest, annual,
                                                                   effect):
    d = lambda s: None if s is None else dt.date.fromisoformat(s)  # noqa: E731
    assert runner.own_period_effect(before, after, d(report_date), d(newest), d(annual)) == effect


def test_document_meta_repair_renames_an_entity_the_current_rule_reads_differently(monkeypatch):
    row = _entity_row()
    conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/vit.txt": VIT_4E_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == SET_ENTITY and sql.endswith(GUARD)
    assert params == ("Vitura Health Limited", "vit-4e", EXTRACTED_AT, row["document_meta"])
    assert counts == {"read": 1, "renamed": 1, "now passes": 1, "period unchanged": 1}


def test_document_meta_repair_writes_a_cosmetic_name_change(monkeypatch):
    # Readers already clean "Vitura Health Limited |" to the name the rule now
    # stores: written, and nothing they see changes.
    row = _entity_row(entity="Vitura Health Limited |")
    conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/vit.txt": VIT_4E_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == SET_ENTITY and sql.endswith(GUARD)
    assert params == ("Vitura Health Limited", "vit-4e", EXTRACTED_AT, row["document_meta"])
    assert counts == {"read": 1, "cosmetic": 1, "no change": 1, "period unchanged": 1}


def test_document_meta_repair_removes_a_stored_value_readers_read_as_no_entity(monkeypatch):
    row = _entity_row("ALK", "alk-4e", ALK_STORED, "gs://b/alk.txt")
    conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/alk.txt": NO_ENTITY_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == REMOVE_ENTITY, "the key goes, never the column"
    assert sql.endswith(GUARD) and params == ("alk-4e", EXTRACTED_AT, row["document_meta"])
    assert counts == {"read": 1, "cosmetic": 1, "no change": 1, "period unchanged": 1}


def test_document_meta_repair_adds_an_entity_to_a_row_that_stated_none(monkeypatch):
    row = _entity_row(url="vit-ar", entity=None)
    conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/vit.txt": VIT_4E_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == SET_ENTITY and sql.endswith(GUARD)
    assert params == ("Vitura Health Limited", "vit-ar", EXTRACTED_AT, "{}")
    assert counts == {"read": 1, "added": 1, "no change": 1, "period unchanged": 1}


def test_document_meta_repair_adds_a_name_where_readers_saw_none(monkeypatch):
    row = _entity_row("BLG", "blg-4e", BLG_STORED, "gs://b/blg.txt")
    conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/blg.txt": BLG_4E_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == SET_ENTITY and sql.endswith(GUARD)
    assert params == ("BluGlass Limited", "blg-4e", EXTRACTED_AT, row["document_meta"])
    assert counts == {"read": 1, "added": 1, "no change": 1, "period unchanged": 1}


def test_document_meta_repair_keeps_a_name_readers_check_when_the_text_yields_none(monkeypatch, caplog):
    row = _entity_row("AXR", "axr-fs", AXR_STORED, "gs://b/axr.txt")
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/axr.txt": NO_ENTITY_TEXT})
    assert conn.statements == [], "removing the name would publish another company's accounts as AXR's"
    assert counts == {"read": 1, "kept": 1, "no change": 1, "period unchanged": 1}
    assert _messages(caplog, logging.WARNING) == [
        f"  kept AXR axr-fs: company 'Axiant Resources', stored {AXR_STORED!r}, seen 'Grant Thornton Audit Pty Ltd', "
        "new ''; entity check: no change (the text names no entity, and without this name readers would check "
        "none: left as stored)"
    ]


def test_document_meta_repair_does_not_write_an_unchanged_entity(monkeypatch):
    rows = [_entity_row(entity="Vitura Health Limited"), _entity_row("ABC", "abc-4e", None, "gs://b/abc.txt")]
    conn, counts = _repair_meta(monkeypatch, rows, {"gs://b/vit.txt": VIT_4E_TEXT, "gs://b/abc.txt": NO_ENTITY_TEXT})
    assert conn.statements == []
    assert counts == {"read": 2, "unchanged": 2, "period unchanged": 2}


def test_document_meta_repair_rewrites_vits_entity_and_period_in_one_statement(monkeypatch, caplog):
    # VIT's own 4E needs both: its entity to pass the entity check and its own
    # period to be the newest flow period the stock page summarises.
    row = _meta_row("VIT", "vit-4e", VIT_STORED, "gs://b/vit-4e.txt", newest=dt.date(2026, 6, 30),
                    annual=dt.date(2026, 6, 30))
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/vit-4e.txt": VIT_4E_FULL_TEXT})
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == SET_ENTITY_AND_PERIOD and sql.endswith(GUARD)
    assert params == ("Vitura Health Limited", "2026-06-30", "annual", "vit-4e", EXTRACTED_AT, json.dumps(VIT_STORED))
    assert counts == {"read": 1, "renamed": 1, "now passes": 1, "period changed": 1, "becomes the newest period": 1}
    vit_period = ("company 'Vitura Health', report date 2026-08-26, stored 2025-06-30 annual, new 2026-06-30 annual, "
                  "newest flow period 2026-06-30; own-period check: becomes the newest period")
    assert _messages(caplog) == [
        "  renamed VIT vit-4e: company 'Vitura Health', stored 'Cortexa Pty Ltd', seen 'Cortexa Pty Ltd', "
        "new 'Vitura Health Limited'; entity check: now passes",
        f"  period changed VIT vit-4e: {vit_period}",
        _recap_header(False, 1, 0, 0, changed=1),
        "  VIT 'Vitura Health' vit-4e: renamed 'Cortexa Pty Ltd' -> 'Vitura Health Limited'; entity check: now passes",
        "  VIT 'Vitura Health' vit-4e: period changed 2025-06-30 annual -> 2026-06-30 annual, report date 2026-08-26, "
        "newest flow period 2026-06-30; own-period check: becomes the newest period",
    ]


def test_document_meta_repair_judges_a_stored_period_by_what_readers_see(monkeypatch, caplog):
    # The selection reads document_meta's keys as stored; ParseDocumentMeta
    # keeps only a period_end that is a real day. One readers cannot read is
    # no period to them, so the period the text states is added, and the
    # report date had already placed the 4E on its year: nothing changes on
    # the page.
    stored = {**VIT_STORED, "entity": "Vitura Health Limited", "period_end": "2026-06-31"}
    row = _meta_row("VIT", "vit-4e", stored, "gs://b/vit-4e.txt", newest=dt.date(2026, 6, 30),
                    annual=dt.date(2026, 6, 30))
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, [row], {"gs://b/vit-4e.txt": VIT_4E_FULL_TEXT})
    assert [(url, edits) for url, edits, _ in _edits(conn)] == [
        ("vit-4e", {"period_end": "2026-06-30", "period_type": "annual"}),
    ]
    assert counts == {"read": 1, "unchanged": 1, "period added": 1, "neither": 1}
    assert _messages(caplog)[0] == (
        "  period added VIT vit-4e: company 'Vitura Health', report date 2026-08-26, stored (none), new 2026-06-30 "
        "annual, newest flow period 2026-06-30; own-period check: neither"
    )


def test_the_writer_edits_only_the_keys_it_is_given():
    stored = json.dumps(VIT_STORED)
    for kwargs, clause, values in [
        ({"entity": "Vitura Health Limited"}, SET_ENTITY, ("Vitura Health Limited",)),
        ({"period": ("2026-06-30", "annual")}, SET_PERIOD, ("2026-06-30", "annual")),
        ({"entity": "Vitura Health Limited", "period": ("2026-06-30", "annual")}, SET_ENTITY_AND_PERIOD,
         ("Vitura Health Limited", "2026-06-30", "annual")),
    ]:
        conn = _SqlConn()
        assert extract.store_document_meta_repair(conn, "vit-4e", EXTRACTED_AT, stored, **kwargs) is True
        [(sql, params)] = conn.statements
        assert _set_clause(sql) == clause and _where(sql) == GUARD
        assert params == (*values, "vit-4e", EXTRACTED_AT, stored)
    conn = _SqlConn()
    alk = json.dumps({"entity": ALK_STORED, "period_type": "annual"})
    assert extract.store_document_meta_repair(conn, "alk-4e", EXTRACTED_AT, alk, entity="",
                                              period=("2026-06-30", "annual")) is True
    [(sql, params)] = conn.statements
    assert _set_clause(sql) == REMOVE_ENTITY_SET_PERIOD and params == ("2026-06-30", "annual", "alk-4e", EXTRACTED_AT, alk)
    assert extract.store_document_meta_repair(_SqlConn(rowcount=0), "vit-4e", EXTRACTED_AT, stored,
                                              entity="Vitura Health Limited") is False, "the guard missed"


def test_the_writer_never_lifts_an_entity_check_or_removes_a_period():
    conn = _SqlConn()
    axr = json.dumps({"entity": AXR_STORED, "period_end": "2025-06-30", "period_type": "annual"})
    with pytest.raises(ValueError, match="readers check that name"):
        extract.store_document_meta_repair(conn, "axr-fs", EXTRACTED_AT, axr, entity="")
    with pytest.raises(ValueError, match="no document_meta entity to remove"):
        extract.store_document_meta_repair(conn, "vit-ar", EXTRACTED_AT, "{}", entity="")
    for period in (("", ""), ("", "annual"), ("2026-06-30", ""), ("2026-06-31", "annual"), ("2026-06-30", "year")):
        with pytest.raises(ValueError, match="not a period readers read as one"):
            extract.store_document_meta_repair(conn, "axr-fs", EXTRACTED_AT, axr, period=period)
    with pytest.raises(ValueError, match="nothing to write"):
        extract.store_document_meta_repair(conn, "axr-fs", EXTRACTED_AT, axr)
    # The guard is the stored object as read: without one, nothing is guarded.
    for stored in (None, "null", '"Cortexa Pty Ltd"', "[]"):
        with pytest.raises(ValueError, match="the guard needs the document_meta object as read"):
            extract.store_document_meta_repair(conn, "vit-4e", EXTRACTED_AT, stored, entity="Vitura Health Limited")
    assert conn.statements == []
    alk = json.dumps({"entity": ALK_STORED})
    assert extract.store_document_meta_repair(conn, "alk-4e", EXTRACTED_AT, alk, entity="") is True
    [(sql, _)] = conn.statements
    assert _set_clause(sql) == REMOVE_ENTITY


def test_document_meta_repair_leaves_alone_a_row_rewritten_since_it_was_read(monkeypatch, caplog):
    rows = [
        _entity_row(), _entity_row("ALK", "alk-4e", ALK_STORED, "gs://b/alk.txt"),
        _entity_row(url="vit-ar", entity=None),
        # The period alone: GRR's entity reads as stored.
        _meta_row("GRR", "grr-4d", GRR_STORED, "gs://b/grr.txt", dt.date(2026, 8, 31), dt.date(2026, 6, 30),
                  dt.date(2025, 12, 31)),
    ]
    texts = {"gs://b/vit.txt": VIT_4E_TEXT, "gs://b/alk.txt": NO_ENTITY_TEXT, "gs://b/grr.txt": GRR_4D_TEXT}
    # rowcount 0: every guard missed (a concurrent run rewrote the rows after
    # they were read: a new extracted_at, or any key of document_meta).
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts, rowcount=0)
    assert [(_where(sql), params[-3:]) for sql, params in conn.statements] == [
        (GUARD, (row["report_url"], EXTRACTED_AT, row["document_meta"])) for row in rows
    ], "every guard is the whole document_meta and the extracted_at read"
    assert counts == {"read": 4, "left_alone": 4}, "nothing written: no class, outcome or effect counted"
    assert _messages(caplog) == [
        "  left alone VIT vit-4e: renamed, company 'Vitura Health', stored 'Cortexa Pty Ltd', seen 'Cortexa Pty Ltd', "
        "new 'Vitura Health Limited' (rewritten since it was read)",
        f"  left alone ALK alk-4e: cosmetic, company 'Alkane Resources', stored {ALK_STORED!r}, seen '', new '' "
        "(rewritten since it was read)",
        "  left alone VIT vit-ar: added, company 'Vitura Health', stored (none), seen '', new 'Vitura Health Limited' "
        "(rewritten since it was read)",
        "  left alone GRR grr-4d: period added, company 'Grange Resources Limited.', report date 2026-08-31, stored "
        "(none), new 2026-06-30 half, newest flow period 2026-06-30 (rewritten since it was read)",
        _recap_header(False, 0, 0, 0),
    ]


def _every_class():
    rows = [
        _entity_row(),  # renamed: now passes
        _entity_row("VIT", "vit-4d", "Vitura Health Limited |", "gs://b/vit-4d.txt"),  # cosmetic
        _entity_row("ALK", "alk-4e", ALK_STORED, "gs://b/alk.txt"),  # cosmetic: the value goes
        _entity_row("VIT", "vit-ar", None, "gs://b/vit-ar.txt"),  # added
        _entity_row("BLG", "blg-4e", BLG_STORED, "gs://b/blg.txt"),  # added
        _entity_row("BP8", "bp8-ar", None, "gs://b/bp8-ar.txt"),  # added: now fails
        _entity_row("AXR", "axr-fs", AXR_STORED, "gs://b/axr.txt"),  # kept
        _entity_row("VIT", "vit-hy", "Vitura Health Limited", "gs://b/vit-hy.txt"),  # unchanged
        # A blank stored text is not read, never read as naming no entity: a
        # stored value readers read as none would go on an empty read.
        _entity_row("ALK", "alk-hy", ALK_STORED, "gs://b/blank.txt"),
        _entity_row("XYZ", "xyz-4e", "Xylo Limited", "gs://b/gone.txt"),  # no text
    ]
    texts = {
        "gs://b/vit.txt": VIT_4E_TEXT, "gs://b/vit-4d.txt": VIT_4E_TEXT, "gs://b/alk.txt": NO_ENTITY_TEXT,
        "gs://b/vit-ar.txt": VIT_4E_TEXT, "gs://b/blg.txt": BLG_4E_TEXT, "gs://b/bp8-ar.txt": BP8_AR_TEXT,
        "gs://b/axr.txt": NO_ENTITY_TEXT, "gs://b/vit-hy.txt": VIT_4E_TEXT, "gs://b/blank.txt": "  \n",
    }
    return rows, texts


EVERY_CLASS_COUNTS = {
    "read": 8, "without_text": 2, "renamed": 1, "cosmetic": 2, "added": 3, "kept": 1, "unchanged": 1,
    "now passes": 1, "now fails": 1, "no change": 5, "period unchanged": 8,
}


def _every_class_records(tag):
    """(level, message) of each row's line, in row order."""
    return [
        ("INFO", f"  {tag}renamed VIT vit-4e: company 'Vitura Health', stored 'Cortexa Pty Ltd', "
                 "seen 'Cortexa Pty Ltd', new 'Vitura Health Limited'; entity check: now passes"),
        ("INFO", f"  {tag}cosmetic VIT vit-4d: company 'Vitura Health', stored 'Vitura Health Limited |', "
                 "seen 'Vitura Health Limited', new 'Vitura Health Limited'; entity check: no change"),
        ("INFO", f"  {tag}cosmetic ALK alk-4e: company 'Alkane Resources', stored {ALK_STORED!r}, seen '', new ''; "
                 "entity check: no change"),
        ("INFO", f"  {tag}added VIT vit-ar: company 'Vitura Health', stored (none), seen '', "
                 "new 'Vitura Health Limited'; entity check: no change"),
        ("INFO", f"  {tag}added BLG blg-4e: company 'Bluglass', stored {BLG_STORED!r}, seen '', "
                 "new 'BluGlass Limited'; entity check: no change"),
        ("INFO", f"  {tag}added BP8 bp8-ar: company 'Bph Global', stored (none), seen '', new 'Ocean Sciences Ltd'; "
                 "entity check: now fails"),
        ("WARNING", f"  kept AXR axr-fs: company 'Axiant Resources', stored {AXR_STORED!r}, "
                    "seen 'Grant Thornton Audit Pty Ltd', new ''; entity check: no change (the text names no "
                    "entity, and without this name readers would check none: left as stored)"),
        ("WARNING", "  ALK alk-hy: stored text gs://b/blank.txt not read (the stored text is blank); left as stored, "
                    "and later rows whose text cannot be read are only counted"),
    ]


# The recap: the row that now passes, the row that now fails, the kept row.
EVERY_CLASS_RECAP = [
    "  VIT 'Vitura Health' vit-4e: renamed 'Cortexa Pty Ltd' -> 'Vitura Health Limited'; entity check: now passes",
    "  BP8 'Bph Global' bp8-ar: added '' -> 'Ocean Sciences Ltd'; entity check: now fails",
    "  AXR 'Axiant Resources' axr-fs: kept 'Grant Thornton Audit Pty Ltd' -> '' (left as stored); "
    "entity check: no change",
]


def test_document_meta_repair_dry_run_lists_every_decisive_row_and_writes_nothing(monkeypatch, caplog):
    rows, texts = _every_class()
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts, dry_run=True)
    assert conn.statements == []
    assert counts == EVERY_CLASS_COUNTS
    assert _messages(caplog) == [message for _, message in _every_class_records("[dry-run] ")] + [
        _recap_header(True, 1, 1, 1),
        *EVERY_CLASS_RECAP,
    ]


def test_document_meta_repair_real_run_writes_each_class_once_and_logs_what_it_replaced(monkeypatch, caplog):
    # The real run's lines are the only record of the entity each write
    # replaced, which a bad rename would be undone from.
    rows, texts = _every_class()
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts)
    assert [(url, edits) for url, edits, _ in _edits(conn)] == [
        ("vit-4e", {"entity": "Vitura Health Limited"}),
        ("vit-4d", {"entity": "Vitura Health Limited"}),
        ("alk-4e", {"entity": None}),
        ("vit-ar", {"entity": "Vitura Health Limited"}),
        ("blg-4e", {"entity": "BluGlass Limited"}),
        ("bp8-ar", {"entity": "Ocean Sciences Ltd"}),
    ], "AXR's kept row, the unchanged row and the rows without text (one blank) are not written"
    assert counts == EVERY_CLASS_COUNTS
    assert [(r.levelname, r.getMessage()) for r in caplog.records if r.levelno >= logging.INFO] == (
        _every_class_records("")
        + [("INFO", _recap_header(False, 1, 1, 1))]
        + [("INFO", line) for line in EVERY_CLASS_RECAP]
    )


def _every_period_class():
    rows = [
        # renamed and period changed, in one statement: the page shows it.
        _meta_row("VIT", "vit-4e", VIT_STORED, "gs://b/vit-4e.txt", VIT_REPORT_DATE, dt.date(2026, 6, 30),
                  dt.date(2026, 6, 30)),
        # period added: the report date already placed it on its half.
        _meta_row("GRR", "grr-4d", GRR_STORED, "gs://b/grr.txt", dt.date(2026, 8, 31), dt.date(2026, 6, 30),
                  dt.date(2025, 12, 31)),
        # period kept: the text states none of its own; not written.
        _meta_row("NHC", "nhc-4e", NHC_STORED, "gs://b/nhc.txt", dt.date(2026, 9, 15), dt.date(2026, 7, 31),
                  dt.date(2026, 7, 31)),
        # period changed, off the page: it was summarised as the prior year.
        _meta_row("GLS", "gls-4e", GLS_STORED, "gs://b/gls.txt", VIT_REPORT_DATE, dt.date(2025, 6, 30),
                  dt.date(2025, 6, 30)),
        # period changed, from a range's first day to its end: the page can
        # show it.
        _meta_row("GNG", "gng-fy26", GNG_STORED, "gs://b/gng.txt", dt.date(2026, 8, 24), dt.date(2026, 6, 30),
                  dt.date(2026, 6, 30)),
        # period unchanged: read with its report date.
        _meta_row("NIC", "nic-1h", NIC_STORED, "gs://b/nic.txt", VIT_REPORT_DATE, dt.date(2026, 6, 30),
                  dt.date(2025, 12, 31)),
        # period unchanged: the half it is still to report is not its own.
        _meta_row("VIG", "vig-ar", VIG_STORED, "gs://b/vig.txt", dt.date(2026, 9, 25), dt.date(2026, 6, 30),
                  dt.date(2026, 6, 30)),
    ]
    texts = {"gs://b/vit-4e.txt": VIT_4E_FULL_TEXT, "gs://b/grr.txt": GRR_4D_TEXT, "gs://b/nhc.txt": NHC_4E_TEXT,
             "gs://b/gls.txt": GLS_4E_TEXT, "gs://b/gng.txt": GNG_FY26_TEXT, "gs://b/nic.txt": NIC_1H_TEXT,
             "gs://b/vig.txt": VIG_AR_TEXT}
    return rows, texts


EVERY_PERIOD_CLASS_COUNTS = {
    "read": 7, "renamed": 1, "unchanged": 6, "now passes": 1,
    "period changed": 3, "period added": 1, "period kept": 1, "period unchanged": 2,
    "becomes the newest period": 2, "was the newest period": 1, "neither": 2,
}


def _every_period_class_records(tag):
    """(level, message) of each row's lines, in row order."""
    return [
        ("INFO", f"  {tag}renamed VIT vit-4e: company 'Vitura Health', stored 'Cortexa Pty Ltd', "
                 "seen 'Cortexa Pty Ltd', new 'Vitura Health Limited'; entity check: now passes"),
        ("INFO", f"  {tag}period changed VIT vit-4e: company 'Vitura Health', report date 2026-08-26, stored "
                 "2025-06-30 annual, new 2026-06-30 annual, newest flow period 2026-06-30; own-period check: becomes "
                 "the newest period"),
        ("INFO", f"  {tag}period added GRR grr-4d: company 'Grange Resources Limited.', report date 2026-08-31, "
                 "stored (none), new 2026-06-30 half, newest flow period 2026-06-30; own-period check: neither"),
        ("WARNING", "  period kept NHC nhc-4e: company 'New Hope', report date 2026-09-15, stored 2025-07-31 annual, "
                    "new (none), newest flow period 2026-07-31; own-period check: neither (the text states no "
                    "period of its own: left as stored)"),
        ("INFO", f"  {tag}period changed GLS gls-4e: company 'L1 Global Long Short Fund', report date 2026-08-26, "
                 "stored 2025-06-30 annual, new 2026-06-30 annual, newest flow period 2025-06-30; own-period check: "
                 "was the newest period"),
        ("INFO", f"  {tag}period changed GNG gng-fy26: company 'Gr Engineering Services', report date 2026-08-24, "
                 "stored 2025-07-01 annual, new 2026-06-30 annual, newest flow period 2026-06-30; own-period check: "
                 "becomes the newest period"),
    ]


# The recap: VIT's rename, then every period change, then the kept period.
EVERY_PERIOD_CLASS_RECAP = [
    "  VIT 'Vitura Health' vit-4e: renamed 'Cortexa Pty Ltd' -> 'Vitura Health Limited'; entity check: now passes",
    "  VIT 'Vitura Health' vit-4e: period changed 2025-06-30 annual -> 2026-06-30 annual, report date 2026-08-26, "
    "newest flow period 2026-06-30; own-period check: becomes the newest period",
    "  GLS 'L1 Global Long Short Fund' gls-4e: period changed 2025-06-30 annual -> 2026-06-30 annual, report date "
    "2026-08-26, newest flow period 2025-06-30; own-period check: was the newest period",
    "  GNG 'Gr Engineering Services' gng-fy26: period changed 2025-07-01 annual -> 2026-06-30 annual, report date "
    "2026-08-24, newest flow period 2026-06-30; own-period check: becomes the newest period",
    "  GRR 'Grange Resources Limited.' grr-4d: period added (none) -> 2026-06-30 half, report date 2026-08-31, "
    "newest flow period 2026-06-30; own-period check: neither",
    "  NHC 'New Hope' nhc-4e: period kept 2025-07-31 annual -> (none) (left as stored), report date 2026-09-15, "
    "newest flow period 2026-07-31; own-period check: neither",
]


def test_document_meta_repair_dry_run_lists_every_period_change_and_writes_nothing(monkeypatch, caplog):
    rows, texts = _every_period_class()
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts, dry_run=True)
    assert conn.statements == []
    assert counts == EVERY_PERIOD_CLASS_COUNTS
    assert [(r.levelname, r.getMessage()) for r in caplog.records if r.levelno >= logging.INFO] == (
        _every_period_class_records("[dry-run] ")
        + [("INFO", _recap_header(True, 1, 0, 0, changed=3, added=1, period_kept=1))]
        + [("INFO", line) for line in EVERY_PERIOD_CLASS_RECAP]
    )


def test_document_meta_repair_real_run_writes_each_period_change_and_never_the_kept_period(monkeypatch, caplog):
    rows, texts = _every_period_class()
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts)
    stored = {row["report_url"]: json.loads(row["document_meta"]) for row in rows}
    assert [(url, edits, guard == stored[url]) for url, edits, guard in _edits(conn)] == [
        ("vit-4e", {"entity": "Vitura Health Limited", "period_end": "2026-06-30", "period_type": "annual"}, True),
        ("grr-4d", {"period_end": "2026-06-30", "period_type": "half"}, True),
        ("gls-4e", {"period_end": "2026-06-30", "period_type": "annual"}, True),
        ("gng-fy26", {"period_end": "2026-06-30", "period_type": "annual"}, True),
    ], "NHC's kept period and NIC's and VIG's unchanged ones are not written"
    assert counts == EVERY_PERIOD_CLASS_COUNTS
    assert [(r.levelname, r.getMessage()) for r in caplog.records if r.levelno >= logging.INFO] == (
        _every_period_class_records("")
        + [("INFO", _recap_header(False, 1, 0, 0, changed=3, added=1, period_kept=1))]
        + [("INFO", line) for line in EVERY_PERIOD_CLASS_RECAP]
    )


def test_document_meta_repair_recaps_a_changed_verdict_and_a_kept_row_only(monkeypatch, caplog):
    rows = [
        _entity_row("BP8", "bp8-4e", "BPH Global Limited", "gs://b/bp8-ar.txt"),  # renamed: now fails
        _entity_row("AXR", "axr-fs", AXR_STORED, "gs://b/axr-fs.txt"),  # renamed: withheld either way
        _entity_row("NEW", "new-4e", None, "gs://b/vit.txt", company=None),  # added, no name on record
        _entity_row("AXR", "axr-fs2", AXR_STORED, "gs://b/none.txt"),  # kept
    ]
    texts = {"gs://b/bp8-ar.txt": BP8_AR_TEXT, "gs://b/axr-fs.txt": AXR_FS_TEXT, "gs://b/vit.txt": VIT_4E_TEXT,
             "gs://b/none.txt": NO_ENTITY_TEXT}
    with caplog.at_level(logging.INFO):
        _, counts = _repair_meta(monkeypatch, rows, texts, dry_run=True)
    assert counts == {"read": 4, "renamed": 2, "added": 1, "kept": 1, "now fails": 2, "no change": 2,
                      "period unchanged": 4}
    messages = _messages(caplog)
    assert (
        f"  [dry-run] renamed AXR axr-fs: company 'Axiant Resources', stored {AXR_STORED!r}, "
        "seen 'Grant Thornton Audit Pty Ltd', new 'Sturt Exploration Pty Ltd'; entity check: no change"
    ) in messages
    assert messages[messages.index(_recap_header(True, 0, 2, 1)):] == [
        _recap_header(True, 0, 2, 1),
        "  BP8 'Bph Global' bp8-4e: renamed 'BPH Global Limited' -> 'Ocean Sciences Ltd'; entity check: now fails",
        "  NEW '' new-4e: added '' -> 'Vitura Health Limited'; entity check: now fails",
        "  AXR 'Axiant Resources' axr-fs2: kept 'Grant Thornton Audit Pty Ltd' -> '' (left as stored); "
        "entity check: no change",
    ], "AXR's rename changes no verdict: only its own line lists it"


def test_document_meta_repair_samples_cosmetic_rows_and_counts_unreadable_ones(monkeypatch, caplog):
    rows = [_entity_row("VIT", f"vit-{i}", "Vitura Health Limited |", f"gs://b/vit-{i}.txt") for i in range(7)]
    rows += [_entity_row("XYZ", f"xyz-{i}", "Xylo Limited", f"gs://b/gone-{i}.txt") for i in range(3)]
    texts = {f"gs://b/vit-{i}.txt": VIT_4E_TEXT for i in range(7)}
    with caplog.at_level(logging.INFO):
        conn, counts = _repair_meta(monkeypatch, rows, texts, dry_run=True)
    assert counts == {"read": 7, "cosmetic": 7, "without_text": 3, "no change": 7, "period unchanged": 7}
    listed = _messages(caplog)
    assert [m.split(":")[0] for m in listed] == [f"  [dry-run] cosmetic VIT vit-{i}" for i in range(5)] + [
        "  XYZ xyz-0",
        "  [dry-run] 2 more cosmetic rows not listed (readers see no difference)",
        _recap_header(True, 0, 0, 0).split(":")[0],
    ]
    assert "FileNotFoundError: 404 GET gs://b/gone-0.txt" in listed[5], "the first failure carries its cause"


# --- the report date reaches every extract_document_meta call -------------------------
#
# A period ending on or after the report date is not the document's own; NIC's
# 1H26 report reads as its half only with it (and as the year of its sales
# quota without it). The date is the report's or the stored row's, never one
# read from the text.


def _meta_reads(monkeypatch, module):
    """Record the (text, report_date) of every extract_document_meta call made
    through `module`, and still read the text with the real rule."""
    reads = []
    real = module.extract_document_meta

    def record(text, report_date=None):
        reads.append((text, report_date))
        return real(text, report_date)

    monkeypatch.setattr(module, "extract_document_meta", record)
    return reads


def test_the_extraction_reads_document_meta_with_the_report_date(monkeypatch):
    reads = _meta_reads(monkeypatch, extract)
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    nic = {**REPORT, "stock_code": "NIC", "url": "nic-1h", "date": "2026-08-26"}
    *_, meta, outcome = extract.process_report_text(nic, NIC_1H_TEXT, "m")
    assert outcome == "ok" and reads == [(NIC_1H_TEXT, dt.date(2026, 8, 26))]
    assert (meta["period_end"], meta["period_type"]) == ("2026-06-30", "half"), "not the quota's 2026-12-31"


def test_the_runner_reads_document_meta_with_the_date_of_the_document_it_read(monkeypatch):
    # The company's newest document cannot be downloaded; its fallback, lodged
    # on another day, is read: that day is the one that counts.
    def fetch(session, url, max_pages=8):
        return (None, extract.FETCH_FAILED) if url == "abc-fy" else (DOC_TEXT, extract.FETCH_OK)

    stored = _wire(monkeypatch, fetch)
    reads = _meta_reads(monkeypatch, extract)
    monkeypatch.setattr(extract, "extract_financial_data", lambda *a, **k: GROUNDED)
    monkeypatch.setattr(extract, "summarize_report", lambda *a, **k: GOOD_DIGEST)
    assert runner.process(_company_report(), "m", 8, False, write_meta=True) == "ok"
    assert reads == [(DOC_TEXT, dt.date(2026, 2, 20))] and [r["url"] for r in stored.rows] == ["abc-h1"]


@pytest.mark.parametrize("repair_echo, digest, outcome", [
    (False, {"digest": "Nickel lifted output.", "confidence": 0.9}, "ok_gcs"),  # --backfill-digests
    (True, {"digest": ""}, "echo_cleared"),  # --repair-echo-digests with no new digest
    (True, {"digest": "Nickel lifted output.", "confidence": 0.9}, "ok_gcs"),
])
def test_the_digest_paths_read_document_meta_with_the_stored_report_date(monkeypatch, repair_echo, digest, outcome):
    stored = _wire(monkeypatch, _fetch_ok)
    reads = _meta_reads(monkeypatch, runner)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: NIC_1H_TEXT)
    monkeypatch.setattr(extract, "summarize_report", lambda metrics, text, **k: digest)
    # select_digestless_reports' and select_echo_digest_reports' shape:
    # report_date::text.
    row = {**REPORT, "stock_code": "NIC", "url": "nic-1h", "date": "2026-08-26", "metrics": json.dumps(_echo_metrics()),
           "raw_text_gcs_url": "gs://b/nic.txt", **({"repair_echo": True} if repair_echo else {})}
    assert runner.process_digestless(row, "m", 8, False, write_meta=True) == outcome
    [saved] = stored.rows
    assert reads == [(NIC_1H_TEXT, dt.date(2026, 8, 26))]
    assert (saved["document_meta"]["period_end"], saved["document_meta"]["period_type"]) == ("2026-06-30", "half")


def test_a_digest_row_with_no_report_date_reads_document_meta_without_one(monkeypatch):
    stored = _wire(monkeypatch, _fetch_ok)
    reads = _meta_reads(monkeypatch, runner)
    monkeypatch.setattr(extract, "download_text_from_gcs", lambda uri: DOC_TEXT)
    monkeypatch.setattr(extract, "summarize_report", lambda metrics, text, **k: GOOD_DIGEST)
    row = {**REPORT, "date": None, "metrics": "{}", "raw_text_gcs_url": "gs://b/x.txt"}
    assert runner.process_digestless(row, "m", 8, False) == "ok_gcs"
    assert reads == [(DOC_TEXT, None)] and len(stored.rows) == 1


def test_the_document_meta_repair_reads_each_row_with_its_own_report_date(monkeypatch):
    rows, texts = _every_period_class()
    reads = _meta_reads(monkeypatch, runner)
    _, counts = _repair_meta(monkeypatch, rows, texts, dry_run=True)
    # Each row's text with that row's date: compared as dates alone, two rows
    # read with each other's dates would still match. (The reads run on
    # threads, so in any order; every text here is a different string.)
    assert sorted(reads) == sorted((texts[row["raw_text_gcs_url"]], row["report_date"]) for row in rows)
    assert counts["period unchanged"] == 2, "NIC's half, read with its report date, and VIG's year are as stored"


def _main_repair(monkeypatch, conn, texts, argv=(), column=True):
    for key in ("GEMINI_API_KEY", "LANGEXTRACT_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(runner, "open_selection_connection", lambda: conn)
    monkeypatch.setattr(extract, "document_meta_column_exists", lambda c: column)
    monkeypatch.setattr(extract, "fetch_text_from_gcs", _fetch_from(texts))
    for name in ("select_reports", "select_echo_digest_reports", "select_digestless_reports"):
        monkeypatch.setattr(runner, name, lambda *a, **k: pytest.fail("selected reports for extraction"))
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--repair-document-meta", *argv])
    runner.main()


def test_main_runs_the_document_meta_repair_without_a_model_key_and_selects_nothing_else(monkeypatch, caplog):
    # The default backend is openrouter: without the early branch, a run with
    # no OPENROUTER_API_KEY exits 1 before selecting anything.
    vit = _meta_row("VIT", "vit-4e", VIT_STORED, "gs://b/vit-4e.txt", VIT_REPORT_DATE, dt.date(2026, 6, 30),
                    dt.date(2026, 6, 30))
    conn = _SqlConn(rows=[vit, _entity_row("XYZ", "xyz-4e", "Xylo Limited", "gs://b/gone.txt")])
    with caplog.at_level(logging.INFO):
        _main_repair(monkeypatch, conn, {"gs://b/vit-4e.txt": VIT_4E_FULL_TEXT})
    (select, _), (update, params) = conn.statements
    assert "document_meta IS NOT NULL" in select and "raw_text_gcs_url IS NOT NULL" in select
    assert "? 'entity'" not in select and "? 'period_end'" not in select, "rows that state neither are read too"
    columns = select.split("FROM", 1)[0]
    assert "extracted_at" in columns and "document_meta::text" in columns, "the write guard needs both"
    assert "report_date" in columns, "the period is read with it"
    assert "company_name" in columns and 'LEFT JOIN "company-metadata"' in select, "the name every gate compares"
    assert "newest_flow_period_end" in columns and "latest_annual_period_end" in columns
    assert "FROM stock_fundamentals" in select, "the stock page's newest flow period, as the shorts store reads it"
    assert update.startswith("UPDATE financial_report_extractions") and params[:3] == (
        "Vitura Health Limited", "2026-06-30", "annual")
    assert conn.closed
    assert _messages(caplog)[0] == (
        "Document meta repair: 2 rows with document_meta and stored text, 2 of them state an entity and 1 a period "
        "(workers=4)"
    )
    # The recap, then the summary, end the log: the workflow's step summary
    # prints that block.
    assert _messages(caplog)[-4:] == [
        _recap_header(False, 1, 0, 0, changed=1),
        "  VIT 'Vitura Health' vit-4e: renamed 'Cortexa Pty Ltd' -> 'Vitura Health Limited'; entity check: now passes",
        "  VIT 'Vitura Health' vit-4e: period changed 2025-06-30 annual -> 2026-06-30 annual, report date 2026-08-26, "
        "newest flow period 2026-06-30; own-period check: becomes the newest period",
        _summary(False, 2, 1, 1, entity=(0, 0, 1, 0, 0), period=(0, 1, 0, 0), outcomes=(1, 0, 0), effects=(1, 0, 0)),
    ]


def test_main_fails_a_document_meta_repair_that_could_read_no_text(monkeypatch, caplog):
    conn = _SqlConn(rows=[_entity_row(), _entity_row("XYZ", "xyz-4e", "Xylo Limited", "gs://b/gone.txt")])
    with caplog.at_level(logging.INFO), pytest.raises(SystemExit) as exc:
        _main_repair(monkeypatch, conn, {}, argv=["--dry-run"])
    assert exc.value.code == 1
    assert len(conn.statements) == 1, "the selection only: nothing written"
    assert _messages(caplog)[-3:] == [
        _recap_header(True, 0, 0, 0),
        _summary(True, 2, 0, 2),
        "No row's stored text could be read (2 selected): nothing was read again and nothing was written",
    ]


def test_main_passes_a_document_meta_repair_that_selects_nothing(monkeypatch, caplog):
    # Exit 1 is for a run that could read none of its rows' texts; a run with
    # no row to read failed at nothing.
    conn = _SqlConn(rows=[])
    with caplog.at_level(logging.INFO):
        _main_repair(monkeypatch, conn, {})  # exit 0: no SystemExit
    assert len(conn.statements) == 1 and conn.closed, "the selection only"
    assert _messages(caplog) == [
        "Document meta repair: 0 rows with document_meta and stored text, 0 of them state an entity and 0 a period "
        "(workers=4)",
        _recap_header(False, 0, 0, 0),
        _summary(False, 0, 0, 0),
    ]


def test_main_without_the_document_meta_column_selects_and_writes_nothing(monkeypatch, caplog):
    conn = _SqlConn(rows=[_entity_row()])
    with caplog.at_level(logging.INFO):
        _main_repair(monkeypatch, conn, {"gs://b/vit.txt": VIT_4E_TEXT}, column=False)  # exit 0: no SystemExit
    assert conn.statements == [] and conn.closed
    assert _messages(caplog) == [
        "financial_report_extractions.document_meta is absent (migration 000132): nothing to repair"
    ]
