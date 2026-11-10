# Development Flight privacy finding — 10 November 2026

Status: **observed in the development renderer; unresolved**. This record is not
a claim about a production deployment. The production-mode follow-up must produce
its own native receipts and does not retroactively turn this failed run green.

## Immutable evidence

- PR: [#973](https://github.com/castlemilk/shorted.com.au/pull/973)
- Tested head: `87bbe77c6853c351b96dba1d95cb59bda32e2a66`
- Native run: [a168d6c9-d1ba-45a7-8df7-8e428bbaf3e0](https://app.cuttlefish.sh/runs/a168d6c9-d1ba-45a7-8df7-8e428bbaf3e0)
- Attempt: `143e718b-cc72-4bc9-a50a-c6163cf537de`, exit 1 at
  `2026-11-10T10:10:58.944678Z`. The Cuttlefish shadow lane actually executed.
- Artifact: `0643f089-7ac7-4f5d-b0d5-65c6bf6e18cc`,
  `gha-artifacts/community-integration-evidence.zip`, 9,673,273 bytes.
- Archive SHA-256:
  `2b2a3ed92b0b036a3bf899e6fb3fb83fa70acc44a01e00f6154adf8ed454de25`
- Inside `postgres-reader-trace.zip`, response resource
  `resources/1c9bd154006fda25dc85e93d72038bcdda016c01.html` contains the disclosure.
  All stored author values in this run were synthetic test data.

## Observed result

Six Postgres cases passed before the failure: actual adapter/parent visibility,
child-status transitions, summary removal, persisted constraints and stock scope,
the then-development Credentials flow, and UI write/reload/direct navigation.
The signed-out browser then passed saved-reply navigation/reload and public DTO
API checks, but its legacy-fixture thread HTML contained private author fields.
That seventh case failed and was not recorded as passed. The Firestore emulator
started, but **no Firestore adapter/browser cases ran** after the first driver
failed. No both-adapter integration completion can be claimed from this run.

The response's `self.__next_f.push` stream contained an asynchronous I/O diagnostic
named `BoundPool.query` whose resolved value was the raw `pg` QueryResult. Its
`rows` included this shape (values redacted here):

```json
{
  "author_user_id": "[synthetic private ID]",
  "author_display_name": "[synthetic email-like name]",
  "author_handle": "[synthetic private handle]",
  "author_avatar_url": "[synthetic private avatar URL]",
  "author_trust_score": "999"
}
```

The query stack led through `postgres-community.ts`, `withPostgresCost`, the
community repository/cache loader and `CommunityThreadPage`. The final client
props and public APIs used the public DTOs; that did not prevent this earlier
development diagnostic from capturing the raw awaited query result.

## Mechanism and limits

Installed Next 15.5.28's development renderer at
`next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.development.js`
registers an async hook and emits resolved I/O values through `outlineIO`,
`emitIOInfoChunk` and `renderDebugModel`. The inspected production renderer does
not contain those development I/O hooks. This code inspection explains a plausible
development-specific mechanism; it is not a production privacy test result.

No supported app-level Next setting to disable just this I/O serialization was
established from the installed configuration/schema and render call sites.
Experimental React tainting would change the app's React channel and was not
shown to protect this debug serialization path, so it was not introduced.

The follow-up uses the ordinary production build/renderer and a synthetic local
session while retaining the exact HTML assertions for `private-fixture` and
`private-name@example.test`. Application auth gates, visibility rules and DTO
boundaries are unchanged. Development servers connected to sensitive records
remain outside the verified safe configuration until this finding is addressed.
