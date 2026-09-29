#!/usr/bin/env python3
"""Score director_direct's consensus against reference readings of real 3Y notices.

The cache is JSON: {"text|<url>": notice text, "<model>|<url>": raw answer to
director_direct.SYSTEM_PROMPT}. It is replayed through validate_trade and
DirectorExtractor for three policies (consensus, primary only, checker only).
The reference is REFERENCE_MODEL's answer validated by the same code, so a
rule change is scored without new model calls. --fill adds any missing
answers through OpenRouter (needs OPENROUTER_API_KEY).

    python bench_director.py CACHE.json [--fill] [-v]

Measured 2026-09-29 on 56 notices: consensus 49 correct, 4 with the value
withheld, 3 withheld, 0 wrong trades or values; each single model made at
least one wrong trade.
"""
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import direct_extract as dx
import director_direct as dd

REFERENCE_MODEL = "anthropic/claude-opus-5.5"
MODELS = (dx.PRIMARY_MODEL, dx.CHECKER_MODEL, dx.ARBITER_MODEL, REFERENCE_MODEL)


class Replay:
    def __init__(self, cache: dict):
        self.cache, self.url = cache, ""

    def chat(self, model, system, user, usage=None, temperature=0.0):
        answer = self.cache.get(f"{model}|{self.url}", "")
        if answer.startswith("ERROR"):
            raise dx.ModelCallError(answer)
        return answer


def fill(cache: dict) -> None:
    client = dx.OpenRouter(api_key=os.environ["OPENROUTER_API_KEY"])
    urls = [k[5:] for k in cache if k.startswith("text|") and cache[k]]
    jobs = [(m, u) for m in MODELS for u in urls if f"{m}|{u}" not in cache]

    def run(job):
        m, u = job
        try:
            return job, client.chat(m, dd.SYSTEM_PROMPT, cache["text|" + u][:dd.TEXT_CHARS])
        except dx.ModelCallError as e:
            return job, f"ERROR {e}"

    with ThreadPoolExecutor(8) as pool:
        for (m, u), answer in pool.map(run, jobs):
            cache[f"{m}|{u}"] = answer


def score(cache: dict, verbose: bool) -> dict[str, Counter]:
    replay = Replay(cache)
    policies = {
        "consensus": dd.DirectorExtractor(client=replay),
        "primary-only": dd.DirectorExtractor(client=replay, checker=None),
        "checker-only": dd.DirectorExtractor(client=replay, primary=dx.CHECKER_MODEL, checker=None),
    }
    out = {}
    for name, ex in policies.items():
        t: Counter = Counter()
        for key in cache:
            if not key.startswith("text|") or not cache[key]:
                continue
            url = key[5:]
            text = cache[key][:dd.TEXT_CHARS]
            replay.url = url
            ref, ref_why = dd.validate_trade(dx.parse_answer(cache.get(f"{REFERENCE_MODEL}|{url}", "")), text,
                                             REFERENCE_MODEL)
            trade, _ = ex.extract(text)
            if ref is None:
                t["ref_none_we_none" if trade is None else "ref_none_we_wrote"] += 1
                continue
            t["ref_trades"] += 1
            if trade is None:
                t["withheld"] += 1
            elif not dd.same_trade(trade, ref):
                t["WRONG_TRADE"] += 1
                if verbose:
                    print(f"  [{name}] {url[-10:]} trade {dd._brief(trade, '')} ref {dd._brief(ref, ref_why)}")
            elif trade.total_value is None and ref.total_value is None or dd.same_value(trade.total_value, ref.total_value):
                t["correct"] += 1
            elif trade.total_value is None:
                t["correct_value_withheld"] += 1
            else:
                t["VALUE_DIFFERS"] += 1
                if verbose:
                    print(f"  [{name}] {url[-10:]} value {trade.total_value} ref {ref.total_value}")
        out[name] = t
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cache")
    ap.add_argument("--fill", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    with open(args.cache) as f:
        cache = json.load(f)
    if args.fill:
        fill(cache)
        with open(args.cache, "w") as f:
            json.dump(cache, f)
    for name, t in score(cache, args.verbose).items():
        print(f"{name:13} {dict(t)}")


if __name__ == "__main__":
    main()
