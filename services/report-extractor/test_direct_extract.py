"""direct_extract: validation, unit normalisation, stored shape and consensus.

Cases are taken from the 2026-09-29 benchmark filings (bench_direct.py). No
network: the model is a stub returning canned JSON.
"""
from collections import Counter

import pytest

import direct_extract as dx
import extract
import extraction_trust

ADH = (
    "Adairs Limited FY26 results. Group sales of $641.7 million, up +3.8%.\n"
    "Statutory NPAT / (loss)  (39.4)  25.7  n.m.\n"
    "Underlying NPAT ¹  34.6  34.0  +1.7%\n"
    "Statutory earnings / (loss) per share (cents)  (22.2)  14.6\n"
    "Diluted earnings per share (cents)  (22.0)\n"
    "Total comprehensive profit / (loss) for the year (40.1)\n"
    "The audited NTA backing as at 30 June 2026 is expected to be $1.96 per unit.\n"
    "Operating profit of $2,675 million, up 15.7%.\n"
)


def fig(metric, value, unit, quote, basis="statutory", period="FY26"):
    return {"metric": metric, "value": value, "unit": unit, "basis": basis, "period": period, "quote": quote}


def check(raw, text=ADH):
    return dx.validate_figure(raw, text, "m", extract.FEWSHOT_DENYLIST)


# --- validation ----------------------------------------------------------------


def test_a_quoted_figure_is_located_and_scaled_to_millions():
    f, why = check(fig("revenue", "641.7", "millions", "Group sales of $641.7 million"))
    assert why == "kept" and f.alignment == "match_exact"
    assert ADH[f.start:f.end] == "Group sales of $641.7 million"
    rec = f.to_record("agree", ["a", "b"])
    assert rec["attributes"]["value_millions"] == "641.7"
    assert rec[extraction_trust.KEY_CHAR_START] == str(f.start)


def test_whole_dollars_and_thousands_are_normalised_to_millions():
    text = "Revenue from ordinary activities $8,927,346\nProfit ($'000) 14,107"
    f, _ = check(fig("revenue", "8,927,346", "dollars", "Revenue from ordinary activities $8,927,346"), text)
    assert f.to_record("agree", [])["attributes"]["value_millions"] == "8.927346"
    g, _ = check(fig("net_profit", "14,107", "thousands", "Profit ($'000) 14,107"), text)
    assert g.to_record("agree", [])["attributes"]["value_millions"] == "14.107"


def test_a_loss_keeps_its_sign():
    f, why = check(fig("net_profit", "-39.4", "millions", "Statutory NPAT / (loss)  (39.4)"))
    assert why == "kept" and f.negative
    assert f.to_record("agree", [])["attributes"]["value_millions"] == "-39.4"


def test_whitespace_differences_align_fuzzy():
    f, why = check(fig("net_profit", "-39.4", "millions", "Statutory NPAT / (loss) (39.4)"))
    assert why == "kept" and f.alignment == "match_fuzzy"


def test_a_table_row_quoted_with_columns_skipped_is_aligned_to_the_documents_own_span():
    text = "Revenue from ordinary activities  (21)%  to  25,040\n"
    f, why = check(fig("revenue", "25,040", "thousands", "Revenue from ordinary activities ... 25,040"), text)
    assert why == "kept" and f.alignment == "match_lesser"
    assert f.quote == text[f.start:f.end] and f.quote.startswith("Revenue from ordinary") and f.quote.endswith("25,040")


@pytest.mark.parametrize("raw,reason", [
    (fig("revenue", "641.7", "millions", "Group revenue was $641.7 million"), "quote_not_in_document"),
    (fig("revenue", "700", "millions", "Group sales of $641.7 million"), "value_not_in_quote"),
    (fig("net_profit", "-40.1", "millions", "Total comprehensive profit / (loss) for the year (40.1)"), "comprehensive_income"),
    (fig("net_profit", "1.96", "dollars", "The audited NTA backing as at 30 June 2026 is expected to be $1.96 per unit"), "label_mismatch"),
    (fig("revenue", "2,675", "millions", "Operating profit of $2,675 million"), "label_mismatch"),
    (fig("revenue", "641.7", "lakhs", "Group sales of $641.7 million"), "bad_unit"),
    (fig("eps", "22.2", "millions", "Statutory earnings / (loss) per share (cents)  (22.2)"), "bad_unit"),
    (fig("goodwill", "1", "millions", "x"), "unknown_metric"),
    (fig("revenue", "n/a", "millions", "Group sales of $641.7 million"), "no_value"),
    (fig("revenue", "641.7", "millions", "Group sales of $641.7 million", period=""), "no_period"),
])
def test_validation_rejects(raw, reason):
    f, why = check(raw)
    assert f is None and why == reason


