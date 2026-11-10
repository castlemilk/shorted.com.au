# Community integration harness

Run from `web` in an isolated checkout without application `.env*` files:

```sh
FIRESTORE_EMULATOR_JAR=/absolute/path/cloud-firestore-emulator-v1.19.8.jar \
  node scripts/community-integration/run.mjs
```

Requires Node 24, installed web dependencies, a local Docker daemon, Java 21,
OpenSSL and Playwright Chromium (`npx playwright install --with-deps chromium`).
The PR-only `community-integration.yml` job provisions these dependencies. It
downloads the official Firestore 1.19.8 JAR and verifies SHA-256
`9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d`, as published in
[firebase-tools v14.22.0's emulator manifest](https://github.com/firebase/firebase-tools/blob/v14.22.0/src/emulator/downloadableEmulatorInfo.json).

The harness creates a uniquely named, disposable `postgres:15-alpine` container,
applies the actual community migration to `shorted_community_test`, and starts
the official Firestore emulator with project `demo-shorted-community-test`. A
second disposable `redis:7-alpine` container supplies password-protected rate
limiting, preserving the application's production fail-closed policy. All services
bind to loopback. It never accepts an existing database URL or cloud project.
Service startup, the ordinary production build (eight minutes), each driver
journey (five minutes) and the CI job (thirty minutes) have bounded timeouts.
Missing Docker, emulator, Redis, production-build success, auth-route readiness
or Chromium fails the check; none can report a skipped green run.

## What is real

Each adapter runs against its actual database protocol, using application writes
and reads. Tests cover active/review-held/hidden/deleted parents and children,
cross-company and missing parents, committed status transitions, stale summary
text, Firestore's legacy missing statuses and Postgres's status constraints.

The harness builds the actual app once with `next build`, then runs `next start`
for each store on a fresh loopback port. The same stock fixture remains alive for
the build and both starts, so baked public endpoints and rewrites cannot drift.
A streaming HTTPS loopback proxy and a fresh self-signed certificate preserve the
application's production `__Secure-` session-cookie policy. Only the synthetic
browser contexts trust this certificate; global TLS verification is unchanged.

The writer receives a short-lived synthetic cookie minted with the installed
[Auth.js JWT encoder](https://authjs.dev/reference/core/jwt) and the disposable
app's generated secret. The real HTTP session endpoint must return that identity
without admin privileges, while an anonymous reader and a wrong-secret cookie
remain signed out. The application's Credentials provider stays disabled; a
separate test calls the real production provider to prove even matching test
credentials are rejected. This fixture exercises session consumption, not real
account sign-in or Firebase identity verification.

For each store the writer creates a thread and reply through the UI. The harness
checks the datastore, author reload, direct navigation and an independent
signed-out browser context. Public API and SSR payloads are checked for leaked
legacy author snapshots. Review-held replies are checked as local author
previews; fresh readers and a full reload cannot retrieve them. Already-read APIs
and browser pages are read again after moderation transitions to verify that the
next request sees the current state.

Stock-service responses used by the page chrome, the Google font download and
the initial synthetic session are fixtures. This is not evidence about stock
ingestion, real account providers, hosted Redis/edge enforcement, Firestore
security rules/index enforcement, CDN caching, standalone deployment packaging,
a production deployment or a production incident.

## Development renderer finding

The first real native run failed the HTML privacy assertion in `next dev`.
Its React development Flight diagnostics serialized the raw Postgres query result,
including private author fields, before the public DTO boundary. This was actual
response data, not a harmless match on a source variable. The exact run, artifact
hash, redacted evidence and verification limits are recorded in
[DEV_SSR_FINDING.md](./DEV_SSR_FINDING.md).

The production journey keeps the same private-field assertions unchanged. A
passing production receipt establishes only that renderer's tested behavior; it
does not close the unresolved development-runtime exposure. No framework debug
setting or application guard has been weakened to suppress the finding.

## Isolation and evidence

Application children receive a small OS environment allowlist plus generated test
values. All stock/edge/market endpoints point to a local fixture. An inherited
Node preload rejects outbound sockets to non-loopback hosts, and browser contexts
abort requests outside the local app origin. No production credentials or
telemetry exporters are inherited. The synthetic Firebase certificate only
satisfies Admin SDK initialization; the SDK is pinned to the emulator. Synthetic
auth uses a freshly generated secret, a fixed synthetic identity and the installed
encoder. `NODE_ENV=production`, `ALLOW_E2E_AUTH=false` and no `VERCEL_ENV` are
enforced for the app journeys. Both development and production `.env*` files are
refused.

Only the containers/processes created by this run are cleaned up, on success,
failure or SIGTERM/SIGINT. Both container names are also recorded before creation
for always-run workflow cleanup if the harness is interrupted. Their tiny stores
use disposable tmpfs volumes. The generated TLS files are removed by the harness
and are not uploaded as evidence. Checkout retains no repository credential.
The test runner uses the Playwright API directly, avoiding the documented Node
24/Playwright 1.52 CLI discovery hang without changing the application's Node
version. Evidence is written under `web/test-results/community-integration`:
exact checkout head, per-driver assertion receipts, app/emulator/build logs,
traces and the successful separate-reader screenshot. Native CI uploads these on
success or failure. A summary with `status: failed` or missing driver receipts is
not completed integration evidence.
