#!/usr/bin/env python3
"""Score notice_direct's consensus against the hand-read gold set (testdata/notices/gold.json).

The cache is JSON: {"<model>|<id>": the raw answer the model gave for that notice}. It is
replayed through validate_notice and NoticeExtractor for the consensus policy, so a rule or a
prompt change is scored without new model calls for the answers already cached. --fill adds any
missing answer through OpenRouter (needs OPENROUTER_API_KEY and the PDFs stored in the gold set;
a notice whose PDF is only linked is skipped with its reason).

    python bench_notices.py CACHE.json [--fill | --dry-run] [-v] [--json OUT] [--gold PATH]
        [--primary M] [--checker M] [--arbiter M] [--scan-primary M] [--scan-checker M]

The model names are the ones notice_direct reads with (EXTRACTOR_* and NOTICE_SCAN_* from the
environment, or the flags). Scoring and --fill both take them from the same place, so a cache filled
under one set of names is scored under the same set. --fill calls paid models and needs
NOTICE_BENCH_LIVE=1 and OPENROUTER_API_KEY; the scoring never does. --dry-run makes no call: it
prints how many answers --fill would ask for (cached or missing, per model) and scores the cache as
it is, so it needs no cache file.

For each gold notice the bench reports one of: correct (a reading that matches the hand reading
on every figure), wrong (a reading that disagrees with the hand reading on any figure: the bad
figure is the one that counts), withheld_correct (no reading, and the hand reading is none), or
withheld_missed (no reading, though a reading exists). Precision is per field over the readings
made: a field the reading states and gets right, over every field it states. A reading made where
the hand result is withheld is wrong on every field it states.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import direct_extract as dx
import notice_direct as nd
import os

HERE = Path(__file__).parent
GOLD = HERE / "testdata" / "notices" / "gold.json"
PENDING_READING = "awaiting hand reading"  # gold.json: no person has read this notice yet
BENCH_LIVE_ENV = "NOTICE_BENCH_LIVE"  # --fill calls paid models; it refuses unless this is "1"
FIELDS = ("form", "holder", "previous_pct", "present_pct", "previous_votes", "present_votes", "ceased", "event_date")


class ReplayClient:
    """Serves cached raw answers in place of OpenRouter. A missing answer is a model failure."""

    def __init__(self, cache: dict, current: dict):
        self.cache = cache
        self.current = current  # {model: entry id}, set per notice before the reads

    def chat(self, model, system, user, usage=None, temperature=0.0, images=None):
        key = f"{model}|{self.current['id']}"
        if key not in self.cache:
            raise dx.ModelCallError(f"no cached answer for {key}")
        return json.dumps(self.cache[key]) if isinstance(self.cache[key], dict) else self.cache[key]


def load_gold(path: Path = GOLD) -> list[dict]:
    return json.loads(path.read_text())["notices"]


def has_document(entry: dict) -> bool:
    """The stored file a reader is given: the PDF of a scan, the text of any other notice. A notice
    with no stored file (a scan over 300 KB, or one with no text) is skipped, never read from its
    directory: an empty path would name this folder, which always exists."""
    key = "pdf_file" if entry.get("scan") else "text_file"
    name = entry.get(key)
    return bool(name) and (HERE / name).is_file()


def document_for(entry: dict) -> tuple[str, bool, list[bytes] | None]:
    """The text and images a reader is given, from the gold set's stored files."""
    if entry["scan"]:
        pdf_path = HERE / entry["pdf_file"]
        images = nd.document_images(pdf_path.read_bytes(), 4)
        return "", True, images
    return (HERE / entry["text_file"]).read_text(), False, None


def same_field(name: str, got, want) -> bool:
    if want is None:
        return got is None
    if name == "holder":
        # the grouping key notice_direct stores by, never the text: "X Limited (PVM)" is X Limited
        return got is not None and nd.holder_same(got, want)
    if name in ("previous_pct", "present_pct"):
        return got is not None and abs(float(got) - float(want)) < 1e-6
    return got == want


