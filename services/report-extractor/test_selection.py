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


def test_order_recent_first_then_newest_unextracted_by_market_cap_then_backfill():
    candidates = [
        _doc("OLD1", "old1", "2026-02-20"),  # metric extraction, big, newest unextracted
        _doc("NEW1", "new1", "2026-02-21"),  # no extraction, small
        _doc("NEW2", "new2", "2026-02-22"),  # no extraction, big
        _doc("REC1", "rec1", "2026-08-20"),  # within 45 days, older
        _doc("REC2", "rec2", "2026-09-20"),  # within 45 days, newest
        _doc("NOCAP", "nocap", "2026-02-23"),  # no extraction, no market cap
        _doc("OLD2", "old2", "2026-02-24"),  # metric extraction, small, newest unextracted
        # Company BACK1 with extracted newest, backfilling older
        _doc("BACK1", "back1-extracted", "2026-02-25"),  # extracted newest
        _doc("BACK1", "back1-older", "2026-02-15"),  # unextracted older
    ]
    caps = {"OLD1": 9e10, "NEW1": 1e8, "NEW2": 5e10, "REC1": 1e9, "REC2": 1e6, "OLD2": 2e8, "BACK1": 1e11}
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"back1-extracted"},  # BACK1's newest is extracted, so it's backfilling
        metric_codes={"OLD1", "OLD2", "REC1", "BACK1"},
        market_caps=caps,
        today=TODAY
    )
    # Tier 0: REC2, REC1 (within 45 days, newest first)
    # Tier 1: OLD1 (metric but newest unextracted, big), NEW2 (big), OLD2 (metric but newest unextracted, small), NEW1 (small), NOCAP
    # Tier 2: BACK1 (backfilling because newest is extracted)
    assert [r["stock_code"] for r in ordered] == ["REC2", "REC1", "OLD1", "NEW2", "OLD2", "NEW1", "NOCAP", "BACK1"]


def test_newest_unextracted_ahead_of_no_extraction_and_backfill():
    """A company with a metric-bearing extraction whose newest results document
    is unextracted and 60 days old sorts AHEAD of a smaller company with no
    extraction (both in tier 1, by market cap), and ahead of a larger company
    whose newest document is extracted and whose second-newest is being
    back-filled (tier 2)."""
    candidates = [
        # Company with prior extraction, newest unextracted, 60 days old, big cap
        _doc("CBA_EXTRACT", "cba-extract-new", "2026-07-30"),
        _doc("CBA_EXTRACT", "cba-extract-old", "2026-05-20"),
        # Smaller company with no prior extraction
        _doc("DEF_NEWCO", "def-new", "2026-08-01"),
        # Larger company whose newest IS extracted, backfilling second-newest
        _doc("GHI_BACKFILL", "ghi-backfill-newest", "2026-08-15"),
        _doc("GHI_BACKFILL", "ghi-backfill-second", "2026-07-20"),
    ]
    caps = {
        "CBA_EXTRACT": 9e10,  # big
        "DEF_NEWCO": 1e8,     # small
        "GHI_BACKFILL": 5e11,  # largest
    }
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"ghi-backfill-newest"},  # Newest for GHI is extracted
        metric_codes={"CBA_EXTRACT", "GHI_BACKFILL"},
        market_caps=caps,
        today=TODAY,
    )
    codes = [r["stock_code"] for r in ordered]
    # Tier 1: CBA (newest unextracted, big cap), DEF (small cap)
    # Tier 2: GHI (backfilling, largest cap)
    assert codes == ["CBA_EXTRACT", "DEF_NEWCO", "GHI_BACKFILL"]
    # Verify the chosen URLs
    assert [r["url"] for r in ordered] == ["cba-extract-new", "def-new", "ghi-backfill-second"]


def test_newest_extracted_stays_in_tier_2():
    """A company whose newest document is extracted and whose older document
    is unextracted stays in tier 2, behind a small never-extracted company."""
    candidates = [
        # Company with newest extracted, older unextracted
        _doc("ABC_BACKFILL", "abc-newest", "2026-08-20"),
        _doc("ABC_BACKFILL", "abc-older", "2026-07-15"),
        # Small never-extracted company (tier 1)
        _doc("XYZ_NEW", "xyz-new", "2026-08-05"),
    ]
    caps = {
        "ABC_BACKFILL": 9e10,  # Large
        "XYZ_NEW": 1e7,         # Small
    }
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"abc-newest"},  # ABC's newest is extracted
        metric_codes={"ABC_BACKFILL"},  # ABC has prior extraction
        market_caps=caps,
        today=TODAY,
    )
    codes_urls = [(r["stock_code"], r["url"]) for r in ordered]
    # XYZ is tier 1 (never extracted, small)
    # ABC is tier 2 (backfilling, newest extracted)
    assert codes_urls == [("XYZ_NEW", "xyz-new"), ("ABC_BACKFILL", "abc-older")]


def test_company_without_metrics_stays_in_tier_1_when_its_newest_was_attempted():
    """A company with no metric-bearing extraction is tier 1 even when its
    newest document already has a (metric-less) extraction row and an older
    one is chosen: Shorted still knows nothing usable about it."""
    candidates = [
        _doc("EMPTY", "empty-newest", "2026-07-01"),
        _doc("EMPTY", "empty-older", "2026-02-01"),
        _doc("BACK", "back-newest", "2026-07-02"),
        _doc("BACK", "back-older", "2026-02-02"),
    ]
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"empty-newest", "back-newest"},
        metric_codes={"BACK"},
        market_caps={"EMPTY": 1e7, "BACK": 9e10},
        today=TODAY,
    )
    assert [r["url"] for r in ordered] == ["empty-older", "back-older"]


def test_recent_documents_come_first():
    """Documents within 45 days still come first, newest first, whatever the
    tiers above."""
    candidates = [
        # Recent unextracted (tier 0)
        _doc("REC1", "rec1", (TODAY - dt.timedelta(days=30)).isoformat()),
        # Old unextracted with prior extraction (tier 1 in new logic)
        _doc("OLD1", "old1", (TODAY - dt.timedelta(days=60)).isoformat()),
        # Never extracted (tier 1)
        _doc("NEW1", "new1", (TODAY - dt.timedelta(days=50)).isoformat()),
    ]
    caps = {"REC1": 1e9, "OLD1": 1e10, "NEW1": 1e8}
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls=set(),
        metric_codes={"OLD1"},  # OLD1 has prior extraction
        market_caps=caps,
        today=TODAY,
    )
    assert [r["url"] for r in ordered] == ["rec1", "old1", "new1"]


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


