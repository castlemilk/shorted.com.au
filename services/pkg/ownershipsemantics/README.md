# Ownership semantic revision foundation

This package is the additive storage and interchange foundation for [#971](https://github.com/castlemilk/shorted.com.au/issues/971). It records source-grounded observations for review. It does not parse SHN PDFs, modify a legacy holding, publish a value, select a current holding, send an alert or decide whether a filing complies with the law.

The reviewed source interpretation is in [the ownership notice field map](../../../docs/research/2026-11/Shorted_Ownership_Notice_Field_Map_2026-11-10.md). Existing `substantial_holder_notices` rows, the legacy form constraint, `previous_pct`/`present_pct` voting meanings and the Go/Python `unsupported_format` guards remain unchanged. No existing public RPC or `SubstantialNotice` field is extended by this foundation. The independent `ownership_semantics.proto` messages are interchange types, not a public service.

## What is preserved

`Input` holds format, jurisdiction, legal regime, declared reason, source publication date, an optional actual publication timestamp, notice/change/previous-notice dates, supplied extraction review metadata and extraction completeness. A date-only `announced_on` never becomes an invented midnight timestamp. Dates and percentages do not select a legal regime or infer a notice reason.

Every A–G `Measurement` is a body-level total in a `previous` or `present` period. Its percent, votes and denominator votes have independent `ObservedValue` statuses and evidence. A separately reported movement uses `DisclosedMovementPP`, in signed percentage points. The package does not calculate a movement from two rounded observations.

| Status | Meaning of the stored observation |
|---|---|
| `reported` | A source value was captured, including an explicit zero. |
| `unknown` | The source explicitly identifies the information as unknown. |
| `missing` | The inspected source context lacks the value; the evidence identifies that context. |
| `unreadable` | The value's source context could not be read reliably. |
| `not_applicable` | The source identifies the field as inapplicable. |
| `not_extracted` | This extraction did not establish the field. This is the truthful state for a legacy database NULL without field-level source evidence. |

Only `reported` may carry a value. Every other status has an empty value, never a numeric zero. All observed statuses except `not_extracted` require a source locator. Percentages are finite nonnegative decimal strings; votes are nonnegative integer strings. Reported movements may retain a `+` or `-` sign. Lexical precision is preserved, with no binary float conversion, exponent notation, global 100% limit or four-decimal coercion. Structural length limits prevent unbounded payloads.

`SecurityClass` retains class identity, period, quantities, voting rights and any source-reported class percentage. A class percentage requires its own stated denominator basis and cannot replace an A–G body total. `Interest` retains one source row even when several legal bases apply, with distinct holder/registered-holder/person-entitled observations. The package neither sums associates nor treats each statutory basis as a new parcel. Annexure records distinguish reference, acquisition and parsing; an unparsed referenced annexure cannot accompany `complete` extraction coverage.

Conflicting reported totals remain representable with review reasons. The validator never repairs C to equal D+E+F, constructs A from B+C, nets G, rejects a new disclosure because B is below 5%, or converts a cessation into zero. Extraction completeness describes coverage, not statutory compliance.

## Captured source and field evidence

New persisted inputs require `Source.HashStatus = "captured"`, a lowercase SHA-256 of the actual source bytes, and a SHA-256 of the extractor configuration. Callers must compute those from retained bytes/configuration; a hash of a URL is not a content hash. This package receives the hashes and does not fetch documents or verify retained document storage.

An `Evidence` locator names a source URL and at least one page, section, row or source excerpt. Pages are one-based. For the main document, an omitted `SourceSHA256` inherits the captured main source hash; an explicitly conflicting hash is rejected. Evidence in a different document requires that document's captured hash. Preparation resolves inherited hashes explicitly in the stored canonical payload. This supports annexures without pretending that a mutable URL alone identifies their contents.

## Immutable identity, replay and lineage

`Prepare(Input)` validates and deep-copies the observations, sorts keyed collections and evidence, and computes deterministic identities. It checks the one-MiB payload bound again after inherited evidence hashes are made explicit, before storage opens a transaction. Reads remove only the insignificant whitespace added by JSONB rendering before applying the same bound. Preparation never assigns a storage timestamp or mutates its caller.

- `DisclosureID` hashes a namespaced tuple of source URL, captured source SHA-256 and stable one-based document notice position (`DisclosureSlot`). The slot is a source position, not an inferred holder slug. Replaced bytes at the same URL create a different disclosure identity.
- `RevisionID` hashes the disclosure ID, source hash, extractor version, configuration hash and contract version. Changing an extractor/configuration/contract creates a distinct extraction revision, not a market event.
- `PayloadSHA256` covers the canonical complete input, including supplied review metadata, dates, links, precision and field evidence. IDs and the database-assigned `RecordedAt` are excluded from input equality.

`Store.Append` uses an explicit database transaction. Exact replay returns the original revision and timestamp with `inserted = false`. Same identity with different values, provenance, precision or review metadata returns `ErrReplayConflict`; nothing is overwritten. A separate read after an insert conflict uses a fresh READ COMMITTED snapshot, so concurrent identical inserts converge on the committed row.

`SupersedesRevisionID` links a new extraction to an existing revision of the same source bytes, URL and notice slot. `SupersedesDisclosureID` links a different disclosure to a stored earlier filing only when correction evidence is supplied. A corrected PDF replacing bytes at the same URL therefore uses a disclosure correction, not an extraction predecessor. The package never infers either relationship from arrival order, equal numbers or similar names.

Correction edges across all extraction revisions form a graph. The writer serializes correction-edge validation/insertion with a transaction advisory lock keyed to the resolved table's database identity and rejects cycles, including concurrent opposite edges. Different search-path prefixes resolving to that same table therefore take the same lock. An ancestry search reaching 128 links is rejected for explicit review rather than allowed to run unbounded. Lock waits are bounded at five seconds. There is no automatic revision ordinal, winning revision, current holding or public selector. Source aliases across different URLs are not deduplicated without a future explicit identity decision.

`ReviewState` (`needs_review`, `reviewed`, `rejected`) is immutable metadata supplied with this extraction, not a human review transition API. A new human decision must not be disguised as an extractor-version bump; a review ledger is separate future work. `PublicationEligible` must be false in domain validation and in the database, including for a `complete` and `reviewed` input.

## Persistence and compatibility

Migration `000161_ownership_semantic_revisions` creates a sidecar table independent of legacy parsed notice rows. The schema can store an unsupported notice without fabricating a legacy form or holding. The application exposes append/get/bounded-history operations only. Database triggers also reject UPDATE, DELETE and TRUNCATE, and reads revalidate the input and its deterministic identities/payload hash. The migration enables row-level security without policies or FORCE and revokes PUBLIC/anon/authenticated access to its table and helper function within the same transaction. Backend ownership and explicit `service_role` grants keep the existing 000138 treatment; no global default privilege is changed. The explicit down migration drops only the new table and helper function.

This foundation does not add migration 000161 to the deployment replay allowlist. Before a later release stages it, review deployment ordering (the existing 000138 Data API grant lockdown remains last). No production migration is executed here. Uninstalled sidecar storage returns `ErrSchemaUnavailable`; existing public ownership reads are untouched and do not depend on its presence. No historical backfill or Go/Python writer is connected to this sidecar yet.

`ToProto` and `FromProto` map the independent messages through matching JSON field names and domain validation. They reject unknown protobuf fields recursively, so unsupported metadata cannot silently disappear from an immutable observation. A shared synthetic fixture exercises Go/TypeScript interchange and captured source hashes. These examples are not actual post-commencement filings.

## Verification and remaining boundary

Run the package unit/wire tests from `services`:

```sh
go test ./pkg/ownershipsemantics -count=1
```

The real Postgres test is `TestPostgresSemanticRevisions`. It requires the explicit `OWNERSHIP_SEMANTICS_TEST_DATABASE_URL`, permits only a loopback database named `shorted_ownership_semantics_test`, and creates/drops its own unique schema. It uses the actual migration and store code. Set `OWNERSHIP_SEMANTICS_REQUIRE_DATABASE=1` to make absent prerequisites fail, rather than skip. The dedicated PR-only [runner](../../../scripts/test-ownership-semantics-postgres.sh) and workflow create a disposable local database and enforce this mode.

The Postgres cases cover migration replay without a legacy schema, exact and conflicting replay, concurrent identical inserts, preservation of prior extraction versions, corrected source bytes at the same URL, missing/cyclic/concurrent correction links, database immutability/publication checks, stored-payload integrity and unchanged legacy voting rows. A local unit run that skips this test is not persistence or concurrency evidence; the dedicated CI result must be inspected separately.

Still outside this slice: new-format parsing in either language, automatic reprocessing of `unsupported_format`, annexure acquisition, institutional/overlap resolution, compliance calculations, human review operations, production schema application, public API/UI/MCP/export integration, cache invalidation, actual mixed-format shadow ingestion and the transition readiness decision. The existing guard remains in force until those consumers and the richer extraction have evidence of working together.
