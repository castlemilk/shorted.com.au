# Vercel release recovery

The production web job pins Node 24.22.1 (the reviewed security patch that `scripts/verify-build-node.mjs` enforces) and Vercel CLI 54.10.2. Its production
environment pull runs before Cloud Run URL lookup, npm install and web compilation.
Only read failures with explicit transient transport/status evidence get up to
three attempts. Authentication challenges, authorization errors, build failures,
uploads and promotions are never automatically replayed.
The preflight step has a five-minute limit including package setup; it verifies
the installed package identity/version and runs its Node entry point directly.
Each read command has a 60-second timeout, so terminating an npm wrapper cannot
leave an earlier CLI read running while the next attempt begins.

`Challenge required` is the observed provider-side block during environment
download. Vercel's `challenge_required` recovery code identifies sensitive-env
fresh authentication as the matching supported recovery; the existing logs do
not establish the stored token's type or the provider's precise policy decision.
It does not establish that the token is invalid. Vercel's
interactive `vc env pull` recovery requires an existing stored refresh token and
a terminal, starts its supported step-up device flow, and updates local CLI
credentials. It is unavailable when an explicit CI token is supplied. The account
owner can complete that one-time step with CLI 56.5.0 or later, using an existing
interactive CLI session and `vercel pull --environment production --project shorted-com-au --scope document-analyser`
with no explicit `VERCEL_TOKEN` or `--token`. This updates the local CLI session;
it does **not** replace or prove acceptance of the explicit token stored for CI.
Do not create a login or run that credential-changing flow as part of source-only
diagnosis. The persistent CI credential needs account-owner review. Replacing only
the effective production `VERCEL_TOKEN`, if needed, requires separate approval and
must use Vercel's supported automation authentication; do not copy a temporary
interactive access token into CI as a lasting fix. The web job uses environment
`prod`, whose secret can override the repository-level secret checked by
`validate-secrets`; a presence check does not establish effective token acceptance.
Do not enable
interactive login in CI, bypass the challenge, copy production env files into
artifacts, or rebuild repeatedly while access remains blocked.

CLI 56.5.0 extends that interactive recovery to `pull`, `build` and other env
consumers. Its shared recovery still rejects tokens from `--token`/`VERCEL_TOKEN`
and a noninteractive stdin. Upgrading alone therefore does not resolve this CI
failure; the release pin remains 54.10.2 until a separate upgrade is qualified.

After access is resolved, inspect the existing attempt first. Retry only the web
job if the runner supports that retry and its prerequisites/receipt are retained.
The existing whole-workflow dispatch also runs backend image builds and Terraform;
it is not a web-only resume. Do not replay migrations to recover a web release.

An upload uses production settings with `--prebuilt --skip-domain` and emits JSON.
If its response is interrupted, reconcile Vercel deployment metadata before
uploading again: a deployment may already exist. Before promotion, the returned
deployment ID, URL, project, team, production target, READY state and full source
metadata must match the exact checked-out commit. Automatic push promotions also
refuse to move an older commit over a newer main. These checks do not prove HTTP
runtime acceptance: after promotion, `/api/version` must return the same full
commit baked into the artifact. A failed runtime check fails the release summary;
it does not automatically promote again or roll back.

The existing Bundle budget build now checks the real compiled version handler
without starting a server or building twice, and rejects tracked source changes.
The repository contract job also runs the actual pinned CLI against a loopback
fake API: it checks `--non-interactive`, bare `--env NAME` inheritance, the pull's
project-link fields, production JSON output and a terminal fake challenge. These
tests contain fixture credentials only and establish CLI compatibility, not live
production authentication or deployment acceptance.

Sources: [Vercel CLI step-up implementation](https://github.com/vercel/vercel/commit/92988c2),
[pinned CLI token handling](https://github.com/vercel/vercel/blob/vercel%4054.10.2/packages/cli/src/index.ts),
[pinned deployment JSON and environment handling](https://github.com/vercel/vercel/blob/vercel%4054.10.2/packages/cli/src/commands/deploy/index.ts).
See also [56.5.0 release](https://github.com/vercel/vercel/releases/tag/vercel%4056.5.0)
and [its recovery preconditions](https://github.com/vercel/vercel/blob/vercel%4056.5.0/packages/cli/src/util/env/challenge-recovery.ts).