# --- documents listed under several codes ---------------------------------------


def test_a_renamed_companys_document_belongs_to_the_code_still_priced():
    # Swift Networks (SW1) became Swift TV (STV). ASX lists Swift TV's results
    # under both codes, and only STV still has prices; SW1's stale market cap
    # is the larger.
    owners = extract.choose_document_owners(
        {"stv-fy26": {"SW1", "STV"}},
        last_price={"STV": dt.date(2026, 10, 9)},
        last_short={},
        market_caps={"SW1": 11641040, "STV": 10127916},
    )
    assert owners["stv-fy26"].code == "STV"
    assert owners["stv-fy26"].stale == frozenset({"SW1"})


def test_when_both_codes_are_priced_asics_short_report_decides():
    # Yahoo still serves Hillgrove's old ticker (HGO) with Kantra's prices
    # (KAN); ASIC's short report lists only the code that trades.
    def owner(hgo_tail):
        return extract.choose_document_owners(
            {"kan-h1": {"HGO", "KAN"}},
            last_price={"HGO": dt.date(2026, 10, 9), "KAN": dt.date(2026, 10, 9)},
            last_short={"HGO": dt.date(2026, 8, 31), "KAN": dt.date(2026, 10, 5)},
            market_caps={"HGO": 9e8, "KAN": 2e8},
            price_tails={"HGO": hgo_tail, "KAN": ("2026-10-09=1.1550", "2026-10-08=1.1800", "2026-10-07=1.1750")},
        )["kan-h1"]

    same = owner(("2026-10-09=1.1550", "2026-10-08=1.1800", "2026-10-07=1.1750"))
    assert same.code == "KAN" and same.stale == frozenset({"HGO"})
    # Different closes are two securities that both trade (two funds): KAN
    # still reads the document, but a row filed under HGO is not out of date.
    other = owner(("2026-10-09=84.3600", "2026-10-08=82.8100", "2026-10-07=82.6700"))
    assert other.code == "KAN" and other.stale == frozenset()


def test_without_current_prices_the_short_report_moves_rows():
    owners = extract.choose_document_owners(
        {"sww-fy26": {"OMT", "SWW"}},
        last_price={},
        last_short={"OMT": dt.date(2025, 11, 3), "SWW": dt.date(2026, 10, 5)},
        market_caps={"OMT": 9e7, "SWW": 2e7},
    )
    assert owners["sww-fy26"] == extract.DocumentOwner("SWW", frozenset({"OMT"}))


def test_listings_equally_current_go_to_the_largest_and_none_is_stale():
    # One report for several funds that all trade: read once, under the
    # largest, and a row already filed under another fund stays there.
    owners = extract.choose_document_owners(
        {"vanguard-ar": {"VAS", "VAP", "VHY"}},
        last_price={"VAS": dt.date(2026, 10, 9), "VAP": dt.date(2026, 10, 9), "VHY": dt.date(2026, 10, 8)},
        last_short={"VAS": dt.date(2026, 10, 5), "VAP": dt.date(2026, 9, 30), "VHY": dt.date(2026, 10, 2)},
        market_caps={"VAS": 2e10, "VAP": 2e9, "VHY": 4e9},
    )
    assert owners["vanguard-ar"].code == "VAS"
    assert owners["vanguard-ar"].stale == frozenset()


def test_a_price_a_week_old_is_still_current():
    # A suspension or a missed sync is not a rename: within
    # OWNER_PRICE_WINDOW_DAYS the listings tie on prices.
    def owner(bbb_last_price):
        return extract.choose_document_owners(
            {"u": {"AAA", "BBB"}},
            last_price={"AAA": dt.date(2026, 10, 9), "BBB": bbb_last_price},
            last_short={},
            market_caps={"AAA": 1e6, "BBB": 5e8},
        )["u"]

    assert extract.OWNER_PRICE_WINDOW_DAYS == 7
    tied = owner(dt.date(2026, 10, 2))
    assert tied.code == "BBB" and tied.stale == frozenset()
    behind = owner(dt.date(2026, 10, 1))
    assert behind.code == "AAA" and behind.stale == frozenset({"BBB"})


def test_listings_with_neither_signal_go_to_market_cap_then_code():
    owners = extract.choose_document_owners(
        {"u": {"ZZ1", "AA1", "MM1"}, "v": {"QQ1", "PP1"}},
        last_price={},
        last_short={},
        market_caps={"MM1": 3e6, "ZZ1": 3e6},
    )
    assert owners["u"].code == "MM1" and owners["u"].stale == frozenset()
    assert owners["v"].code == "PP1"


def test_a_document_listed_once_has_no_owner_entry():
    assert extract.choose_document_owners({"u": {"CBA"}}, {}, {}, {}) == {}


def test_a_shared_document_is_selected_once_under_its_owner():
    # In the 11 Oct 2026 run, 19 documents were read under 2-4 codes each. Each
    # listing's own documents still count: SW1's last own results stay its
    # candidate.
    candidates = [
        _doc("SW1", "stv-fy26", "2026-08-28", "Appendix 4E"),
        _doc("SW1", "sw1-fy24", "2024-08-30", "Appendix 4E"),
        _doc("STV", "stv-fy26", "2026-08-28", "Appendix 4E"),
        _doc("CBA", "cba-fy26", "2026-08-12", "2026 Full Year Results Profit Announcement"),
    ]
    owners = {"stv-fy26": extract.DocumentOwner("STV", frozenset({"SW1"}))}
    kept = extract.drop_copies_owned_elsewhere(candidates, owners)
    assert [(r["stock_code"], r["url"]) for r in kept] == [("SW1", "sw1-fy24"), ("STV", "stv-fy26"), ("CBA", "cba-fy26")]
    ordered = extract.order_extraction_targets(kept, set(), set(), {}, TODAY, recent=0)
    assert sorted((r["stock_code"], r["url"]) for r in ordered) == [
        ("CBA", "cba-fy26"), ("STV", "stv-fy26"), ("SW1", "sw1-fy24"),
    ]


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
    monkeypatch.setattr(
        extract, "fetch_pdf_text", lambda *a, **k: events.append("download") or ("text " * 200, extract.FETCH_OK)
    )
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


