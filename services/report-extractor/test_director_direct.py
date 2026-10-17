"""director_direct: 3Y validation, consideration parsing and consensus.

Each case is a notice shape seen in the 2026-09-29 evaluation (57 real
Appendix 3Y notices scored against Claude Opus 5.5 reference readings).
"""
import json

import pytest

import direct_extract as dx
import director_direct as dd
import extract_director_trades as job


def ch(direction, number, consideration=None, nature="On-market trade", cls="Fully paid ordinary shares"):
    return {"direction": direction, "number": number, "consideration": consideration, "nature": nature,
            "security_class": cls, "interest": "direct", "date": "2026-07-15"}


def ans(name, *changes, is3y=True):
    return {"is_appendix_3y": is3y, "director_name": name, "changes": list(changes)}


def v(answer, text):
    return dd.validate_trade(answer, text, "m")


# --- consideration ------------------------------------------------------------------

NUMS = dx.numbers_in("13,000 $4.0035 $57,062.70 250,002.00 4.25 58,824 1,430,100 0.05 0.06 50,976 204,024")


@pytest.mark.parametrize("box,number,want", [
    ("Nil", 100, None),
    ("$57,062.70", 300000, 57062.70),
    ("$4.0035 per ordinary share", 13000, 52045.5),
    ("Payment exercise price $250,002.00 ($4.25 per option)", 58824, 250002.0),  # a total with the price beside it
    ("$3.51 average price per Stapled Security", 1000, None),  # 3.51 is not in NUMS: not written in the notice
])
def test_parse_consideration(box, number, want):
    got, _ = dd.parse_consideration(box, number, NUMS | ({"3.51"} if "3.51" in box and want else set()))
    assert got == want


def test_several_lots_at_several_prices_are_withheld_not_summed():
    box = "50,976 - $0.05 per CODO option purchased on 19 March. 204,024 - $0.06 per CODO option purchased on 20 March."
    got, why = dd.parse_consideration(box, 255000, NUMS)
    assert got is None and why == "several_amounts"


def test_an_implausible_price_drops_the_value():
    got, why = dd.parse_consideration("$57,062.70 per share", 300000, NUMS)
    assert got is None and why == "implausible_price"


# --- validation -----------------------------------------------------------------------

TEXT = ("Appendix 3Y Change of Director's Interest Notice. Name of Director Gary Levin. "
        "Number acquired 13,000. Value/Consideration $4.0035 per ordinary share.")


def test_a_valid_notice():
    t, why = v(ans("Mr Gary Levin", ch("acquired", "13,000", "$4.0035 per ordinary share", "On-market trade")), TEXT)
    assert why == "kept"
    assert (t.director_name, t.trade_type, t.shares, t.total_value, t.price) == ("Gary Levin", "buy", 13000, 52045.5, 4.0035)


@pytest.mark.parametrize("answer,reason", [
    (ans("Gary Leven", ch("acquired", "13,000")), "name_not_in_notice"),
    (ans("Levin", ch("acquired", "13,000")), "name_not_in_notice"),  # a surname alone could be anyone
    (ans("Gary Levin", ch("acquired", "31,000")), "number_not_in_notice"),
    (ans("Gary Levin", ch("sideways", "13,000")), "no_direction"),
    (ans("Gary Levin", ch("acquired", "13,000", nature="On market sale")), "direction_conflicts_with_nature"),
    (ans("Gary Levin", ch("disposed", "13,000", nature="On-market purchase")), "direction_conflicts_with_nature"),
    (ans(None), "not_3y"),
    (ans("Gary Levin", is3y=False), "not_3y"),
])
def test_validation_rejects(answer, reason):
    t, why = v(answer, TEXT)
    assert t is None and why == reason


def test_free_attaching_options_are_not_counted_as_shares_and_a_shared_price_is_withheld():
    text = "Name of Director Gregory Solomon. Number acquired (a) 8,000,000 (b) 4,000,000. take up at $0.035 per share"
    box = "entitlement offer take up at $0.035 per share"
    t, _ = v(ans("Gregory Solomon",
                 ch("acquired", "8,000,000", box, "Participation in entitlement offer"),
                 ch("acquired", "4,000,000", box, "Participation in entitlement offer", cls="Unlisted options")), text)
    assert t.shares == 8_000_000 and t.trade_type == "buy"
    assert t.total_value is None  # one box over shares AND options: not the shares' own price


def test_one_valuation_copied_onto_both_halves_of_a_conversion_counts_once():
    text = ("Name of Director Chris Giannopoulos. Number acquired 335,886 ordinary shares on exercise of performance rights. "
            "Number disposed 335,886 performance rights. Estimated valuation $87,330")
    box = "No cash consideration. Estimated valuation $87,330"
    t, _ = v(ans("Chris Giannopoulos",
                 ch("acquired", "335,886", box, "Exercise of performance rights"),
                 ch("disposed", "335,886", box, "Conversion of performance rights", cls="Performance rights")), text)
    assert (t.trade_type, t.shares, t.total_value) == ("exercise_options", 335886, 87330.0)


def test_a_priced_sale_beside_an_unpriced_transfer_is_the_priced_lots():
    text = "Name of Director Jacob Klein. Number disposed 3,250,000 and 80,000. $15.7587 per share"
    t, _ = v(ans("Jacob Klein",
                 ch("disposed", "3,250,000", "$15.7587 per share", "On-market sale"),
                 ch("disposed", "80,000", None, "Off-market transfer")), text)
    assert (t.trade_type, t.shares, t.total_value) == ("sell", 3250000, round(3250000 * 15.7587, 2))


