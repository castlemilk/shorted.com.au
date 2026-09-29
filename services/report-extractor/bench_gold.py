#!/usr/bin/env python3
"""Reference answers + scoring for bench_models.py, on what downstream reads.

The picks filings step (services/jobs/internal/jobs/picks/filings_ingest.go)
reads only three figures out of an extraction: revenue, net profit and EPS
(filingMetricClasses maps the aliases). "More values" is not better — a wrong
number under one of those classes is a wrong fundamental. So each model is
scored per document on those three:

  hit    the reference value is among the values it filed under that class
  wrong  it filed a value under that class that is not the reference value
         (a segment figure, a prior-period comparative, an NTA per unit…)
  miss   the reference exists and it filed nothing under that class

    # 1. reference answers (strong model, full text, reads every figure it states)
    OPENROUTER_API_KEY=... python bench_gold.py gold --out gold.json CODE=URL ...
    # 2. score a bench_models.py --json result against them
    python bench_gold.py score --gold gold.json bench.json [bench2.json ...]
    # 3. the alternative mechanism: one direct call per document, no chunking
    python bench_gold.py gold --model qwen/qwen3.8-flash --as-results --out direct.json CODE=URL ...

The reference is itself a model's answer. Every reference value is checked to
appear in the document text (a value not in the text is dropped as unverifiable)
and the file is small enough to eyeball — do.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

import requests

from extract import ASX_HEADERS, DEFAULT_MAX_PAGES, canonical_number, download_pdf_text, numbers_in

# filingMetricClasses in filings_ingest.go, inverted to the three targets.
ALIASES = {
    "revenue": {"revenue", "total_revenue"},
    "net_profit": {"net_profit", "npat", "net_income", "statutory_npat"},
    "eps": {"eps", "basic_eps", "diluted_eps", "earnings_per_share"},
}
VALUE_KEY = {"revenue": "value_millions", "net_profit": "value_millions", "eps": "value_cents"}

GOLD_MODEL = "anthropic/claude-opus-5.5"

PROMPT = """You are building a reference answer for testing a financial extractor.
Below is the text of the first {pages} pages of an ASX filing by {code}.

Report, for the MOST RECENT reporting period and for the WHOLE GROUP (never a
segment, division or brand), exactly as stated in this text:
  revenue      statutory revenue (or total revenue / sales revenue if that is the
               headline revenue line), in millions of the reporting currency
  net_profit   statutory net profit after tax (a loss is negative), in millions
  eps          basic earnings per share, in cents (a loss per share is negative)

Rules:
- Only figures stated in this text. Never compute, convert units beyond
  thousands->millions / dollars->cents, or use a prior-period comparative.
- If a figure is not stated for the group in this text, use null.
- For each figure also give the shortest verbatim quote containing it.

Reply with JSON only:
{{"period": "...", "revenue": {{"value": <number|null>, "quote": "..."}},
  "net_profit": {{"value": <number|null>, "quote": "..."}},
  "eps": {{"value": <number|null>, "quote": "..."}}}}