def _create_tables(admin, schema, with_meta=False, with_attempts=False):
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
    if with_attempts:
        cur.execute("ALTER TABLE financial_report_extractions ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 1")
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
    # BHP (key_metrics) and ZZZ have no metric-bearing extraction, and CBA's
    # newest document (cba-h1) is unread, so all three are tier 1, by market cap
    # from either column: BHP's key_metrics, then CBA's market_cap column.
    assert [r["url"] for r in got] == ["bhp-fy26", "cba-h1", "zzz-fy"]


def test_pg_an_unreadable_marker_moves_selection_to_the_next_document(pg_schema):
    # A scanned newest document gets a marker row: from then on the company's
    # next document is selected, and the digest backfill never re-reads it.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=True)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """UPDATE "company-metadata" SET financial_reports = %s WHERE stock_code = 'ZZZ'""",
        (json.dumps([
            {"source": "asx_announcements", "type": "annual_results", "title": "Appendix 4E",
             "url": "zzz-fy", "date": "2026-02-27"},
            {"source": "asx_announcements", "type": "half_year_results", "title": "Appendix 4D",
             "url": "zzz-h1", "date": "2025-08-27"},
        ]),),
    )
    cur.close()
    conn = runner.open_selection_connection()
    try:
        today = dt.date(2027, 6, 1)
        [zzz] = [r for r in extract.select_extraction_targets(conn, recent=2, limit=10, today=today) if r["stock_code"] == "ZZZ"]
        assert zzz["url"] == "zzz-fy" and [f["url"] for f in zzz["fallbacks"]] == ["zzz-h1"]

        extract.store_unreadable(conn, zzz, 7)
        [zzz] = [r for r in extract.select_extraction_targets(conn, recent=2, limit=10, today=today) if r["stock_code"] == "ZZZ"]
        assert zzz["url"] == "zzz-h1" and zzz["fallbacks"] == []

        cur = conn.cursor()
        cur.execute(
            "SELECT metrics, raw_text_length, digest, document_meta FROM financial_report_extractions"
            " WHERE report_url = 'zzz-fy'"
        )
        assert cur.fetchone() == ({}, 7, None, None)
        cur.close()
        # DONE's legacy '{}' row (raw_text_length NULL) is still backfilled; the marker is not.
        assert {r["url"] for r in runner.select_digestless_reports(conn, limit=10)} == {"cba-old", "done-fy"}
    finally:
        conn.close()


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


# --- empty retry ordering -------------------------------------------------------


def test_an_empty_extraction_due_a_retry_comes_after_every_first_attempt():
    """Empty extractions (EMPTY_RETRY_LIMIT=2, EMPTY_RETRY_MIN_DAYS=7) count as
    unextracted but rank after every first attempt in every tier, and in tier
    order among themselves. Two docs per company: the newest candidate and the
    oldest."""
    candidates = [
        # RET0: filed within 45 days, an empty extraction due a retry
        _doc("RET0", "ret0", "2026-09-20"),
        # NEW0: filed within 45 days but OLDER than RET0, never read
        _doc("NEW0", "new0", "2026-08-20"),
        # RET1: newest is an empty extraction due a retry, older never read; has metrics
        _doc("RET1", "ret1-new", "2026-02-26"),
        _doc("RET1", "ret1-old", "2025-08-26"),
        # NEW1: never read, no metrics, smaller market cap than RET1
        _doc("NEW1", "new1", "2026-02-20"),
        # BACK2: two docs, newest extracted, older unextracted; has metrics; biggest cap
        _doc("BACK2", "back2-new", "2026-02-25"),
        _doc("BACK2", "back2-old", "2025-08-25"),
    ]
    caps = {
        "RET0": 1e9, "NEW0": 1e9, "RET1": 5e10, "NEW1": 2e8, "BACK2": 1e11
    }
    # A retry has a row, so its URL is in extracted_urls as well as retry_urls.
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"ret0", "ret1-new", "back2-new"},
        metric_codes={"RET1", "BACK2"},
        market_caps=caps,
        today=TODAY,
        retry_urls={"ret0", "ret1-new"},
    )
    codes = [r["stock_code"] for r in ordered]
    # First attempts in tier order: NEW0 (filed within 45 days), NEW1 (no
    # metrics), BACK2 back-filling its older document. NEW1 is CBA on 11 Oct
    # 2026, its full year unread and 121 retries of recent filings due. Then the
    # retries, in tier order: RET0 before RET1, though RET1 is bigger.
    assert codes == ["NEW0", "NEW1", "BACK2", "RET0", "RET1"]
    assert [r.get("empty_retry") for r in ordered] == [None, None, None, True, True]
    assert ordered[2]["url"] == "back2-old"
    assert ordered[4]["url"] == "ret1-new"
    assert [(f["url"], f.get("empty_retry")) for f in ordered[4]["fallbacks"]] == [("ret1-old", None)]


def test_an_empty_extraction_not_due_stays_done():
    """An extracted document whose URL is NOT in retry_urls (not due for
    another attempt, or is unreadable) stays extracted; its older unextracted
    fallback is chosen."""
    candidates = [
        _doc("DONE", "done-new", "2026-02-25"),
        _doc("DONE", "done-old", "2025-08-25"),
    ]
    caps = {"DONE": 1e10}
    ordered = extract.order_extraction_targets(
        candidates,
        extracted_urls={"done-new"},
        metric_codes={"DONE"},
        market_caps=caps,
        today=TODAY,
        retry_urls=set(),  # done-new is not retryable
    )
    assert len(ordered) == 1
    assert ordered[0]["url"] == "done-old"
    assert ordered[0].get("empty_retry") is None


