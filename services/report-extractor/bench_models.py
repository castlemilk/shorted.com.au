#!/usr/bin/env python3
"""Benchmark extraction models on real ASX filings, through the PRODUCTION path.

    GEMINI_API_KEY=... DEEPSEEK_API_KEY=... python bench_models.py \\
        --model gemini:gemini-2.5-flash --model gemini:gemini-2.5-flash-lite \\
        --model deepseek:deepseek-flash --reference gemini:gemini-2.5-flash

Every candidate runs through extract.extract_financial_data — the same prompt,
few-shot example, 50k-char cap, chunking and grounding filter the nightly job
uses — so "kept" here means exactly what would be stored. compare_models.py
predates the grounding filter and reports raw extractions; prefer this.

Per model and document it records: grounded extractions kept, the metric
values (class + value) and how many agree with the reference model's, prompt /
cached / output / reasoning tokens, latency, and an estimated cost from PRICES.
Agreement with a reference is NOT accuracy: two models can agree on a wrong
number. Spot-check disagreements against the PDF (the report prints them).

Providers:
  gemini:<model>    BudgetedGemini (thinking off), key GEMINI_API_KEY / LANGEXTRACT_API_KEY
  deepseek:<model>  OpenAI-compatible https://api.deepseek.com, key DEEPSEEK_API_KEY,
                    thinking disabled (it bills output tokens and the job does not use it)
  openai:<model>    OpenAI, key OPENAI_API_KEY
  openrouter:<vendor/model>  OpenRouter, key OPENROUTER_API_KEY, reasoning disabled;
                    cost is OpenRouter's billed usage.cost, not a list-price estimate
  compat:<model>@<base_url>  any other OpenAI-compatible endpoint, key COMPAT_API_KEY

Nothing is written to the database or GCS.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import requests

import extract
from extract import ASX_HEADERS, VALUE_KEYS, canonical_number, download_pdf_text
from token_usage import TokenUsage

# USD per 1M tokens: (input cache miss, input cache hit, output). List prices,
# checked 2026-09-29 (ai.google.dev/gemini-api/docs/pricing,
# api-docs.deepseek.com/quick_start/pricing). DeepSeek is quoted at its
# OFF-PEAK rate: the job runs at 14:00 UTC, outside DeepSeek's peak windows
# (01-04 and 06-10 UTC weekdays). Update when prices move; unknown models
# report tokens only. gemini-2.5-flash-lite is gone from the API (404, 2026-09-29).
PRICES: dict[str, tuple[float, float, float]] = {
    "gemini-2.5-flash": (0.30, 0.03, 2.50),
    "gemini-3.1-flash-lite": (0.25, 0.025, 1.50),
    "gemini-3-flash-preview": (0.50, 0.05, 3.00),
    "deepseek-flash": (0.15, 0.003, 0.60),
    "deepseek-v4-pro": (0.66, 0.022, 1.98),
}

# Recent statutory results filings: the eight documents the 2026-09-28 run
# failed on (every Gemini call returned API_KEY_INVALID), so the queue the job
# owes. Override with --url.
DEFAULT_DOCS = [
    ("MXT", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144656"),
    ("VMM", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144901"),
    ("TVN", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144411"),
    ("ZIM", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144779"),
    ("MOT", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144657"),
    ("ACF", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144963"),
    ("MRE", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144652"),
    ("AS1", "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144929"),
]

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class Usage:
    """Token counts from OpenAI-compatible responses (thread-safe)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.prompt = self.cached = self.output = self.reasoning = self.responses = 0
        self.billed = 0.0  # OpenRouter usage.cost (USD); 0 when the provider reports none
        self.has_billed = False

    def add(self, u: Any) -> None:
        def g(obj: Any, name: str) -> int:
            v = getattr(obj, name, None) if obj is not None else None
            return int(v) if isinstance(v, (int, float)) else 0

        details_in = getattr(u, "prompt_tokens_details", None)
        details_out = getattr(u, "completion_tokens_details", None)
        # DeepSeek reports cache hits as prompt_cache_hit_tokens; OpenAI as
        # prompt_tokens_details.cached_tokens.
        cached = g(u, "prompt_cache_hit_tokens") or g(details_in, "cached_tokens")
        with self._lock:
            self.prompt += g(u, "prompt_tokens")
            self.cached += cached
            self.output += g(u, "completion_tokens")
            self.reasoning += g(details_out, "reasoning_tokens")
            self.responses += 1
            billed = getattr(u, "cost", None) if u is not None else None
            if billed is None and u is not None:
                billed = (getattr(u, "model_extra", None) or {}).get("cost")
            if isinstance(billed, (int, float)):
                self.billed += float(billed)
                self.has_billed = True


