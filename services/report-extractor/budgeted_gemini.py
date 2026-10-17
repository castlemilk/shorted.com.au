"""BudgetedGemini: langextract's Gemini provider with thinking off and tokens counted.

Contract 6.1 "Thinking and tokens". gemini-2.5-flash thinks by default, and a
thinking model spends (and bills) output tokens on reasoning before it writes a
word. The extraction task is span-copying, not reasoning, so every per-prompt
call sets thinking_config=ThinkingConfig(thinking_budget=0), and every
response's usage_metadata is summed into a TokenUsage so the run logs what it
spent. The digest call (extract.summarize_report) sets the same config.

Passing a pre-built model to lx.extract(model=...) skips langextract's own
example-derived schema constraints, so build_budgeted_model() applies them
exactly as langextract's factory does for model_id= (GeminiSchema.from_examples,
provider kwargs, apply_schema, fence auto), keeping the request shape the
extractor had before this change.

Pinned to langextract==1.7.0 (requirements.txt): the two overridden hooks,
_process_single_prompt and _response_to_scored_output, are that version's.
test_budgeted_gemini.py drives lx.extract end to end through a stub client, so
an upgrade that moves either hook fails there rather than silently thinking.
"""
from __future__ import annotations

import os
from typing import Any, Optional, Sequence

from google.genai import types as genai_types
from langextract.core import data as lx_data
from langextract.providers import gemini as lx_gemini
from langextract.providers.schemas import gemini as lx_gemini_schema

from token_usage import TokenUsage

THINKING_BUDGET = 0


def thinking_config() -> genai_types.ThinkingConfig:
    """The thinking configuration every extractor Gemini call carries."""
    return genai_types.ThinkingConfig(thinking_budget=THINKING_BUDGET)


class BudgetedGemini(lx_gemini.GeminiLanguageModel):
    """GeminiLanguageModel that adds thinking_config to each per-prompt call and
    sums each response's usage_metadata into `usage`."""

    def __init__(self, *args: Any, usage: Optional[TokenUsage] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.usage = usage if usage is not None else TokenUsage()

    def _process_single_prompt(self, prompt: str, config: dict):  # type: ignore[override]
        config = dict(config)
        config["thinking_config"] = thinking_config()
        return super()._process_single_prompt(prompt, config)

    def _response_to_scored_output(self, response):  # type: ignore[override]
        # Count before the parent validates the text: a response that is then
        # rejected (blocked, no text) was still billed.
        self.usage.add(getattr(response, "usage_metadata", None))
        return lx_gemini.GeminiLanguageModel._response_to_scored_output(response)


def build_budgeted_model(
    model_id: str,
    examples: Sequence[Any],
    usage: Optional[TokenUsage] = None,
    api_key: Optional[str] = None,
    max_workers: int = 1,
    **provider_kwargs: Any,
) -> BudgetedGemini:
    """A BudgetedGemini configured as langextract's factory would configure a
    GeminiLanguageModel for lx.extract(model_id=..., examples=...)."""
    if api_key is None:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY")
    schema_instance = lx_gemini_schema.GeminiSchema.from_examples(list(examples))
    kwargs = schema_instance.to_provider_config()
    kwargs.update({k: v for k, v in provider_kwargs.items() if v is not None})
    kwargs.setdefault("format_type", lx_data.FormatType.JSON)
    schema_instance.sync_with_provider_kwargs(kwargs)
    model = BudgetedGemini(model_id=model_id, api_key=api_key, max_workers=max_workers, usage=usage, **kwargs)
    model.apply_schema(schema_instance)
    model.set_fence_output(None)
    return model