def test_a_retry_reads_more_pages_and_its_fallback_the_usual_budget():
    """read_first_available uses max(max_pages, EMPTY_RETRY_MAX_PAGES) for a
    retryable document, EMPTY_RETRY_MAX_PAGES >= DEFAULT_MAX_PAGES. Its fallback uses the usual budget."""
    import unittest.mock
    
    # Fake session and record_unreadable callback
    session = None
    record_unreadable_calls = []
    def record_unreadable(doc, text_length):
        record_unreadable_calls.append((doc, text_length))
    
    # Mock fetch_pdf_text to record (url, max_pages) and fail on "a", succeed on "b"
    fetch_calls = []
    def mock_fetch(session, url, max_pages):
        fetch_calls.append((url, max_pages))
        if url == "a":
            return (None, extract.FETCH_FAILED)
        return ("x" * 500, extract.FETCH_OK)
    
    report = {
        "stock_code": "X", "url": "a", "empty_retry": True,
        "fallbacks": [{"stock_code": "X", "url": "b"}]
    }
    
    with unittest.mock.patch("extract.fetch_pdf_text", side_effect=mock_fetch):
        doc, text, status = extract.read_first_available(session, report, extract.DEFAULT_MAX_PAGES, record_unreadable)
    
    # Verify the calls
    assert fetch_calls == [
        ("a", max(extract.DEFAULT_MAX_PAGES, extract.EMPTY_RETRY_MAX_PAGES)),
        ("b", extract.DEFAULT_MAX_PAGES),
    ]
    assert doc["url"] == "b"
    assert text == "x" * 500
    assert status == extract.FETCH_OK


def test_store_counts_an_attempt_only_when_asked():
    """store_extraction with count_attempt=True increments extraction_attempts;
    with count_attempt=False it does not mention the column."""
    import unittest.mock
    
    conn = unittest.mock.MagicMock()
    cur = unittest.mock.MagicMock()
    conn.cursor.return_value = cur
    conn.autocommit = True
    
    report = {"stock_code": "ZZZ", "url": "zzz-url", "type": "annual_results", "title": "Report", "date": "2026-02-27"}
    
    # Call with count_attempt=True
    extract.store_extraction(conn, report, {}, 100, count_attempt=True)
    call_true = cur.execute.call_args[0][0]
    assert "extraction_attempts = financial_report_extractions.extraction_attempts + 1" in call_true
    
    # Reset mock
    cur.reset_mock()
    
    # Call with count_attempt=False (default)
    extract.store_extraction(conn, report, {}, 100, count_attempt=False)
    call_false = cur.execute.call_args[0][0]
    assert "extraction_attempts" not in call_false

    cur.reset_mock()
    extract.store_unreadable(conn, report, 40, count_attempt=True)
    assert "extraction_attempts = financial_report_extractions.extraction_attempts + 1" in cur.execute.call_args[0][0]


def test_empty_retry_budget_is_deliberate():
    """The empty retry constants have expected values."""
    assert extract.EMPTY_RETRY_LIMIT == 2
    assert extract.EMPTY_RETRY_MIN_DAYS == 7
    assert extract.EMPTY_RETRY_MAX_PAGES == 24
    assert extract.EMPTY_RETRY_MAX_PAGES > extract.DEFAULT_MAX_PAGES
    # The API's latest-filing gate (services/shorts/internal/services/shorts/
    # latest_filing.go latestFilingMinConfidence), the only reader of a row
    # with no metrics; the review job pins the same number.
    assert extract.USABLE_DIGEST_MIN_CONFIDENCE == 0.6


def _add_company(admin, schema, code, docs, market_cap=None):
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        'INSERT INTO "company-metadata" (stock_code, financial_reports, market_cap) VALUES (%s, %s, %s)',
        (code, json.dumps([
            {"source": "asx_announcements", "type": t, "title": title, "url": url, "date": date}
            for t, title, url, date in docs
        ]), market_cap),
    )
    cur.close()


DRO_H1 = [("half_year_results", "Appendix 4D and Half Year Report", "dro-h1", "2026-08-26")]


def _dro_targets():
    conn = runner.open_selection_connection()
    try:
        return [r for r in extract.select_extraction_targets(conn, recent=2, limit=0, today=TODAY) if r["stock_code"] == "DRO"]
    finally:
        conn.close()


def test_pg_extraction_attempts_probe_reads_the_catalog(pg_schema):
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_attempts=False)
    conn = extract.get_db_connection(autocommit=True)
    try:
        assert extract.extraction_attempts_column_exists(conn) is False
        admin.cursor().execute(
            f'ALTER TABLE "{schema}".financial_report_extractions ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 1'
        )
        assert extract.extraction_attempts_column_exists(conn) is True
    finally:
        conn.close()


