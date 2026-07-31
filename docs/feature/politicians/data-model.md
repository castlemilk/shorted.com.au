# Data model

Migrations `000096`–`000103`. The shape below is what exists now; the reasoning
behind each decision is in [architecture.md](architecture.md).

## The flow

```
register_documents      the APH PDFs we know about (manifest)
  └─ register_extractions   one JSON artifact per extraction attempt
       └─ register_statements      one lodgement by one person
            └─ register_declared_items    one declared row (the 14 form items)
                 ├─ register_item_securities   item 1 & 4 → an ASX code, or not
                 └─ register_item_locations    item 3 → an ABS suburb, or not
                      └─ register_holding_periods   the ordered add/remove fold
                           └─ mv_register_public_holdings   ← THE PUBLIC SURFACE
```

**Every public read path goes through `mv_register_public_holdings`.** Nothing
downstream queries the item tables directly. That MV is where the publication
guarantees are baked: identity-resolved people only, cleanly-extracted documents
only, and a `stock_code` a CHECK proved was matched by a publishable method.

## Identity

`politicians` — one row per person. `person_key` is derived from surname + first
given name; **slugs are minted once and never reassigned**, because they reach OG
images, the sitemap and editorial cross-links.

That minting rule is why merges are careful: `merged_into_id` retires a row
without deleting it, so the old slug can still resolve as a redirect.

| Column | Note |
|---|---|
| `aph_phid` | APH Handbook person id. **309/324.** The authoritative identity key |
| `aph_mpid` | A *different* id from a source never wired up. **0/324** — do not use it |
| `merged_into_id` + `merged_by` / `merged_at` / `merge_evidence` | A merge requires a curator and a reason (CHECK) |
| `photo_*` (6 cols) | Portrait + the attribution its licence requires |

**`person_key` cannot collapse preferred names.** It keeps only the first given
name, so `Chris` and `Christopher` are different people to it. That is why 28
humans were published twice with split histories — see
[operations.md](operations.md).

### Guards

- `politicians_photo_needs_attribution` — a photo may not exist without a licence
  and a source URL. CC BY / CC BY-SA make attribution a *condition of
  publication*, so the unattributed state is made unstorable rather than merely
  discouraged.
- `politicians_merge_needs_evidence` — no anonymous history-moving.
- `trg_politicians_reject_merge_chain` — **checks both directions.** Blocking
  "merge into an already-merged row" alone still permits merging away a row that
  others point *at*, which builds the same A→B→C chain from the other end. The
  first version missed that and the guard test caught it.

## The curated layer (000103)

Every collector rebuilds its own rows on every run. Before this, an operator
correcting a value would lose it on the next load.

```
politician_profile_facts       machine-owned. Collectors write freely.
politician_profile_overrides   human-owned. Append-only. ALWAYS wins.
politician_profile_resolved    ← the ONLY view a read path may query
```

**Querying `politician_profile_facts` directly would serve a value a curator has
already corrected** — which is the §8.17 failure exactly ("fixed in two layers,
still served from the third"). Proven end to end: a curated occupation survives a
re-crawl that rewrites the underlying fact.

Overrides are **append-only**: a correction is superseded, never edited, and a
fact is suppressed rather than deleted, so the trail stays evidence. Each carries
`machine_text` frozen at the moment of decision — without it a reviewer cannot
tell whether the crawl moved underneath them, and the console cannot show
"machine read X, we publish Y".

### The field vocabulary is closed by a trigger

§4 and rule 5 were policy, and policy widens. `politician_profile_reject_field()`
refuses, at insert, any field name matching:

- **private attributes** — `address|street|postal|phone|mobile|email|dob|birth|home|residen|spouse|partner|child|family|school|religio|health|medical|sexual|ethnic|race|criminal|conviction|allegation|scandal|controvers`
- **magnitude** — `amount|value|salary|worth|price|cost|expenditure|holding_size|portfolio`

Verified: `home_address` rejected, `net_worth_amount` rejected, `occupation`
accepted. The vocabulary can now only widen through a reviewed migration.

## Resolution

`register_item_securities.entity_kind` names *what* a candidate is:

`listed` · `private_company` · `family_trust` · `smsf` · `managed_fund` ·
`foreign` · `multi_entity` · `not_an_entity`

**`listed` is a DEFAULT**, assigned to anything the resolver cannot otherwise
explain. This is why §6.1's gate is contested: its denominator is that default
bucket, so classifying the backlog raises the number with zero new matches.
Always report it with its method.

`register_security_aliases` is the **single human control surface**: the resolver
reads it and nothing else. One row moves the gate either way —

| `resolution` | Effect |
|---|---|
| `resolved` + code | numerator up — a real new published link |
| `unlisted_fund` | denominator down → `managed_fund` |
| `not_a_security` | denominator down → `not_an_entity` |
| `foreign` | denominator down → `foreign` (added 000101) |

Only `curated_alias`, `ticker_in_text` and `name_exact` may be `resolved` —
`register_item_securities_public_gate` makes a fuzzy match structurally
unpublishable.

## Takedown

`register_declared_items.suppressed_at` (000101) withdraws **one row** without
taking the feature down. Filtered in **all three arms** of the fold — a filter
reaching two of three tells an operator a row is withdrawn while it is still
published. `aph_suppression_test.go` asserts the arm count.

Suppression is never deletion: the row keeps its provenance, and deleting one
would also break the nil-rate tripwire that `register_extraction_stats` measures.

## Search index

`politicians` (Algolia), built from `mv_register_public_holdings` — the same view
the public read path uses, so **the index cannot contain a row the site would not
already serve**. A search index is a second read path, and §8.16's lesson is that
a second path trusting its own filter is how a withheld row gets published.

## Caching

Server reads are KV-cached (`cache:politicians:*`, 24h) and busted by
`/api/revalidate?flush=politicians`.

**An empty cache entry is a MISS, not a hit.** `readCached` takes a
non-emptiness predicate mirroring each writer's own guard. Without it, `{}`
parses into a valid all-zero message, `if (hit)` is truthy, and the function
returns before the fetch that would correct it — pinning zeros for the full TTL
with the write guard unreachable. That shipped, and served a zeroed
`/politicians` until it was flushed by hand.
