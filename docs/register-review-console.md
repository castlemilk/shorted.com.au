> **START HERE — measured backlog, 2026-07-27**
>
> This is what the console would be pointed at on day one:
>
> | queue | rows | note |
> |---|---|---|
> | quarantined documents | **88** | `extract_status='partial'` — excluded from public output today |
> | unmatched securities | **3,636** | frequency-ordered in `register_resolution_backlog` |
> | ambiguous securities | **18** | >1 listing matched; never auto-resolved by design |
> | already resolved | 1,197 | 24.7% of resolvable — the gate wants >=35% |
>
> **88 documents is the whole document-review job.** It is a sitting of work, not a
> program. The 3,636 unmatched securities are NOT 3,636 decisions — they collapse
> to ~2,601 distinct names, and the top of that list repeats (`Woodside` 8,
> `AGL Ltd` 6), so a few hundred curated aliases covers most of the volume. Build
> the securities screen FIRST for that reason: it has the best ratio of decisions
> to rows resolved.
>
> **Two things to verify before step 0**, both flagged by the design pass as
> unverified:
> 1. `ocr_parse_gates()` is currently DEAD CODE — no stage calls it. Either wire it
>    into the vision stage or delete it; do not build a queue on a signal nothing
>    emits.
> 2. Corpus counts drift as the pipeline runs. Re-measure rather than trusting the
>    table above.
>
> The per-document form the operator fills in is §5 (three keyboard-first screens);
> the reason it survives the next `register-load` is §3 (correction replay), which
> is the part to read first and the part most likely to be got wrong.

# Register Review Console — implementation spec

Status: **spec, unimplemented.** Written 2026-07-27.
Owner surface: `/admin/register/*`.
Prerequisite reading: `docs/politician-register-architecture.md` (§2.8–2.10 layout
failures, §3.2–3.5 resolution, §6–8 gates and open items) and
`docs/influence-editorial-standards.md` (rules 1, 5, 7, 8).

The pipeline this console sits on top of:

```
register_documents -> register_extractions -> register_statements -> register_declared_items
  -> register_item_securities / register_item_locations -> register_holding_periods
  -> mv_register_public_holdings -> PoliticiansService -> /politicians surfaces
```

The console does three things and nothing else:

1. **Escalate** — enumerate the documents, rows, candidates and localities the
   pipeline could not process confidently, with a triage order and a claim.
2. **Correct** — let a signed-in operator read the source page and hand-fix
   specific fields, as an auditable, replayable, reversible event.
3. **Gate** — let an operator approve a quarantined document into public output,
   or retroactively hold a published one.

It is not a pipeline control panel, not a publishing tool, and not a PDF viewer
for anyone but a signed-in operator.

---

## 0. Contradiction and verification register

Three independent codebase surveys fed this spec. Where they disagreed, the
resolution and its evidence are recorded here rather than buried below.

| # | Disagreement | Resolution | Evidence |
|---|---|---|---|
| C1 | Correction row key: `document_id` + ordinals vs `content_sha256` + ordinals | **`document_id`.** `register_documents.id` is stable (documents are upserted on the `source_url` UNIQUE and never deleted); `content_sha256` is **nullable** and changes on an APH republish, so keying on it orphans the ledger with no FK path home. The behaviour the sha-key was reaching for — "a republished PDF must not silently inherit a human decision" — is delivered instead by the `machine_text` equality check in the applier and by `evidence_sha256` on approvals. | `000096:126` `source_url TEXT NOT NULL UNIQUE`; `000096:147` `content_sha256 TEXT` (nullable); `000096:124` `id UUID PRIMARY KEY` |
| C2 | Before/after column naming: `before_value/after_value JSONB` vs `machine_text/corrected_text` | **`machine_text`/`corrected_text`/`machine_lines`/`corrected_lines`.** The rule-5 invariant test is a **regex over the column NAME**, and `JSONB` merely happens not to be in its type list today. A `*_value` column in this subsystem is a landmine for the next person who widens that regex. Step 1 extends the test to cover `register_corrections` **and** adds `JSONB` to the banned type list. | `services/migrations/register_of_interests.test.mjs:49-50` |
| C3 | Queue membership: `extract_status = 'partial'` vs derived from the latest extraction's `warnings` | **Derived from `warnings` + coverage + `contains_amount` + resolution status.** `extract_status` is written from **only two** conditions — `page_coverage_pct < 90.0`, or the literal warning `centred_label_layout` — so every vision QA gate lands in `register_extractions.warnings` and is then ignored by the status. A survey measured **33 documents / 27 named people / 1,516 declared rows** sitting at `extract_status='extracted'` (i.e. **published**) while carrying `vision_amount_spike`, `vision_holder_triple_missing` or `no_items_parsed`. A `WHERE extract_status='partial'` queue misses exactly the rows that most need a human. | `services/report-extractor/extract_register.py:491-496` (status logic) vs `:777` (`ok = … and not gates`, which only moves a log counter) |
| C4 | New RPCs on `shorts.v1alpha1` vs a separate proto package | **Separate package `shortedapi.registerreview.v1`.** `services/shorts/internal/services/shorts/proto_parity_test.go` walks package `shorts.v1alpha1` and **fails if any domain rpc is missing from the legacy `ShortedStocksService`** — with no exemption for `VISIBILITY_PRIVATE`. Putting nine admin rpcs in `shorts.v1alpha1` would force mirroring them onto the public legacy service and into the public API descriptor. A sibling package is out of the parity test's scope, and `shortedapi/register/v1` is the existing precedent for a non-`shorts` package mounted in the same server. | `proto_parity_test.go:20-22, 76-79`; `serve.go:153` |
| C5 | "A `RegisterService` is already mounted at `serve.go:153`, so the register domain has a home" | **False — name collision.** `serve.go:153` mounts `registerv1connect.NewRegisterServiceHandler`, which is `proto/shortedapi/register/v1/register.proto`: the **email-signup** service (`RegisterEmail`, `Unsubscribe`). It has nothing to do with the parliamentary register. Do not extend it. | `proto/shortedapi/register/v1/register.proto` |
| C6 | Corrections applied by one big SQL `UPDATE … FROM` CTE | **Applied one correction at a time in Go, each inside a `SAVEPOINT`.** A `holder` or `item_no` amendment mutates part of the `UNIQUE (statement_id, item_no, holder, change_type, row_ordinal)` key, so it can collide with a sibling row. A single-statement applier turns one collision into a failed load for the whole document; a per-correction savepoint turns it into `apply_status='conflict'` on that one correction and a queue item. | `000096:330` |
| C7 | Whether `blocks_publication=TRUE` should take effect the moment the migration lands | **No — split into two steps.** The migration seeds the reason vocabulary (a statement of fact about each signal) but the loader keeps reading `extract_status` until **step 9**, after the console exists and the blocking set has been triaged. Flipping both at once withdraws ~1,516 rows about 27 named people from `mv_register_public_holdings` in an unattended collector run. Step 9 names the measured number in its PR body. | Measured crossover query, §8 step 0 |
| C8 | `register_document_gate` should `EXISTS` against `register_review_queue` | **No — both read a shared `register_document_signals` view.** The full queue unions the 2,939-row candidate backlog and the 817-row locality backlog; the loader joins the gate against every document on every run. Splitting the document lane out keeps the gate cheap and stops a locality backlog change from perturbing publication. | design decision, this spec |

**Unverified / drifting numbers — re-measure before writing any PR body.** The three
surveys report different corpus sizes because they sampled at different times and,
in at least one case, a different database: 88 vs ~136 documents at
`extract_status='partial'`; 119 vs 87 documents carrying `centred_label_layout`;
2,609 vs 2,755 statements. None of these is load-bearing for the design, but every
one of them is load-bearing for a PR body. §8 step 0 gives the exact queries.

**Flagged as unverifiable from the code:** `ocr_item_recall_low` and
`ocr_core_items_missing` are seeded into the reason vocabulary but **cannot fire
today** — `ocr_parse_gates()` (`register_vision.py:714`) is imported only by
`test_register_vision.py`, and `extract_register.py` has no OCR stage
(`--stage` choices are `classify|extract|vision`). Seeding them is correct forward
planning. Attributing any current quarantine to them is wrong.

---

## 1. The escalation model

### 1.1 Principle: derive the signal, store only the human state

Every signal the queue needs **already exists** in the pipeline. The migration
adds no signal table and copies no counts. It adds exactly four things:

| Added | Why it cannot be derived |
|---|---|
| `register_review_reasons` | The mapping warning → severity → blocks-publication is an editorial judgement, not a fact in the pipeline. Making it a seeded table means adding a gate later is an `INSERT`, not a code change. |
| `register_review_state` | Claim, disposition and priority override are human acts. Nothing in the pipeline records them. |
| `register_corrections` | who / when / before / after / why. Nothing in the subsystem records a human decision beyond `register_security_aliases.curated_by` (a bare TEXT with no rationale and no prior reading). |
| `register_location_aliases` | `register_item_locations.match_method` already permits `'curated'` (`000096:443`) but there is **no table to write** — the missing analogue of `register_security_aliases`. |

Everything else is a view. The two existing frequency-ordered worklists —
`register_resolution_backlog` (2,939 rows) and `register_location_backlog`
(817 rows) — are **selected from**, not re-aggregated.

### 1.2 The five lanes

| Lane | `target_kind` | Address (`target_key`) | Source of signal |
|---|---|---|---|
| Document | `document` | `register_documents.id::text` | latest `register_extractions.warnings`, `page_coverage_pct`, `fetch_status`/`classify_status`/`extract_status`, correction replay failures |
| Row | `item` | `register_item_key(...)` | `register_declared_items.contains_amount` on a non-exempt item |
| Security candidate | `candidate` | `candidate_norm` | `register_resolution_backlog` |
| Locality | `locality` | `locality_norm` | `register_location_backlog` (excluding `region`) |
| Person | `person` | `politician_id::text` or statement id | `register_statements.identity_status <> 'resolved'` |

Two exclusions are **deliberate and must not be "fixed" later**:

* `register_item_locations.resolution_status = 'region'` never enters the queue.
  The form asks for "suburb or area only", so a region result is a *source
  characteristic*. `000096:422-425`: "Alarm on the ambiguous bucket, never on
  region, or you will chase a phantom forever."
