# Implementation plan and delivery gates

Complete the existing research workflow and use a small founding cohort to decide what deserves further investment. The first connected journey is: follow a company, review a dated change, ask or answer a focused question, return when evidence changes, and save a reusable research packet.

**Planning baseline: 10 November 2026.** Code findings refer to [main commit 5ce3eead7f696bacacd6a113eeee144c9cdd8a09](https://github.com/castlemilk/shorted.com.au/commit/5ce3eead7f696bacacd6a113eeee144c9cdd8a09). Source inspection establishes implementation structure and candidate defects; production configuration, deployment and user-facing behaviour still need verification. Estimates below are engineering planning assumptions.

# Priority and delivery boundary

1. Start [ownership transition readiness #971](https://github.com/castlemilk/shorted.com.au/issues/971), with a readiness decision before the 4 December source change.
2. Complete the safe, measurable community slice: #952–956 plus the minimum acknowledgement portion of #963.
3. Deliver one evidence/brief/packet path across #957, #958 and #961, scoped to the pilot companies.
4. Run the six-week pilot and the separate [commercial test #972](https://github.com/castlemilk/shorted.com.au/issues/972). Expand only after its gates are assessed.

Retain the existing heatmaps, market maps, Sankey views, treemaps and company research surfaces. Add contextual question, follow and save actions to those surfaces. Broad social discovery, private team workspaces, contributor payments, imported forum feeds and AI discussion summaries remain gated later work.

# Reuse map

| Workstream | Existing foundation | Required extension |
| --- | --- | --- |
| Questions and replies #952 | Next.js community routes, composer/detail UI, comments, votes/reports and CommunityStore adapters | Persisted reply rendering, visibility rules, bounded pagination/payloads, durable company and event anchors |
| Profiles and follows #953 | Author snapshots and existing watchlist widgets | Public pseudonym boundary, company/question follows, private saves, preferences; stage people-following after the initial loop |
| Disclosures #954 | Author/source snapshots | Atomic post-time declarations, affiliation review state and revision handling |
| Moderation #955 | Heuristic review holds and persisted reports | Operational queue, authorised actions/audit, cache invalidation, block/mute and appeals |
| Measurement #956 | Product-event logs and low-cardinality OpenTelemetry counters | Permissioned cohort ledger, historical actor classification and reproducible gate queries |
| Evidence #957 | GetEventTimeline merges announcements, director events, news and short changes | Stable IDs, multiple dates, provenance/rights, corrections, coverage state and deterministic pagination |
| Alerts #958 | Persistent monitors, evaluator, history, pause/resume, entitlement checks, data holds and delivery/replay machinery | Review cursor, explainable/deduplicated briefs; audit current crossing rules before adding validated controls |
| Packets #961 | Streaming CSV/NDJSON panel export with available_from and security_type | Frozen manifest and snapshot workflow, definitions, coverage, correction lineage and permitted content |

[Community contract](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/lib/community/community-store.ts), [community types](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/types/community.ts), [timeline handler](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/shorts/internal/services/shorts/event_timeline.go), [alerts API](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/proto/shortedapi/shorts/v1alpha1/alerts.proto), [alerts operations/tests](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/jobs/internal/jobs/alerts/README.md), [panel exporter](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/shorts/internal/services/shorts/panel_export.go).

Bulk export [#542](https://github.com/castlemilk/shorted.com.au/issues/542) is closed as completed. Earlier API/data issues [#536](https://github.com/castlemilk/shorted.com.au/issues/536), [#549](https://github.com/castlemilk/shorted.com.au/issues/549), [#563](https://github.com/castlemilk/shorted.com.au/issues/563) and [#582](https://github.com/castlemilk/shorted.com.au/issues/582) are also closed in the live issue snapshot. Treat them as implementation history and useful regression context, not open dependencies. None of #952–969 is complete merely because foundation code exists.

# First verification and hardening slice

| Finding from inspected source | Owning issue | Required evidence before pilot |
| --- | --- | --- |
| Thread page passes an empty comments array; detail component only initialises local state and appends a newly posted reply | #952 | Reply survives reload/direct navigation and is visible to a separate authorised reader against the selected store |
| Thread detail reads do not visibly enforce the active-only policy used by lists | #955 | Hidden/review-held content is inaccessible through public detail/API/cache paths; authorised moderator preview is separate |
| Public author displayName can fall back to session email | #953 | Missing public name uses a safe pseudonym/setup flow; public DTOs contain no account email or internal account ID |
| Explicit Postgres store selection falls back to Firestore when configuration is missing | #952 | Selected source of truth is observable; a missing explicitly selected store fails safely rather than switching writes silently |
| Source count can produce a high-signal label; analytics discard unknown properties | #963 and #956 | Source attachment, helpfulness and review are distinct; cohort facts persist through a deliberately designed ledger |

Sources: [thread page](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/app/shorts/%5BstockCode%5D/community/%5BthreadId%5D/page.tsx), [detail component](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/components/company/community/community-thread-detail.tsx), [create route](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/app/api/community/%5BstockCode%5D/threads/route.ts), [Postgres adapter](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/lib/community/postgres-community.ts), [cache](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/lib/community/community-activity-cache.ts), [store selection](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/lib/community/community-repository.ts), [event helper](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/web/src/@/lib/product-events.ts).

Reproduce each candidate defect in a controlled environment before closing it. The first useful browser check uses an author, an ordinary reader and a moderator; it includes a reload and a cache transition, not only optimistic UI.

# Technical decisions

## Keep current service boundaries

Extend the Next.js community API through CommunityStore, the Go stock/timeline service through its existing contract, the current AlertsService and evaluator, and the panel exporter. Keep protobuf changes additive and regenerate clients through the repository's existing process. A second forum backend, scheduler or entitlement implementation adds migration work without proving the pilot hypothesis.

Choose and record the actual pilot storage adapter before implementation. A storage migration is not a prerequisite if the selected adapter meets the required semantics. If migration is necessary, rehearse counts, timestamps, visibility states, IDs and read parity; preserve rollback capability without deleting new contributions.

## Stable company and instrument identity

First inspect the existing entity graph. Its [entities schema](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/migrations/000047_add_entities.up.sql) provides an ID, but the [backfill](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/shorts/cmd/graph-backfill/main.go) assumes ticker stability. Reuse it only after defining an enduring company identity, a listing/instrument where necessary and effective-dated ticker aliases.

Bind questions, follows, disclosures and evidence to stable identities while retaining the displayed ticker at capture time. Legacy ticker URLs must resolve to the correct history. A ticker rename preserves associations; later ticker reuse by another company must not merge histories. Unknown matches require review rather than a guessed identity.

Timebox the identity decision to the first two engineering days. A pilot mapping for six reviewed companies is acceptable if its contract and migration path are explicit; a second competing company registry is not.

## Proposed object contracts

These are logical contracts to map onto existing tables/DTOs, not a demand to introduce a new service for every row.

| Object | Minimum persistent fields and rules |
| --- | --- |
| Company/listing alias | Stable company ID; listing/instrument ID where needed; exchange, ticker, effective interval and matching evidence |
| Evidence version | Event ID and version; company/listing; event type; source ID/URL/hash; observation/effective date, publication date, ingestion timestamp; units, old/new values; extraction version; quality and coverage state; supersedes link |
| Contribution | ID/type; author public ID; company; optional evidence version/chart-state anchor; body; created/edited timestamps; visibility state; disclosure snapshot ID |
| Disclosure snapshot | Position category and affiliation/sponsorship declarations, declared_at, version; separate verification scope/reviewer/expiry |
| Follow/save/review | Account owner; company/question target; privacy and notification preferences; review cursor and last successful review action |
| Brief item/delivery | Evidence version or contribution version; why-shown reason; audience; deduplication key; queued/sent/failed/suppressed status; entitlement/block checks |
| Packet manifest | Packet/version ID; query and as-of boundary; dataset/source versions; rows/coverage; units/definitions; chart inputs; hashes; permissions; correction links |
| Cohort event | Stable event ID; schema; server times; pseudonymous actor and historical role; cohort/circle/object; action and bounded properties |

Never fill an unknown publication date with ingestion time. Distinguish event occurrence, report observation, source publication and Shorted ingestion. A late-arriving disclosure is new to a review queue even when its effective date is old; show both dates.

In the timeline, decide whether a short-change comparison is previous report or previous complete week. The inspected [query](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/shorts/internal/store/shorts/postgres_timeline.go) uses successive-row LAG despite a weekly description. The label, calculation and test fixture must agree.

## Brief and alert behaviour

Continuous alert evaluation already exists. For a short-interest-above rule, the [evaluator](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/jobs/internal/jobs/alerts/evaluate.go) checks an upward crossing; staying above does not repeatedly fire, and falling below then recrossing can fire again. The API has daily/weekly cadence, active/paused state and history. Configurable once-only and cooldown fields are not present in the inspected contract.

Document that behaviour before extending it. Add only controls justified by the pilot. Use the existing evaluator/outbox path and entitlement rule. A research brief groups eligible evidence; it must not create a parallel monitor that disagrees with existing alerts.

For the first slice, support a quiet in-app review queue and one chosen daily or weekly email cadence. Each item explains whether it appeared because of a company follow, saved question or rule. Keep reported changes separate from community responses.

Advance a user's review cursor only after an explicit successful review action, not because an email was queued or opened. Use a monotonic availability/version boundary plus the saved item set so late arrivals and corrections remain visible. No qualifying change, source late/incomplete and source not checked are separate states.

Recheck entitlement, mute/block and consent at delivery time. The same underlying event should not generate duplicate immediate and digest notifications unless the user deliberately chooses both.

## Research packet behaviour

Build on the existing panel export. First support one company or saved coverage list, a fixed cutoff, source-linked short/ownership events, chart inputs and CSV/JSON data plus a readable summary. A polished PDF and team publishing workflow can follow demonstrated use.

The manifest must let a user understand and reproduce the numerical dataset for the same query, cutoff and source versions. Store complete/incomplete status and row counts; a truncated response must not be presented as a finished packet. A correction creates a new linked version instead of silently changing the packet already used in a report.

Source permissions and private-content permissions apply to every export. Preserve existing eligible open-data rights. Unknown rights for one attached filing should not remove access to an otherwise permitted Shorted/ASIC dataset; withhold the unsupported attachment and explain the scope.

# Ownership transition track

[Issue #971](https://github.com/castlemilk/shorted.com.au/issues/971) owns compatibility; #962 owns the later exploration experience. The scope includes both Go and model-assisted readers, storage constraints, protobuf/API, notice event classification and all consumers of affected measures.

Use official blank forms and reviewed synthetic examples for initial/change/cessation notices across legacy, transitional and SHN families. Include NZ regressions, multiple classes, overlapping interests, offsetting positions, corrections, unreadable fields and a valid new-regime case that the old voting-only threshold would reject.

Store new measures separately. SHN must not fall through to NZ, and a notice that cannot be interpreted must remain visibly unsupported or held for review. Preserve its source for later reprocessing. Relevant/voting power, economic exposure and disclosed offsetting shorts are not interchangeable percentages.

| Proposed checkpoint | Reviewable output |
| --- | --- |
| 13 November | Official-form inventory, semantic field map, fixture cases and consumer impact inventory |
| 20 November | Additive schema plus both readers passing the agreed fixtures |
| 27 November | API/UI/export compatibility and shadow-processing report |
| 3 December | Explicit readiness decision, coverage report and safe fallback |

These targets require a named data/API owner and available release capacity. They are not commitments inferred from this planning task. If support is incomplete, keep supported historical data, expose the coverage gap and withhold misleading new derived values.

# Sequencing and effort

The ranges assume two engineers familiar with Shorted, part-time product/moderation ownership and no extensive identity cleanup. Estimate in engineer-days; parallel capacity is not the same as calendar elapsed time.

| Slice | Scope | Dependency | Base effort |
| --- | --- | --- | --- |
| A Existing-flow verification | Reply reload, public identity, visibility/cache, selected-store behaviour | None | 3–5 days |
| B Durable pilot objects | Identity/aliases, short composer, disclosures, follows/saves | A contracts | 7–11 days |
| C Operable pilot | Moderator workflow, acknowledgement, cohort ledger and gate queries | A/B | 6–10 days |
| D Evidence and brief | Six-company source/provenance contract and one review/digest path | Identity and source rights; can overlap B/C | 6–10 days |
| E Reusable packet | Manifest and output around current exporter | D evidence versions | 4–7 days |
| F Ownership transition | Fixtures, parsers/schema, consumer parity and coverage | Immediate deadline track | 6–10 days, provisional |
| G Commercial contract | Capability/entitlement matrix, offer and economics | Can begin immediately; paid test needs D/E | 2–4 product days plus 1–2 billing-engineering days |

A–C total 16–26 engineer-days. D–E add 10–17. F adds 6–10; G adds 1–2 engineering days. Overall planned engineering work is 33–55 engineer-days before a 25–35% integration allowance, or approximately 41–74 engineer-days with that allowance. This is roughly 4–7.5 full-capacity weeks for two engineers, with sequencing and owner availability potentially extending elapsed time. Commercial product work and the six-week measured pilot are additional.

The deadline means F consumes early capacity. Do not promise both all new workflows and SHN readiness within three weeks. A smaller manually curated brief/packet can support learning while D/E are completed, provided source, permission and measurement controls still hold. Charge only for a delivered, clearly described workflow.

# Pilot and expansion gates

The [pilot protocol](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Pilot_Protocol_2026-11-10.md) preserves the 24-person, three-circle design, the original activation/helpfulness/retention gates and the 8–12 hour weekly human-work budget. Day 0 begins after readiness, with measured weeks separate from engineering preparation.

The minimum useful-response acknowledgement in #963 is P0 because #956 depends on it; richer contributor discovery remains P1. Keep the full issues open until their complete acceptance criteria pass.

Keep professional/team work in discovery until there is a repeated output and a budget holder. Keep external forum ingestion behind a documented rights/cost case. Use AI summaries only after source/version permissions and corrections work across retrieval and export.

# Ownership and handoff

The live issue audit found #951–969 open and unassigned. The following are required roles, not existing personnel assignments.

| Role | Accountable deliverables |
| --- | --- |
| Product owner | Cohort/offer scope, acceptance of the research task and gate decisions |
| Community host/moderation owner | Three circle hosts/backups, moderation workflow, response audit and workload record |
| Frontend/community engineer | #952–956 and P0 #963; public identity and persistent user journey |
| Data/API engineer | #971, #957 and the evidence/packet contract |
| Billing/alerts engineer | #958 and #972 entitlement/delivery consistency |
| Independent reviewer | Source interpretation, negative access cases and release evidence |

The first handoff is a two-day discovery/verification packet: selected community store, reproduced or cleared P0 findings, identity choice, SHN fixture inventory and a refined estimate. Record that evidence on the owning issues before wider build commitments.

# Acceptance and release evidence

Use focused tests for material risks, not a checklist that merely repeats the implementation.

- Two-account community flow: publish, reply, full reload, follow/save and ticker rename/reuse.
- Privacy/visibility matrix: anonymous, author, other user and moderator; active/review-held/hidden; cached-active to hidden; queued digest and packet after a block/removal.
- Evidence fixtures: late source, missing date, correction, different units, report-vs-week comparison, old/new ownership regime and unsupported notice.
- Alert replay: crossing, staying above, recrossing, paused state, duplicate job, incomplete data, unsubscribe and entitlement change.
- Packet fixture: identical query/cutoff yields equivalent numerical data, known source revisions, clear truncation and linked correction.
- Cohort query fixture: deduplication, 48-hour boundary, staff exclusion, fixed founder denominator and week-five/week-six intersection.

A staging result and current production readiness evidence are required before closing feature issues. Coordinate with the active release work, including [#970](https://github.com/castlemilk/shorted.com.au/pull/970) as observed at audit time, and recheck its current status when implementation reaches release. This planning update publishes documentation and issue scope; it does not establish a production rollout.

# Linked planning material

- [Research update](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Strategy_Research_Update_2026-11-10.md)
- [Pilot protocol and commercial validation](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Pilot_Protocol_2026-11-10.md)
- [Epic #951](https://github.com/castlemilk/shorted.com.au/issues/951)
- [Ownership transition #971](https://github.com/castlemilk/shorted.com.au/issues/971)
- [Product contract and paid pilot #972](https://github.com/castlemilk/shorted.com.au/issues/972)
- [Research PR #950](https://github.com/castlemilk/shorted.com.au/pull/950)