def test_a_nil_change_is_a_zero_share_record():
    t, why = v(ans("Gary Levin"), TEXT)
    assert why == "kept" and t.shares == 0 and t.total_value is None


# --- names --------------------------------------------------------------------------

def test_same_person_tolerates_middle_names_and_honorifics():
    assert dd.same_person("Mr Thomas F. Bogan", "Thomas Bogan")
    assert dd.same_person("Ian Robert Mulholland", "Ian Mulholland")
    assert not dd.same_person("Terrence Bates", "James Chirnside")
    assert not dd.same_person("Chris Levin", "Gary Levin")


# --- consensus ------------------------------------------------------------------------


class Stub:
    def __init__(self, answers):
        self.answers = answers

    def chat(self, model, system, user, usage=None, temperature=0.0):
        a = self.answers[model]
        if isinstance(a, Exception):
            raise a
        return a if isinstance(a, str) else json.dumps(a)


def run(p, c, a="{}"):
    ex = dd.DirectorExtractor(client=Stub({"p": p, "c": c, "a": a}), primary="p", checker="c", arbiter="a")
    return ex.extract(TEXT)


GOOD = ans("Gary Levin", ch("acquired", "13,000", "$4.0035 per ordinary share"))
NO_VALUE = ans("Gary Levin", ch("acquired", "13,000", None))
OTHER = ans("Gary Levin", ch("disposed", "13,000", None, "On-market sale"))


def test_agreement_writes_the_trade_and_the_value_needs_both_readings():
    t, out = run(GOOD, GOOD)
    assert out == "agree" and t.total_value == 52045.5
    t, out = run(GOOD, NO_VALUE)
    assert out == "agree" and t.shares == 13000 and t.total_value is None


def test_a_disagreement_is_settled_by_the_arbiter_or_withheld():
    t, out = run(GOOD, OTHER, GOOD)
    assert out == "majority" and t.trade_type == "buy"
    t, out = run(GOOD, OTHER, "{}")
    assert t is None and out == "disputed"


def test_a_checker_that_says_nothing_valid_leaves_the_primary_unconfirmed_without_value():
    t, out = run(GOOD, "not json at all", "also not json")
    assert out == "unconfirmed" and t.shares == 13000 and t.total_value is None


def test_a_wrapped_array_answer_is_read():
    t, out = run(GOOD, json.dumps([GOOD]))
    assert out == "agree"


def test_the_primary_failing_raises_so_the_job_records_model_error():
    with pytest.raises(dx.ModelCallError):
        run(dx.ModelCallError("p: HTTP 401"), GOOD)


# --- the job ------------------------------------------------------------------------------


def test_a_model_error_is_never_recorded_as_an_attempt(monkeypatch):
    recorded = []
    monkeypatch.setattr(job, "record_attempt", lambda url, outcome: recorded.append(outcome))
    monkeypatch.setattr(job.extract, "download_pdf_text", lambda s, url, max_pages: TEXT)

    class Boom:
        def extract(self, text, usage=None):
            raise dx.ModelCallError("p: HTTP 401")

    out = job.process_one({"announcement_url": "u"}, dry_run=False, record_attempts=True, direct=Boom())
    assert out == "model_error" and recorded == []


def test_a_disputed_notice_is_recorded_and_nothing_is_written(monkeypatch):
    recorded, written = [], []
    monkeypatch.setattr(job, "record_attempt", lambda url, outcome: recorded.append(outcome))
    monkeypatch.setattr(job, "update_trade", lambda *a: written.append(a))
    monkeypatch.setattr(job.extract, "download_pdf_text", lambda s, url, max_pages: TEXT)

    class Disputed:
        def extract(self, text, usage=None):
            return None, "disputed"

    assert job.process_one({"announcement_url": "u"}, False, True, direct=Disputed()) == "disputed"
    assert recorded == ["disputed"] and written == []


def test_the_retry_window_forgives_only_no_extract_markers_inside_it():
    captured = {}

    class Cur:
        def execute(self, sql, params):
            captured["sql"], captured["params"] = sql, params

        def fetchall(self):
            return []

        def close(self):
            pass

    class Conn:
        def cursor(self, cursor_factory=None):
            return Cur()

    import extract_director_trades as j
    orig = j.attempts_table_exists
    j.attempts_table_exists = lambda conn: True
    try:
        j.select_urls(Conn(), "recent", 20, retry_after_days=30, retry_no_extract_between=("2026-07-30", "2026-10-15"))
    finally:
        j.attempts_table_exists = orig
    assert "last_outcome = 'no_extract'" in captured["sql"]
    assert captured["params"] == (30, "2026-07-30", "2026-10-15", 20)


@pytest.mark.parametrize("raw,want", [
    ("Mr Doug McTaggart", "Doug McTaggart"),
    ("Andree St-Germain", "Andree St-Germain"),
    ("DR JOHN O'BRIEN", "John O'Brien"),
    ("MARY-ANNE SMITH", "Mary-Anne Smith"),
    ("Thomas F. Bogan", "Thomas F. Bogan"),
])
def test_names_keep_their_written_casing(raw, want):
    assert dd.title_case(raw) == want
