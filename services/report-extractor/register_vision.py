#!/usr/bin/env python3
"""Vision OCR tier for scanned register PDFs, backed by the local `agy` CLI.

WHY A CLI AND NOT THE GEMINI API
--------------------------------
`agy` fronts the same Gemini models but authenticates as the operator, so this
tier needs no GEMINI_API_KEY and carries no per-token billing. That makes it an
OPERATOR-MACHINE tier by construction: the report-extractor container is
python-slim and has no `agy` binary, so `--stage vision` cannot run in Cloud Run.
The runbook in docs/politician-register-architecture.md says so explicitly.

`--sandbox` is MANDATORY and `--dangerously-skip-permissions` is FORBIDDEN. The
latter disables agy's own approval gate; it is blocked by this environment's
safety classifier and a test asserts it never appears in the argv.

EDITORIAL (influence-editorial-standards rule 5)
-----------------------------------------------
The model is asked to TRANSCRIBE, never to value. No numeric field exists in the
artifact and none may be added. A figure printed on the form is copied verbatim
into declared_text; `contains_amount` is then computed HERE, by regex over our
own transcription, and never requested from the model — a model-supplied boolean
would be an opinion where we need a measurement. A spike in the rate is a
hallucination signal, not data.

A nil row ("Not Applicable") is STORED, never dropped. "Declared nothing" is a
fact, and the stored row is what proves the tier actually read that item rather
than skipping it.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from typing import Optional

import fitz  # pymupdf

from register_parse import AMOUNT_RE, Item, ParsedDocument, Row, Statement
from register_schema import (
    CHANGE_ADDITION,
    CHANGE_DECLARED,
    CHANGE_DELETION,
    HOLDER_DEPENDENT,
    HOLDER_SELF,
    HOLDER_SPOUSE,
    HOLDER_UNSPECIFIED,
    ITEM_LABELS,
    STATEMENT_ALTERATION,
    STATEMENT_BASE,
    is_nil_value,
)

log = logging.getLogger("register_vision")

# ---------------------------------------------------------------------------
# Tuning — every number here was measured, not guessed
# ---------------------------------------------------------------------------

VISION_MODEL_DEFAULT = "gemini-3.6-flash-low"

# 150dpi renders a 1148x1755 page, which transcribed a 0-chars/page scan with
# 100% accuracy in the probe. Higher costs latency for no measured gain.
VISION_RASTER_DPI = 150

# BATCHING IS THE THROUGHPUT LEVER, NOT CONCURRENCY. ~10-16s of the per-call cost
# is fixed CLI startup, so 4 pages per call measured 7.8s/page against 12.9s/page
# one-at-a-time. 4 also keeps a table that spans a page break inside one context.
VISION_BATCH_PAGES = 4
VISION_MAX_BATCH_PAGES = 6

# Measured throughput: 4-way 0.204 job/s, 8-way 0.229, 16-way 0.145 — a
# REGRESSION past 8, and calls queue server-side rather than erroring, so
# over-concurrency is invisible except as latency. Clamped in code, not left to
# the operator.
VISION_CONCURRENCY_DEFAULT = 4
VISION_CONCURRENCY_MAX = 8

# --print-timeout bounds the response wait, NOT wall clock (a 1s value still
# burned 13.9s). The subprocess timeout is the real bound.
VISION_PRINT_TIMEOUT_S = 240
VISION_SUBPROCESS_SLACK_S = 90

# One retry, then the batch is split to single pages: a batch usually fails
# because one page in it is pathological.
VISION_MAX_ATTEMPTS = 2

# A base statement should surface most of the 14 items, nil rows included.
VISION_MIN_BASE_ITEMS = 8

# contains_amount is a hallucination tripwire — but only for the items where the
# form asks WHAT is held and never how much.
#
# Items 11 (gifts) and 12 (sponsored travel) are different: the form itself asks
# for a value, and real declarations read "total value $500" / "valued at $370 ex
# GST". Measured on Aly_47P: 2 of 25 rows carried an amount, both in items 11/12,
# both genuine. Counting them tripped the gate at 8% and quarantined a correct
# document. An amount in item 1 or item 3 is still anomalous and still trips.
VISION_MAX_AMOUNT_PCT = 2.0
VISION_AMOUNT_EXEMPT_ITEMS = frozenset({11, 12})

# The form's holder labels, and the wordings the model returns for them.
VISION_HOLDER_MAP = {
    "self": HOLDER_SELF,
    "spouse/partner": HOLDER_SPOUSE,
    "spouse": HOLDER_SPOUSE,
    "spouse or partner": HOLDER_SPOUSE,
    "spouse_partner": HOLDER_SPOUSE,
    "partner": HOLDER_SPOUSE,
    "dependent children": HOLDER_DEPENDENT,
    "dependent child": HOLDER_DEPENDENT,
    "dependent_children": HOLDER_DEPENDENT,
    "children": HOLDER_DEPENDENT,
}

VISION_CHANGE_MAP = {
    "declared": CHANGE_DECLARED,
    "addition": CHANGE_ADDITION,
    "added": CHANGE_ADDITION,
    "deletion": CHANGE_DELETION,
    "deleted": CHANGE_DELETION,
}


class VisionError(RuntimeError):
    """Terminal failure for one batch. Its pages stay unattributed, which lowers
    page_coverage_pct and pushes the document to 'partial' — quarantined rather
    than published as though the member declared nothing."""


class VisionUnavailable(RuntimeError):
    """`agy` is not installed. Raised once, before any work."""


class VisionQuotaExhausted(RuntimeError):
    """The agy subscription quota is spent.

    Distinct from VisionError because it is not per-batch and not retryable: every
    subsequent call in the run will fail the same way. Measured 2026-07-26 — a
    bulk run over 367 documents exhausted the quota after 16 documents (~200
    pages) and then logged 266 identical failures while marking real documents as
    0%-coverage partials. Same posture as the APH 403: stop, do not hammer on.
    """


# agy's wording, matched loosely so a rephrasing still trips it.
_QUOTA_RE = re.compile(r"quota reached|upgrade your subscription", re.I)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_NUM_WORDS = {1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE", 6: "SIX"}

# Every clause earns its place. The completeness sentence and the closed holder
# vocabulary are what stop the model summarising instead of transcribing.
_PROMPT = """You are transcribing scanned pages of an Australian federal Register of \
Members'/Senators' Interests form. Transcribe ONLY what is printed. Never summarise, \
never infer, never omit a row.

