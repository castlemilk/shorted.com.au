"""Fresh offline regressions for the reconstructed migration candidate."""
import json
from types import SimpleNamespace
import httpx
import pytest
from google import genai
from google.genai import types
from extractor_test_support import stub_missing_deps
stub_missing_deps()
import budgeted_gemini
import extract
from token_usage import TokenUsage
from test_budgeted_gemini import DOC, MODEL_OUTPUT, StubModels

TARGET = 'gemini-3.5-flash-lite'

@pytest.mark.parametrize('model_id', [TARGET, 'models/' + TARGET])
def test_target_suppresses_constructor_generation_settings(model_id):
    model = budgeted_gemini.build_budgeted_model(model_id, extract.EXTRACTION_EXAMPLES,
        api_key='offline-test-key', temperature=0.7, top_p=0.9, top_k=40, candidate_count=2)
    model._client = SimpleNamespace(models=StubModels(MODEL_OUTPUT))
    kept = extract.extract_financial_data(DOC, 'WBT', model=model)
    cfg = model._client.models.calls[0]['config']
    assert cfg['thinking_config'].thinking_level == types.ThinkingLevel.MINIMAL
    assert cfg['thinking_config'].thinking_budget is None
    assert not set(cfg).intersection({'temperature', 'top_p', 'top_k', 'candidate_count'})
    assert cfg['response_mime_type'] == 'application/json'
    assert 'response_schema' in cfg
    assert {(r['class'], r['text']) for r in kept} == {
        ('revenue', 'revenue of $412.6 million'), ('eps', 'Basic EPS was 12.3 cents')}

@pytest.mark.parametrize('model_id', ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'google/gemini-3.5-flash-lite'])
def test_model_policy_is_exact_and_does_not_reclassify_openrouter(model_id):
    assert not budgeted_gemini.uses_thinking_levels(model_id)
    assert budgeted_gemini.thinking_config(model_id).thinking_budget == 0


def mock_client(output):
    bodies = []
    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={
            'candidates': [{'content': {'role': 'model', 'parts': [{'text': output}]}, 'finishReason': 'STOP'}],
            'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 20, 'thoughtsTokenCount': 3, 'totalTokenCount': 123}})
    client = genai.Client(api_key='offline-test-key', http_options=types.HttpOptions(
        client_args={'transport': httpx.MockTransport(handle), 'trust_env': False},
        async_client_args={'transport': httpx.MockTransport(handle), 'trust_env': False}))
    return client, bodies


def assert_target_wire(body):
    cfg = body['generationConfig']
    # Actual google-genai 2.25.0 uses a snake_case inner proto field.
    assert cfg['thinkingConfig'] == {'thinking_level': 'MINIMAL'}
    assert not set(cfg).intersection({'temperature', 'topP', 'topK', 'candidateCount'})
    assert body['contents'][-1]['role'] == 'user'


def test_actual_sdk_extraction_wire_schema_grounding_and_usage():
    usage = TokenUsage()
    model = budgeted_gemini.build_budgeted_model(TARGET, extract.EXTRACTION_EXAMPLES, api_key='offline-test-key', usage=usage)
    client, bodies = mock_client(MODEL_OUTPUT)
    model._client = client
    try:
        kept = extract.extract_financial_data(DOC, 'WBT', model=model)
    finally:
        client.close()
    assert len(bodies) == 1
    assert_target_wire(bodies[0])
    assert bodies[0]['generationConfig']['responseMimeType'] == 'application/json'
    assert 'responseSchema' in bodies[0]['generationConfig']
    assert kept and usage.thoughts == 3 and usage.responses == 1


def test_actual_sdk_digest_wire_and_usage():
    client, bodies = mock_client(json.dumps({'digest': 'Revenue increased.', 'confidence': 0.8, 'key_takeaways': ['Revenue $412.6m']}))
    usage = TokenUsage()
    try:
        result = extract.summarize_report({}, DOC, model_id=TARGET, client=client, usage=usage)
    finally:
        client.close()
    assert_target_wire(bodies[0])
    assert bodies[0]['systemInstruction']['parts'][0]['text'] == extract.DIGEST_PROMPT
    assert result['digest'] == 'Revenue increased.'
    assert usage.thoughts == 3 and usage.total == 123


def test_default_digest_retains_legacy_settings():
    config = extract.digest_config(types)
    assert config.temperature == 0.2
    assert config.thinking_config.thinking_budget == 0
    assert config.thinking_config.thinking_level is None


def test_actual_sdk_does_not_reintroduce_camelcase_alias_settings():
    model = budgeted_gemini.build_budgeted_model(TARGET, extract.EXTRACTION_EXAMPLES,
        api_key='offline-test-key', topP=0.9, topK=40, candidateCount=2)
    client, bodies = mock_client(MODEL_OUTPUT)
    model._client = client
    try:
        extract.extract_financial_data(DOC, 'WBT', model=model)
    finally:
        client.close()
    assert_target_wire(bodies[0])