def _got(notice: nd.Notice) -> dict:
    return {
        "form": notice.form,
        "holder": notice.holder_name,
        "previous_pct": notice.previous_pct,
        "present_pct": notice.present_pct,
        "previous_votes": notice.previous_votes,
        "present_votes": notice.present_votes,
        "ceased": notice.ceased,
        "event_date": notice.event_date,
    }


def score_one(entry: dict, notice: nd.Notice | None) -> tuple[str, dict[str, bool]]:
    reading = entry["reading"]
    if notice is None:
        return ("withheld_correct" if reading is None else "withheld_missed"), {}
    got = _got(notice)
    if reading is None:
        # The reader read a notice the hand reading withholds: every field it states is wrong.
        return "wrong", {f: False for f in FIELDS if got[f] is not None}
    want = {
        "form": reading["form"],
        "holder": reading["holder_name"],
        "previous_pct": reading.get("previous_pct"),
        "present_pct": reading.get("present_pct"),
        "previous_votes": reading.get("previous_votes"),
        "present_votes": reading.get("present_votes"),
        "ceased": reading.get("ceased", False),
        "event_date": reading.get("event_date"),
    }
    stated = {f: got[f] is not None for f in FIELDS}
    marks = {}
    for f in FIELDS:
        if stated[f]:
            marks[f] = same_field(f, got[f], want[f])
    return ("correct" if all(marks.values()) else "wrong"), marks


def score(cache: dict, verbose: bool, names: dict, gold_path: Path = GOLD) -> dict:
    results: Counter = Counter()
    per_field: dict[str, Counter] = {f: Counter() for f in FIELDS}
    rows = []
    for entry in load_gold(gold_path):
        if entry.get("reading_status") == PENDING_READING:
            rows.append((entry["id"], "skipped_pending_hand_reading"))
            results["skipped"] += 1
            continue
        if not has_document(entry):
            reason = "skipped_no_pdf" if entry.get("scan") else "skipped_no_text"
            rows.append((entry["id"], reason))
            results["skipped"] += 1
            continue
        text, scan, images = document_for(entry)
        client = ReplayClient(cache, {"id": entry["id"]})
        ex = nd.extractor_for(client, names)
        ctx = nd.ReadContext(text=text, images=images, headline=entry["headline"],
                             announced_on=entry["announced_on"], shares_on_issue=entry.get("shares_on_issue") or 0,
                             scan=scan, company_name=entry.get("company_name") or "")
        try:
            notice, outcome = ex.extract(ctx)
        except dx.ModelCallError as e:
            rows.append((entry["id"], f"uncached: {e}"))
            results["uncached"] += 1
            continue
        verdict, marks = score_one(entry, notice)
        results[verdict] += 1
        for f, ok in marks.items():
            per_field[f]["right" if ok else "wrong"] += 1
        rows.append((entry["id"], f"{verdict} ({outcome})"))
    precision = {f: (c["right"] / (c["right"] + c["wrong"]) if (c["right"] + c["wrong"]) else None)
                 for f, c in per_field.items()}
    readings = results["correct"] + results["wrong"]
    total = sum(results[k] for k in ("correct", "wrong", "withheld_correct", "withheld_missed"))
    summary = {
        "notices": total,
        "correct": results["correct"],
        "wrong": results["wrong"],
        "withheld_correct": results["withheld_correct"],
        "withheld_missed": results["withheld_missed"],
        "skipped": results["skipped"],
        "uncached": results["uncached"],
        "withheld_rate": (results["withheld_correct"] + results["withheld_missed"]) / total if total else None,
        "readings": readings,
        "precision_per_field": precision,
        "models": names,
    }
    if verbose:
        for rid, verdict in rows:
            print(f"{rid:40s} {verdict}")
    return summary


def names_from_args(args: argparse.Namespace, environ=None) -> dict:
    """The model names the bench scores and fills with: the environment's, with any flag overriding."""
    names = nd.model_names_from_env(environ)
    for key in nd.MODEL_KEYS:
        flag = getattr(args, key, None)
        if flag is not None:
            names[key] = flag or None
    return names