def test_pg_an_empty_extraction_is_read_again_after_seven_days(pg_schema):
    # DroneShield's half-year: read once, nothing kept. It is offered again a
    # week after each attempt while it has had at most EMPTY_RETRY_LIMIT; an
    # unreadable marker never is. Storing it again counts one more attempt.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_attempts=True)
    _add_company(admin, schema, "DRO", DRO_H1, 2_000_000_000)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        INSERT INTO financial_report_extractions (stock_code, report_url, metrics, raw_text_length, extracted_at)
        VALUES ('DRO', 'dro-h1', '{}', 9997, now() - interval '8 days')
        """
    )
    [doc] = _dro_targets()
    assert doc["url"] == "dro-h1" and doc["empty_retry"] is True

    cur.execute("UPDATE financial_report_extractions SET extraction_attempts = 3 WHERE report_url = 'dro-h1'")
    assert _dro_targets() == []  # both retries used
    cur.execute(
        "UPDATE financial_report_extractions SET extraction_attempts = 2, extracted_at = now() - interval '1 day' "
        "WHERE report_url = 'dro-h1'"
    )
    assert _dro_targets() == []  # tried yesterday
    cur.execute(
        "UPDATE financial_report_extractions SET extracted_at = now() - interval '8 days', raw_text_length = 40 "
        "WHERE report_url = 'dro-h1'"
    )
    assert _dro_targets() == []  # an unreadable marker
    cur.execute("UPDATE financial_report_extractions SET raw_text_length = 9997 WHERE report_url = 'dro-h1'")
    [doc] = _dro_targets()  # attempt 2 of 3, a week on

    # With no metrics, only the latest-filing summary reads the row, and only
    # a digest at or above its 0.6 gate: anything less (or no confidence at all)
    # is no digest, and the row is read again.
    for confidence, retried in (("0.2", True), ("0.5", True), ("NULL", True), ("0.6", False)):
        cur.execute(
            f"UPDATE financial_report_extractions SET digest = 'A thin summary.', digest_confidence = {confidence} "
            "WHERE report_url = 'dro-h1'"
        )
        assert bool(_dro_targets()) is retried, confidence
    cur.execute("UPDATE financial_report_extractions SET digest = NULL, digest_confidence = NULL WHERE report_url = 'dro-h1'")
    [doc] = _dro_targets()

    conn = extract.get_db_connection(autocommit=True)
    try:
        extract.store_extraction(conn, doc, {}, 9997, count_attempt=True)
    finally:
        conn.close()
    cur.execute("SELECT extraction_attempts FROM financial_report_extractions WHERE report_url = 'dro-h1'")
    assert cur.fetchone()[0] == 3
    cur.close()


def test_pg_without_the_attempts_column_nothing_is_retried(pg_schema):
    # Before migration 000136 an empty extraction stays done, as it always was.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_attempts=False)
    _add_company(admin, schema, "DRO", DRO_H1, 2_000_000_000)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        INSERT INTO financial_report_extractions (stock_code, report_url, metrics, raw_text_length, extracted_at)
        VALUES ('DRO', 'dro-h1', '{}', 9997, now() - interval '8 days')
        """
    )
    cur.close()
    assert _dro_targets() == []


def _add_listing_tables(admin, schema, prices=(), shorts=()):
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        CREATE TABLE stock_prices (stock_code VARCHAR(10) NOT NULL, date DATE NOT NULL, close NUMERIC(12,4));
        CREATE TABLE shorts ("DATE" TIMESTAMP NOT NULL, "PRODUCT_CODE" TEXT NOT NULL);
        """
    )
    cur.executemany(
        "INSERT INTO stock_prices (stock_code, date, close) VALUES (%s, %s, %s)",
        [p if len(p) == 3 else (*p, 1) for p in prices],
    )
    cur.executemany('INSERT INTO shorts ("DATE", "PRODUCT_CODE") VALUES (%s, %s)', [(d, c) for c, d in shorts])
    cur.close()


SWIFT_TV = [
    ("annual_results", "Appendix 4E", "stv-fy26", "2026-08-28"),
    ("annual_results", "Appendix 4E", "stv-fy25", "2025-08-29"),
]


def test_pg_a_renamed_companys_results_move_to_its_current_code_and_are_read_once(pg_schema):
    # Swift TV's FY25 results were read under SW1, its code before the rename,
    # and stayed there. Its FY26 results, listed under both codes, are unread.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_attempts=True)
    _add_listing_tables(admin, schema, prices=[("SW1", "2025-12-01"), ("STV", "2026-10-09")])
    _add_company(admin, schema, "SW1", SWIFT_TV, 11641040)
    _add_company(admin, schema, "STV", SWIFT_TV, 10127916)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        INSERT INTO financial_report_extractions (stock_code, report_url, metrics)
        VALUES ('SW1', 'stv-fy25', '{"revenue": {"source_text": "x"}}')
        """
    )
    conn = runner.open_selection_connection()
    try:
        assert extract.rehome_shared_extractions(conn, dry_run=True) == [("stv-fy25", "SW1", "STV")]
        cur.execute("SELECT stock_code FROM financial_report_extractions WHERE report_url = 'stv-fy25'")
        assert cur.fetchone()[0] == "SW1"  # a dry run moves nothing
        got = runner.select_reports(conn, recent=2, limit=10)
    finally:
        conn.close()
    cur.execute("SELECT stock_code FROM financial_report_extractions WHERE report_url = 'stv-fy25'")
    assert cur.fetchone()[0] == "STV"
    # The FY26 results are selected once, under STV; SW1 lists nothing else.
    assert [(r["stock_code"], r["url"]) for r in got if r["stock_code"] in ("SW1", "STV")] == [("STV", "stv-fy26")]
    cur.close()


