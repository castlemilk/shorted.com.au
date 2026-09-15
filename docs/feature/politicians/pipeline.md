# Pipeline

Every mode is `shorted influence -mode <name>` from `services/jobs`, implemented
in `services/jobs/internal/jobs/influence/`.

**`REGISTER_DRY_RUN` defaults TRUE.** Each mode is a no-op until it is explicitly
set false. All register modes are deliberately **excluded from `-mode all`**:
`all` runs on every prod deploy, and an 804-document crawl of aph.gov.au must
never fire from a deploy step or an unattended timer.

**A bare mode name is rejected.** `shorted influence register-fetch` (dropping
`-mode`) used to parse clean, leave mode at its `tax` default, and ingest the
entire ATO corporate-tax corpus.

## Order

```
register-senators ──────────────────────────────┐   (identity, no documents)
                                                ▼
register-discover ─→ register-fetch ─→ [python extract] ─→ register-load ─→ register-resolve
                                                                                 │
                                    ┌────────────────────────────────────────────┤
                                    ▼                    ▼                       ▼
                            register-handbook     register-photos         register-index
                            (identity + facts)     (portraits)          (Algolia; LAST)
```

`register-index` **must run last** — it reads `mv_register_public_holdings`,
which `register-resolve` rebuilds. An index built first advertises stale matches.

| Mode | Writes | Notes |
|---|---|---|
| `register-discover` | `register_documents` | Scrapes listing pages. Downloads nothing. Re-queues documents APH lists as changed; records succession |
| `register-fetch` | GCS + manifest | Polite serial fetch, ~1.5s apart. Incremental: only `pending`/`failed` rows (a full first crawl is **~20 min by design**) |
| `register-load` | statements, declared items | DELETEs and rebuilds per document. Writes `holder`, which the fold groups on — order matters. Carries identity across succession and retires predecessors |
| `register-resolve` | securities, locations, the fold, MV refresh | ~32s. A killed run rolls back cleanly |
| `register-freshness` | — | Read-only sentinel; non-zero exit on alarm |
| `register-propose-aliases` | `register_alias_proposals` | LLM proposals. Publishes nothing; no resolver reads that table |
| `register-promote-aliases` | `register_security_aliases` | Copies only human-`confirmed` rows |
| `register-senators` | `politicians`, `politician_terms`, `politician_aliases` | **The only mode that MINTS people.** No document behind it |
| `register-handbook` | `aph_phid`, `politician_profile_facts` | **Reports duplicate PHIDs; never merges** |
| `register-photos` | `politicians.photo_*` | Wikidata/Commons. No credentials needed |
| `register-index` | Algolia `politicians` | Needs `ALGOLIA_WRITE_KEY` |

## Re-crawling: what changes when a document changes

The crawl is **incremental**, and three rules make it safe to re-run. All three
are exercised against real Postgres in `aph_succession_db_test.go` (set
`REGISTER_TEST_DATABASE_URL` to a *local* database — the suite refuses a hosted
one and never falls back to `DATABASE_URL`, which in `services/.env` is prod).

**1. Re-queue on update (discover).** A `fetched` row returns to `pending` when
its listing date is on or after the Sydney date we fetched it. Before 2026-09
nothing re-queued anything: `last_updated_at` was written and never read, and 57
of 151 current members were stale without any alarm. `blocked` and `failed` rows
are never moved, and discover never touches classify/extract status.

**2. Changed bytes, same document (fetch → extract → load).** A re-fetch whose
sha differs resets `classify_status` (page counts describe the old file); the
extractor already queues on `content_sha256`, so the new file re-extracts with no
`--force`. `extract_status` is left alone, so the member **keeps publishing the
rows from the previous file** until the new extraction lands — load only accepts
an artifact whose sha equals the document's current one. A new file that only
extracts `partial` is quarantined as before.

**3. A new URL for the same member (succession).** `source_url` is identity, so
when APH re-points a row the new URL is a new document. `register-discover`
links the departed row to its replacement (`superseded_by`, migration 000123)
within one parliament and one division, **only** on a matching surname
(letters-only, tolerating the `Surname. Ms Given` typo form) unique in both
directions, or a one-to-one spelling correction with an identical first given
name. `register-load` then:

- gives the successor the predecessor's **resolved person**, never a name match.
  The 2026 host move edited 9 of 147 name keys — Chalmers James→Jim, Conaghan
  Patrick→Pat, Wilson Josh→Joshua, Sharkie Rebeka→Rebekha, O'Brien Llew→Llewellyn,
  Pasin Antony→Tony, Brynes→Byrnes, and the `France.`/`Ryan.` full stops. Resolving
  any of those by name mints a second person;
- retires the predecessor (`extract_status='skipped'`, rows deleted) **in the same
  transaction** that publishes the successor, and only if the successor published
  at least one statement — an unreadable successor never blanks a member;
- **withholds** a new House document while a departed, unpaired document in its
  division still publishes. That is the by-election shape (two people, one seat),
  and a person decides by setting `superseded_by` or leaving the departure alone.

`register-freshness` reports unpaired departures as INFO, and alarms on a fetch
queue left undrained a week after the listing read (`aph-fetch-backlog`).
Staleness is measured on the listing clock (`last_listed_at`), not the fetch
clock, because an incremental crawl through a quiet recess fetches nothing.

## Extraction tiers

The Python extractor (`services/report-extractor/`) runs
`--stage classify → extract → vision`.

