#!/usr/bin/env python3
"""Evaluate direct_extract (prompt + validation + consensus) against references.

    OPENROUTER_API_KEY=... python bench_direct.py --gold gold.json --cache answers.json \\
        --model deepseek/deepseek-v4-flash --model google/gemini-2.5-flash-lite \\
        --model google/gemini-2.5-flash

Every model answers every document ONCE (cached in --cache, so re-running with
different policies costs nothing). Then each single model and each consensus
policy (primary / checker / arbiter, lax or strict) is scored with
bench_gold's revenue / NPAT / EPS scoring, and validation drops are summed per
model. Use this when changing SYSTEM_PROMPT, validate_figure or reconcile.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import requests

import bench_gold
import direct_extract as dx
import extract
from token_usage import TokenUsage


def fig_to_json(f: dx.Figure) -> dict:
    return f.__dict__.copy()


def fig_from_json(d: dict) -> dx.Figure:
    return dx.Figure(**d)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--primary", default=dx.PRIMARY_MODEL)
    ap.add_argument("--checker", action="append", default=[], help="checker model(s) to evaluate (default: every non-primary --model)")
    ap.add_argument("--arbiter", default=dx.ARBITER_MODEL)
    ap.add_argument("--daily-docs", type=int, default=120)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    gold = json.load(open(args.gold))
    try:
        cache = json.load(open(args.cache))
    except (OSError, ValueError):
        cache = {}
    client = dx.OpenRouter(api_key=os.environ["OPENROUTER_API_KEY"])
    ex = dx.DirectExtractor(client=client, denylist=extract.FEWSHOT_DENYLIST)
    session = requests.Session()
    session.headers.update(extract.ASX_HEADERS)
    texts = {}
    for code, g in gold.items():
        t = extract.download_pdf_text(session, g["url"], max_pages=extract.DEFAULT_MAX_PAGES)
        if t:
            texts[code] = t

    jobs = [(m, c) for m in args.model for c in texts if f"{m}|{c}" not in cache]

    def run(job):
        m, c = job
        u = TokenUsage()
        try:
            a = ex.ask(m, texts[c], c, u)
            return job, {"raw": a.raw, "figures": [fig_to_json(f) for f in a.figures], "rejected": dict(a.rejected),
                         "is_results": a.is_results, "cost": u.cost_usd, "prompt": u.prompt,
                         "output": u.candidates + u.thoughts, "error": None}
        except dx.ModelCallError as e:
            return job, {"figures": [], "rejected": {}, "is_results": None, "cost": u.cost_usd,
                         "prompt": u.prompt, "output": 0, "error": str(e)[:200]}

    with ThreadPoolExecutor(args.workers) as pool:
        for (m, c), res in pool.map(run, jobs):
            cache[f"{m}|{c}"] = res
            print(f"{m:36} {c:5} figures={len(res['figures'])} rejected={res['rejected']} "
                  f"{'ERR ' + res['error'] if res['error'] else ''}", file=sys.stderr)
            json.dump(cache, open(args.cache, "w"))

    def answer(m: str, c: str) -> dx.Answer:
        # Re-validate the cached RAW answer, so validation changes are scored
        # without new model calls (entries cached before raw was kept replay
        # their validated figures).
        r = cache[f"{m}|{c}"]
        if "raw" not in r:
            return dx.Answer(m, r["is_results"], [fig_from_json(f) for f in r["figures"]], Counter(r["rejected"]))
        figs, rej = [], Counter()
        for raw in r["raw"]:
            f, why = dx.validate_figure(raw, texts[c][:dx.TEXT_CHARS], m, extract.FEWSHOT_DENYLIST)
            (figs.append(f) if f else rej.update([why]))
        return dx.Answer(m, r["is_results"], figs, rej, r["raw"])

    results: dict = defaultdict(dict)
    per_model_cost = {m: sum(cache[f"{m}|{c}"]["cost"] for c in texts) / max(len(texts), 1) for m in args.model}
    for m in args.model:
        for c in texts:
            recs, _ = dx.reconcile(answer(m, c), None, None)
            results[f"single:{m}"][c] = {"metrics": extract.extractions_to_metrics(recs), "cost": cache[f"{m}|{c}"]["cost"],
                                         "error": cache[f"{m}|{c}"]["error"]}
    checkers = args.checker or [m for m in args.model if m not in (args.primary, args.arbiter)]
    policy_counts = {}
    for chk in checkers:
        for strict in (False, True):
            name = f"consensus:{args.primary.split('/')[-1]}+{chk.split('/')[-1]}{'+strict' if strict else ''}"
            tally: Counter = Counter()
            for c in texts:
                arb_used = []

                def arb(c=c, arb_used=arb_used):
                    arb_used.append(1)
                    return answer(args.arbiter, c) if args.arbiter in args.model else None

                recs, counts = dx.reconcile(answer(args.primary, c), answer(chk, c), arb, strict=strict)
                tally.update(counts)
                cost = cache[f"{args.primary}|{c}"]["cost"] + cache[f"{chk}|{c}"]["cost"] + (
                    cache[f"{args.arbiter}|{c}"]["cost"] if arb_used and args.arbiter in args.model else 0)
                results[name][c] = {"metrics": extract.extractions_to_metrics(recs), "cost": cost, "error": None}
            policy_counts[name] = dict(tally)

    out = args.cache.replace(".json", "") + ".scored.json"
    json.dump(results, open(out, "w"), default=str)
    ns = argparse.Namespace(gold=args.gold, results=[out], detail=True)
    bench_gold.score(ns)
    print("\nValidation drops per model (all documents):")
    for m in args.model:
        drops: Counter = Counter()
        for c in texts:
            drops.update(answer(m, c).rejected)
        print(f"  {m:36} {dict(drops)}  avg ${per_model_cost[m]:.5f}/doc  ${per_model_cost[m] * args.daily_docs:.2f}/night")
    print("\nConsensus outcomes:")
    for name, t in policy_counts.items():
        print(f"  {name:60} {t}")


if __name__ == "__main__":
    main()