def test_pg_the_short_report_moves_one_security_under_two_codes_but_not_a_fund(pg_schema):
    # HGO and KAN close alike (one security); VAP and VAS do not (two funds),
    # though VAP has not been on ASIC's report since May.
    _, admin, schema = pg_schema
    _create_tables(admin, schema)
    sessions = ("2026-10-07", "2026-10-08", "2026-10-09")
    _add_listing_tables(
        admin, schema,
        prices=[(code, d, close) for code in ("HGO", "KAN") for d, close in zip(sessions, (1.175, 1.18, 1.155))]
        + [("VAS", d, 107.92) for d in sessions] + [("VAP", d, 84.36) for d in sessions],
        shorts=[("HGO", "2026-08-31 00:00"), ("KAN", "2026-10-05 00:00"), ("VAS", "2026-09-24 00:00"), ("VAP", "2026-05-15 00:00")],
    )
    kantra = [("half_year_results", "Results for Half Year Ended 30 June 2025", "kan-h1", "2025-09-12")]
    vanguard = [("annual_results", "Annual Report", "vanguard-ar", "2025-09-20")]
    _add_company(admin, schema, "HGO", kantra, 900000000)
    _add_company(admin, schema, "KAN", kantra, 200000000)
    _add_company(admin, schema, "VAS", vanguard, 20000000000)
    _add_company(admin, schema, "VAP", vanguard, 2000000000)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        INSERT INTO financial_report_extractions (stock_code, report_url, metrics)
        VALUES ('HGO', 'kan-h1', '{}'), ('VAP', 'vanguard-ar', '{}')
        """
    )
    conn = runner.open_selection_connection()
    try:
        assert extract.rehome_shared_extractions(conn) == [("kan-h1", "HGO", "KAN")]
    finally:
        conn.close()
    cur.execute("SELECT report_url, stock_code FROM financial_report_extractions WHERE report_url IN ('kan-h1', 'vanguard-ar') ORDER BY 1")
    assert cur.fetchall() == [("kan-h1", "KAN"), ("vanguard-ar", "VAP")]
    cur.close()


def test_pg_a_session_without_a_close_is_not_a_price(pg_schema):
    # stock_prices.close is nullable on prod. A row with no close must neither
    # stop selection nor make an old code look priced.
    _, admin, schema = pg_schema
    _create_tables(admin, schema)
    _add_listing_tables(
        admin, schema,
        prices=[("SW1", "2025-12-01"), ("SW1", "2026-10-09", None), ("STV", "2026-10-08"), ("STV", "2026-10-09")],
    )
    _add_company(admin, schema, "SW1", SWIFT_TV, 11641040)
    _add_company(admin, schema, "STV", SWIFT_TV, 10127916)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute("INSERT INTO financial_report_extractions (stock_code, report_url, metrics) VALUES ('SW1', 'stv-fy25', '{}')")
    conn = runner.open_selection_connection()
    try:
        assert extract.rehome_shared_extractions(conn, dry_run=True) == [("stv-fy25", "SW1", "STV")]
    finally:
        conn.close()
    cur.close()


def test_pg_without_the_price_tables_a_shared_document_is_still_read_once(pg_schema):
    # A schema without stock_prices or shorts (a test or dev database): market
    # cap decides, and no row moves.
    _, admin, schema = pg_schema
    _create_tables(admin, schema)
    _add_company(admin, schema, "SW1", SWIFT_TV, 11641040)
    _add_company(admin, schema, "STV", SWIFT_TV, 10127916)
    conn = runner.open_selection_connection()
    try:
        assert extract.rehome_shared_extractions(conn) == []
        got = extract.select_extraction_targets(conn, recent=2, limit=0, today=TODAY)
    finally:
        conn.close()
    assert [(r["stock_code"], r["url"]) for r in got if r["stock_code"] in ("SW1", "STV")] == [("SW1", "stv-fy26")]


# What the stored texts read as with the current rule and each row's report
# date (test_model_errors.py pins it, with the documents' own lines, and the
# stored values: ALK's "ACN 000 689 216 |" reads as no entity).
VIT_4E_TEXT = "Name of entity: Vitura Health Limited\nASX Appendix 4E\nResults for announcement to the Market\n"
NO_ENTITY_TEXT = "ASX Appendix 4E\nResults for announcement to the Market\n"
# VIT's own FY26 Appendix 4E (idsId=03130179): stored with the prior year's
# period, read from its dividend line ahead of the reporting-period statement.
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
# GRR's 1H26 Appendix 4D (idsId=03133655), stored with no period.
GRR_4D_TEXT = (
    "Appendix 4D \n \nHalf year report \n \nName of entity \nGRANGE RESOURCES LIMITED \n \nABN \n80 009 132 405 \n"
    "The interim financial report for the six-month period ended 30 June 2026 has been prepared in accordance with \n"
)
# NHC's FY26 Appendix 4E (idsId=03139480) was stored with its comparative year;
# this line alone states no period of its own (the whole 4E's "Current period"
# range now reads as 2026-07-31).
NHC_4E_TEXT = ("1.\tPercentage movements relate to the previous comparative period being the full year ended "
               "31 July 2025. Highlights reflect 80 per cent interest  \n")
# The stored objects, as prod stores them (2026-10-13).
VIT_STORED = {"entity": "Cortexa Pty Ltd", "period_end": "2025-06-30", "period_type": "annual",
              "report_kind": "appendix_4e"}
GRR_STORED = {"units": "thousands", "entity": "GRANGE RESOURCES LIMITED", "report_kind": "appendix_4d",
              "units_evidence": "$’000"}
NHC_STORED = {"abn": "38 010 653 844", "units": "thousands", "period_end": "2025-07-31", "period_type": "annual",
              "report_kind": "appendix_4e", "units_evidence": "$000"}


def _add_fundamentals(admin, schema, rows):
    """stock_fundamentals with the columns latestFilingContextQuery reads:
    (code, period_end, period_type, revenue, net_income)."""
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute(
        """
        CREATE TABLE stock_fundamentals (
            stock_code TEXT NOT NULL,
            period_end DATE NOT NULL,
            period_type TEXT NOT NULL,
            revenue NUMERIC, net_income NUMERIC, eps_basic NUMERIC, eps_diluted NUMERIC,
            operating_cash_flow NUMERIC, free_cash_flow NUMERIC
        )
        """
    )
    cur.executemany(
        "INSERT INTO stock_fundamentals (stock_code, period_end, period_type, revenue, net_income)"
        " VALUES (%s, %s, %s, %s, %s)",
        rows,
    )
    cur.close()


def test_pg_document_meta_repair_rewrites_only_the_entity_and_period_keys(pg_schema, monkeypatch):
    # --repair-document-meta's statements on real Postgres: every write edits
    # the entity and period keys alone (every other key, and extracted_at, as
    # stored); a name readers check, or a period, that the text no longer
    # yields is kept; a row that stated none gets one; and a row a concurrent
    # run rewrote after it was read is left alone, whether that run changed the
    # entity, another key, the whole object (to NULL) or only extracted_at, or
    # added an entity. Each row carries the name the entity gates compare
    # ("company-metadata".company_name, None for a code with no row there) and
    # the code's newest flow and latest annual period ends, read as the shorts
    # store reads them, which the own-period check's effect is judged against.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=True)
    _add_fundamentals(admin, schema, [
        ("VIT", "2026-06-30", "annual", 131.2, -4.4), ("VIT", "2026-06-30", "ttm", 131.2, -4.4),
        ("VIT", "2025-06-30", "annual", 124.0, 3.3),
        ("VIT", "2026-09-30", "quarter", 33.0, None),  # a balance snapshot: not a flow period
        ("VIT", "2026-12-31", "half", None, None), ("VIT", "2025-12-31", "ttm", None, None),  # no flow figure
        ("GRR", "2026-06-30", "half", 290.1, None), ("GRR", "2025-12-31", "annual", 560.4, 80.2),
        ("NHC", "2026-07-31", "annual", None, 362.0),
    ])
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.execute('ALTER TABLE "company-metadata" ADD COLUMN company_name TEXT')
    cur.executemany(
        'INSERT INTO "company-metadata" (stock_code, company_name) VALUES (%s, %s)',
        [("VIT", "Vitura Health"), ("VHL", "Vitura Health"), ("ALK", "Alkane Resources"), ("ABC", "Abc Holdings"),
         ("GRR", "Grange Resources Limited."), ("NHC", "New Hope")],
    )
    key = {"entity": "Vitura Health Limited", "period_end": "2025-06-30", "period_type": "annual",
           "report_kind": "appendix_4e"}
    extracted_at = dt.datetime(2026, 10, 12, 14, 20, 5, 485322, tzinfo=dt.timezone.utc)
    rows = [
        ("NHC", "nhc-4e", "2026-09-15", NHC_STORED, "gs://b/nhc.txt"),  # period kept
        ("GRR", "grr-4d", "2026-08-31", GRR_STORED, "gs://b/grr.txt"),  # period added
        ("KEY", "key-4e", "2026-08-30", key, "gs://b/vit-4e.txt"),  # left alone: another key rewritten
        ("NLL", "nll-4e", "2026-08-29", VIT_STORED, "gs://b/vit-4e.txt"),  # left alone: set to NULL
        ("VHL", "vhl-4e", "2026-08-27", {"entity": "Vitura Health Limited |", "units": "thousands"},
         "gs://b/vit.txt"),  # cosmetic
        ("VIT", "vit-4e", "2026-08-26", VIT_STORED, "gs://b/vit-4e.txt"),  # renamed, period changed
        ("UNC", "unc-4e", "2026-08-25", {"entity": "Vitura Health Limited"}, "gs://b/vit.txt"),  # unchanged
        ("RAC", "rac-4e", "2026-08-24", {"entity": "Cortexa Pty Ltd"}, "gs://b/vit.txt"),  # left alone
        ("SAM", "sam-4e", "2026-08-23", {"entity": "Cortexa Pty Ltd"}, "gs://b/vit.txt"),  # left alone
        ("NOE", "noe-4e", "2026-08-22", {"report_kind": "appendix_4e"}, "gs://b/vit.txt"),  # added
        ("NOX", "nox-4e", "2026-08-21", {"report_kind": "appendix_4e"}, "gs://b/vit.txt"),  # left alone
        ("ALK", "alk-4e", "2026-08-20", {"entity": "ACN 000 689 216 |", "period_type": "annual"},
         "gs://b/none.txt"),  # cosmetic: the value goes
        ("ABC", "abc-4d", "2026-02-20", {"entity": "Old Name Ltd", "abn": "49 004 028 077"},
         "gs://b/none.txt"),  # kept
        ("NOT", "not-4e", "2026-08-02", {"entity": "No Text Ltd"}, None),  # no stored text: not selected
        ("NUL", "nul-4e", "2026-08-01", None, "gs://b/vit.txt"),  # no document_meta: not selected
        ("JSN", "jsn-4e", "2026-07-31", "null", "gs://b/vit.txt"),  # JSON null, not an object: not selected
    ]
    cur.executemany(
        "INSERT INTO financial_report_extractions"
        " (stock_code, report_url, report_date, metrics, document_meta, raw_text_gcs_url, extracted_at)"
        " VALUES (%s, %s, %s, '{}', %s, %s, %s)",
        [(code, url, date, meta if meta is None or isinstance(meta, str) else json.dumps(meta), gcs, extracted_at)
         for code, url, date, meta, gcs in rows],
    )
    texts = {"gs://b/vit.txt": VIT_4E_TEXT, "gs://b/none.txt": NO_ENTITY_TEXT, "gs://b/vit-4e.txt": VIT_4E_FULL_TEXT,
             "gs://b/grr.txt": GRR_4D_TEXT, "gs://b/nhc.txt": NHC_4E_TEXT}
    monkeypatch.setattr(extract, "fetch_text_from_gcs", lambda uri: texts[uri])

    d = dt.date.fromisoformat
    conn = runner.open_selection_connection()
    try:
        selected = runner.select_document_meta_rows(conn)
        # Newest first, with or without an entity, a period or a company row;
        # no stored text or no document_meta: not read. The newest flow period
        # skips a quarter and the rows with no flow figure, a later half among
        # them.
        assert [
            (r["report_url"], r["entity"], r["period_end"], r["company_name"], r["newest_flow_period_end"],
             r["latest_annual_period_end"])
            for r in selected
        ] == [
            ("nhc-4e", None, "2025-07-31", "New Hope", d("2026-07-31"), d("2026-07-31")),
            ("grr-4d", "GRANGE RESOURCES LIMITED", None, "Grange Resources Limited.", d("2026-06-30"),
             d("2025-12-31")),
            ("key-4e", "Vitura Health Limited", "2025-06-30", None, None, None),
            ("nll-4e", "Cortexa Pty Ltd", "2025-06-30", None, None, None),
            ("vhl-4e", "Vitura Health Limited |", None, "Vitura Health", None, None),
            ("vit-4e", "Cortexa Pty Ltd", "2025-06-30", "Vitura Health", d("2026-06-30"), d("2026-06-30")),
            ("unc-4e", "Vitura Health Limited", None, None, None, None),
            ("rac-4e", "Cortexa Pty Ltd", None, None, None, None),
            ("sam-4e", "Cortexa Pty Ltd", None, None, None, None),
            ("noe-4e", None, None, None, None, None),
            ("nox-4e", None, None, None, None, None),
            ("alk-4e", "ACN 000 689 216 |", None, "Alkane Resources", None, None),
            ("abc-4d", "Old Name Ltd", None, "Abc Holdings", None, None),
        ]
        assert {r["extracted_at"] for r in selected} == {extracted_at}
        assert {r["report_url"]: r["report_date"] for r in selected}["vit-4e"] == d("2026-08-26")
        assert json.loads({r["report_url"]: r["document_meta"] for r in selected}["vit-4e"]) == VIT_STORED
        # Concurrent runs, after the rows were read: RAC's entity changes; SAM
        # is stored again with the same entity (an EMPTY retry); NOX gets an
        # entity without a new extracted_at; KEY's other key changes; NLL's
        # document_meta is cleared.
        cur.execute("""UPDATE financial_report_extractions SET document_meta = '{"entity": "Racing Ltd"}'"""
                    " WHERE report_url = 'rac-4e'")
        cur.execute("UPDATE financial_report_extractions SET extracted_at = extracted_at + interval '1 hour'"
                    " WHERE report_url = 'sam-4e'")
        cur.execute("""UPDATE financial_report_extractions SET document_meta = document_meta || '{"entity": "Other Ltd"}'"""
                    " WHERE report_url = 'nox-4e'")
        cur.execute("""UPDATE financial_report_extractions SET document_meta = document_meta || '{"report_kind": "annual_report"}'"""
                    " WHERE report_url = 'key-4e'")
        cur.execute("UPDATE financial_report_extractions SET document_meta = NULL WHERE report_url = 'nll-4e'")
        counts = runner.repair_document_meta(conn, selected, workers=2, dry_run=False)
    finally:
        conn.close()
    # VIT now passes the entity check and its period becomes the newest flow
    # period; NOE's added name has no company to match, so it now fails; GRR's
    # added period is the one its report date already gave; NHC's period is
    # kept; the rows left alone were not written, so no class, outcome or
    # effect of theirs is counted.
    assert counts == {"read": 13, "left_alone": 5, "unchanged": 3, "cosmetic": 2, "renamed": 1, "added": 1, "kept": 1,
                      "now passes": 1, "now fails": 1, "no change": 3, "period unchanged": 5, "period changed": 1,
                      "period added": 1, "period kept": 1, "becomes the newest period": 1, "neither": 2}

    cur.execute(
        "SELECT report_url, document_meta, extracted_at FROM financial_report_extractions WHERE report_url = ANY(%s)",
        ([url for _, url, _, _, _ in rows],),
    )
    got = {url: (meta, at) for url, meta, at in cur.fetchall()}
    cur.close()
    assert {url: meta for url, (meta, _) in got.items()} == {
        "nhc-4e": NHC_STORED,
        "grr-4d": {**GRR_STORED, "period_end": "2026-06-30", "period_type": "half"},
        "key-4e": {**key, "report_kind": "annual_report"},
        "nll-4e": None,
        "vhl-4e": {"entity": "Vitura Health Limited", "units": "thousands"},
        "vit-4e": {**VIT_STORED, "entity": "Vitura Health Limited", "period_end": "2026-06-30", "period_type": "annual"},
        "unc-4e": {"entity": "Vitura Health Limited"},
        "rac-4e": {"entity": "Racing Ltd"},
        "sam-4e": {"entity": "Cortexa Pty Ltd"},
        "noe-4e": {"report_kind": "appendix_4e", "entity": "Vitura Health Limited"},
        "nox-4e": {"report_kind": "appendix_4e", "entity": "Other Ltd"},
        "alk-4e": {"period_type": "annual"},
        "abc-4d": {"entity": "Old Name Ltd", "abn": "49 004 028 077"},
        "not-4e": {"entity": "No Text Ltd"},
        "nul-4e": None,
        "jsn-4e": None,
    }
    assert {url for url, (_, at) in got.items() if at != extracted_at} == {"sam-4e"}, "the repair never moves extracted_at"


def test_pg_the_document_meta_guard_is_the_whole_object_in_any_key_order(pg_schema):
    # jsonb equality compares objects, not text: the guard matches the stored
    # object in any key order and spacing, misses it when one value or one key
    # differs or extracted_at is a microsecond off, and never matches NULL.
    _, admin, schema = pg_schema
    _create_tables(admin, schema, with_meta=True)
    cur = admin.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    at = dt.datetime(2026, 10, 6, 14, 3, 57, 999995, tzinfo=dt.timezone.utc)  # NHC's row, as stored
    cur.execute(
        "INSERT INTO financial_report_extractions (stock_code, report_url, metrics, document_meta, extracted_at)"
        " VALUES ('NHC', 'nhc-4e', '{}', %s, %s)",
        (json.dumps(NHC_STORED), at),
    )
    cur.execute("SELECT document_meta::text FROM financial_report_extractions WHERE report_url = 'nhc-4e'")
    as_read = cur.fetchone()[0]
    reordered = json.dumps(dict(reversed(list(NHC_STORED.items()))), indent=2)
    assert as_read != reordered and json.loads(as_read) == json.loads(reordered) == NHC_STORED
    fewer = {k: v for k, v in NHC_STORED.items() if k != "units_evidence"}
    period = ("2026-07-31", "annual")
    conn = runner.open_selection_connection()
    try:
        for guard, guard_at in [
            (json.dumps({**NHC_STORED, "units": "millions"}), at),
            (json.dumps(fewer), at),
            (json.dumps({**NHC_STORED, "entity": "New Hope Corporation Limited"}), at),
            (as_read, at + dt.timedelta(microseconds=1)),
        ]:
            assert extract.store_document_meta_repair(conn, "nhc-4e", guard_at, guard, period=period) is False
        assert extract.store_document_meta_repair(conn, "nhc-4e", at, reordered, period=period) is True
        cur.execute("SELECT document_meta, extracted_at FROM financial_report_extractions WHERE report_url = 'nhc-4e'")
        assert cur.fetchone() == ({**NHC_STORED, "period_end": "2026-07-31"}, at)
        cur.execute("UPDATE financial_report_extractions SET document_meta = NULL WHERE report_url = 'nhc-4e'")
        # NULL equals nothing: the row is left alone...
        assert extract.store_document_meta_repair(conn, "nhc-4e", at, "{}", entity="New Hope Ltd") is False
        # ...and a NULL read is no guard: the writer refuses it.
        with pytest.raises(ValueError, match="the guard needs the document_meta object as read"):
            extract.store_document_meta_repair(conn, "nhc-4e", at, "null", entity="New Hope Ltd")
    finally:
        conn.close()
    cur.execute("SELECT document_meta FROM financial_report_extractions WHERE report_url = 'nhc-4e'")
    assert cur.fetchone() == (None,)
    cur.close()
