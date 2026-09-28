"""Targeting, ordering, the run budget and connection hygiene (contract 6.1).

Pure tests run everywhere. The Postgres tests run only when
REPORT_EXTRACTOR_TEST_DATABASE_URL points at a throwaway database (never a
pooler or Supabase DSN); each builds its own schema and drops it afterwards.
"""
import datetime as dt
import json
import os
import threading
import time
import uuid
from urllib.parse import quote

import pytest

from extractor_test_support import stub_missing_deps

stub_missing_deps()

import extract  # noqa: E402
import extract_reports_concurrent as runner  # noqa: E402

TODAY = dt.date(2026, 9, 28)


def _doc(code, url, date, title="Appendix 4E and Annual Report", rtype="annual_results"):
    return {"stock_code": code, "url": url, "title": title, "date": date, "type": rtype}


# --- ordering -----------------------------------------------------------------


def test_order_recent_first_then_unextracted_by_market_cap_then_rest():
    candidates = [
        _doc("OLD1", "old1", "2026-02-20"),  # extracted before, big
        _doc("NEW1", "new1", "2026-02-21"),  # never extracted, small
        _doc("NEW2", "new2", "2026-02-22"),  # never extracted, big
        _doc("REC1", "rec1", "2026-08-20"),  # within 45 days, older
        _doc("REC2", "rec2", "2026-09-20"),  # within 45 days, newest
        _doc("NOCAP", "nocap", "2026-02-23"),  # never extracted, no market cap
        _doc("OLD2", "old2", "2026-02-24"),  # extracted before, small
    ]
    caps = {"OLD1": 9e10, "NEW1": 1e8, "NEW2": 5e10, "REC1": 1e9, "REC2": 1e6, "OLD2": 2e8}
    ordered = extract.order_extraction_targets(
        candidates, extracted_urls=set(), metric_codes={"OLD1", "OLD2", "REC1"}, market_caps=caps, today=TODAY
    )
    assert [r["stock_code"] for r in ordered] == ["REC2", "REC1", "NEW2", "NEW1", "NOCAP", "OLD1", "OLD2"]


def test_forty_five_day_window_edges():
    candidates = [
        _doc("EDGE", "edge", (TODAY - dt.timedelta(days=45)).isoformat()),
        _doc("PAST", "past", (TODAY - dt.timedelta(days=46)).isoformat()),
        _doc("FUTR", "futr", (TODAY + dt.timedelta(days=30)).isoformat()),  # a bogus future date is not "recent"
        _doc("BAD", "bad", "not a date"),
    ]
    caps = {"PAST": 3.0, "FUTR": 2.0, "BAD": 1.0}
    ordered = extract.order_extraction_targets(candidates, set(), set(), caps, TODAY)
    assert [r["stock_code"] for r in ordered] == ["EDGE", "PAST", "FUTR", "BAD"]


def test_one_document_per_company_newest_unextracted_within_recent():
    candidates = [
        _doc("ABC", "abc-h1", "2026-02-20", "Appendix 4D and Half Year Report"),
        _doc("ABC", "abc-fy", "2026-08-20", "Appendix 4E and Annual Report"),
        _doc("ABC", "abc-old", "2025-08-20", "Appendix 4E"),
        # Same day: the Appendix 4E before the annual report.
        _doc("XYZ", "xyz-ar", "2026-08-25", "Annual Report 2026"),
        _doc("XYZ", "xyz-4e", "2026-08-25", "Appendix 4E"),
    ]
    ordered = extract.order_extraction_targets(candidates, set(), set(), {}, TODAY)
    assert [r["url"] for r in ordered] == ["xyz-4e", "abc-fy"]

    # The newest is done: the next newest within `recent`.
    ordered = extract.order_extraction_targets(candidates, {"abc-fy", "xyz-4e"}, set(), {}, TODAY)
    assert sorted(r["url"] for r in ordered) == ["abc-h1", "xyz-ar"]

    # Both of ABC's newest two are done: ABC is up to date; an older document
    # outside `recent` is not dug up.
    ordered = extract.order_extraction_targets(candidates, {"abc-fy", "abc-h1"}, set(), {}, TODAY, recent=2)
    assert [r["stock_code"] for r in ordered] == ["XYZ"]
    ordered = extract.order_extraction_targets(candidates, {"abc-fy", "abc-h1"}, set(), {}, TODAY, recent=0)
    assert {r["url"] for r in ordered} == {"xyz-4e", "abc-old"}


