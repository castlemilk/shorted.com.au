# Fluid Compute preview validation

Prepared against Shorted main `a1643ec4d` on 2026-10-03. This document describes a bounded canary; it is not evidence of a deployment or realized savings.

## Configuration and release boundaries

Vercel supports a deployment-local `"fluid": true` setting. A project-wide dashboard toggle is unnecessary for this experiment. With the observed project Root Directory `web`, use the app's `web/vercel.json` or a separate JSON copy of it, preserving `regions: ["syd1"]` and its other app settings. The CLI supports selecting that file with `--local-config`. A baseline uses the same source and settings with `fluid: false`; the candidate changes only `fluid` to `true`. [Fluid configuration](https://vercel.com/docs/fluid-compute#enable-for-specific-environments-and-deployments), [CLI local config](https://vercel.com/docs/cli/global-options#local-config).

The repository-root config supplies legacy monorepo install/build/output commands and `framework: null`; it is not interchangeable with `web/vercel.json`. The two configs keep the same Fluid flag, region and cron inventory; their build settings differ. For this remote source canary, explicitly select the web config while invoking the CLI from the monorepo root, so the existing Root Directory is applied once. Do not invoke deployment from `web/` or modify the live Root Directory. [Monorepo CLI guidance](https://vercel.com/docs/monorepos#add-a-monorepo-through-vercel-cli).

The observed project CPU setting `standard_legacy` is a baseline observation, not proof of the candidate's memory or concurrency. Inspect each built/deployed function resource. Current Fluid Standard uses 2 GB/1 vCPU, and memory cannot be set in `vercel.json`; CPU/memory dashboard changes would affect future deployments and are outside this canary. [Function memory and CPU](https://vercel.com/docs/functions/configuring-functions/memory).

Keep Sydney and existing route limits. Code-level `maxDuration` wins over configuration defaults. Shorted has many 60-second page/sitemap limits, 120 seconds on static-page warming, and 300 seconds on page warming. Fluid defaults to 300 seconds, so also inspect generated limits for routes without an explicit export rather than assuming every old limit survives. No region, CPU, memory, or duration change is needed to isolate this experiment. [Setting precedence](https://vercel.com/docs/fluid-compute#order-of-settings-precedence), [Next.js duration configuration](https://vercel.com/docs/functions/configuring-functions/duration).

`scripts/release-web.sh` and `.github/workflows/release-preview-smoke.yml` call their candidate a preview, but build/deploy with `--target production --skip-domain`. They use production configuration and can later promote. For this isolated test, select `--target preview` consistently when pulling, building and deploying; do not run the release script or dispatch the release workflow as a shortcut. Do not promote or assign production domains. Once the canary is accepted, production promotion still needs the repository's Firebase/Stripe preflights and complete release smoke against a candidate built with the intended production environment.

If using prebuilt output later, supply the deployment-local file to both `vercel build` and `vercel deploy --prebuilt`. Verify generated function metadata and deployment resources actually use Fluid and `syd1`; a config file's presence alone does not prove that a prebuilt deployment picked up the override. Use the same supported CLI version for both commands and pin it for repeatability. The release workflow currently pins `vercel@54.10.2`.

The following remote-source command targets the existing project and uses normal CLI authentication, with no token extraction. Run it only after the selected config has the intended Fluid value and the candidate source/tests are ready:

```bash
SHORTED_CANARY_CHECKOUT=/private/tmp/shorted-vercel-cost-reduction-20261003
VERCEL_ORG_ID=team_xE5DMN3hIo8aPqyHNkBybg8r \
VERCEL_PROJECT_ID=prj_FbJ12yJO63YCIG5wnUYh4Fbte20L \
npx --yes --package vercel@54.10.2 vercel deploy \
  --cwd "$SHORTED_CANARY_CHECKOUT" \
  --local-config "$SHORTED_CANARY_CHECKOUT/web/vercel.json" \
  --target preview --scope document-analyser --yes --archive=tgz
```

These public project/org IDs come from the tracked release workflow. For a separate baseline/candidate JSON copy, replace only `--local-config` with its absolute path. Do not use `--skip-domain` for this true-preview command: that flag is for staged production deployments. No force flag is needed; a forced repeat build should explicitly retain cache with `--force --with-cache`. Inspect the deployment target and resources after completion. [Deployment options](https://vercel.com/docs/cli/deploy).

## Authentication

Use the existing CLI session for project inspection and the authorized preview operations. Do not open CLI auth files, print environment values, or change live project settings.

The HTTP benchmark uses plain fetch. For an already protected preview, it can consume an existing `VERCEL_AUTOMATION_BYPASS_SECRET` supplied by the execution environment. It neither creates a bypass nor records its value. A failed initial response stops the measured phase for that deployment.

`vercel curl` is an alternative only after confirming the protection behavior: Vercel documents that it retrieves **or generates** a bypass token. Do not assume it is free of project configuration changes merely because the CLI is already logged in. Do not use verbose request-header logging or follow redirects with a bypass header. [Protected deployment requests](https://vercel.com/docs/cli/curl#how-it-works).

## Bounded comparison

After the exact preview build/deploy step is authorized and both deployment URLs are ready:

```bash
node --test scripts/tests/fluid-benchmark.test.mjs
node scripts/benchmark-fluid-preview.mjs \
  --baseline https://shorted-BASELINE-document-analyser.vercel.app \
  --candidate https://shorted-CANDIDATE-document-analyser.vercel.app \
  --output /private/tmp/shorted-fluid-preview-comparison.json
```

The defaults make 52 GET requests per deployment: one initial request to each of `/api/version`, `/top`, `/shorts/BHP`, `/shorts/CBA`, then six requests per route at concurrency 1 and 4. Baseline/candidate phases alternate. Requests have a 20-second timeout and the overall run has a three-minute deadline; the count is capped at 12 per route/phase and concurrency stays at 4. Output creation fails if the report path already exists, preserving earlier evidence.

`/api/version` provides a Node.js control and source/runtime metadata. `/api/health` uses the Edge runtime and is not a useful control for Node.js instance sharing. Stock HTML checks require the requested code, which catches obvious cross-key response mixups. The benchmark never calls login, chat, payment, community writes, unsubscribe, cron, cache flush, revalidation or warming endpoints; it does not store response bodies or cookies. Public page requests may perform ordinary application cache fills and emit access logs.

Record deployment IDs, source SHA, runtime/memory/region/duration metadata, build logs, and the benchmark time window. Examine deployment-scoped Observability for invocation errors, timeouts, Active CPU, provisioned memory and instance behavior. Separate CDN HIT/STALE results from responses exercising compute. HTTP timing and an `x-vercel-id` prefix do not establish Fluid use, same-instance concurrency, function region or billed savings. Preview does not receive Fluid's production-only bytecode caching/prewarming optimizations, so this is a compatibility signal, not a production cold-start forecast. [Fluid instance sharing and preview limitations](https://vercel.com/docs/fluid-compute).

Acceptance requires all benchmark content/status checks and existing release smoke to pass, no new invocation/auth/rate-limit failures, and no material p95 regression against the paired baseline. Six samples give only an early latency signal. A production cost claim requires comparable usage windows and traffic-normalized billing after rollout; do not derive one from wall time alone.

## Shared runtime review

The inspected singleton clients initialize synchronously and do not store a current request/user globally: Redis clients in `kv-cache.ts` and `rate-limit.ts`, the Stripe client, and the Postgres pool are shared resources. Authentication identity remains local to `rateLimit()` and is keyed by user ID/IP. The Postgres pool defaults to five connections; monitor queue/connection timeouts under concurrency instead of raising the pool automatically.

`cache.ts` contains a process-local Map and a cleanup interval; its values must remain public/cache-key scoped, and it does not provide cross-instance correctness. In-memory KV fallback is disabled in production. The bounded legacy Firestore email-miss cache includes collection, user ID and normalized email in its key. This inspection found no obvious mutable current-user slot, but it does not replace authenticated isolation tests. KV serialization uses synchronous gzip/gunzip; a large cached payload can occupy the shared Node.js event loop and increase latency for other concurrent requests, so compare the payload-heavy public pages at concurrency 4.

Before production, run existing auth/admin/chat/rate-limit tests and a concurrent test with two distinct mocked identities. Verify no session, entitlement, user ID, subscription or rate-limit state crosses between requests. Review any runtime mutation of `process.env`, shared headers, or SDK credentials introduced by subsequent changes. Keep user-specific responses outside public caches. No live user-account writes are needed for these tests.

The candidate also removes `/api/about/statistics`' unconditional background refresh on valid cache hits, including its separate uncancelled timer. The existing cache-read TTL contract still refreshes a miss, the helper clears its fetch timeout, and failed fetches do not overwrite a last-good cache snapshot. Focused tests cover concurrent hits, a miss and a backend failure. This route remains outside the benchmark's narrow allowlist.

For rollback, discard the canary. If Fluid is later released through source configuration, rebuild the same source with `fluid: false` and run release checks, or restore the prior verified production deployment through the normal rollback path. Do not change dashboard protection/CPU settings to recover a deployment-local experiment.
