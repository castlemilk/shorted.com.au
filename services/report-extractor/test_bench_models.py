"""bench_models: cost arithmetic, value comparison, and usage capture. No network."""

from types import SimpleNamespace

import bench_models as bm


def test_cost_splits_cached_and_uncached_input():
    t = {"prompt": 1_000_000, "cached": 400_000, "output": 100_000}
    miss, hit, out = bm.PRICES["deepseek-flash"]
    assert bm.cost("deepseek-flash", t) == (600_000 * miss + 400_000 * hit + 100_000 * out) / 1e6


def test_unknown_model_has_no_cost():
    assert bm.cost("mystery-model", {"prompt": 1, "cached": 0, "output": 1}) is None


def test_values_are_canonical_class_key_number_triples():
    kept = [
        {"class": "revenue", "attributes": {"value_millions": "3,847", "period": "FY26"}},
        {"class": "guidance", "attributes": {"range": "4-6%"}},
    ]
    assert bm.values(kept) == {("revenue", "value_millions", "3847")}


def test_usage_reads_deepseek_and_openai_cache_fields():
    u = bm.Usage()
    u.add(SimpleNamespace(prompt_tokens=100, completion_tokens=10, prompt_cache_hit_tokens=60))
    u.add(SimpleNamespace(prompt_tokens=50, completion_tokens=5,
                          prompt_tokens_details=SimpleNamespace(cached_tokens=20),
                          completion_tokens_details=SimpleNamespace(reasoning_tokens=3)))
    u.add(None)
    assert (u.prompt, u.cached, u.output, u.reasoning, u.responses) == (150, 80, 15, 3, 3)


def test_billed_cost_wins_over_list_price():
    u = bm.Usage()
    u.add(SimpleNamespace(prompt_tokens=1000, completion_tokens=10, cost=0.00042))
    t = bm.tokens(u)
    assert t["billed"] == 0.00042
    assert bm.cost("deepseek-flash", t) == 0.00042
