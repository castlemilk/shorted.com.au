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
| `register-discover` | `register_documents` | Scrapes listing pages. Downloads nothing |
| `register-fetch` | GCS + manifest | Polite serial fetch, ~1.5s apart. **~20 min by design** |
| `register-load` | statements, declared items | DELETEs and rebuilds per document. Writes `holder`, which the fold groups on — order matters |
| `register-resolve` | securities, locations, the fold, MV refresh | ~32s. A killed run rolls back cleanly |
| `register-freshness` | — | Read-only sentinel; non-zero exit on alarm |
| `register-propose-aliases` | `register_alias_proposals` | LLM proposals. Publishes nothing; no resolver reads that table |
| `register-promote-aliases` | `register_security_aliases` | Copies only human-`confirmed` rows |
| `register-handbook` | `aph_phid`, `politician_profile_facts` | **Reports duplicate PHIDs; never merges** |
| `register-photos` | `politicians.photo_*` | Wikidata/Commons. No credentials needed |
| `register-index` | Algolia `politicians` | Needs `ALGOLIA_WRITE_KEY` |

## Extraction tiers

The Python extractor (`services/report-extractor/`) runs
`--stage classify → extract → vision`.

- **Deterministic tier** — pymupdf word-bboxes reconstruct the table. Works on
  born-digital documents.
- **Vision tier** — shells out to the local **`agy` CLI**, not the Gemini API, so
  there is no per-token billing and no `GEMINI_API_KEY`. It is therefore an
  **operator-machine stage**: the container has no `agy` binary and
  `require_agy()` fails fast rather than marking a batch as failed extractions.

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
