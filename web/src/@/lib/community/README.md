# Public community reads

This is the initial read and visibility repair for #952 and #955. It does not
complete the wider community persistence, moderation, or migration work.

## Visibility contract

Store reads return internal records. API and server-rendered client props must
still use the public DTO projection before serialization.

| Stored status      | Public list/detail | Public children                                               |
| ------------------ | ------------------ | ------------------------------------------------------------- |
| `active`           | Included           | Only active children, with an active parent in the same stock |
| `needs_review`     | Excluded           | Excluded                                                      |
| `hidden`           | Excluded           | Excluded                                                      |
| `deleted`          | Excluded           | Excluded                                                      |
| Missing or unknown | Excluded           | Excluded                                                      |

A nonpublic or absent thread returns `null` from the store and HTTP 404 from
the thread endpoint/page. Child reads return an empty list for a nonpublic or
absent parent. Firestore checks the parent document before reading children;
Postgres enforces the parent and stock condition in the child SELECT.

There is no authenticated moderator/author preview read API in this slice.
The existing response to a successful creation can give its author a local
review-held preview. The thread component preserves that preview only for the
current author and thread. It is not supplied by public reads, and a delayed
POST response cannot expose it after sign-out or account switching. A refresh
replaces persisted replies with current server data. A full load or direct
navigation reads saved replies from the store.

## Caching and cost

Community status can currently change without a guaranteed application cache
invalidation path. Public content and summary loaders therefore call Next's
`unstable_noStore`, and successful public API responses use `Cache-Control:
no-store`. The thread 404 and read-unavailable fallbacks are also not cached.
The legacy `getCached*` function names and tag helpers remain to keep callers
compatible; they no longer cache these mutable records.

Firestore summaries are rebuilt from the current active thread/pulse lists,
because a materialised summary headline can retain a removed thread's title.
This changes a summary read from one document read to two bounded queries.
Thread and pulse lists still return at most 25 records each; child lists still
return at most 50 records. A Firestore child read adds one parent document read.
The detail page intentionally retains that adapter-level parent guard even
after its own thread read, so direct API/store callers get the same policy.
Summary counts describe the bounded lists, as they already do in Postgres.

Shared caching can return once every moderation/status writer invalidates all
affected detail, list, child, and summary entries and the CDN path is covered.
Until then, budget and observe the extra read cost. Content already rendered
in an open browser is not retroactively erased; a new server request must
re-evaluate visibility. Client-held data can remain until a fresh request.

Previously cached HTTP responses from an older release can survive deployment
until their original TTL/stale window ends. A release must purge those entries
or account for expiry before claiming the new policy applies everywhere.

## Store selection and rollout

Firestore remains the default. An explicit `COMMUNITY_STORE_DRIVER=postgres`
requires the existing Postgres connection configuration. Missing configuration
throws instead of falling back to Firestore, preventing split writes and reads
from the wrong store. There is no database migration in this change. Check the
selected store configuration before releasing it. Legacy records with no
status remain excluded, consistent with the active-only feeds.

## Verification

Run the focused suite from `web`:

```sh
node_modules/.bin/jest --runInBand --testPathPattern=community
```

The regression tests cover saved replies on direct loads, current-state cache
reads, stale summary text, all moderation statuses, absent and cross-stock
parents, store misconfiguration, refresh reconciliation, and delayed POSTs
across a viewer change. The Postgres read-contract tests execute the actual
portable SELECTs against Node 24's embedded SQLite. They do not substitute for
Postgres integration or Firestore emulator tests.

The existing authenticated Playwright flow now checks both a full reload and
direct navigation after saving a reply. It still requires its existing
Firestore emulator and authenticated browser fixture. Production reproduction
and deployment verification are separate from these local checks.