def calls_for(entry: dict, names: dict) -> list[str]:
    """The models the consensus asks about this gold notice (a scan has its vision pair only)."""
    if entry["scan"]:
        models = (names["scan_primary"], names["scan_checker"])
    else:
        models = (names["primary"], names["checker"], names["arbiter"])
    return [m for m in models if m]


def plan(cache: dict, names: dict, gold_path: Path = GOLD) -> dict:
    """What --fill would ask for, from the cache as it is. Makes no model call."""
    counts: Counter = Counter()
    for entry in load_gold(gold_path):
        if entry.get("reading_status") == PENDING_READING:
            continue
        if not has_document(entry):
            continue
        for model in calls_for(entry, names):
            counts["cached" if f"{model}|{entry['id']}" in cache else "missing"] += 1
    return {"answers_cached": counts["cached"], "answers_missing": counts["missing"], "models": names}


def fill(cache: dict, names: dict, gold_path: Path = GOLD) -> None:
    """Asks the models for every gold notice whose answer is not cached (paid: NOTICE_BENCH_LIVE=1)."""
    if os.environ.get(BENCH_LIVE_ENV) != "1":
        sys.exit(f"--fill calls paid models: set {BENCH_LIVE_ENV}=1 to run it")
    key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if not key:
        sys.exit("OPENROUTER_API_KEY is not set")
    ex = nd.extractor_for(dx.OpenRouter(api_key=key), names)
    for entry in load_gold(gold_path):
        if entry.get("reading_status") == PENDING_READING:
            continue
        if not has_document(entry):
            continue
        text, scan, images = document_for(entry)
        # a scan is read by the two vision readers only (no arbiter), a text notice by the three
        models = (ex.scan_primary, ex.scan_checker) if scan else (ex.primary, ex.checker, ex.arbiter)
        for model in models:
            if not model or f"{model}|{entry['id']}" in cache:
                continue
            user = text[:nd.TEXT_CHARS] if not scan else nd.SCAN_USER_MESSAGE
            cache[f"{model}|{entry['id']}"] = dx.parse_answer(ex.client.chat(model, nd.SYSTEM_PROMPT, user, images=images))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cache", nargs="?", help="the answers cache (JSON); a dry run may omit it")
    ap.add_argument("--fill", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="make no model call; print the plan and score the cache")
    ap.add_argument("--gold", type=Path, default=GOLD, help="the gold set (default testdata/notices/gold.json)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--json", help="write the summary here")
    ap.add_argument("--primary", help="override EXTRACTOR_PRIMARY_MODEL")
    ap.add_argument("--checker", help="override EXTRACTOR_CHECKER_MODEL")
    ap.add_argument("--arbiter", help="override EXTRACTOR_ARBITER_MODEL")
    ap.add_argument("--scan-primary", dest="scan_primary", help="override NOTICE_SCAN_PRIMARY_MODEL")
    ap.add_argument("--scan-checker", dest="scan_checker", help="override NOTICE_SCAN_CHECKER_MODEL")
    args = ap.parse_args()
    if args.fill and args.dry_run:
        sys.exit("--fill and --dry-run are exclusive")
    if args.fill and not args.cache:
        # Checked before any model call: --fill writes its answers to the cache, so without a file
        # the paid answers would be lost when the write fails.
        sys.exit("--fill writes the answers it asks for to a cache file: name one (CACHE.json)")
    names = names_from_args(args)
    cache_path = Path(args.cache) if args.cache else None
    cache = json.loads(cache_path.read_text()) if cache_path and cache_path.exists() else {}
    if args.fill:
        fill(cache, names, args.gold)
        cache_path.write_text(json.dumps(cache, indent=1, sort_keys=True))
    if args.dry_run:
        print(json.dumps({"plan": plan(cache, names, args.gold)}, indent=2, sort_keys=True))
    summary = score(cache, args.verbose, names, args.gold)
    text = json.dumps(summary, indent=2, sort_keys=True, default=str)
    print(text)
    if args.json:
        Path(args.json).write_text(text)


if __name__ == "__main__":
    main()
