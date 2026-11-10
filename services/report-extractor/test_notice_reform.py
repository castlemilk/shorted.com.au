"""New-format documents must never be rescued by a legacy model answer."""
import json
import sqlite3
from pathlib import Path

import pytest

import notice_direct as nd
from test_notice_direct import FakeClient, answer_604, ctx

CASES = json.loads((Path(__file__).parents[1] / "jobs/internal/jobs/ownership/testdata/notices/reform_format_guard.json").read_text())["cases"]
REFORM_CASES = [c for c in CASES if c["expected_format"]]


def plausible_legacy_answer():
    # This is a valid legacy-shaped reading of the transitional 604's voting
    # table. Publishing it would silently discard the notice's new semantics.
    return answer_604(
        holder_name="Example Investments Pty Ltd", subject_company="Example Research Limited",
        previous_pct=5.2, present_pct=5.8, previous_votes=5_200_000, present_votes=5_800_000,
        event_date=None,
        quotes={
            "holder_name": "Name: Example Investments Pty Ltd",
            "previous_pct": "Previous notice 5,200,000 5.20%",
            "previous_votes": "Previous notice 5,200,000 5.20%",
            "present_pct": "Present notice 5,800,000 5.80%",
            "present_votes": "Present notice 5,800,000 5.80%",
        },
    )


@pytest.mark.parametrize("case", REFORM_CASES, ids=lambda c: c["id"])
def test_legacy_model_answer_cannot_publish_a_reform_notice(case):
    notice, reason = nd.validate_notice(
        plausible_legacy_answer(), case["text"], headline=case["headline"],
        announced_on="2026-12-04", shares_on_issue=100_000_000,
        scan=False, model="test",
    )
    assert notice is None
    assert reason == "unsupported_format"


@pytest.mark.parametrize("case", REFORM_CASES, ids=lambda c: c["id"])
def test_reform_notice_is_withheld_before_any_paid_model_call(case):
    client = FakeClient({})
    extractor = nd.NoticeExtractor(client=client, primary="p", checker="c", arbiter="a")
    assert extractor.extract(ctx(text=case["text"])) == (None, "unsupported_format")
    assert not client.calls


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["id"])
def test_format_detection_keeps_legacy_and_reference_text_distinct(case):
    assert nd.unsupported_notice_format(case["text"]) == case["expected_format"]


def test_legacy_voting_table_remains_accepted():
    legacy = next(c for c in CASES if c["id"] == "legacy_604")
    notice, reason = nd.validate_notice(
        plausible_legacy_answer(), legacy["text"], headline=legacy["headline"],
        announced_on="2026-12-04", shares_on_issue=100_000_000,
        scan=False, model="test",
    )
    assert reason == ""
    assert notice.present_pct == 5.8


def test_guard_record_is_explicit_keeps_source_and_does_not_clobber_a_concurrent_success():
    # Execute the actual portable UPDATE rather than asserting its SQL spelling.
    db = sqlite3.connect(":memory:")
    db.create_function("now", 0, lambda: "2026-12-04T00:00:00Z")
    db.execute("CREATE TABLE substantial_holder_notice_attempts (announcement_url TEXT, outcome TEXT, read_by TEXT, detail TEXT, attempted_at TEXT)")
    db.executemany("INSERT INTO substantial_holder_notice_attempts VALUES (?, ?, ?, ?, ?)", [
        ("https://example.test/source.pdf", "no_voting_power", "parser", "old", "old"),
        ("https://example.test/completed.pdf", "parsed", "model", "confirmed", "old"),
        ("https://example.test/parser-completed.pdf", "parsed", "parser", "confirmed", "old"),
    ])

    class Cursor:
        def execute(self, sql, params):
            db.execute(sql.replace("%s", "?"), params)

    for url in ["source", "completed", "parser-completed"]:
        nd.record_withheld(Cursor(), f"https://example.test/{url}.pdf", "no_voting_power", "unsupported_format")
    source = db.execute("SELECT * FROM substantial_holder_notice_attempts WHERE announcement_url = ?", ("https://example.test/source.pdf",)).fetchone()
    assert source[:3] == ("https://example.test/source.pdf", "unsupported_format", "parser")
    assert "prior parser outcome: no_voting_power" in source[3]
    assert source[4] == "2026-12-04T00:00:00Z"
    assert db.execute("SELECT count(*) FROM substantial_holder_notice_attempts WHERE outcome = 'parsed' AND detail = 'confirmed'").fetchone()[0] == 2
    db.close()