def test_the_few_shot_example_is_never_stored():
    example = extract.EXTRACTION_EXAMPLES[0]
    quote = example.extractions[0].extraction_text
    f, why = check(fig("revenue", "3,847", "millions", quote), example.text)
    assert f is None and why == "fewshot_echo"


def test_underlying_and_diluted_figures_are_stored_under_their_own_classes():
    u, _ = check(fig("net_profit", "34.6", "millions", "Underlying NPAT ¹  34.6", basis="underlying"))
    d, _ = check(fig("eps", "-22.0", "cents", "Diluted earnings per share (cents)  (22.0)"))
    b, _ = check(fig("eps", "-22.2", "cents", "Statutory earnings / (loss) per share (cents)  (22.2)"))
    assert u.to_record("agree", [])["class"] == "underlying_net_profit"
    assert d.to_record("agree", [])["class"] == "diluted_eps"
    assert b.to_record("agree", [])["class"] == "eps"
    assert b.to_record("agree", [])["attributes"]["value_cents"] == "-22.2"


def test_a_per_share_figure_written_in_dollars_is_stored_as_value_dollars():
    text = "Basic earnings per share $0.125"
    f, _ = check(fig("eps", "0.125", "dollars", "Basic earnings per share $0.125"), text)
    attrs = f.to_record("agree", [])["attributes"]
    assert attrs["value_dollars"] == "0.125" and "value_cents" not in attrs


def test_a_bare_table_figure_is_widened_to_its_unit_heading():
    text = "Results for announcement to the market\n30 June 2026 $’000 30 June 2025 $’000\nRevenue from ordinary activities 115,116 98,210\n"
    f, why = check(fig("revenue", "115,116", "thousands", "Revenue from ordinary activities 115,116"), text)
    assert why == "kept" and f.alignment == "match_greater"
    assert "$’000" in f.quote and f.quote.endswith("115,116")


def test_a_heading_for_the_other_unit_blocks_widening():
    text = "$'000 old table\nfoo\n$m\nRevenue 115,116\n"
    f, _ = check(fig("revenue", "115,116", "thousands", "Revenue 115,116"), text)
    assert f.alignment == "match_exact" and "$'000" not in f.quote


# --- consensus -------------------------------------------------------------------


def answer(model, *raws, text=ADH):
    figs = [check(r, text)[0] for r in raws]
    return dx.Answer(model, True, [f for f in figs if f], Counter())


REV = fig("revenue", "641.7", "millions", "Group sales of $641.7 million")
NP = fig("net_profit", "-39.4", "millions", "Statutory NPAT / (loss)  (39.4)")
NP_WRONG = fig("net_profit", "-40.1", "millions", "Statutory NPAT / (loss)  (39.4)")  # rejected: value not in quote
NP_UNDERLYING_AS_STATUTORY = fig("net_profit", "34.6", "millions", "Underlying NPAT ¹  34.6")


def test_agreement_is_stored_and_labelled():
    recs, counts = dx.reconcile(answer("p", REV, NP), answer("c", REV, NP), None)
    assert counts == {"agree": 2}
    assert {r["attributes"]["consensus"] for r in recs} == {"agree"}
    assert recs[0]["attributes"]["models"] == "p,c"


def test_a_figure_only_the_primary_found_is_primary_only_or_withheld_when_strict():
    recs, counts = dx.reconcile(answer("p", REV, NP), answer("c", REV), None)
    assert counts == {"agree": 1, "primary_only": 1}
    _, strict = dx.reconcile(answer("p", REV, NP), answer("c", REV), None, strict=True)
    assert strict == {"agree": 1, "withheld_unconfirmed": 1}


def test_a_disagreement_goes_to_the_arbiter_and_the_majority_wins():
    asked = []

    def arbiter():
        asked.append(1)
        return answer("a", NP)

    recs, counts = dx.reconcile(answer("p", NP_UNDERLYING_AS_STATUTORY), answer("c", NP), arbiter)
    assert asked == [1]
    assert counts == {"majority_checker": 1}
    assert recs[0]["attributes"]["value_millions"] == "-39.4"
    assert recs[0]["attributes"]["models"] == "c,a"