def build_openai_compatible(model_id: str, base_url: Optional[str], api_key: str, usage: Usage,
                            extra_body: Optional[dict] = None, max_workers: int = 4) -> Any:
    """langextract's OpenAI provider with usage capture and an extra_body
    passthrough (langextract 1.7.0 whitelists request params and drops
    extra_body, which DeepSeek needs to switch thinking off)."""
    from langextract.providers.openai import OpenAILanguageModel

    body = dict(extra_body or {})

    class Captured(OpenAILanguageModel):
        def _build_chat_completions_params(self, prompt: str, config: dict) -> dict:
            params = super()._build_chat_completions_params(prompt, config)
            if body:
                params["extra_body"] = dict(body)
            return params

    model = Captured(model_id=model_id, api_key=api_key, base_url=base_url, max_workers=max_workers,
                     temperature=0.0)
    create = model._client.chat.completions.create

    def create_and_count(*args: Any, **kwargs: Any) -> Any:
        try:
            resp = create(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - re-raised unless it is the one case handled
            # Some models (OpenAI GPT-5, GLM) refuse reasoning OFF ("Reasoning
            # mandatory endpoint cannot disabled"). Fall back, once and for the
            # rest of the run, to the smallest reasoning they accept: its tokens
            # are billed and reported, so the cost comparison stays honest.
            msg = str(e).lower()
            if "reasoning" not in msg or "mandatory" not in msg or body.get("reasoning") == {"effort": "minimal"}:
                raise
            body["reasoning"] = {"effort": "minimal"}
            kwargs["extra_body"] = dict(body)
            print(f"  {model_id}: reasoning cannot be disabled; using effort=minimal", file=sys.stderr)
            resp = create(*args, **kwargs)
        usage.add(getattr(resp, "usage", None))
        return resp

    model._client.chat.completions.create = create_and_count  # type: ignore[method-assign]
    return model


def build(spec: str) -> tuple[str, Any, Any]:
    """(model_id, model, usage) for a provider:model spec."""
    provider, _, rest = spec.partition(":")
    if provider == "gemini":
        from budgeted_gemini import build_budgeted_model

        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY")
        if not key:
            raise SystemExit("gemini: set GEMINI_API_KEY")
        usage = TokenUsage()
        return rest, build_budgeted_model(rest, extract.EXTRACTION_EXAMPLES, usage=usage, api_key=key), usage
    usage = Usage()
    if provider == "deepseek":
        key = os.environ.get("DEEPSEEK_API_KEY") or sys.exit("deepseek: set DEEPSEEK_API_KEY")
        return rest, build_openai_compatible(rest, DEEPSEEK_BASE_URL, key, usage,
                                             extra_body={"thinking": {"type": "disabled"}}), usage
    if provider == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY") or sys.exit("openrouter: set OPENROUTER_API_KEY")
        return rest, build_openai_compatible(rest, OPENROUTER_BASE_URL, key, usage, extra_body={
            "reasoning": {"enabled": False},
            "usage": {"include": True},
        }), usage
    if provider == "openai":
        key = os.environ.get("OPENAI_API_KEY") or sys.exit("openai: set OPENAI_API_KEY")
        return rest, build_openai_compatible(rest, None, key, usage), usage
    if provider == "compat":
        model_id, _, base = rest.partition("@")
        key = os.environ.get("COMPAT_API_KEY") or sys.exit("compat: set COMPAT_API_KEY")
        return model_id, build_openai_compatible(model_id, base, key, usage), usage
    raise SystemExit(f"unknown provider in {spec!r}")


def tokens(usage: Any) -> dict:
    if isinstance(usage, TokenUsage):  # Gemini: implicit caching is not reported per call here
        return {"prompt": usage.prompt, "cached": 0, "output": usage.candidates + usage.thoughts,
                "reasoning": usage.thoughts, "responses": usage.responses}
    return {"prompt": usage.prompt, "cached": usage.cached, "output": usage.output,
            "reasoning": usage.reasoning, "responses": usage.responses,
            "billed": usage.billed if usage.has_billed else None}


def cost(model_id: str, t: dict) -> Optional[float]:
    if t.get("billed") is not None:
        return t["billed"]
    p = PRICES.get(model_id)
    if not p:
        return None
    miss, hit, out = p
    return ((t["prompt"] - t["cached"]) * miss + t["cached"] * hit + t["output"] * out) / 1e6


def values(kept: list[dict]) -> set[tuple[str, str, str]]:
    """(class, value key, canonical number) for every valued extraction."""
    out = set()
    for e in kept:
        for k in VALUE_KEYS:
            v = (e.get("attributes") or {}).get(k)
            if v is not None:
                out.add((e["class"], k, canonical_number(str(v)) or str(v)))
    return out


def snapshot(t: dict) -> dict:
    return dict(t)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append", required=True, help="provider:model (repeatable)")
    ap.add_argument("--reference", help="spec whose values the others are compared with (default: first --model)")
    ap.add_argument("--url", action="append", default=[], help="CODE=URL of a filing (repeatable; default: 8 recent filings)")
    ap.add_argument("--max-pages", type=int, default=extract.DEFAULT_MAX_PAGES)
    ap.add_argument("--daily-docs", type=int, default=120, help="documents per nightly run, for the cost projection")
    ap.add_argument("--json", help="write full results here")
    args = ap.parse_args()

    docs = [tuple(u.split("=", 1)) for u in args.url] if args.url else DEFAULT_DOCS
    reference = args.reference or args.model[0]
    specs = list(dict.fromkeys([reference, *args.model]))
    models = {s: build(s) for s in specs}

    session = requests.Session()
    session.headers.update(ASX_HEADERS)
    texts = {}
    for code, url in docs:
        text = download_pdf_text(session, url, max_pages=args.max_pages)
        if text:
            texts[code] = text
            print(f"fetched {code}: {len(text):,} chars", file=sys.stderr)
        else:
            print(f"fetched {code}: FAILED, skipping", file=sys.stderr)

    results: dict = defaultdict(dict)

    def run_model(spec: str) -> None:
        # One thread per model: models are independent, so a slow provider
        # does not serialise the rest. Documents within a model stay in order,
        # which keeps its per-document token deltas exact.
        model_id, model, usage = models[spec]
        for code, text in texts.items():
            before = tokens(usage)
            start = time.time()
            try:
                kept = extract.extract_financial_data(text, code, model_id=model_id, model=model)
                err = None
            except Exception as e:  # noqa: BLE001 - recorded per document
                kept, err = [], str(e)[:300]
            after = tokens(usage)
            t = {k: None if after[k] is None else after[k] - (before[k] or 0) for k in after}
            results[spec][code] = {
                "kept": len(kept), "values": sorted(values(kept)), "error": err,
                "seconds": round(time.time() - start, 1), "tokens": t, "cost": cost(model_id, t),
                "metrics": extract.extractions_to_metrics(kept) if kept else {},
            }
            print(f"{spec:40} {code:5} kept={len(kept):3} {t['prompt']:>7,}in {t['output']:>6,}out "
                  f"{time.time() - start:5.1f}s {'ERR ' + err[:80] if err else ''}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=len(specs)) as pool:
        list(pool.map(run_model, specs))

    ref = results[reference]
    print(f"\n{len(texts)} documents, reference = {reference}\n")
    print(f"{'model':40} {'kept':>5} {'agree%':>7} {'errors':>6} {'in tok':>9} {'cached':>8} "
          f"{'out tok':>8} {'s/doc':>6} {'$/doc':>8} {'$/night':>8}")
    for spec in specs:
        rows = {c: results[spec][c] for c in texts if c in results[spec]}
        n = len(rows) or 1
        kept = sum(r["kept"] for r in rows.values())
        errors = sum(1 for r in rows.values() if r["error"])
        agree = both = 0
        for code, r in rows.items():
            mine, theirs = set(map(tuple, r["values"])), set(map(tuple, ref.get(code, {}).get("values", [])))
            both += len(mine | theirs)
            agree += len(mine & theirs)
        tin = sum(r["tokens"]["prompt"] for r in rows.values())
        tc = sum(r["tokens"]["cached"] for r in rows.values())
        tout = sum(r["tokens"]["output"] for r in rows.values())
        costs = [r["cost"] for r in rows.values() if r["cost"] is not None]
        per_doc = sum(costs) / n if costs else None
        secs = sum(r["seconds"] for r in rows.values()) / n
        pct = f"{100 * agree / both:6.1f}%" if both else "     -"
        money = f"{per_doc:8.4f} {per_doc * args.daily_docs:8.2f}" if per_doc is not None else f"{'?':>8} {'?':>8}"
        print(f"{spec:40} {kept:5} {pct:>7} {errors:6} {tin:9,} {tc:8,} {tout:8,} {secs:6.1f} {money}")

    print("\nDisagreements with the reference (check these against the PDF):")
    for spec in specs:
        if spec == reference:
            continue
        for code, r in results[spec].items():
            mine = set(map(tuple, r["values"]))
            theirs = set(map(tuple, ref.get(code, {}).get("values", [])))
            if mine != theirs:
                print(f"  {spec} {code}: only here {sorted(mine - theirs)}; only in reference {sorted(theirs - mine)}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nfull results: {args.json}")


if __name__ == "__main__":
    main()