- **Deterministic tier** — pymupdf word-bboxes reconstruct the table. Works on
  born-digital documents.
- **Vision tier** — shells out to the local **`agy` CLI**, not the Gemini API, so
  there is no per-token billing and no `GEMINI_API_KEY`. It is therefore an
  **operator-machine stage**: the container has no `agy` binary and
  `require_agy()` fails fast rather than marking a batch as failed extractions.

**Unreachable bytes never touch a status column.** `open_document` raises
`DocumentUnavailable` for a missing local file, a storage 403/404 or a dropped
download, and classify/extract/vision each count those separately and leave
`classify_status`/`extract_status` as they were. Marking them would downgrade an
already-extracted document, and load purges the rows of anything that is not
`extracted` — 84 documents were one load away from that on 2026-09-15.

**`--stage extract --force` is not scoped to born-digital docs.** It re-ran the
deterministic tier over `mixed` documents whose only complete read is the vision
artifact, and `loadPendingExtractions` takes the NEWEST extraction per document —
so 85 documents silently downgraded to 20% coverage. Scope by `text_class`.

## The identity + curation modes

### `register-handbook`

Fetches `handbookapi.aph.gov.au/api/individuals` (1,879 records, ~7 MB, one call,
plain honest UA — not WAF-walled). Matches on **surname + division** (member) or
**surname + state** (senator); ambiguity withholds.

Writes `aph_phid` (309/324) and structured facts: occupations, secondary
occupations, qualifications, preferred name — each stored **verbatim as the atom
the Handbook publishes**, never rewritten. APH is ND; no prose is adapted.

**It reports duplicate PHIDs and does not merge them.** A merge moves an entire
declared history onto a named individual; detection is a machine job, disposition
is not. The 000103 CHECK refuses a merge without a curator and evidence.

### `register-senators`

The same Handbook feed as `register-handbook`, doing the opposite job: that mode
**annotates** people the crawl produced, this one **mints** them. It is the first
thing in the subsystem to create a `politicians` row from something other than a
lodged document, because the Senate register volumes are not loaded and every
senator was therefore invisible to the photo job, the search index, the funding
resolver and every read path that starts at `politicians`.

Filter: `MPorSenator ∋ Senator` (a LIST — 14 people are both) **and**
`max(RepresentedParliaments) ≥ 44`. **180 people; 171 minted, 8 matched to rows
we already held, 1 withheld.**

**The dual-chamber derivation.** `RepresentedParliaments` is flat across both
chambers, so for those 14 it cannot say which parliaments were Senate ones. The
dated `ElectorateService` (House) intervals are **subtracted** from the dated
`PartyParliamentaryService` (whole career) intervals, and what survives is mapped
back onto parliaments through the static election-day map in
`aph_parliaments.go` (38–48, each boundary cross-checked against the Handbook's
own House service records). Hanson → 45–48; Henderson → 46–48 (a casual vacancy
four months into the 46th); Ananda-Rajah → 48; Joyce and Bishop → **none**, their
Senate service is entirely below the floor.

**`1900-01-01` is the Handbook's "ongoing" marker**, not a date — it sorts before
every real date in the corpus, so parsing it inverts every interval comparison.
An ongoing interval also comes back ending **today**, because the payload is
generated per request; both are normalised to an open end.

**Two keys, one person.** `person_key` is minted from the **formal** given name
(`CANAVAN|MATTHEW`) while the slug and display name come from the **preferred**
one (`matt-canavan`), and the preferred-name key is seeded into
`politician_aliases`. `resolvePolitician` consults that table before minting, so a
future Senate register volume writing "Matt Canavan" lands on this row instead of
forking a second identity — the mechanism that produced the 28 published
duplicates.

Upsert precedence is **PHID → person_key → preferred key → mint**. A PHID held by
**two** rows is a disputed identity and writes nothing at all.

### `register-photos`

Wikidata P18 → Commons. 241/324. See
[data-sources.md](data-sources.md#portraits-why-not-the-obvious-source) for why
not aph.gov.au, and for the "Anthony Smith → Dean Smith" near-miss that made the
match key a composite rather than a name search.

Position items: House `Q18912794`, Senate `Q6814428`. **Not `Q19795070`** — that
is a Korean clan-name item with zero holders, and it shipped once, making the job
structurally House-only.

### `register-index`

Builds the Algolia `politicians` index from the published MV. Pushes index
settings on every run so a hand-edit in the Algolia dashboard cannot silently
become the contract. Records carry the portrait **with** its licence fields, so a
search hit cannot render an unattributed face.

## Commands

```bash
make register-senators-dry   # preview senator identity, writes nothing
make register-senators       # mint identity + Senate terms (no credentials)
make register-photos-dry     # preview portraits, writes nothing
make register-photos         # no credentials needed
make register-index-dry      # preview the index build
make register-index          # needs ALGOLIA_WRITE_KEY in services/.env
make register-index-env      # which Algolia creds are visible (values masked)
```

`ALGOLIA_POLITICIANS_INDEX=politicians_dev` targets a scratch namespace.

**The `DATABASE_URL` re-export in those targets is load-bearing.**
`services/.env` holds the **production** Supabase URL — it is the file operators
use for prod DDL — so sourcing it for the Algolia credentials would silently
point a "local" build at prod. The targets re-export the Makefile default
afterwards and print the (password-masked) database before doing anything.
