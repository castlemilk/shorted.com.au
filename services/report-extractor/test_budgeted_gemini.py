"""BudgetedGemini (contract 6.1 "Thinking and tokens"), driven end to end.

A stub google-genai client stands in for the network: lx.extract runs for real
(langextract 1.7.0: prompting, chunking, parsing, alignment) and every
generate_content call is recorded, so these tests prove the thinking config
reaches the SDK call, the usage metadata is summed, and the request keeps the
example-derived schema constraints langextract's own factory would apply.
"""
import json
from types import SimpleNamespace

import pytest

pytest.importorskip("google.genai")
pytest.importorskip("langextract.providers.gemini")

from extractor_test_support import stub_missing_deps  # noqa: E402

stub_missing_deps()

import budgeted_gemini  # noqa: E402
import extract  # noqa: E402
from token_usage import TokenUsage  # noqa: E402

DOC = (
    "Wombat Foods Limited reported revenue of $412.6 million for the year ended 30 June 2026. "
    "Net profit after tax was $55.1 million. Basic EPS was 12.3 cents."
)

MODEL_OUTPUT = json.dumps({
    "extractions": [
        {"revenue": "revenue of $412.6 million", "revenue_attributes": {"value_millions": "412.6", "period": "FY2026"}},
        {"net_profit": "Net profit after tax was $55.1 million",
         "net_profit_attributes": {"value_millions": "55", "period": "FY2026"}},
        {"eps": "Basic EPS was 12.3 cents", "eps_attributes": {"value_cents": "12.3", "period": "FY2026"}},
        # The retired few-shot example, echoed: not in this document.
        {"revenue": "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
         "revenue_attributes": {"value_millions": "5142", "period": "H1 FY2025"}},
    ]
})


class StubModels:
    def __init__(self, output, metadata=None):
        self.output = output
        self.metadata = metadata or {"prompt_token_count": 1200, "candidates_token_count": 90, "thoughts_token_count": 0}
        self.calls = []

    def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        return SimpleNamespace(
            text=self.output,
            usage_metadata=SimpleNamespace(**self.metadata),
            prompt_feedback=None,
            candidates=[],
        )


def _stubbed_model(usage, output=MODEL_OUTPUT, **stub_kwargs):
    model = budgeted_gemini.build_budgeted_model(
        "gemini-2.5-flash", extract.EXTRACTION_EXAMPLES, usage=usage, api_key="test-key"
    )
    model._client = SimpleNamespace(models=StubModels(output, **stub_kwargs))
    return model


def test_thinking_config_reaches_generate_content():
    usage = TokenUsage()
    model = _stubbed_model(usage)
    extract.extract_financial_data(DOC, "WBT", model=model)
    calls = model._client.models.calls
    assert len(calls) == 1
    config = calls[0]["config"]
    assert config["thinking_config"].thinking_budget == 0
    assert calls[0]["model"] == "gemini-2.5-flash"
    # The example-derived schema constraints still ride on the request.
    assert config["response_mime_type"] == "application/json"
    assert "response_schema" in config
    assert config["temperature"] == 0.0


def test_usage_metadata_is_summed_per_report_and_per_run():
    run = TokenUsage()
    report = TokenUsage(parent=run)
    model = _stubbed_model(report, metadata={"prompt_token_count": 1000, "candidates_token_count": 50, "thoughts_token_count": 7})
    # Two chunks: max_char_buffer=2000 splits a long document into two calls.
    long_doc = DOC + " " + ("Filler sentence about operations. " * 70)
    extract.extract_financial_data(long_doc, "WBT", model=model)
    n = len(model._client.models.calls)
    assert n >= 2
    assert report.snapshot() == {"responses": n, "prompt": 1000 * n, "candidates": 50 * n, "thoughts": 7 * n, "total": 1057 * n}
    assert run.snapshot() == report.snapshot()


def test_extraction_through_budgeted_model_is_grounded():
    usage = TokenUsage()
    kept = extract.extract_financial_data(DOC, "WBT", model=_stubbed_model(usage))
    by_class = {(r["class"], r["text"]) for r in kept}
    assert by_class == {("revenue", "revenue of $412.6 million"), ("eps", "Basic EPS was 12.3 cents")}
    for r in kept:
        assert r["alignment"] in {"match_exact", "match_greater", "match_lesser", "match_fuzzy"}
        assert DOC[int(r["char_start"]):int(r["char_end"])] == r["text"]


def test_default_path_builds_a_budgeted_model(monkeypatch):
    built = []
    real_build = budgeted_gemini.build_budgeted_model

    def fake_build(model_id, examples, usage=None, **kwargs):
        model = real_build(model_id, examples, usage=usage, api_key="test-key")
        model._client = SimpleNamespace(models=StubModels(MODEL_OUTPUT))
        built.append(model)
        return model

    monkeypatch.setattr(budgeted_gemini, "build_budgeted_model", fake_build)
    usage = TokenUsage()
    extract.extract_financial_data(DOC, "WBT", usage=usage)
    assert len(built) == 1 and isinstance(built[0], budgeted_gemini.BudgetedGemini)
    assert built[0].usage is usage
    assert usage.responses == 1


def test_a_rejected_response_is_still_counted_and_is_a_model_error():
    # A blocked or empty response is a model failure, never "nothing grounded"
    # (review C4): it raises ModelError so the document is not stored.
    usage = TokenUsage()
    model = _stubbed_model(usage, output="")
    model._client.models.generate_content = lambda model, contents, config: SimpleNamespace(
        text=None,
        usage_metadata={"prompt_token_count": 500, "candidates_token_count": 0, "thoughts_token_count": 0},
        prompt_feedback=None,
        candidates=[],
    )
    with pytest.raises(extract.ModelError):
        extract.extract_financial_data(DOC, "WBT", model=model)
    assert usage.prompt == 500 and usage.responses == 1


def test_request_matches_langextracts_own_factory():
    # The pre-built model must send what lx.extract(model_id=...) would have:
    # same schema, same mime type, same model id.
    from langextract import factory

    ours = budgeted_gemini.build_budgeted_model("gemini-2.5-flash", extract.EXTRACTION_EXAMPLES, api_key="k")
    theirs = factory.create_model(
        factory.ModelConfig(model_id="gemini-2.5-flash", provider_kwargs={"api_key": "k", "max_workers": 1}),
        examples=extract.EXTRACTION_EXAMPLES,
        use_schema_constraints=True,
    )
    assert ours.gemini_schema.to_provider_config() == theirs.gemini_schema.to_provider_config()
    assert ours.requires_fence_output == theirs.requires_fence_output is False
    assert ours.model_id == theirs.model_id and ours.max_workers == theirs.max_workers == 1
