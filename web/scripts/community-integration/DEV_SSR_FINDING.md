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

## Separate production follow-up: partial evidence

Head `8f4e1e4a4d6963cd9daf8cd8cbf52c1897099ae0` ran the ordinary production
build successfully in about 7 minutes 38 seconds, then recorded six Postgres cases
as passed, including real production-session positive/negative/non-admin checks
and UI save/reload/direct navigation. Native run
[449ec522-711c-4e6f-85bf-d6f319903f0d](https://app.cuttlefish.sh/runs/449ec522-711c-4e6f-85bf-d6f319903f0d),
attempt `d366a42e-7b9b-438a-9f0d-87a8f32c95bb`, still **failed**.

Both unchanged raw-HTML privacy assertions passed before the failure. The retained
reader HTML contains zero occurrences of the private fixture ID/email markers and
two safe `author.displayName` DTOs. The next assertion incorrectly expected the
generic label to be visible: neither the current thread nor reply component
renders author labels. The screenshot and HTML do show the legacy thread title
and reply. The follow-up corrects that positive assertion to the serialized safe
author DTO and visible title/reply, without changing the private-field checks.

Evidence artifact `4c899996-f5ea-44da-a915-d35748c294d4` has SHA-256
`e06b31a51f5ec50991e55d62d7a899e84836e537955d8ef203d751c051dd5fbb`.
Its `postgres-reader-trace.zip` includes response
`resources/0c484975dee287966aef3491b9bec0591144e052.html` and the `page.content`
result for trace call `call@1105`. This is partial production evidence, not a full
driver or both-store pass. Firestore was again not reached, and the original
development finding remains unresolved.
