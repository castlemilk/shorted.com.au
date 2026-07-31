# Parliament's Portfolio — the register of interests feature

What Australian federal parliamentarians declare, from the APH Registers of
Members' and Senators' Interests. **Live on prod.**

Prod, as at 2026-07-31: **17,153 published rows · 319 politicians · 296 listed
companies · 335 suburbs · parliaments 44–48 · 241 portraits.**

## Read these in this order

| Doc | What it answers |
|---|---|
| **[data-sources.md](data-sources.md)** | Where every field comes from, what licence it carries, and which sources are ruled OUT and why |
| **[data-model.md](data-model.md)** | Tables, the curated-override layer, and the guards that are enforced in the database rather than by review |
| **[pipeline.md](pipeline.md)** | The job modes, the order they must run in, and what each one writes |
| **[operations.md](operations.md)** | Runbook: local commands, prod deploy order, and the landmines that have actually bitten |
| [architecture.md](architecture.md) | The 135KB decision-and-incident record. §8.x is the wrong-fact history — read it before changing resolution logic |
| [review-console.md](review-console.md) | The operator console spec (13 steps; screen (b) and the CRM are built) |
| [explorer-ui.md](explorer-ui.md) | Plan of record for the explorer hub / profile / compare redesign (2026-07-31): wireframe→register adaptations, new RPC contracts, work packages |
| [../../influence-editorial-standards.md](../../influence-editorial-standards.md) | The 8 editorial rules. **Not politician-specific** — it governs the whole influence layer |

## The three rules that shape everything

**1. What is held, never how much.** The registers record *what* a member
declares and do not record quantity, value, purchase price or income. There is no
amount column anywhere in the subsystem, the proto carries no amount field, and a
migration test asserts none exists. Editorial rule 5.

**2. Extracted facts are publishable; source artefacts are not.** We publish the
facts and deep-link `aph.gov.au`. The GCS bucket is a private working cache with
`public_access_prevention = enforced` and no CDN, so "we do not maintain a mirror"
is true in fact. This is why portraits come from Wikimedia Commons and **not**
from aph.gov.au — see [data-sources.md](data-sources.md).

**3. Withhold rather than guess.** Every ambiguity in this subsystem resolves to
*publish nothing*: a multi-entity cell, an ambiguous name match, two Wikidata
candidates for one person. A missing row is a gap; a wrong row is a false
statement about a named individual in the most plaintiff-friendly defamation
jurisdiction in the English-speaking world.

## Surfaces

| Route | What it is |
|---|---|
| `/politicians` | Hub: search (Algolia), party × industry heatmap, state split, full crawlable roll. **Static ISR** |
| `/politicians/[slug]` | One member's declared interests, with a portrait and per-row source links |
| `/politicians/changes` | Register additions and removals over time |
| `/politicians/short-interest` | Declared interests in companies carrying short interest |
| `/admin/register/securities` | Operator: the security-resolution backlog |
| `/admin/register/politicians[/slug]` | Operator: per-person CRM — merge, curate, portrait |

Plus embedded cards on `/shorts/[code]`, `/housing/[state]/[suburb]` and
`/economy/[state]`.

## Known-open, as of 2026-07-31

- **§6.2's editorial sign-off is unsigned.** Rule 2 (juxtaposition/iconography)
  is "no test can decide this" by its own definition, and seven items now need a
  person's read. The block is in [architecture.md](architecture.md) §6.2.
- **§6.1's resolution gate is contested at ~51%.** The denominator is a DEFAULT
  bucket; report it with its method, never as "met". See architecture.md §8.19.1.
- **A merged politician slug 404s instead of redirecting.** `canonical_slug` is
  in the proto and the profile page honours it, but the store never populates it.
  **Do not merge on prod until this is wired.**
- **28 duplicate identities** are detected but unmerged on prod.
- The 44th/45th parliaments and all 35 Senate volumes are unfetched. Every
  profile states this via `CoverageNote` rather than rendering an empty list that
  reads as "declared nothing".