def test_parse_market_cap():
    assert extract.parse_market_cap(None, "123456789") == 123456789.0
    assert extract.parse_market_cap("2.5e9", "1") == 2.5e9
    assert extract.parse_market_cap("", "n/a", "0", "-5", "nan", "inf", None) is None
    assert extract.parse_market_cap("1,234") == 1234.0
    assert extract.parse_market_cap(True, 7) == 7.0


def test_top_shorted_first_is_gone():
    import inspect

    src = inspect.getsource(runner)
    assert "--top-shorted-first" not in src and "_apply_top_shorted_order" not in src
    assert not hasattr(runner, "_apply_top_shorted_order")
    assert runner.DEFAULT_BUDGET_MIN == 90


# --- the run budget -------------------------------------------------------------


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.lock = threading.Lock()

    def __call__(self):
        with self.lock:
            return self.now

    def advance(self, seconds):
        with self.lock:
            self.now += seconds


def test_budget_stops_submitting_and_reports_the_remainder():
    clock = FakeClock()
    seen = []

    def worker(item):
        seen.append(item)
        clock.advance(30)  # every report takes 30 "seconds"
        return "ok"

    counts, submitted = runner.run_with_budget(list(range(10)), worker, workers=1, budget_seconds=60, clock=clock)
    # t=0 start #0 -> t=30 start #1 -> t=60 budget reached: nothing new.
    assert submitted == 2 and seen == [0, 1]
    assert counts == {"ok": 2}


def test_in_flight_reports_finish_after_the_budget():
    clock = FakeClock()
    started_1 = threading.Event()
    release_1 = threading.Event()
    finished = []

    def worker(item):
        if item == 1:
            started_1.set()
            release_1.wait(5)
        else:
            started_1.wait(5)  # both in flight before the budget elapses
            clock.advance(100)
            release_1.set()
        finished.append(item)
        return "ok" if item else "slow"

    counts, submitted = runner.run_with_budget([0, 1, 2, 3], worker, workers=2, budget_seconds=60, clock=clock)
    assert submitted == 2
    assert sorted(finished) == [0, 1]
    assert counts == {"ok": 1, "slow": 1}


def test_budget_runner_counts_worker_errors_and_empty_input():
    def worker(item):
        if item == "boom":
            raise RuntimeError("x")
        return "ok"

    counts, submitted = runner.run_with_budget(["a", "boom", "b"], worker, workers=2, budget_seconds=3600)
    assert submitted == 3 and counts == {"ok": 2, "error": 1}
    assert runner.run_with_budget([], worker, workers=2, budget_seconds=1) == ({}, 0)


def test_timed_logs_and_forwards_usage(caplog):
    run_usage = runner.TokenUsage()

    def worker(report, usage):
        usage.add({"prompt_token_count": 10, "candidates_token_count": 2, "thoughts_token_count": 0})
        return "ok"

    with caplog.at_level("INFO"):
        assert runner.timed(worker, run_usage)({"stock_code": "WBT", "url": "u"}) == "ok"
    assert run_usage.total == 12
    assert any("report WBT u: ok in" in r.getMessage() for r in caplog.records)


# --- connection hygiene (fake connection, always runs) ---------------------------


class RecordingCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def execute(self, sql, params=None):
        # psycopg2 opens a transaction on the first statement unless autocommit.
        self.conn.log.append(("execute", self.conn.autocommit))
        if not self.conn.autocommit:
            self.conn.in_transaction = True
        self._rows = self.conn.results.pop(0) if self.conn.results else []

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass


class RecordingConn:
    def __init__(self, results, autocommit=True):
        self.autocommit = autocommit
        self.in_transaction = False
        self.results = list(results)
        self.log = []
        self.closed = False

    def cursor(self, *args, **kwargs):
        return RecordingCursor(self)

    def close(self):
        self.closed = True


def test_selection_runs_on_autocommit_and_leaves_no_transaction():
    reports = json.dumps([
        {"source": "asx_announcements", "type": "annual_results", "title": "Appendix 4E", "url": "u1", "date": "2026-09-01"},
    ])
    conn = RecordingConn(
        results=[
            [{"stock_code": "WBT", "financial_reports": reports, "km_market_cap": "1e9", "market_cap_text": None}],
            [("ABC",)],
            [],  # no URL extracted yet
        ]
    )
    got = extract.select_extraction_targets(conn, recent=2, limit=10, today=TODAY)
    assert [r["url"] for r in got] == ["u1"]
    assert conn.log and all(autocommit for _, autocommit in conn.log)
    assert conn.in_transaction is False


