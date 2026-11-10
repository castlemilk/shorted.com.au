# Community integration harness

Run from `web` in an isolated checkout without application `.env*` files:

```sh
FIRESTORE_EMULATOR_JAR=/absolute/path/cloud-firestore-emulator-v1.19.8.jar \
  node scripts/community-integration/run.mjs
```

Requires Node 24, installed web dependencies, a local Docker daemon, Java 21 and
Playwright Chromium (`npx playwright install --with-deps chromium`). The PR-only
`community-integration.yml` job provisions these dependencies. It downloads the
official Firestore 1.19.8 JAR and verifies SHA-256
`9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d`, as published in
[firebase-tools v14.22.0's emulator manifest](https://github.com/firebase/firebase-tools/blob/v14.22.0/src/emulator/downloadableEmulatorInfo.json).

The harness creates a uniquely named, disposable `postgres:15-alpine` container,
applies the actual community migration to `shorted_community_test`, and starts
the official Firestore emulator with project `demo-shorted-community-test`.
Both bind to loopback. It never accepts an existing database URL or cloud project.
Service startup, each driver journey and the CI job have bounded timeouts. Missing
Docker, emulator, credentials-route readiness or Chromium fails the check; none
of these paths can report a skipped green run.

## What is real

Each adapter runs against its actual database protocol, using application writes
and reads. Tests cover active/review-held/hidden/deleted parents and children,
cross-company and missing parents, committed status transitions, stale summary
text, Firestore's legacy missing statuses and Postgres's status constraints.

For each store, the harness starts Next on a fresh loopback port, signs the writer
in through the existing non-production credentials provider, and creates a thread
and reply through the UI. It checks the datastore, author reload, direct navigation
and an independent signed-out browser context. Public API and SSR payloads are
checked for leaked legacy author snapshots. Review-held replies are checked as
local author previews; fresh readers and a full reload cannot retrieve them.
Already-read APIs and browser pages are read again after moderation transitions
to verify that the next request sees the current state.

Only the stock-service responses used by the page chrome and the Google font
download are fixtures. This is not evidence about stock ingestion, real account
providers, distributed rate limiting, Firestore security rules/index enforcement,
production caching, a production deployment or a production incident.

## Isolation and evidence

Application children receive a small OS environment allowlist plus generated test
values. All stock/edge/market endpoints point to a local fixture. An inherited
Node preload rejects outbound sockets to non-loopback hosts, and browser contexts
abort requests outside the local app origin. No production credentials or
telemetry exporters are inherited. The synthetic Firebase certificate only
satisfies Admin SDK initialization; the SDK is pinned to the emulator. Synthetic
auth uses the existing `ALLOW_E2E_AUTH` development gate and a fresh test password.

Only the container/processes created by this run are cleaned up, on success,
failure or SIGTERM/SIGINT. The container's unique name is also recorded before
creation for an always-run workflow cleanup if the harness is interrupted. Its
tiny database uses a disposable tmpfs. Checkout retains no repository credential.
The test runner uses the Playwright API directly,
avoiding the documented Node 24/Playwright 1.52 CLI discovery hang without changing
the application's Node version. Evidence is written under
`web/test-results/community-integration`: exact checkout head, per-driver assertion
receipts, app/emulator logs, traces and the successful separate-reader screenshot.
Native CI uploads these on success or failure. A summary with `status: failed` or
missing driver receipts is not completed integration evidence.
