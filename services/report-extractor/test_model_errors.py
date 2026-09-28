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
company's other statutory document).

Pure tests use fakes at the function boundary and run everywhere; the tests
that drive the real langextract / google-genai stack skip without it.
"""
import json
import logging
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
    monkeypatch.setattr(runner, "select_reports", lambda conn, recent, limit: reports)
    by_url = {r["url"]: o for r, o in zip(reports, outcomes)}
    monkeypatch.setattr(runner, "process", lambda report, **kw: by_url[report["url"]])
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--workers", "1", *argv])
    runner.main()


def test_main_exits_non_zero_after_printing_the_counts_when_any_model_error_occurred(monkeypatch, caplog):
    with caplog.at_level(logging.INFO), pytest.raises(SystemExit) as exc:
        _main_with(monkeypatch, ["ok", "model_error", "no_metrics"])
    assert exc.value.code == 1
    messages = [r.getMessage() for r in caplog.records]
    done = next(i for i, m in enumerate(messages) if m.startswith("DONE"))
    assert "'model_error': 1" in messages[done]
    assert any("1 model errors" in m for m in messages[done:])


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
    def __init__(self):
        self.statements = []
        self.autocommit = True

    def cursor(self, *a, **k):
        conn = self

        class C:
            def execute(self, sql, params=None):
                conn.statements.append((sql, params))

            def fetchall(self):
                return []

            def close(self):
                pass

        return C()


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