def test_the_runner_opens_an_autocommit_selection_connection(monkeypatch):
    opened = []

    def fake_get(autocommit=False):
        opened.append(autocommit)
        return RecordingConn([], autocommit=autocommit)

    monkeypatch.setattr(extract, "get_db_connection", fake_get)
    conn = runner.open_selection_connection()
    assert opened == [True] and conn.autocommit is True
    # Worker connections too.
    runner._tl.__dict__.pop("conn", None)
    assert runner._conn().autocommit is True


def test_the_run_refuses_to_start_without_a_gemini_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("LANGEXTRACT_API_KEY", "  ")
    monkeypatch.setattr(runner, "open_selection_connection", lambda: pytest.fail("must not select"))
    monkeypatch.setattr("sys.argv", ["extract_reports_concurrent.py", "--limit", "5"])
    with pytest.raises(SystemExit) as exc:
        runner.main()
    assert exc.value.code == 1
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert runner.gemini_key_present()


def test_process_touches_the_database_only_after_the_model(monkeypatch):
    events = []
    monkeypatch.setattr(extract, "download_pdf_text", lambda *a, **k: events.append("download") or "text " * 200)
    monkeypatch.setattr(
        extract, "process_report_text",
        lambda report, text, model, usage=None: events.append("model") or ({}, None, {"report_kind": "other"}, "no_metrics"),
    )
    monkeypatch.setattr(extract, "upload_raw_text_to_gcs", lambda *a, **k: None)

    class Conn:
        autocommit = True
        closed = False

    monkeypatch.setattr(runner, "_conn", lambda: events.append("connect") or Conn())
    stored = {}
    monkeypatch.setattr(extract, "store_extraction", lambda conn, report, metrics, n, dry, **kw: stored.update(kw))
    out = runner.process(_doc("WBT", "u", "2026-09-01"), "gemini-2.5-flash", 8, False, write_meta=True)
    assert out == "no_metrics"
    assert events == ["download", "model", "connect"]
    assert stored["write_document_meta"] is True and stored["document_meta"] == {"report_kind": "other"}


# --- real Postgres (env-gated) ----------------------------------------------------

PG_DSN = os.environ.get("REPORT_EXTRACTOR_TEST_DATABASE_URL", "")


def _refuse_shared(dsn):
    lowered = dsn.lower()
    if "pooler" in lowered or "supabase" in lowered or ":6543" in lowered:
        pytest.fail("REPORT_EXTRACTOR_TEST_DATABASE_URL must be a throwaway database, never a pooler/Supabase DSN")