Read these {n_word} image(s), in order:
{image_list}

FORM STRUCTURE. Numbered items 1-14. Each item is a table whose rows are labelled \
Self, Spouse/partner, Dependent children. An item may have MULTIPLE sub-tables \
(item 2 has 2.i and 2.ii) — emit every holder row of every sub-table, in page order. \
An alteration page has ADDITION and DELETION sections instead; use change_type \
"addition" or "deletion" there, otherwise "declared".

RULES
1. Transcribe every cell VERBATIM, including "Not Applicable", "Nil", "N/A", \
"Same as above". Never replace a cell with a summary.
2. Emit one object per holder row you can see. Do not merge rows. Do not invent \
rows for holders that are not printed.
3. declared_text = the FIRST value column. secondary_text = the second column if \
the table has one (item 3 "Purpose", item 6 "Creditor"), else "".
4. If a value cell contains several entries on separate physical lines, put each \
line in declared_lines and join them with "; " in declared_text.
5. If a cell shows a dollar amount, transcribe it verbatim into declared_text. \
Do NOT create any numeric field. We record what is held, never how much.
6. page_no = the 1-based index of the image in the list above (1..{n}).
7. If a page is not a numbered-item table (a cover, a signature page, a blank), \
emit nothing for it.

Return ONLY a JSON object. No prose, no markdown fence:
{{"rows":[{{"page_no":int,"item_no":int,"holder":"self|spouse/partner|dependent children",\
"change_type":"declared|addition|deletion","declared_text":string,"secondary_text":string,\
"declared_lines":[string]}}]}}"""


def build_prompt(image_paths: list[str]) -> str:
    listing = "\n".join(f"  {i + 1}. {p}" for i, p in enumerate(image_paths))
    n = len(image_paths)
    return _PROMPT.format(
        n=n, n_word=_NUM_WORDS.get(n, str(n)), image_list=listing
    )


# ---------------------------------------------------------------------------
# The agy invocation
# ---------------------------------------------------------------------------


def agy_argv(prompt: str, workdir: str, model: str) -> list[str]:
    """Build the argv.

    --sandbox is not optional. It keeps agy's own tool-approval gate on, which is
    what makes running a model over untrusted scanned documents acceptable. There
    is a test asserting "dangerously" never appears in this list.
    """
    return [
        "agy",
        "-p",
        prompt,
        "--model",
        model,
        "--add-dir",
        workdir,
        "--sandbox",
        "--print-timeout",
        f"{VISION_PRINT_TIMEOUT_S}s",
    ]


def require_agy() -> str:
    path = shutil.which("agy")
    if not path:
        raise VisionUnavailable(
            "the `agy` CLI is not on PATH. The vision tier runs on an operator "
            "machine, not in the report-extractor container."
        )
    return path


def extract_json_object(stdout: str) -> dict:
    """Pull the JSON object out of agy's stdout.

    Brace-matched from the LAST '{' that yields a parse, scanning backwards. Not
    last-line parsing: the reply can carry a trailing blank line, a ```json fence,
    or a one-line preamble, and any of those would break a naive tail read. A
    fence is stripped by the brace scan for free.
    """
    text = stdout.strip()
    if not text:
        raise VisionError("agy returned empty stdout")

    # Scan FORWARD and brace-match, so we return the OUTERMOST object. Scanning
    # backwards from the last '{' finds the innermost one instead — for
    # {"rows":[{"item_no":1}]} that is {"item_no":1}, which parses cleanly and is
    # the wrong answer. String-aware, so a '}' inside a declared_text value
    # cannot end the match early.
    for start in (i for i, ch in enumerate(text) if ch == "{"):
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break  # not valid JSON from here; try the next '{'
                    if isinstance(obj, dict):
                        return obj
                    break
    raise VisionError(f"no JSON object in agy output: {text[:300]!r}")


def run_batch(
    image_paths: list[str], workdir: str, model: str
) -> list[dict]:
    """Invoke agy over one batch of page images and return its raw row dicts."""
    argv = agy_argv(build_prompt(image_paths), workdir, model)
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=VISION_PRINT_TIMEOUT_S + VISION_SUBPROCESS_SLACK_S,
        )
    except subprocess.TimeoutExpired as exc:
        raise VisionError(f"agy timed out after {exc.timeout}s") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "")[:300]
        # Quota is terminal for the whole run, not for this batch. Retrying it
        # burns nothing but time and leaves a trail of 0%-coverage documents that
        # look like unreadable scans.
        if _QUOTA_RE.search(detail):
            raise VisionQuotaExhausted(detail.strip())
        raise VisionError(f"agy exit {proc.returncode}: {detail}")

    payload = extract_json_object(proc.stdout)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise VisionError("payload has no 'rows' list")
    return [r for r in rows if isinstance(r, dict)]


# ---------------------------------------------------------------------------
# Payload -> our dataclasses
# ---------------------------------------------------------------------------


def _clean(value) -> str:
    return " ".join(str(value or "").split())


def normalise_row(raw: dict, page_offset: int) -> Optional[tuple[int, int, Row]]:
    """One payload dict -> (page_no, item_no, Row), or None if unusable.

    Rows are dropped rather than guessed at: an item_no we cannot trust would
    attach a real declaration to the wrong item of the form.
    """
    try:
        item_no = int(raw.get("item_no"))
    except (TypeError, ValueError):
        return None
    if item_no not in ITEM_LABELS:
        return None

    holder = VISION_HOLDER_MAP.get(_clean(raw.get("holder")).casefold())
    if holder is None:
        holder = HOLDER_UNSPECIFIED

    change_type = VISION_CHANGE_MAP.get(
        _clean(raw.get("change_type")).casefold(), CHANGE_DECLARED
    )

    lines = raw.get("declared_lines")
    declared_lines = [_clean(x) for x in lines if _clean(x)] if isinstance(lines, list) else []
    declared_text = _clean(raw.get("declared_text")) or "; ".join(declared_lines)
    if not declared_lines and declared_text:
        declared_lines = [declared_text]

    try:
        page_no = int(raw.get("page_no", 1))
    except (TypeError, ValueError):
        page_no = 1
    page_no = page_offset + max(1, page_no)

    row = Row(
        holder=holder,
        change_type=change_type,
        ordinal=0,  # assigned per item after grouping
        declared_text=declared_text,
        secondary_text=_clean(raw.get("secondary_text")),
        is_nil=is_nil_value(declared_text),
        page_no=page_no,
        declared_lines=declared_lines,
        # Computed from OUR transcription, never taken from the model.
        contains_amount=bool(AMOUNT_RE.search(declared_text)),
    )
    return page_no, item_no, row


def to_parsed(
    raw_rows: list[dict], page_offset: int, page_count: int, pages_read: int
) -> ParsedDocument:
    """Fold payload rows into a single-statement ParsedDocument.

    ONE base statement, deliberately. The vision tier does not attempt to split a
    scanned document into base + alterations: a mis-split would attribute an
    ADDITION to the wrong period, and the interval fold treats an unsplit
    document as one declaration with an unknown start — which is the honest
    reading when we cannot see the section boundaries.
    """
    by_item: dict[int, list[Row]] = {}
    for raw in raw_rows:
        parsed = normalise_row(raw, page_offset)
        if parsed is None:
            continue
        _page_no, item_no, row = parsed
        by_item.setdefault(item_no, []).append(row)

    items: list[Item] = []
    for item_no in sorted(by_item):
        rows = by_item[item_no]
        for ordinal, row in enumerate(rows):
            row.ordinal = ordinal
        items.append(
            Item(
                item_no=item_no,
                item_label=ITEM_LABELS[item_no],
                page_no=min(r.page_no for r in rows),
                rows=rows,
            )
        )

    statement = Statement(
        ordinal=0,
        kind=STATEMENT_BASE,
        page_from=1,
        page_to=page_count,
        lodged_date=None,
        # The scanned form puts the date in a signature block we do not parse.
        # An unknown start stays unknown rather than being back-filled with the
        # parliament's opening, which would fabricate the start of a real
        # person's holding.
        date_is_stated=False,
        items=items,
    )
    return ParsedDocument(
        statements=[statement] if items else [],
        warnings=[],
        pages_attributed=pages_read,
    )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def rasterise(pdf_path: str, page_numbers: list[int], outdir: str, dpi: int = VISION_RASTER_DPI) -> dict[int, str]:
    """Render the given 1-based pages to PNGs. Returns page_no -> path.

    The falsy-path guard is not defensive padding. `fitz.open(None)` returns a
    NEW EMPTY DOCUMENT instead of raising, so passing a None path produced an
    empty result set, zero page coverage and a 'partial' document — with no error
    anywhere. Exactly the silent under-extraction the coverage gate exists to
    catch, arriving through a route the gate could not distinguish from a genuinely
    unreadable scan.
    """
    if not pdf_path:
        raise VisionError("rasterise called with an empty pdf_path")

    out: dict[int, str] = {}
    with fitz.open(pdf_path) as doc:
        if doc.page_count == 0:
            raise VisionError(f"{pdf_path} opened with zero pages")
        for page_no in page_numbers:
            if page_no < 1 or page_no > doc.page_count:
                continue
            pix = doc[page_no - 1].get_pixmap(dpi=dpi)
            path = os.path.join(outdir, f"page{page_no:04d}.png")
            pix.save(path)
            out[page_no] = path
    return out


def batches(items: list[int], size: int) -> list[list[int]]:
    size = max(1, min(size, VISION_MAX_BATCH_PAGES))
    return [items[i : i + size] for i in range(0, len(items), size)]


def vision_pages(
    pdf_path: str,
    page_numbers: list[int],
    page_count: int,
    model: str = VISION_MODEL_DEFAULT,
    batch_size: int = VISION_BATCH_PAGES,
    concurrency: int = VISION_CONCURRENCY_DEFAULT,
) -> ParsedDocument:
    """Read the listed pages of one PDF through the vision tier.

    Only the pages given are read, so a MIXED document sends its scanned pages
    here and keeps the deterministic parse of its text pages.
    """
    require_agy()
    concurrency = max(1, min(concurrency, VISION_CONCURRENCY_MAX))

    if not page_numbers:
        return ParsedDocument(statements=[], warnings=[], pages_attributed=0)

    raw_rows: list[dict] = []
    pages_read = 0
    failures: list[str] = []

    with tempfile.TemporaryDirectory(prefix="register-vision-") as workdir:
        rendered = rasterise(pdf_path, sorted(page_numbers), workdir)
        if not rendered:
            return ParsedDocument(statements=[], warnings=["vision_no_pages_rendered"], pages_attributed=0)

        groups = batches(sorted(rendered), batch_size)

        def work(group: list[int]) -> tuple[list[int], list[dict], Optional[str]]:
            paths = [rendered[p] for p in group]
            last: Optional[str] = None
            for attempt in range(1, VISION_MAX_ATTEMPTS + 1):
                try:
                    return group, run_batch(paths, workdir, model), None
                except VisionQuotaExhausted:
                    raise  # terminal for the run; never retried, never salvaged
                except VisionError as exc:
                    last = str(exc)
                    log.warning(
                        "batch %s attempt %d/%d failed: %s",
                        group, attempt, VISION_MAX_ATTEMPTS, exc,
                    )
            # A batch usually fails because ONE page in it is pathological, so
            # fall back to single pages rather than losing the whole group.
            if len(group) > 1:
                salvaged: list[dict] = []
                ok: list[int] = []
                for page_no in group:
                    try:
                        salvaged += run_batch([rendered[page_no]], workdir, model)
                        ok.append(page_no)
                    except VisionQuotaExhausted:
                        raise
                    except VisionError as exc:
                        log.warning("page %d unrecoverable: %s", page_no, exc)
                if ok:
                    return ok, salvaged, None
            return [], [], last

        # ONE pool, sized once. Nesting pools per batch would multiply the real
        # fan-out past the measured ceiling of 8.
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            for group, rows, err in pool.map(work, groups):
                # page_no in the payload is 1-based WITHIN the batch, so the
                # offset is the batch's first page minus one.
                offset = (min(group) - 1) if group else 0
                for row in rows:
                    raw_rows.append(row)
                pages_read += len(group)
                if err:
                    failures.append(err)
                # Re-key page numbers against the absolute page index.
                for row in rows:
                    try:
                        row["page_no"] = offset + int(row.get("page_no", 1))
                    except (TypeError, ValueError):
                        row["page_no"] = offset + 1

    parsed = to_parsed(raw_rows, page_offset=0, page_count=page_count, pages_read=pages_read)
    if not parsed.statements:
        # Raise rather than return an empty document. store_extraction would
        # otherwise persist a 0-item artifact, and the NOT EXISTS resume guard
        # keys on the artifact's existence — so the document would never be
        # retried, and would sit at 0% coverage looking like an unreadable scan.
        raise VisionError(
            f"vision read no items from {len(page_numbers)} page(s); "
            f"{len(failures)} batch failure(s): {failures[:1]}"
        )
    if failures:
        parsed.warnings.append("vision_batch_unrecoverable")
    return parsed


def vision_gates(parsed: ParsedDocument) -> list[str]:
    """Runtime QA gates specific to the vision tier.

    These are NEW. Before this tier the extract stage had one numeric gate (page
    coverage); nil-rate lived in a post-load SQL view and the holder-triple check
    only in unit tests. A vision tier without them degrades silently, because
    wrong JSON and right JSON are indistinguishable at the database layer.
    """
    out: list[str] = []
    rows = [r for s in parsed.statements for i in s.items for r in i.rows]

    for statement in parsed.statements:
        if statement.kind != STATEMENT_BASE:
            continue
        if len({i.item_no for i in statement.items}) < VISION_MIN_BASE_ITEMS:
            out.append("vision_base_item_sparse")
        # Only ever seeing 'self' means the holder rows were not read as rows.
        for item in statement.items:
            holders = {r.holder for r in item.rows if r.change_type == CHANGE_DECLARED}
            if holders and not {HOLDER_SELF, HOLDER_SPOUSE, HOLDER_DEPENDENT} <= holders:
                out.append("vision_holder_triple_missing")
                break
        if statement.items and all(r.is_nil for i in statement.items for r in i.rows):
            out.append("vision_nil_saturated")

    # Scored over the items where a figure would be anomalous. Gifts and
    # sponsored travel are excluded because the form asks for a value there.
    scored = [
        r
        for s in parsed.statements
        for i in s.items
        if i.item_no not in VISION_AMOUNT_EXEMPT_ITEMS
        for r in i.rows
    ]
    if scored:
        amount_pct = 100.0 * sum(1 for r in scored if r.contains_amount) / len(scored)
        if amount_pct > VISION_MAX_AMOUNT_PCT:
            out.append("vision_amount_spike")

    return sorted(set(out))