* `contains_amount` on **items 11 (Gifts) and 12 (Sponsored travel)** never
  enters the queue. The form asks for a value there, which is why
  `register_vision.py:129` sets `VISION_AMOUNT_EXEMPT_ITEMS = frozenset({11, 12})`.
  A survey measured 598 of 879 flagged rows on item 11 and 88 on item 12 —
  queueing them buries the **193** genuinely anomalous rows.

### 1.3 The security-backlog asymmetry (must be re-derived)

`register_resolution_backlog` groups by `candidate_norm` **only**, so the
`ambiguous` candidates (a same-name trap needing adjudication) are
indistinguishable from the `unmatched` ones (needing an alias insert).
`register_location_backlog` does **not** have this flaw — it groups by
`(locality_norm, resolution_status)`. The queue view therefore re-derives the
status with an `EXISTS` against `register_item_securities`. Handing an operator
an ambiguity dressed as a missing alias produces exactly the mis-attribution the
ambiguous bucket exists to prevent (`aph_resolve.go:411-414`: "these need a human
decision, not a new alias guess").

---

## 2. Migration `000098_add_register_review_and_corrections`

Next free number: `000097_seed_register_security_aliases` is the highest.
Files: `services/migrations/000098_add_register_review_and_corrections.up.sql`
and `.down.sql`; test `services/migrations/register_review_console.test.mjs`.

### 2.1 The reload-stable row address

```sql
-- register_declared_items.id is REGENERATED on every `-mode register-load`:
-- loadExtraction DELETEs a document's statements (aph_load.go:225) and the FK
-- cascade clears the items, and selectExtractionsToLoad has no already-loaded
-- guard, so EVERY extracted document is deleted and reinserted on EVERY run.
-- A human decision may therefore NEVER be keyed on that id. The durable address
-- is the pair of natural keys that already exist:
--   register_statements      UNIQUE (document_id, statement_ordinal)   000096:271
--   register_declared_items  UNIQUE (statement_id, item_no, holder,
--                                    change_type, row_ordinal)          000096:330
CREATE OR REPLACE FUNCTION register_item_key(
    p_document_id       UUID,
    p_statement_ordinal SMALLINT,
    p_item_no           SMALLINT,
    p_holder            TEXT,
    p_change_type       TEXT,
    p_row_ordinal       SMALLINT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT p_document_id::text || ':' || p_statement_ordinal::text || ':' ||
           COALESCE(p_item_no, -1)::text || ':' || COALESCE(p_holder, '') || ':' ||
           COALESCE(p_change_type, '') || ':' || COALESCE(p_row_ordinal, -1)::text
$$;
```

The address is always the **machine's** reading of the row, never the corrected
one. A `holder` correction moves the row after it is inserted; the next load
reinserts the machine row at the original address and moves it again. Keying on
the corrected value would make the correction un-findable on the second load.

### 2.2 Reason vocabulary

```sql
CREATE TABLE IF NOT EXISTS register_review_reasons (
    reason_code        TEXT PRIMARY KEY,
    target_kind        TEXT     NOT NULL,
    severity           SMALLINT NOT NULL,   -- 1 wrong-fact risk, 2 suspect, 3 curation
    blocks_publication BOOLEAN  NOT NULL DEFAULT FALSE,  -- document lane only
    description        TEXT     NOT NULL,
    CONSTRAINT register_review_reasons_kind_check
        CHECK (target_kind IN ('document','item','candidate','locality','person')),
    CONSTRAINT register_review_reasons_severity_check
        CHECK (severity BETWEEN 1 AND 3)
);

-- Strings are copied VERBATIM from the emitters. A typo here silently drops a
-- whole class of document out of the queue, so register_review_console.test.mjs
-- asserts every seeded document-lane code appears literally in the Python.
INSERT INTO register_review_reasons
    (reason_code, target_kind, severity, blocks_publication, description) VALUES
('centred_label_layout',        'document',1,TRUE ,'47P/46P form centres holder labels; Self/Spouse/Dependent attribution unreliable'),
('no_items_parsed',             'document',1,TRUE ,'parser found no items at all'),
('no_readable_pages',           'document',1,TRUE ,'no page yielded bands'),
('vision_holder_triple_missing','document',1,TRUE ,'vision did not read the three holder rows as rows'),
('ocr_core_items_missing',      'document',1,TRUE ,'base statement missing item 1 or item 3 (OCR stage not yet wired)'),
('ocr_item_recall_low',         'document',1,TRUE ,'OCR base statement below VISION_MIN_BASE_ITEMS (OCR stage not yet wired)'),
('vision_base_item_sparse',     'document',2,TRUE ,'vision base statement below VISION_MIN_BASE_ITEMS'),
('vision_amount_spike',         'document',2,TRUE ,'>VISION_MAX_AMOUNT_PCT (2.0%) of non-exempt rows flagged as containing a figure'),
('vision_nil_saturated',        'document',2,TRUE ,'every row of a base statement read as nil'),
('vision_batch_unrecoverable',  'document',2,TRUE ,'a vision page batch failed and was not recovered'),
('page_coverage_low',           'document',2,TRUE ,'page_coverage_pct < MIN_PAGE_COVERAGE_PCT (90.0)'),
('ocr_failed',                  'document',2,FALSE,'one or more pages could not be OCR''d; the coverage gate catches the consequence'),
('extract_failed',              'document',2,FALSE,'classify_status or extract_status = failed; nothing loaded'),
('fetch_blocked',               'document',2,FALSE,'fetch failed/blocked or http_status 403 (WAF posture change)'),
('correction_stale',            'document',1,TRUE ,'a human correction no longer matches the machine reading it replaced'),
('correction_orphaned',         'document',1,TRUE ,'a human correction addresses a row this extraction no longer produces'),
('correction_conflict',         'document',1,TRUE ,'applying a correction would collide with an existing row key'),
('amount_flagged',              'item',    2,FALSE,'contains_amount on a non-exempt item (11/12 excused: the form asks for a value)'),
('security_ambiguous',          'candidate',1,FALSE,'name maps to >1 listing; needs adjudication, NOT an alias guess'),
('security_unmatched',          'candidate',3,FALSE,'no curated alias, no stated ticker, no exact name match'),
('locality_ambiguous',          'locality',2,FALSE,'suburb name resolves to >1 SAL'),
('locality_no_state',           'locality',2,FALSE,'no state token, so a national match is unsafe'),
('locality_unmatched',          'locality',3,FALSE,'no SAL match'),
('identity_unresolved',         'person',  1,FALSE,'statement has no politician_id'),
('identity_ambiguous',          'person',  1,FALSE,'statement matched more than one person')
ON CONFLICT (reason_code) DO UPDATE SET
    severity = EXCLUDED.severity,
    blocks_publication = EXCLUDED.blocks_publication,
    description = EXCLUDED.description;
-- 'region' is deliberately ABSENT (000096:422-425). Do not add it.
```

### 2.3 Human state

```sql
CREATE TABLE IF NOT EXISTS register_review_state (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_kind       TEXT NOT NULL,
    target_key        TEXT NOT NULL,
    reason_code       TEXT NOT NULL REFERENCES register_review_reasons(reason_code),
    disposition       TEXT NOT NULL DEFAULT 'open',
    priority_override SMALLINT,
    claimed_by        TEXT NOT NULL DEFAULT '',
    claimed_at        TIMESTAMPTZ,
    claim_expires_at  TIMESTAMPTZ,   -- a stale claim must not park a named person's row forever
    decided_by        TEXT NOT NULL DEFAULT '',
    decided_at        TIMESTAMPTZ,
    decision_note     TEXT NOT NULL DEFAULT '',
    -- The evidence the decision was made against. An approval is void once the
    -- source PDF changes: APH republishes, sha256 moves, the document re-queues.
    evidence_sha256   TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_review_state_kind_check
        CHECK (target_kind IN ('document','item','candidate','locality','person')),
    CONSTRAINT register_review_state_disposition_check
        CHECK (disposition IN ('open','claimed','approved','held','dismissed','corrected')),
    CONSTRAINT register_review_state_priority_check
        CHECK (priority_override IS NULL OR priority_override BETWEEN 1 AND 3),
    CONSTRAINT register_review_state_claim_needs_who
        CHECK (disposition <> 'claimed' OR (btrim(claimed_by) <> '' AND claimed_at IS NOT NULL)),
    CONSTRAINT register_review_state_decision_needs_who
        CHECK (disposition IN ('open','claimed')
               OR (btrim(decided_by) <> '' AND decided_at IS NOT NULL)),
    CONSTRAINT register_review_state_approval_needs_evidence
        CHECK (disposition <> 'approved' OR btrim(evidence_sha256) <> ''),
    UNIQUE (target_kind, target_key, reason_code)
);
CREATE INDEX IF NOT EXISTS idx_register_review_state_open
    ON register_review_state (target_kind, disposition)
    WHERE disposition IN ('open','claimed');
CREATE INDEX IF NOT EXISTS idx_register_review_state_claimed
    ON register_review_state (claimed_by, claim_expires_at)
    WHERE disposition = 'claimed';
```

No anonymous decision may attribute or withdraw a financial interest about a
named person — hence the two `_needs_who` CHECKs. Claims expire
(`claim_expires_at`, default now()+2h, see §4.4) so an abandoned claim does not
permanently park a document.

### 2.4 The correction ledger

```sql
-- EDITORIAL rule 5: no column here records a magnitude, AND no column may be
-- SPELLED *value/*amount/*quantity/*price — register_of_interests.test.mjs's
-- banned-column regex matches on the NAME.
-- EDITORIAL rule 7: the machine's reading is frozen here AND survives intact in
-- the immutable, content-addressed register_extractions.payload
-- (UNIQUE (content_sha256, extractor_version, tier), 000096:226). Applying a
-- correction stamps the DERIVED row; it never destroys the reading it replaced.
CREATE TABLE IF NOT EXISTS register_corrections (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reload-stable address. RESTRICT, never CASCADE: every other child of
    -- register_documents cascades, but a delete must never silently destroy the
    -- evidence that a human overrode a machine reading about a named person.
    document_id       UUID     NOT NULL REFERENCES register_documents(id) ON DELETE RESTRICT,
    statement_ordinal SMALLINT NOT NULL,
    item_no           SMALLINT,
    holder            TEXT,
    change_type       TEXT,
    row_ordinal       SMALLINT,
    item_key          TEXT GENERATED ALWAYS AS (
        register_item_key(document_id, statement_ordinal, item_no, holder, change_type, row_ordinal)
    ) STORED,

    field             TEXT NOT NULL,
    action            TEXT NOT NULL,

    -- BEFORE: the machine's reading, frozen at correction time.
    machine_text      TEXT   NOT NULL DEFAULT '',
    machine_lines     TEXT[] NOT NULL DEFAULT '{}',
    -- AFTER: NULL for suppress/reinstate/annotate.
    corrected_text    TEXT,
    corrected_lines   TEXT[],

    -- WHY. rationale is INTERNAL and never selected by a public view; public_note
    -- is the rule-7 annotation rendered on the profile.
    rationale         TEXT NOT NULL,
    reason_code       TEXT NOT NULL DEFAULT '',   -- fixed vocabulary chip, see §6.2
    public_note       TEXT NOT NULL DEFAULT '',

    -- Provenance of the reading being corrected.
    source_extraction_id     UUID REFERENCES register_extractions(id) ON DELETE SET NULL,
    source_content_sha256    TEXT NOT NULL DEFAULT '',
    source_extractor_version TEXT NOT NULL DEFAULT '',

    -- WHO / WHEN.
    corrected_by      TEXT        NOT NULL,
    corrected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Second-review gate for the two highest-fanout classes (§6.4).
    needs_second_review BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_by        TEXT NOT NULL DEFAULT '',
    confirmed_at        TIMESTAMPTZ,

    -- Lifecycle. A change is a NEW row; this one is superseded, never edited.
    superseded_by     UUID REFERENCES register_corrections(id) ON DELETE SET NULL,
    revoked_at        TIMESTAMPTZ,
    revoked_by        TEXT NOT NULL DEFAULT '',
    revoked_reason    TEXT NOT NULL DEFAULT '',

    -- Replay outcome of the last -mode register-load.
    apply_status      TEXT NOT NULL DEFAULT 'pending',
    applied_at        TIMESTAMPTZ,
    apply_note        TEXT NOT NULL DEFAULT '',

    CONSTRAINT register_corrections_field_check CHECK (field IN (
        'declared_text','declared_lines','secondary_text','tertiary_text',
        'holder','item_no','change_type','row_suppressed',
        'lodged_date','statement_kind','statement_pages')),
    -- No 'delete'. A correction can amend, hide, unhide or annotate. It can never
    -- remove a row, so a nil row (000096:285-290: "a nil row proves the tier read
    -- the item") can be hidden from public output but never turned into absence.
    CONSTRAINT register_corrections_action_check
        CHECK (action IN ('amend','suppress','reinstate','annotate')),
    CONSTRAINT register_corrections_suppress_field_check
        CHECK (action NOT IN ('suppress','reinstate') OR field = 'row_suppressed'),
    CONSTRAINT register_corrections_apply_check
        CHECK (apply_status IN ('pending','applied','stale','orphaned','conflict','superseded','revoked')),
    CONSTRAINT register_corrections_why_required   CHECK (btrim(rationale)    <> ''),
    CONSTRAINT register_corrections_who_required   CHECK (btrim(corrected_by) <> ''),
    CONSTRAINT register_corrections_amend_needs_both
        CHECK (action <> 'amend'
               OR (corrected_text IS NOT NULL AND corrected_text IS DISTINCT FROM machine_text)),
    CONSTRAINT register_corrections_suppress_has_no_replacement
        CHECK (action <> 'suppress' OR corrected_text IS NULL),
    CONSTRAINT register_corrections_revoke_needs_who
        CHECK (revoked_at IS NULL OR btrim(revoked_by) <> ''),
    CONSTRAINT register_corrections_second_review
        CHECK (confirmed_at IS NULL
               OR (btrim(confirmed_by) <> '' AND confirmed_by <> corrected_by))
);

-- At most ONE live correction per (row, field). Superseded and revoked rows stay.
CREATE UNIQUE INDEX IF NOT EXISTS idx_register_corrections_live
    ON register_corrections (item_key, field)
    WHERE superseded_by IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_register_corrections_document
    ON register_corrections (document_id, apply_status);
CREATE INDEX IF NOT EXISTS idx_register_corrections_replay
    ON register_corrections (apply_status)
    WHERE apply_status IN ('stale','orphaned','conflict');

COMMENT ON TABLE register_corrections IS
    'Append-only human-correction ledger. Records who/when/before/after/why and is REPLAYED onto freshly loaded rows, never applied in place. The machine reading survives here and in register_extractions.payload. Editorial rule 7: corrections are annotated, not silently applied.';
COMMENT ON COLUMN register_corrections.rationale IS
    'Internal justification. May name a complainant or legal advice - never selected by a public view. Use public_note for the rendered annotation.';
```

Append-only is enforced, not conventional (same posture as
`register_item_securities_public_gate`):

```sql
CREATE OR REPLACE FUNCTION register_corrections_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'register_corrections is append-only: revoke row %, never delete it', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.document_id       IS DISTINCT FROM OLD.document_id
    OR NEW.statement_ordinal IS DISTINCT FROM OLD.statement_ordinal
    OR NEW.item_no           IS DISTINCT FROM OLD.item_no
    OR NEW.holder            IS DISTINCT FROM OLD.holder
    OR NEW.change_type       IS DISTINCT FROM OLD.change_type
    OR NEW.row_ordinal       IS DISTINCT FROM OLD.row_ordinal
    OR NEW.field             IS DISTINCT FROM OLD.field
    OR NEW.action            IS DISTINCT FROM OLD.action
    OR NEW.machine_text      IS DISTINCT FROM OLD.machine_text
    OR NEW.machine_lines     IS DISTINCT FROM OLD.machine_lines
    OR NEW.corrected_text    IS DISTINCT FROM OLD.corrected_text
    OR NEW.corrected_lines   IS DISTINCT FROM OLD.corrected_lines
    OR NEW.rationale         IS DISTINCT FROM OLD.rationale
    OR NEW.corrected_by      IS DISTINCT FROM OLD.corrected_by
    OR NEW.corrected_at      IS DISTINCT FROM OLD.corrected_at THEN
        RAISE EXCEPTION 'register_corrections is append-only: supersede row % with a new row, never edit it', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;  -- only superseded_by / revoked_* / apply_* / confirmed_* / public_note may move
END;
$$;

DROP TRIGGER IF EXISTS register_corrections_immutable ON register_corrections;
CREATE TRIGGER register_corrections_immutable
    BEFORE UPDATE OR DELETE ON register_corrections
    FOR EACH ROW EXECUTE FUNCTION register_corrections_append_only();
```

### 2.5 Two columns on `register_declared_items`, and the curated locality table

```sql
-- docs/politician-register-architecture.md §6.3 open item 1: "Row-level takedown
-- does not exist... A register_declared_items.suppressed_at column plus a filter
-- in mv_register_public_holdings would fix it; until then a single contested
-- declaration means taking the whole surface down."
ALTER TABLE register_declared_items
    ADD COLUMN IF NOT EXISTS correction_id UUID REFERENCES register_corrections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS corrected_fields TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_register_items_suppressed
    ON register_declared_items (suppressed_at) WHERE suppressed_at IS NOT NULL;

COMMENT ON COLUMN register_declared_items.suppressed_at IS
    'Row-level takedown, set by replaying a register_corrections action=suppress. The ROW SURVIVES - a nil row can be hidden but never turned into absence. Filtered out of the holding-period fold, so it never reaches mv_register_public_holdings.';

-- register_item_locations.match_method already permits 'curated' (000096:443)
-- but there was no table to write. This is the analogue of
-- register_security_aliases: one human-authored row per decision.
CREATE TABLE IF NOT EXISTS register_location_aliases (
    locality_norm TEXT NOT NULL,
    state_code    TEXT NOT NULL DEFAULT '',
    sal_code      TEXT,                       -- suburb_demographics.sal_code (no FK, house style)
    resolution    TEXT NOT NULL DEFAULT 'resolved',
    note          TEXT NOT NULL DEFAULT '',
    curated_by    TEXT NOT NULL,
    curated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (locality_norm, state_code),
    CONSTRAINT register_location_aliases_resolution_check
        CHECK (resolution IN ('resolved','region','unresolvable')),
    CONSTRAINT register_location_aliases_resolved_needs_sal
        CHECK (resolution <> 'resolved' OR sal_code IS NOT NULL)
);
```

### 2.6 Views

```sql
-- Document lane only. Read by BOTH the queue and the publication gate, so the
-- gate never has to scan the candidate/locality backlogs (contradiction C8).
CREATE OR REPLACE VIEW register_document_signals AS
WITH latest AS (
    SELECT DISTINCT ON (e.document_id)
           e.document_id, e.id AS extraction_id, e.warnings,
           e.tier, e.page_coverage_pct, e.created_at
    FROM register_extractions e
    ORDER BY e.document_id, e.created_at DESC
)
-- (a) every warning the latest extraction emitted. ocr_failed:page_N is
--     parameterised, so it is collapsed to its prefix or it would never join.
SELECT d.id AS document_id,
       CASE WHEN w LIKE 'ocr_failed:%' THEN 'ocr_failed' ELSE w END AS reason_code,
       l.created_at AS observed_at
FROM register_documents d
JOIN latest l ON l.document_id = d.id
CROSS JOIN LATERAL jsonb_array_elements_text(l.warnings) AS w
UNION ALL
SELECT d.id, 'page_coverage_low', l.created_at
FROM register_documents d JOIN latest l ON l.document_id = d.id
WHERE l.page_coverage_pct < 90.0
UNION ALL
SELECT d.id, 'extract_failed', d.updated_at
FROM register_documents d
WHERE d.extract_status = 'failed' OR d.classify_status = 'failed'
UNION ALL
SELECT d.id, 'fetch_blocked', d.updated_at
FROM register_documents d
WHERE d.fetch_status IN ('failed','blocked') OR d.http_status = 403
UNION ALL
-- correction replay failures re-enter as document escalations
SELECT c.document_id,
       CASE c.apply_status
         WHEN 'stale'    THEN 'correction_stale'
         WHEN 'conflict' THEN 'correction_conflict'
         ELSE 'correction_orphaned' END,
       c.corrected_at
FROM register_corrections c
WHERE c.superseded_by IS NULL AND c.revoked_at IS NULL
  AND c.apply_status IN ('stale','orphaned','conflict');
```

```sql
CREATE OR REPLACE VIEW register_review_queue AS
WITH doc_rows AS (
    SELECT st.document_id,
           count(*) FILTER (WHERE NOT i.is_nil)  AS declared_rows,
           count(DISTINCT st.politician_id)      AS people
    FROM register_statements st
    JOIN register_declared_items i ON i.statement_id = st.id
    GROUP BY 1
),
signals AS (
    SELECT 'document'::text AS target_kind, s.document_id::text AS target_key,
           s.reason_code, s.document_id, NULL::uuid AS politician_id,
           d.source_url, COALESCE(d.content_sha256,'') AS content_sha256,
           COALESCE(r.declared_rows,0)::bigint AS blast_rows,
           COALESCE(r.people,0)::bigint       AS blast_people,
           s.observed_at
    FROM register_document_signals s
    JOIN register_documents d ON d.id = s.document_id
    LEFT JOIN doc_rows r ON r.document_id = s.document_id
  UNION ALL
    SELECT 'item',
           register_item_key(st.document_id, st.statement_ordinal, i.item_no,
                             i.holder, i.change_type, i.row_ordinal),
           'amount_flagged', st.document_id, i.politician_id,
           i.source_url, COALESCE(d.content_sha256,''), 1, 1, i.created_at
    FROM register_declared_items i
    JOIN register_statements st ON st.id = i.statement_id
    JOIN register_documents  d  ON d.id  = st.document_id
    WHERE i.contains_amount AND i.item_no NOT IN (11,12) AND i.suppressed_at IS NULL
  UNION ALL
    -- Re-derives the status register_resolution_backlog drops (§1.3).
    SELECT 'candidate', b.candidate_norm,
           CASE WHEN EXISTS (SELECT 1 FROM register_item_securities s2
                             WHERE s2.candidate_norm = b.candidate_norm
                               AND s2.resolution_status = 'ambiguous')
                THEN 'security_ambiguous' ELSE 'security_unmatched' END,
           NULL::uuid, NULL::uuid, '', '', b.occurrences,
           (SELECT count(DISTINCT i2.politician_id)
              FROM register_item_securities s3
              JOIN register_declared_items i2 ON i2.id = s3.item_id
             WHERE s3.candidate_norm = b.candidate_norm),
           now()
    FROM register_resolution_backlog b
  UNION ALL
    SELECT 'locality', b.locality_norm, 'locality_' || b.resolution_status,
           NULL::uuid, NULL::uuid, '', '', b.occurrences, 0, now()
    FROM register_location_backlog b
    WHERE b.resolution_status <> 'region'
  UNION ALL
    SELECT 'person', COALESCE(st.politician_id::text, st.id::text),
           'identity_' || st.identity_status, st.document_id, st.politician_id,
           st.source_url, '', 1, 1, st.updated_at
    FROM register_statements st
    WHERE st.identity_status <> 'resolved'
)
SELECT s.target_kind, s.target_key, s.reason_code,
       r.description, r.blocks_publication,
       COALESCE(v.priority_override, r.severity) AS priority,
       COALESCE(v.disposition, 'open')           AS disposition,
       v.claimed_by, v.claimed_at, v.claim_expires_at,
       v.decided_by, v.decided_at, v.decision_note,
       s.document_id, s.politician_id, s.source_url, s.content_sha256,
       s.blast_rows, s.blast_people, s.observed_at
FROM signals s
JOIN register_review_reasons r ON r.reason_code = s.reason_code
LEFT JOIN register_review_state v
       ON v.target_kind = s.target_kind
      AND v.target_key  = s.target_key
      AND v.reason_code = s.reason_code
ORDER BY COALESCE(v.priority_override, r.severity),
         s.blast_people DESC, s.blast_rows DESC, s.observed_at;
```

```sql
-- ONE publication predicate, read by both the loader and the purge, so a human
-- can approve a partial document AND hold an extracted one — the direction the
-- current `extract_status = 'extracted'` predicate cannot express.
CREATE OR REPLACE VIEW register_document_gate AS
SELECT d.id AS document_id,
       d.extract_status,
       COALESCE(g.disposition, '') AS disposition,
       CASE
         WHEN g.disposition = 'held' THEN FALSE            -- 'held' wins: fail CLOSED
         WHEN g.disposition = 'approved'
              AND g.evidence_sha256 = COALESCE(d.content_sha256,'') THEN TRUE
         WHEN EXISTS (
                SELECT 1
                FROM register_document_signals s
                JOIN register_review_reasons rr ON rr.reason_code = s.reason_code
                LEFT JOIN register_review_state rs
                       ON rs.target_kind = 'document'
                      AND rs.target_key  = d.id::text
                      AND rs.reason_code = s.reason_code
                WHERE s.document_id = d.id
                  AND rr.blocks_publication
                  AND COALESCE(rs.disposition,'open') IN ('open','claimed')
              ) THEN FALSE
         ELSE d.extract_status = 'extracted'
       END AS publishable,
       CASE
         WHEN g.disposition = 'held' THEN 'held_by:' || g.decided_by
         WHEN g.disposition = 'approved'
              AND g.evidence_sha256 <> COALESCE(d.content_sha256,'')
              THEN 'approval_stale_source_changed'
         WHEN d.extract_status <> 'extracted' THEN 'machine_' || d.extract_status
         ELSE ''
       END AS gate_reason
FROM register_documents d
LEFT JOIN LATERAL (
    SELECT rs.disposition, rs.decided_by, rs.evidence_sha256
    FROM register_review_state rs
    WHERE rs.target_kind = 'document' AND rs.target_key = d.id::text
      AND rs.disposition IN ('approved','held')
    ORDER BY (rs.disposition = 'held') DESC, rs.decided_at DESC
    LIMIT 1
) g ON TRUE;

-- Rule-7 read artefact. rationale is deliberately NOT selected.
CREATE OR REPLACE VIEW register_public_corrections AS
SELECT c.id, st.politician_id, p.slug, c.item_no, c.action,
       c.public_note, c.corrected_at, st.source_url
FROM register_corrections c
JOIN register_statements st
  ON st.document_id = c.document_id AND st.statement_ordinal = c.statement_ordinal
JOIN politicians p ON p.id = st.politician_id AND p.merged_into_id IS NULL
WHERE c.superseded_by IS NULL AND c.revoked_at IS NULL AND c.apply_status = 'applied';
```

**Approvals are pinned to evidence.** `evidence_sha256` records the
`register_documents.content_sha256` the operator approved. If APH republishes,
the hash moves, the approval goes stale, and the document re-enters the queue
with `gate_reason = 'approval_stale_source_changed'`.

### 2.7 Operator page-view log

```sql
-- Proves "internal operator view, not a public mirror" rather than asserting it.
CREATE TABLE IF NOT EXISTS register_page_views (
    id            BIGSERIAL PRIMARY KEY,
    document_id   UUID NOT NULL REFERENCES register_documents(id) ON DELETE RESTRICT,
    page_no       INTEGER NOT NULL,
    dpi           SMALLINT NOT NULL,
    operator_email TEXT NOT NULL,
    viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_register_page_views_operator
    ON register_page_views (operator_email, viewed_at DESC);
```

### 2.8 Down migration

`000098_..._down.sql` drops, in order: `register_public_corrections`,
`register_document_gate`, `register_review_queue`, `register_document_signals`,
`register_page_views`, the trigger + `register_corrections_append_only()`, the
three added columns on `register_declared_items`, `register_corrections`,
`register_location_aliases`, `register_review_state`, `register_review_reasons`,
`register_item_key()`. It must **not** be run in prod once corrections exist —
add a leading comment saying so, matching `000096_..._down.sql`'s posture.

---

## 3. How a correction survives the next `register-load`

### 3.1 The problem, exactly

`loadExtraction` (`aph_load.go:225`) runs
`DELETE FROM register_statements WHERE document_id = $1` and the FK cascade
(`000096:294`) clears `register_declared_items`. `selectExtractionsToLoad`
(`aph_load.go:81-90`) has **no already-loaded guard**, so every publishable
document is deleted and reinserted on **every** run. Any human edit written into
`register_declared_items` — and any patch table keyed on
`register_declared_items.id` — is destroyed within one cycle.

### 3.2 The answer: replay, in-transaction, per-correction

A correction is never persisted in place. `loadExtraction` reinserts the machine
rows, then — in the **same transaction, before `tx.Commit`** — calls
`applyCorrections`, which replays the live ledger onto the freshly inserted rows.

```go
// services/influence-collector/aph_corrections.go  (new file)
//
// applyCorrections replays the live correction ledger for one document onto the
// rows loadExtraction just inserted. It runs inside loadExtraction's tx, so a
// document is loaded-with-its-corrections or not at all.
//
// Each correction is applied inside its own SAVEPOINT: a `holder` or `item_no`
// amendment mutates part of the UNIQUE (statement_id, item_no, holder,
// change_type, row_ordinal) key and can therefore collide with a sibling row.
// One collision must degrade to apply_status='conflict' on that correction, not
// fail the whole document (contradiction C6).
func applyCorrections(ctx context.Context, tx pgx.Tx, documentID string) error
```

Four outcomes per correction, all recorded, none silent:

| Situation | `apply_status` | Effect |
|---|---|---|
| Target row exists **and** its fresh machine reading equals `machine_text` | `applied` | field updated; `correction_id`, `corrected_fields` stamped; `suppressed_at` set/cleared for suppress/reinstate |
| Target row exists but the machine now reads it **differently** | `stale` | **not applied**; queue item `correction_stale` |
| Target row is **not produced** by this extraction | `orphaned` | not applied; queue item `correction_orphaned` |
| Applying it would violate the row UNIQUE | `conflict` | savepoint rolled back; queue item `correction_conflict` |

The two failure directions are symmetric and both surface to a human: a
re-extract cannot silently clobber a human decision, and a human decision cannot
silently clobber a genuinely improved machine reading.

Additional applier rules:

* `AND NOT (i.is_nil AND l.action = 'amend')` — a nil row may be **hidden**,
  never emptied into absence (`000096:285-290`).
* `field='item_no'` recomputes `item_label` from a Go map
  `registerItemLabels` in `services/influence-collector/aph_items.go`, mirroring
  `register_schema.ITEM_LABELS`; `aph_items_test.go` parses
  `services/report-extractor/register_schema.py` and asserts all 14 labels match.
  Never let an operator type a label — `register_extraction_stats` groups on it.
* `field IN ('lodged_date','statement_kind','statement_pages')` targets
  `register_statements` via `(document_id, statement_ordinal)`; `lodged_date` and
  `date_is_stated` move as an interlocked pair (§7).

### 3.3 Three Go edits outside the applier

```go
// 1. aph_load.go selectExtractionsToLoad — was: WHERE d.extract_status = 'extracted'
   FROM register_extractions e
   JOIN register_documents d     ON d.id = e.document_id
   JOIN register_document_gate g ON g.document_id = d.id
   WHERE g.publishable
   ORDER BY e.document_id, e.created_at DESC

// 2. aph_load.go purgeNonExtractedStatements — was: AND d.extract_status <> 'extracted'
//    Now also purges an EXTRACTED document a human has HELD: the retroactive
//    quarantine the current predicate cannot express.
   DELETE FROM register_statements s
   USING register_document_gate g
   WHERE g.document_id = s.document_id
     AND NOT g.publishable

// 3. aph_periods.go selectHoldingEventsQuery — add to ALL THREE UNION ALL arms:
     AND i.suppressed_at IS NULL
```

Edit 3 is what makes `suppressed_at` bite. `mv_register_public_holdings` reads
`register_holding_periods`, which carries **no link back to a declared item** —
the fold merges many items into one interval. Adding the column and "a filter in
the MV" (as §6.3 of the architecture doc phrases it) would compile and do
nothing. `register_holding_periods` is `TRUNCATE`d and refolded wholesale
(`aph_periods.go:268`), so a suppression takes effect on the next
`-mode register-resolve` with no incremental bookkeeping.

### 3.4 Re-entry to public output — the fixed four-step runbook

1. Operator writes `register_review_state` (approved/held) and/or
   `register_corrections` rows via the console.
2. `-mode register-load` with `REGISTER_DRY_RUN=false` — the gate admits approved
   partials, purges held documents, and `applyCorrections` replays the ledger.
3. `-mode register-resolve` — `runRegisterSecurityResolve` →
   `runRegisterLocationResolve` → `rebuildHoldingPeriods` (TRUNCATE + refold) →
   `refresh_register_materialized_views()`. **Both steps 2 and 3 are mandatory**;
   the fold is a wholesale rebuild, not an upsert.
4. ISR/KV bust:
   `POST /api/revalidate?path=/politicians,/politicians/changes,/politicians/short-interest&flush=politicians`
   plus the affected `/politicians/[slug]`. Without this a takedown is invisible
   for up to **24 hours** — `/politicians/[slug]/page.tsx:24` is
   `revalidate = 86400`. A `politicians` flush family already exists
   (`web/src/app/api/revalidate/route.ts:15`). Step 10 of §8 automates this by
   copying `services/house-price-collector/revalidate.go`'s `pingRevalidate`
   into `aph_mode.go` at the end of `runRegisterResolve`.

---

## 4. Admin routes, auth, and the write path

### 4.1 Routes

| Route | Type | Purpose |
|---|---|---|
| `web/src/app/admin/register/layout.tsx` | **new** admin shell | Sub-nav across the four console screens. There is **no `web/src/app/admin/layout.tsx` today** — each admin page is standalone under the root layout. Create the scoped layout, not a global one. |
| `web/src/app/admin/register/page.tsx` | server | Queue overview: counts per lane × severity, "my claims", the top of the worklist. |
| `web/src/app/admin/register/documents/page.tsx` | server | Document worklist (filters via `searchParams`). |
| `web/src/app/admin/register/documents/[id]/page.tsx` | server + client editor | **Screen (a)** — page image ⟷ artifact editor. |
| `web/src/app/admin/register/securities/page.tsx` | server + client | **Screen (b)** — candidate adjudication. |
| `web/src/app/admin/register/locations/page.tsx` | server + client | **Screen (c)** — three locality sub-queues. |
| `web/src/app/api/admin/register/page/route.ts` | route handler | §5 page-image proxy. |

Every page: `export const dynamic = "force-dynamic";` — `requireAdmin()` calls
`auth()` (cookies) and the actions use `cache: "no-store"`, both of which throw
`DynamicServerError` during static generation. All five existing admin pages
already declare it.

Add the console to `web/src/@/components/ui/user-auth-nav.tsx:89-108` — the
admin nav is a hardcoded two-item block inside the user dropdown, and
`/admin/takes` and `/admin/broadcasts` are already unreachable except by typed
URL. A console nobody can find is a console nobody uses.

### 4.2 Auth — the `requireAdmin()` pattern, four layers

```ts
// web/src/server/admin.ts:26 — call this as the FIRST statement of every admin
// page, every "use server" export (INCLUDING read-only ones), and derive
// isAdmin() → 403 in every route handler.
const admin = await requireAdmin();   // { email, userId }
```

1. **Middleware path gate** — `web/src/middleware.ts:172` + matcher `:328-329`
   (`"/admin"`, `"/admin/:path*"`). This is **not a boundary**: server actions
   are addressable by action-id outside the matcher, and **`/api/admin/**` is not
   matched at all**.
2. **`requireAdmin()` in-page and in-action** — the real gate. It re-derives from
   `ADMIN_EMAILS` on every call.
3. **`isAdmin()` → 403 in route handlers** — pattern at
   `web/src/app/api/admin/flush-cache/route.ts:30`.
4. **Backend interceptor** — proto `required_role = "admin"`, enforced at
   `services/shorts/internal/services/shorts/middleware_connect.go:227-229`.

**Where the 2026-07 audit found this missing.** The AI code audit
(`ai-code-audit-2026-07`) found two HIGH auth bypasses, one of them
`sendBroadcast` with **no `requireAdmin()`** — a server action that emails every
active subscriber, reachable by action-id without ever touching `/admin`. Fixed
in commit **`9515de916`** (3 Jul 2026), which added `requireAdmin()` to eight
admin server actions and left the canonical comment now at
`web/src/app/actions/reviewEnrichment.ts:13-15`:

> Admin-only. Authorize the caller in-action (not just via route middleware):
> server actions are globally addressable by action-id and can be POSTed to a
> route outside the `/admin` matcher, so the middleware gate alone is bypassable.

Reproduce that comment on every action in this console. Do **not** copy the
divergent idiom still present in `triggerEnrichment.ts:19`,
`processQueuedJobs.ts:12`, `listEnrichmentJobs.ts:22`,
`getEnrichmentJobStatus.ts:18` — those check `session.user.isAdmin`, a flag baked
into the JWT at sign-in, so removing someone from `ADMIN_EMAILS` does not revoke
their existing session. Anything that writes to `register_*` uses
`requireAdmin()`.

**Three auth landmines to fix or route around, all pre-existing:**

* `ADMIN_EMAILS` is parsed twice with different normalisation:
  `web/src/server/admin.ts:10-13` lowercases both sides,
  `web/src/server/auth.ts:169-178` (which feeds the middleware) does not. A
  mixed-case entry passes `requireAdmin()` but is redirected by the middleware —
  the page is unreachable with no error and no log. **Fix `auth.ts` to lowercase
  in step 5.**
* `requireAdmin()`'s unauthenticated redirect hardcodes
  `callbackUrl=/admin/takes` (`admin.ts:30`), so signing in from a deep link
  drops the operator on the takes list. **Make the callback the current path.**
* The backend grants the `admin` role from a **hardcoded Go slice** at
  `middleware_connect.go:193-197` (and a duplicate at `:309-313`), not from
  `ADMIN_EMAILS`. A new operator added web-side reaches the console and gets
  `PermissionDenied` at write time, after reviewing a named person's holdings.
  **Step 5 replaces both slices with a single `REGISTER_ADMIN_EMAILS`/
  `ADMIN_EMAILS` env parse.**

### 4.3 RPCs

New proto package (contradiction C4):
`proto/shortedapi/registerreview/v1/register_review.proto`, package
`shortedapi.registerreview.v1`, service `RegisterReviewService`. Every rpc:

```protobuf
option (shortedapi.options.v1.visibility) = VISIBILITY_PRIVATE;
option (shortedapi.options.v1.required_role) = "admin";
```

| rpc | Purpose |
|---|---|
| `ListReviewQueue` | filters: target_kind, reason_code, disposition, max priority, claimed_by, parliament; page/limit |
| `GetReviewDocument` | one document + its statements/items artifact tree + latest extraction warnings + live corrections + gate state |
| `ClaimReviewItem` / `ReleaseReviewItem` | claim with TTL |
| `DecideReviewItem` | disposition ∈ approved/held/dismissed + note + evidence_sha256 |
| `SubmitCorrections` | a **change set** for one document, applied in one transaction |
| `RevokeCorrection` | append a revocation; never a DELETE |
| `UpsertSecurityAlias` | writes `register_security_aliases` |
| `UpsertLocationAlias` | writes `register_location_aliases` |
| `ResolveDocumentPageSource` | **internal-only**: documentId → storage_uri, for the page server. Never called from a browser. |

Wiring:

* Mount in `services/shorts/internal/services/shorts/serve.go` alongside the
  existing handlers with the shared `interceptors` + `withCORS`.
* Add all nine full method names to `internalOnlyMethods`
  (`middleware_connect.go:60-68`) — generalise the builder, which currently
  hardcodes the `shorts.v1alpha1.` prefix. `VISIBILITY_PRIVATE` alone means "any
  authenticated user" when `required_role` is empty; these have a role, but the
  internal-only list is the belt to the role's braces.
* **No** `web/next.config.mjs` rewrite: every call is server-side.
* The parity test does not apply (different package) — confirm by running it.

### 4.4 Server actions

`web/src/app/actions/admin/register.ts` (`"use server"`), one module, every
export starting with `await requireAdmin()`:

`listReviewQueue`, `getReviewDocument`, `claimReviewItem`, `releaseReviewItem`,
`decideReviewItem`, `submitCorrections`, `revokeCorrection`,
`upsertSecurityAlias`, `upsertLocationAlias`.

Transport — copy `reviewEnrichment.ts:37-62`, **with one fix**:

```ts
const transport = createConnectTransport({ fetch: serverFetchWithUserAgent, baseUrl: SHORTS_API_URL });
const client = createClient(RegisterReviewService, transport);
// NOT process.env.INTERNAL_SECRET — reviewEnrichment.ts:42 reads the WRONG name.
// The Go side reads INTERNAL_SERVICE_SECRET (middleware_connect.go:152, serve.go:60).
const internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";
await retryWithBackoff(() => client.submitCorrections(req, {
  headers: {
    "X-Internal-Secret": internalSecret,
    "X-User-Email": admin.email,   // backend independently authorizes AND records who
    "X-User-Id": admin.userId,
  },
}), RETRY_OPTIONS);
revalidatePath("/admin/register/documents/" + documentId);
```

Do **not** copy `web/src/app/actions/admin/takes.ts:11-17` — its `adminClient()`
sends **no auth headers at all**.

`corrected_by`, `claimed_by`, `decided_by` are always
`admin.email` from the server session. They are never form inputs.

Claims: `claim_expires_at = now() + interval '2 hours'`; the queue renders an
expired claim as reclaimable and `ClaimReviewItem` overwrites it, recording the
prior claimant in `decision_note`.

---

## 5. The page-image endpoint

### 5.1 Shape

```
GET /api/admin/register/page?documentId=<uuid>&page=<n>&zoom=1|2
 -> 200 image/png
    Cache-Control: private, no-store, max-age=0
    X-Robots-Tag: noindex, nofollow, noimageindex, noarchive
    Content-Disposition: inline
```

Implementation: `web/src/app/api/admin/register/page/route.ts`.

1. `if (!(await isAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })`
   — **first statement**. `/api/admin/**` is not covered by the middleware matcher.
2. Validate `documentId` as a UUID and `page` as a positive integer; `zoom`
   maps to exactly two DPI values, **110** (review pane) and **220** (zoom).
   Both are below the 150 DPI the vision tier reads at, so this is a reading
   aid, not a reproduction master.
3. `POST ${REGISTER_PAGE_SERVER_URL}/page` with
   `{ documentId, page, dpi }` and `X-Internal-Secret: INTERNAL_SERVICE_SECRET`.
   **The handler never sees or forwards a path.**
4. Stream the PNG back. Append a `register_page_views` row
   (`operator_email` from the session).
5. If `REGISTER_PAGE_SERVER_URL` is unset → `503 { error: "page_source_unavailable" }`
   and the editor renders a "source page unavailable in this environment" panel.
   The editor remains fully usable without it (the artifact text is the primary
   surface); the operator simply cannot verify against the page.

### 5.2 The page server

`services/report-extractor/register_pageserver.py` — a small `http.server`/
FastAPI app that reuses the **existing** code, not a second renderer:

* `extract_register.open_document(storage_uri)` (`extract_register.py:61-90`) —
  already handles `file://` (the `/Volumes/gamma-systems-2/shorted-crawl/aph-register/`
  working cache) and `gs://` (streams to a temp file; in-window Senate volumes
  reach 33 MB).
* `register_vision.rasterise(pdf_path, [page], outdir, dpi)`
  (`register_vision.py:576-600`) — already 1-based, already rejects an empty
  `pdf_path` and a zero-page document (the `fitz.open(None)` silent-empty trap).

The **page server** resolves `storage_uri` from `DATABASE_URL` given a
`documentId`, and refuses anything else. No component in the chain accepts a
path, URI, bucket or hash from a caller, which closes the arbitrary-file-read /
SSRF hole by construction. It binds `127.0.0.1` by default and requires
`INTERNAL_SERVICE_SECRET`. Renders go to a `tempfile.mkdtemp()` **outside the
repo**, are streamed, then unlinked.

Deployment posture for v1: **local operator only.** The PDF working cache lives
on the operator's external volume, so the page server runs on the operator's Mac
(`make register-pageserver`, port 8099) alongside `npm run dev`. A prod path — a
Cloud Run service `register-page-server` with `ingress = internal` reading
`gs://` — is deferred to step 12 and is not required for the console to be
useful.

### 5.3 Eleven prohibitions

The licence permits reproduction of **extracted facts with attribution**; it does
not permit a PDF mirror. `000096:197-198` says so in the schema itself:

> `Private GCS working cache only. Never expose on a read path - the licence
> permits extracted facts, not a PDF mirror. Public surfaces link source_url.`

The endpoint MUST NOT:

1. Serve PDF bytes under any parameter — no `?format=pdf`, no passthrough, no
   `application/pdf` response.
2. Mint or return a **GCS signed URL** — that is a cookie-free public URL to the
   PDF for the token's lifetime (a mirror with a timer) and it bypasses the
   admin session entirely.
3. Accept a caller-supplied path, URI, bucket or sha — only a `documentId` that
   is looked up server-side.
4. Return `storage_uri` in any JSON response, **including error bodies**.
5. Render more than one page per request — no `?pages=all`, no contact sheet, no
   zip. Batch rendering *is* the mirror.
6. Be served through `next/image` — `/_next/image` is a public, URL-keyed,
   CDN-cacheable path with no session check on the cached object. Use a plain
   `<img>`.
7. Be cached by Cloudflare or Vercel — never emit `public`/`s-maxage`; add
   `/api/admin/*` to the CDN bypass.
8. Be exposed as a public Connect rpc on `api.shorted.com.au` — that surface
   authenticates by API token and rate-limit tier, not by `ADMIN_EMAILS`.
9. Rely on middleware for auth (see §4.2).
10. Write the rendered PNG anywhere under `web/public/**` or any web-served
    directory.
11. Appear in `sitemap.ts` or be linkable from any public surface.

Auth is the control; the robots directives and `register_page_views` are the
evidence.

---

## 6. The three review screens

An operator will do hundreds of these. Every screen is keyboard-first, one hand,
no mouse required; auto-advance never commits.

### 6.1 Screen (a) — document review

`/admin/register/documents/[id]`. Two panes.

* **Left (sticky):** the page image at DPI 110, auto-scrolled to the focused
  row's `page_no`. `+`/`-` toggles DPI 220.
* **Right:** the artifact tree `Statement → Item → Rows` as a dense table
  `holder | declared_text | secondary_text | change_type`, one row per
  `register_declared_items` row.

**The quarantine reason selects the mode**, so the operator's hands land on the
field that is actually wrong. Mode is keyed off the latest extraction's
`warnings`:

| Reason | Mode | Completion condition for `Approve` |
|---|---|---|
| `centred_label_layout` | **Holder assignment** — `declared_text` read-only by default, focus ring on the holder column, machine holder shown as untrusted; header counter "12 / 43 rows attributed" | every row explicitly touched |
| `vision_base_item_sparse` (and, once the OCR stage exists, `ocr_item_recall_low` / `ocr_core_items_missing`) | **Item coverage** — a 14-cell strip from `ITEM_LABELS`, found/missing; the action is "add the missing item from the page" and it demands a page number, an `item_no` from the strip, and at least one row per holder, so a half-item cannot be created | no missing item unaccounted for (added or explicitly marked absent-on-page) |
| `vision_holder_triple_missing` | **Holder triple** — the strip renders per item as has-self / has-spouse / has-dependent; the fix is usually adding nil rows | every item has all three holders present or explicitly noted |
| `vision_amount_spike` | **Transcription**, filtered to rows where `contains_amount` fired, with the items-11/12 exemption stated inline | every flagged row confirmed or corrected |
| `page_coverage_low` | **Coverage** — pages with no parsed rows listed first | every uncovered page visited |

**Keys.** `j`/`k` row · `[`/`]` page · `1`/`2`/`3`/`0` holder =
self/spouse/dependent/unspecified · `i` edit `declared_text` inline (Esc cancels)
· `s` `secondary_text` · `a`/`d`/`D` change_type = addition/declared/deletion ·
`n` `is_nil` override (opens the mandatory reason field — never a bare toggle) ·
`x` split row (item 3) · `Enter` confirm as-read · `u` undo (pre-save only) ·
`z` (hold) reveal the machine's original · `g <n>` jump to item n · `?` shortcut
sheet · `Cmd+Enter` page done · `Cmd+S` open the save diff.

**Footer — exactly two terminal decisions**, equally easy to reach:

* **Approve document** — disabled until the mode's completion condition is met.
  Writes `register_review_state` with `disposition='approved'` and
  `evidence_sha256 = register_documents.content_sha256`. Shows the blast radius
  first: "publishes 43 rows for Jane Smith MP".
* **Keep quarantined** — fixed-vocabulary reason (layout unreadable / page
  illegible / needs re-extract). The honest outcome for a document the operator
  cannot fix.

Row-level y-band highlighting is **not possible in v1**: `register_parse.py:186-199`
computes `Band.y` per row and discards it before serialisation
(`extract_register.py:406-418` carries only `page_no`). Persisting a bbox is a
one-field artifact change that coexists with the previous artifact via
`UNIQUE (content_sha256, extractor_version, tier)` — but it is a re-extract, not
a UI change. **v1 highlights the page.**

### 6.2 Screen (b) — security candidate

`/admin/register/securities`. One candidate at a time from
`register_resolution_backlog`, biggest fanout first.

Card contents, top to bottom:

1. `candidate_raw` in mono with `candidate_norm` beneath.
2. **Blast radius before the decision**: "occurrences 8 · 6 members · items 1,4 ·
   parliaments 46,47,48". A single alias fans out to N **named people**.
3. The actual `declared_text` strings it came from, each with a one-click
   "open the source page" reusing §5 — the anti-guess control. A member's
   "Woodside" might be Woodside Petroleum or Woodside Energy Group Ltd, and only
   the page settles it.
4. A search over `"company-metadata"` (code + name), `↑`/`↓` to pick, showing
   `stock_code · company_name` and how many other register candidates already
   resolve to that code.

**Keys → the alias table's own CHECK vocabulary** (`000096:400-415`):
`1` resolve to the highlighted listing (then one keystroke for `alias_kind`
`e`/`f`/`l`/`m` = equity/etf/lic/managed_fund) · `2` unlisted fund (NULL
`stock_code`, `resolution='unlisted_fund'`) · `3` not a security
(`resolution='not_a_security'`, `alias_kind='noise'`) · `4` skip (writes nothing,
increments a skip count so a repeatedly-skipped candidate surfaces for a second
opinion).

`curated_by`/`curated_at` come from the session. **No fuzzy option is rendered at
all** (§7).

**The stopword trap is surfaced inline.** When the highlighted code is in
`tickerStopwords`, the card names it — "ETF is UBS IQ MSCI Australia ETF —
resolve only if the page says the member holds that fund" — and requires a second
`Enter`. Every fund name ending in "ETF" once resolved to ticker `ETF`, showing
ten members as holding a fund none had declared.

Throughput: after a decision, focus lands on the next candidate with the search
pre-seeded from `candidate_norm`, so the common case is type-nothing + `1`. This
is the one screen where a true post-save undo is cheap and **is** offered:
deleting the alias row returns those items to `unmatched`, the honest pre-state.

### 6.3 Screen (c) — locality

`/admin/register/locations`. **Three sub-queues, never merged** — `ambiguous`,
`no_state` and `unmatched` each have a different correct action.
`register_location_backlog` already keeps the status, so no re-derivation is
needed here.

* **`ambiguous`** (Richmond across NSW/VIC/TAS/QLD): candidate SAL polygons via
  the existing `web/src/@/components/housing/choropleth-map.tsx` with `focusId`.
  Keys `1..9` pick a candidate · `r` mark as region · `n` leave unresolved
  (**the pre-selected default**) · `s` skip.
* **`no_state`**: leads with the page crop and a state selector; picking a state
  runs a live resolver **preview** showing the resulting candidate set before
  anything commits. The action is almost always "leave unresolved".
* **`unmatched`**: two exits — fix the transcription (routes back to screen (a)
  as a `declared_text` correction, because the fix belongs at the source) or
  record a curated locality in `register_location_aliases`.

`region` is an explicit, cheap outcome and is **not** an escalation:
`000096:422-425` — the form asks for "suburb or area only", so a region result is
a source characteristic.

**Three hard guards, all editorial:**

1. Any submitted locality runs through the **same street-token / leading-number
   validator the resolver uses**, or this screen becomes the hole in a redaction
   that currently leaks zero rows across the corpus.
2. The map is clamped far below `choropleth-map.tsx`'s `MAX_SCALE = 48`, so an
   operator cannot zoom toward a house.
3. The candidate list is **unordered**, with no "recommended" or "nearest"
   affordance. Guessing which of two same-named suburbs a member owns property in
   is exactly the invention the standards forbid.

---

## 7. What is deliberately not editable, and what is deliberately absent

### 7.1 Editable — and why each earns it

| Field | Why |
|---|---|
| `declared_text` | The transcription itself; the register is free text as written by the member. This is the fix for the 47P `LABEL_X_MAX` damage where "Not Applicable" became "Applicable" and "X Pty Ltd" became "Ltd". On every edit the UI re-runs `is_nil_value()` (`register_schema.py:126-129`) and the amount regex, so a figure typed into item 1 or 3 flips the read-only `contains_amount` display and warns inline. |
| `declared_lines` | Line structure (textarea, one entry per line). `000096:302-308` keeps physical lines deliberately: "Warragul" + "Port Melbourne" flattened is a locality matching no suburb. |
| `secondary_text` | Item 3 Purpose / 6 Creditor / 4 Activities. Editing it un-suppresses purpose on read with **no API change**: `politicians_attribution.go:68-76` blanks only a purpose matching `purposeRunOnRe`, so a hand-split purpose stops matching and reappears. |
| `tertiary_text` | Item 5's third column. |
| `holder` | 4-option **select** (CHECK at `000096:323-324`). THE fix for the centred-label quarantine, where the rows are right but the parser cannot attribute them — a human looking at the page can. |
| `change_type` | 3-option **select** (`000096:325-326`). Mislabelling an addition as a deletion inverts a named person's holding interval in the ordered fold. |
| `item_no` | 1..14 **select**; `item_label` is **derived** from `ITEM_LABELS`, never typed. The fix for the Tesseract `1.` → `4,` misread that files shareholdings under directorships. |
| `is_nil` | **Override only**, with a mandatory reason. Never a bare checkbox (§7.2). |
| `lodged_date` + `date_is_stated` | An **interlocked pair**: a date may be set only by also asserting the page states it, and clearing the date forces `date_is_stated=false`. `000096:278-279` and `compliance.tsx:203-233` both say an unknown start stays unknown — substituting one fabricates the start of a named person's holding. |
| `statement_kind`, `page_from`/`page_to` | The vision tier deliberately never splits a scan into base + alterations; an operator with the page can. |

### 7.2 Not editable — eight classes

1. **Any amount / value / quantity / price.** There is no such column and the
   migration test asserts none exists. `contains_amount` is displayed
   **read-only**: it is computed from *our* transcription by regex, never asked
   of the model, "because a model-supplied boolean would be an opinion where a
   measurement is needed". An operator who can clear the flag can clear the
   tripwire; one who can set it can fake one. They may change only the text it is
   computed from.
2. **`source_url`.** It is the citation rule 1 requires; an editable source_url
   lets a bad edit hide behind a plausible citation. It is also the UNIQUE join
   key on `register_documents` (`000096:126`).
3. **`content_sha256` / `storage_uri` / `document_id` / `extraction_id` /
   `fetched_at` / `source_licence`.** Provenance. Editing them detaches a
   correction from the artifact it corrects and breaks the correction key itself.
4. **Person identity** — `politician_id`, `person_key`, `slug`,
   `declared_surname`, `declared_other_names`. Reassigning a statement moves an
   **entire declared history onto a named individual in one action**, and slugs
   are minted once and never reassigned because they reach OG images, the sitemap
   and editorial cross-links (`aph_load.go:~215`). Identity belongs in a separate
   merge flow over `politician_aliases`, showing both people's holding counts
   before and after, **not reachable from the row editor**.
5. **`register_item_securities.stock_code` / `resolution_status` directly.**
   Auto-derived rows are **rebuilt every `-mode register-resolve`**
   (`000096:346-348`); only `register_security_aliases` rows survive. A hand-set
   value vanishes and the operator re-fixes the same row forever without knowing
   why. Same for `register_item_locations` → `register_location_aliases`.
6. **`match_method = 'analyst_fuzzy'` as a resolved outcome.** CHECK-forbidden
   (`000096:380-383`). The UI must not **offer** it — a constraint violation is a
   terrible way to learn a load-bearing editorial rule after you have already
   made a decision about a named person.
7. **`register_documents.extract_status` as a toggle.** Promotion is the
   *outcome* of a completed review, computed by the gate, never a checkbox.
8. **Free-text inputs for `holder` / `item_no` / `change_type`.** All three are
   CHECK-constrained enums; a free-text field either fails at save or gets
   "helpfully" normalised into the wrong enum.

### 7.3 Destructive affordances deliberately omitted

| Omitted | Reason |
|---|---|
| **Delete a declared row** | Removing a row a member actually made deletes a declared interest from a named person's record. It also breaks the nil-rate tripwire — `000096:285-290`: "item 1 at 100% nil for a whole parliament is a broken parser, not 151 share-free members", which `register_extraction_stats` measures. Takedown is modelled as `action='suppress'` → `suppressed_at`: the row survives, hidden from the fold. |
| **Bulk edit / find-and-replace across documents** | One regex mistake rewrites declarations for hundreds of named individuals and floods the trail with identical unreviewed events. The safe fan-out mechanism already exists, is a lookup, has one row and one reversal: the alias table. |
| **"Approve all quarantined"** | It publishes precisely the documents whose holder attribution is known unreliable. Wrong attribution under a named person is far worse than a known gap. No force parameter, no queue-level approve, no keyboard path that approves a document the operator has not scrolled. |
| **Reassign a statement to a different person** | See §7.2 item 4. |
| **Download / export the page image or the PDF** | No download button, no "open our copy", no bulk export. The "Original PDF" link points at aph.gov.au, exactly as `SourceLine` already does. Every affordance producing a file on the operator's disk is one right-click from redistribution. |
| **A free-text locality that skips the resolver's validator, or a map zoom below suburb granularity** | This UI is the one place a human could reintroduce a home address. |
| **Edit or delete another operator's correction in place** | Append-only, superseding only, or the trail is not evidence. `Undo` (pre-save, pops the pending set) and `Revert` (post-save, appends a superseding correction whose `corrected_text` equals the original machine reading, `reason_code='reverted'`) are **different words for different things** and must be labelled differently. Deleting a correction row is not an affordance at any level. |
| **Run the pipeline, refresh the MVs, or flip `POLITICIAN_INTERESTS_ENABLED`** | `-mode register-load` DELETEs and rebuilds statements; the kill switch is a takedown control with prod blast radius. Neither shares a keystroke surface with row edits. |
| **Auto-commit on auto-advance** | Advancing is fine; committing on advance is not — a mis-hit `j` would silently write. |
| **`window.confirm()` / `window.prompt()`** | Every confirmation in `/admin` today is native `confirm()` (takes editor `:56/:69/:82`, broadcasts `:70/:89`), and the two writes that touch the data layer — enrichment approve/reject and cache flush — have **no** confirmation at all. `confirm()` is browser-suppressible, inconsistent for screen readers, and cannot show the payload. `web/src/@/components/ui/alert-dialog.tsx` exists and is unused under `/admin`. This console uses it. |

### 7.4 The four wrong-edit hardening rules

1. **Nothing writes on keystroke.** Every action lands in a session-scoped
   pending change set in a persistent right rail. One deliberate `Cmd+S` opens an
   `AlertDialog` listing every pending change as
   `item 1 · Self · row 2 · declared_text: "Ltd" → "X Pty Ltd"` (machine value in
   muted mono, human value in foreground — the same grammar `DeclaredEntity`
   already uses). You confirm the **set**, not the field. One transaction.
   Reason capture is graduated: a fixed-vocabulary chip (`misread`,
   `wrong_column`, `ocr_digit`, `centred_label`, `model_hallucination`) for
   ordinary transcription fixes; a **mandatory free-text `rationale`** for
   `is_nil` override, `holder`, `change_type`, row split and row suppress.
2. **The machine's reading is on screen at all times.** Every corrected field
   renders two lines — human value normal weight, machine value beneath it
   struck through in muted mono labelled "machine read". `z` held collapses the
   human value so the operator compares the machine directly against the page.
   On the public surface the equivalent is a **`Corrected` chip** whose title
   reads `Corrected 27 Jul 2026 — machine read "Ltd"; source page reads "X Pty Ltd"`
   and which links `/disclaimer#corrections` (already written, already linked
   from `CaveatNote` at `compliance.tsx:351-358`, currently with **no mechanism
   behind it**). The chip follows the existing iconography discipline — muted
   outline only, **never a warning colour**: "a warning badge next to a family
   member is an accusation" (`compliance.tsx:45-47`).
3. **Undo ≠ Revert** (see §7.3).
4. **Blast radius before the click, counted in named people**, and a **second
   admin** for the two highest-fanout classes: an alias with `occurrences >= 20`,
   and any `holder` change on a row that already carries a resolved security.
   Those land with `needs_second_review = TRUE` and `applyCorrections` skips them
   until a different admin email confirms (`confirmed_by <> corrected_by`, CHECK
   enforced). Full four-eyes on every edit is incompatible with hundreds of
   reviews; this covers the two ways one keystroke reaches dozens of people.

---

## 8. Build sequence

Each step is independently verifiable and independently shippable. **No step
changes what the public sees until step 9**, which is explicitly a data-withdrawal
step.

### Step 0 — measure (no code)

Run against the target DB and record the numbers in the tracking issue:

```sql
-- a) machine status distribution
SELECT extract_status, extract_tier, count(*),
       min(page_coverage_pct), max(page_coverage_pct)
FROM register_documents GROUP BY 1,2 ORDER BY 3 DESC;

-- b) THE crossover: published documents carrying a blocking gate warning
WITH latest AS (
  SELECT DISTINCT ON (document_id) document_id, warnings
  FROM register_extractions ORDER BY document_id, created_at DESC)
SELECT count(DISTINCT d.id) AS docs,
       count(DISTINCT st.politician_id) AS people,
       count(*) FILTER (WHERE NOT i.is_nil) AS declared_rows
FROM register_documents d
JOIN latest l ON l.document_id = d.id
JOIN register_statements st ON st.document_id = d.id
JOIN register_declared_items i ON i.statement_id = st.id
WHERE d.extract_status = 'extracted'
  AND l.warnings ?| array['vision_amount_spike','vision_holder_triple_missing',
                          'vision_base_item_sparse','vision_nil_saturated',
                          'vision_batch_unrecoverable','no_items_parsed','no_readable_pages'];

-- c) row-lane volume
SELECT item_no, count(*) FROM register_declared_items
WHERE contains_amount GROUP BY 1 ORDER BY 2 DESC;

-- d) current public size
SELECT count(*) FROM mv_register_public_holdings;
```

**Verify:** the four results are pasted into the issue. Every later PR body
quotes them rather than a survey's stale figure (§0).

### Step 1 — migration 000098

Write the up/down SQL of §2 and
`services/migrations/register_review_console.test.mjs` asserting: no banned
column name in `register_corrections` (with `JSONB` added to the type list); the
`action` CHECK contains no `delete`; `register_corrections.document_id` uses
`ON DELETE RESTRICT`; the append-only trigger exists; every seeded document-lane
`reason_code` appears **literally** in `services/report-extractor/register_parse.py`
or `register_vision.py` (the two OCR codes exempted with a named comment);
`'region'` is **not** a seeded reason; `register_public_corrections` does not
select `rationale`.

**Verify:** `cd services && make migrate-up && make migrate-down && make migrate-up`
on a fresh local DB; `node --test services/migrations/register_review_console.test.mjs`;
`node --test services/migrations/register_of_interests.test.mjs` still green;
`SELECT count(*) FROM register_review_queue GROUP BY target_kind` returns the
lane sizes from step 0.

### Step 2 — page server

`services/report-extractor/register_pageserver.py` + a `make register-pageserver`
target + `test_register_pageserver.py`.

**Verify:** `curl -H "X-Internal-Secret: …" '127.0.0.1:8099/page?document_id=<uuid>&page=1&dpi=110' -o /tmp/p.png`
returns a readable PNG; a request with a `storage_uri`, a path, a `dpi=600`, a
page beyond `page_count`, or no secret returns 4xx; the response body for every
error contains no `storage_uri`. `lsof -nP -iTCP:8099 -sTCP:LISTEN` confirms the
pid is the process just started.

### Step 3 — proto + backend

`register_review.proto`, `buf generate`, `RegisterReviewServer` in
`services/shorts/internal/services/shorts/register_review.go`, store methods in
`.../store/shorts/postgres_register_review.go`, mount in `serve.go`, extend
`internalOnlyMethods`.

**Verify:** `cd services && go test ./...` (including `proto_parity_test.go`,
which must stay green — proof the new package is out of its scope); a
`buf curl`/`grpcurl` call to `ListReviewQueue` with no auth returns
`Unauthenticated`; with the internal secret and a non-admin `X-User-Email`
returns `PermissionDenied`; with an admin email returns rows.

### Step 4 — collector replay

`aph_corrections.go` (`applyCorrections`, per-correction savepoints),
`aph_items.go` (+ label parity test), the three edits of §3.3, and
`aph_corrections_test.go` covering all four outcomes.

**Verify:** integration test — load a document, insert an `amend` correction,
re-run `-mode register-load`, assert the corrected value survives and
`apply_status='applied'`; mutate the artifact so the machine reading changes and
assert `stale` + not applied; delete the target row from the artifact and assert
`orphaned`; write a `holder` correction that collides and assert `conflict` with
the document still fully loaded. Then
`SELECT * FROM register_review_queue WHERE reason_code LIKE 'correction_%'`
shows exactly those three.

### Step 5 — auth hygiene (independent, ship first if convenient)

Lowercase `ADMIN_EMAILS` in `web/src/server/auth.ts:169-178`; make
`requireAdmin()`'s sign-in callback the current path; replace both hardcoded
admin slices in `middleware_connect.go` with one env parse.

**Verify:** add a mixed-case address to `ADMIN_EMAILS`, sign in, reach
`/admin/register` (today it silently redirects to `/`); a Jest test asserts
`auth.ts` and `admin.ts` derive the same allowlist from one input; a Go test
asserts the interceptor grants `admin` from the env var and not from a literal.

### Step 6 — server actions + the queue overview screen

`web/src/app/actions/admin/register.ts`,
`web/src/app/admin/register/{layout,page}.tsx`, and the nav entry.

**Verify:** signed in as admin the queue renders with the step-0 lane counts;
signed out, `curl -X POST` of the `listReviewQueue` action-id returns a redirect,
not data (this is the `sendBroadcast` regression test in miniature); Playwright
screenshot of the overview.

### Step 7 — screen (a)

Document worklist + editor + pending-change-set rail + `Cmd+S` diff dialog +
Approve / Keep-quarantined.

**Verify:** end-to-end on a real `centred_label_layout` document — reassign three
holders, save, confirm three `register_corrections` rows with
`corrected_by = <operator>` and non-empty `rationale`; confirm nothing changed in
`register_declared_items` until `-mode register-load` ran; confirm `Approve` is
disabled until every row is touched; confirm the page image renders and a
`register_page_views` row was written per render.

### Step 8 — screens (b) and (c)

**Verify:** resolve the top backlog candidate; confirm one
`register_security_aliases` row, then `-mode register-resolve` and assert the
`occurrences` count of that `candidate_norm` drops to zero in
`register_resolution_backlog`; confirm the fuzzy option does not exist in the
DOM; confirm a locality submission containing a street number is rejected client
**and** server side; confirm `region` never appears in the locality queue.

### Step 9 — flip the publication gate (the data-withdrawal step)

Swap `selectExtractionsToLoad` and `purgeNonExtractedStatements` onto
`register_document_gate` (§3.3 edits 1–2). **Prerequisite:** every
`blocks_publication` document-lane item has a disposition other than
`open`/`claimed`.

**Verify:** before merging, run
`SELECT count(*) FROM register_document_gate WHERE NOT publishable` and the
step-0 crossover query, and put **both numbers in the PR body** — this step
withdraws every un-triaged blocking document from `mv_register_public_holdings`.
After deploy: `-mode register-load` then `-mode register-resolve`, then compare
`count(*) FROM mv_register_public_holdings` against the predicted figure. A
mismatch is a bug, not a surprise.

### Step 10 — suppression reaches the MV, and the ISR bust

Add `AND i.suppressed_at IS NULL` to all three arms of
`selectHoldingEventsQuery`; port `services/house-price-collector/revalidate.go`'s
`pingRevalidate` into `aph_mode.go` at the end of `runRegisterResolve` with
`?path=/politicians,/politicians/changes,/politicians/short-interest&flush=politicians`.

**Verify:** suppress one row for a test politician, run load + resolve, assert it
is gone from `mv_register_public_holdings` **and** still present in
`register_declared_items` with `suppressed_at` set; assert
`/politicians/<slug>` reflects the change within one request rather than 24 hours.

### Step 11 — the rule-7 public annotation

`Corrected` chip on the profile row, fed by `register_public_corrections`,
linking `/disclaimer#corrections`.

**Verify:** a correction with a `public_note` renders the chip; one without
renders nothing; `rationale` appears in **no** network response — assert with a
Playwright network capture and a Go test asserting the public read path never
selects the column.

### Step 12 — deferred: prod page server

Cloud Run service `register-page-server`, `ingress = internal`, reading `gs://`,
with `startup_probe` + `liveness_probe` and `min_instance_count = 0`.

**Verify:** the console renders a page image from a Vercel preview with the
operator signed in, and returns 403 signed out; `curl` of the Cloud Run URL from
outside the VPC fails.

---

## 9. Open questions

1. **Where does the console run in v1?** This spec assumes local (`npm run dev`
   + local page server) against the prod API, because the PDF working cache is on
   `/Volumes/gamma-systems-2`. If the console must be usable from a Vercel
   preview before step 12, the page pane degrades to the 503 panel and the
   operator corrects text-only — acceptable for screens (b) and (c), **not** for
   screen (a)'s holder-assignment mode, which is precisely a "look at the page"
   task.
2. **Claim TTL of 2 hours** is a guess. It only matters once there is more than
   one operator.
3. **Row bbox persistence** (`Band.y`, §6.1) is a re-extract of the whole corpus.
   Worth scheduling only if the operator reports page-level highlighting as the
   bottleneck.
4. **Identity merge flow** (`politician_aliases`, `merged_into_id`) is named as
   out of scope here and has no home yet. Measured state is 0 unresolved
   identities, so it is a rare path — but it is genuinely missing.