@pytest.fixture
def pg_schema(monkeypatch):
    if not PG_DSN:
        pytest.skip("REPORT_EXTRACTOR_TEST_DATABASE_URL not set")
    _refuse_shared(PG_DSN)
    psycopg2 = pytest.importorskip("psycopg2")
    schema = "rx_" + uuid.uuid4().hex[:10]
    admin = psycopg2.connect(PG_DSN)
    admin.autocommit = True
    cur = admin.cursor()
    cur.execute(f'CREATE SCHEMA "{schema}"')
    sep = "&" if "?" in PG_DSN else "?"
    dsn = f"{PG_DSN}{sep}options={quote(f'-csearch_path={schema}')}"
    monkeypatch.setenv("DATABASE_URL", dsn)
    try:
        yield psycopg2, admin, schema
    finally:
        cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def _create_tables(admin, schema, with_meta):
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        CREATE TABLE "company-metadata" (
            stock_code VARCHAR(50) UNIQUE,
            financial_reports JSONB,
            key_metrics JSONB,
            market_cap BIGINT
        );
        CREATE TABLE financial_report_extractions (
            id SERIAL PRIMARY KEY,
            stock_code VARCHAR(50) NOT NULL,
            report_url TEXT NOT NULL UNIQUE,
            report_type VARCHAR(50),
            report_title TEXT,
            report_date DATE,
            metrics JSONB NOT NULL DEFAULT '{}',
            raw_text_length INTEGER,
            extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            digest TEXT,
            digest_confidence DOUBLE PRECISION,
            digest_model TEXT,
            raw_text_gcs_url TEXT
        );
        """
    )
    if with_meta:
        cur.execute("ALTER TABLE financial_report_extractions ADD COLUMN document_meta JSONB")
    reports = lambda *docs: json.dumps([  # noqa: E731
        {"source": "asx_announcements", "type": t, "title": title, "url": url, "date": date}
        for t, title, url, date in docs
    ])
    rows = [
        ("BHP", reports(("annual_results", "Appendix 4E and Annual Report", "bhp-fy26", "2026-08-19"),
                        ("annual_results", "FY26 Results Presentation", "bhp-pres", "2026-08-19")),
         json.dumps({"market_cap": 2.2e11}), None),
        ("CBA", reports(("half_year_results", "2026 Half Year Results Profit Announcement", "cba-h1", "2026-02-11")),
         None, 180000000000),
        ("ZZZ", reports(("annual_results", "Appendix 4E", "zzz-fy", "2026-02-27")), None, 5000000),
        ("DONE", reports(("annual_results", "Appendix 4E", "done-fy", "2026-02-27")), None, 7000000),
    ]
    cur.executemany(
        'INSERT INTO "company-metadata" (stock_code, financial_reports, key_metrics, market_cap) VALUES (%s, %s, %s, %s)',
        rows,
    )
    cur.execute(
        """
        INSERT INTO financial_report_extractions (stock_code, report_url, metrics)
        VALUES ('CBA', 'cba-old', '{"revenue": {"source_text": "x"}}'), ('DONE', 'done-fy', '{}')
        """
    )
    cur.close()


def _backend_state(admin, pid):
    cur = admin.cursor()
    cur.execute("SELECT state, backend_xid FROM pg_stat_activity WHERE pid = %s", (pid,))
    row = cur.fetchone()
    cur.close()
    return row


def test_pg_selection_leaves_the_connection_idle(pg_schema):
    psycopg2, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=True)

    conn = runner.open_selection_connection()
    try:
        assert extract.document_meta_column_exists(conn) is True
        got = runner.select_reports(conn, recent=2, limit=10)
        # The run date is the real today, so only the set is asserted here (the
        # tier order is pinned by the pure tests and the next test). DONE's
        # only document is extracted; BHP's presentation is not a results
        # document.
        assert {r["url"] for r in got} == {"bhp-fy26", "cba-h1", "zzz-fy"}
        assert conn.info.transaction_status == psycopg2.extensions.TRANSACTION_STATUS_IDLE
        state, xid = _backend_state(admin, conn.info.backend_pid)
        assert state == "idle" and xid is None
    finally:
        conn.close()

    # Control: the same selection on a default (non-autocommit) connection is
    # left "idle in transaction", which is what the autocommit prevents.
    raw = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        extract.select_extraction_targets(raw, recent=2, limit=10)
        assert raw.info.transaction_status == psycopg2.extensions.TRANSACTION_STATUS_INTRANS
        time.sleep(0.05)
        assert _backend_state(admin, raw.info.backend_pid)[0] == "idle in transaction"
    finally:
        raw.close()


def test_pg_order_uses_market_cap_from_either_column(pg_schema):
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=False)
    conn = runner.open_selection_connection()
    try:
        # A date past every document's 45-day window: tiers 2 and 3 only.
        got = extract.select_extraction_targets(conn, recent=2, limit=10, today=dt.date(2027, 6, 1))
    finally:
        conn.close()
    # BHP (key_metrics) and ZZZ have no metric-bearing extraction; CBA has one.
    assert [r["url"] for r in got] == ["bhp-fy26", "zzz-fy", "cba-h1"]


def test_pg_store_writes_document_meta_when_present(pg_schema):
    psycopg2, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=False)
    report = {"stock_code": "ZZZ", "url": "zzz-fy", "type": "annual_results", "title": "Appendix 4E", "date": "2026-02-27"}
    meta = {"report_kind": "appendix_4e", "period_end": "2025-12-31", "period_type": "annual"}

    conn = extract.get_db_connection(autocommit=True)
    try:
        assert extract.document_meta_column_exists(conn) is False
        extract.store_extraction(conn, report, {}, 10, document_meta=meta, write_document_meta=False)
        admin.cursor().execute(f'ALTER TABLE "{schema}".financial_report_extractions ADD COLUMN document_meta JSONB')
        assert extract.document_meta_column_exists(conn) is True
        extract.store_extraction(conn, report, {"x": {"source_text": "y"}}, 20, document_meta=meta, write_document_meta=True)
        assert conn.info.transaction_status == psycopg2.extensions.TRANSACTION_STATUS_IDLE
        cur = conn.cursor()
        cur.execute("SELECT document_meta, raw_text_length, report_date FROM financial_report_extractions WHERE report_url = 'zzz-fy'")
        stored, length, report_date = cur.fetchone()
        cur.close()
        assert stored == meta and length == 20 and report_date == dt.date(2026, 2, 27)
    finally:
        conn.close()