TEXT:
{text}
"""


def request(args: argparse.Namespace, code: str, text: str) -> dict:
    return dict(
        model=args.model,
        messages=[{"role": "user", "content": PROMPT.format(pages=args.max_pages, code=code, text=text[:50000])}],
        response_format={"type": "json_object"},
        temperature=0.0,
        extra_body={"usage": {"include": True}},
    )


def gold(args: argparse.Namespace) -> None:
    import openai

    client = openai.OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])
    session = requests.Session()
    session.headers.update(ASX_HEADERS)
    out = {}
    for item in args.docs:
        code, url = item.split("=", 1)
        text = download_pdf_text(session, url, max_pages=args.max_pages) or ""
        if not text:
            print(f"{code}: fetch failed", file=sys.stderr)
            continue
        resp = None
        for attempt in range(6):  # upstream 429s on OpenRouter are common and short-lived
            try:
                resp = client.chat.completions.create(**request(args, code, text))
                break
            except openai.RateLimitError:
                time.sleep(10 * (attempt + 1))
        if resp is None:
            print(f"{code}: rate-limited on every attempt; skipped", file=sys.stderr)
            continue
        billed = getattr(resp.usage, "cost", None) or (getattr(resp.usage, "model_extra", None) or {}).get("cost")
        raw = resp.choices[0].message.content or "{}"
        try:
            ans = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        except ValueError:
            print(f"{code}: unparseable reference answer", file=sys.stderr)
            continue
        entry = {"period": ans.get("period"), "url": url, "cost": billed,
                 "tokens": {"prompt": getattr(resp.usage, "prompt_tokens", 0), "output": getattr(resp.usage, "completion_tokens", 0)}}
        for target in ALIASES:
            v = (ans.get(target) or {}).get("value")
            quote = (ans.get(target) or {}).get("quote") or ""
            if v is None:
                entry[target] = None
                continue
            c = canonical_number(str(abs(v)))
            # Verifiable only if the number is in the document text — as
            # written, or in the thousands / dollars it was converted from.
            present = numbers_in(text)
            scaled = {canonical_number(f"{abs(v) * k:.6f}") for k in (1000, 100, 1_000_000)}
            if c and (c in present or scaled & present):
                entry[target] = {"value": canonical_number(str(v)), "quote": quote}
            else:
                print(f"{code}: {target}={v} not found in text; dropped", file=sys.stderr)
                entry[target] = None
        out[code] = entry
        print(f"{code}: {json.dumps({t: (entry[t] or {}).get('value') for t in ALIASES})}", file=sys.stderr)
    if args.as_results:
        # bench_models.py result shape, so `score` can grade a direct-prompt
        # run beside the langextract runs.
        unit = {"revenue": "value_millions", "net_profit": "value_millions", "eps": "value_cents"}
        out = {f"direct:{args.model}": {
            code: {"error": None, "cost": e.get("cost"), "tokens": e.get("tokens"), "metrics": {
                t: {unit[t]: e[t]["value"], "source_text": e[t]["quote"]} for t in ALIASES if e.get(t)}}
            for code, e in out.items()}}
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)


def filed_values(metrics: dict, target: str) -> set[str]:
    vals = set()
    for cls, entry in metrics.items():
        if cls not in ALIASES[target]:
            continue
        for e in entry if isinstance(entry, list) else [entry]:
            v = e.get(VALUE_KEY[target])
            if v is None:
                continue
            c = canonical_number(str(v))
            if c:
                vals.add(c)
    return vals


def same_figure(a: str, b: str) -> bool:
    """Two canonical numbers name the same figure, allowing the unit a filing
    states it in. Grounding (value_in_span) only stores the number as written,
    so a company reporting in $'000 is stored as thousands; that is a unit
    question the picks gates resolve, not an extraction error, and it affects
    every model alike. Within 0.5% after a power-of-ten rescale, so a
    rounded restatement ("$25.0m" for 25,040 thousand) matches."""
    try:
        x, y = float(a), float(b)
    except ValueError:
        return False
    if x == 0 or y == 0:
        return x == y
    for k in (1e-6, 1e-3, 1e-2, 1, 1e2, 1e3, 1e6):
        if abs(x * k - y) <= 0.005 * abs(y):
            return True
    return False


def score(args: argparse.Namespace) -> None:
    ref = json.load(open(args.gold))
    tallies: dict = defaultdict(lambda: defaultdict(int))
    detail: list[str] = []
    for path in args.results:
        for spec, docs in json.load(open(path)).items():
            for code, d in docs.items():
                if code not in ref:
                    continue
                t = tallies[spec]
                t["docs"] += 1
                t["errors"] += 1 if d.get("error") else 0
                t["cost"] += d.get("cost") or 0
                for target in ALIASES:
                    want = (ref[code].get(target) or {}).get("value")
                    have = filed_values(d.get("metrics") or {}, target)
                    # canonical_number drops the sign, so a loss and a profit of
                    # the same size compare equal; the grounding filter already
                    # requires the number to be in the quoted span.
                    if want is not None:
                        t["targets"] += 1
                        right = {h for h in have if same_figure(h, want)}
                        if right:
                            t["hit"] += 1
                            t["wrong"] += len(have - right)
                        elif have:
                            t["wrong"] += len(have)
                            detail.append(f"{spec:42} {code:4} {target:10} ref {want:>8}  filed {sorted(have)}")
                        else:
                            t["miss"] += 1
                    elif have:
                        t["wrong"] += len(have)
                        detail.append(f"{spec:42} {code:4} {target:10} ref {'none':>8}  filed {sorted(have)}")
    n_ref = sum(1 for c in ref.values() for t in ALIASES if c.get(t))
    print(f"{len(ref)} documents, {n_ref} reference figures (revenue / NPAT / EPS stated in the first pages)\n")
    print(f"{'model':42} {'docs':>4} {'err':>4} {'hit':>4} {'miss':>5} {'wrong':>6} {'recall':>7} {'$ total':>8}")
    for spec, t in sorted(tallies.items(), key=lambda kv: (-kv[1]["hit"], kv[1]["wrong"])):
        recall = f"{100 * t['hit'] / t['targets']:6.1f}%" if t["targets"] else "     -"
        print(f"{spec:42} {t['docs']:4} {t['errors']:4} {t['hit']:4} {t['miss']:5} {t['wrong']:6} {recall:>7} {t['cost']:8.4f}")
    if args.detail:
        print("\nWrong or unexpected values:")
        print("\n".join(detail))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gold")
    g.add_argument("docs", nargs="+", help="CODE=URL")
    g.add_argument("--out", required=True)
    g.add_argument("--model", default=GOLD_MODEL)
    g.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    g.add_argument("--as-results", action="store_true",
                   help="write bench_models.py-shaped results (to score a cheap model's direct answers)")
    s = sub.add_parser("score")
    s.add_argument("results", nargs="+")
    s.add_argument("--gold", required=True)
    s.add_argument("--detail", action="store_true")
    args = ap.parse_args()
    gold(args) if args.cmd == "gold" else score(args)


if __name__ == "__main__":
    main()