def test_with_no_majority_the_figure_is_withheld():
    recs, counts = dx.reconcile(answer("p", NP_UNDERLYING_AS_STATUTORY), answer("c", NP), lambda: answer("a"))
    assert recs == [] and counts == {"withheld_disagreement": 1}


def test_the_arbiter_is_not_called_when_nothing_disagrees():
    dx.reconcile(answer("p", REV), answer("c", REV), lambda: pytest.fail("arbiter called"))


def test_units_do_not_cause_false_disagreement():
    text = "Revenue from ordinary activities $8,927,346. Revenue up 12% to $8.9m."
    a = answer("p", fig("revenue", "8,927,346", "dollars", "Revenue from ordinary activities $8,927,346"), text=text)
    b = answer("c", fig("revenue", "8.9", "millions", "Revenue up 12% to $8.9m"), text=text)
    # 8.927346 vs 8.9 differs by 0.3%: within tolerance, the same figure.
    _, counts = dx.reconcile(a, b, lambda: pytest.fail("arbiter called"))
    assert counts == {"agree": 1}


# --- extractor + transport ---------------------------------------------------------


class StubClient:
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def chat(self, model, system, user, usage=None, temperature=0.0):
        self.calls.append(model)
        a = self.answers[model]
        if isinstance(a, Exception):
            raise a
        import json
        return json.dumps(a)


def test_extractor_checker_failure_degrades_to_unchecked_not_to_nothing():
    client = StubClient({
        "p": {"document": {"is_results_document": True}, "figures": [REV]},
        "c": dx.ModelCallError("c: HTTP 429"),
    })
    ex = dx.DirectExtractor(client=client, primary="p", checker="c", arbiter="a", denylist=extract.FEWSHOT_DENYLIST)
    recs = ex.extract(ADH, "ADH")
    assert [r["attributes"]["consensus"] for r in recs] == ["unchecked"]
    assert ex.stats["checker_failed"] == 1


def test_extractor_primary_failure_raises_so_nothing_is_stored():
    client = StubClient({"p": dx.ModelCallError("p: HTTP 401"), "c": {"figures": []}})
    ex = dx.DirectExtractor(client=client, primary="p", checker="c")
    with pytest.raises(dx.ModelCallError):
        ex.extract(ADH, "ADH")


def test_parse_answer_tolerates_fences_and_prose():
    assert dx.parse_answer('```json\n{"figures": []}\n```') == {"figures": []}
    assert dx.parse_answer('Here you go: {"a": 1} thanks') == {"a": 1}
    assert dx.parse_answer("no json") == {}


def test_openrouter_retries_then_reports_without_leaking_the_key(monkeypatch):
    calls = []

    class Resp:
        def __init__(self, code, body):
            self.status_code, self._body, self.text = code, body, str(body)

        def json(self):
            return self._body

    seq = [Resp(429, {}), Resp(200, {"choices": [{"message": {"content": '{"ok": 1}'}}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 4, "cost": 0.0001}})]

    class Session:
        def post(self, url, json, headers, timeout):
            calls.append((json["model"], json["reasoning"]))
            return seq.pop(0)

    monkeypatch.setattr(dx.time, "sleep", lambda s: None)
    client = dx.OpenRouter(api_key="sk-secret")
    client._tl.session = Session()
    from token_usage import TokenUsage
    u = TokenUsage()
    assert client.chat("m", "s", "u", usage=u) == '{"ok": 1}'
    assert len(calls) == 2 and calls[0][1] == {"enabled": False}
    assert u.prompt == 10 and u.candidates == 4 and abs(u.cost_usd - 0.0001) < 1e-12

    seq[:] = [Resp(401, {"error": "bad key"})]
    with pytest.raises(dx.ModelCallError) as e:
        client.chat("m", "s", "u")
    assert "sk-secret" not in str(e.value)


def test_openrouter_falls_back_to_minimal_reasoning_when_a_model_requires_it(monkeypatch):
    class Resp:
        def __init__(self, code, text, body=None):
            self.status_code, self.text, self._b = code, text, body

        def json(self):
            return self._b

    sent = []
    seq = [Resp(400, "Reasoning is mandatory for this endpoint and cannot be disabled."),
           Resp(200, "", {"choices": [{"message": {"content": "{}"}}]})]

    class Session:
        def post(self, url, json, headers, timeout):
            sent.append(dict(json["reasoning"]))
            return seq.pop(0)

    client = dx.OpenRouter(api_key="k")
    client._tl.session = Session()
    client.chat("gpt", "s", "u")
    assert sent == [{"enabled": False}, {"effort": "minimal"}]
    assert "gpt" in client._min_reasoning
