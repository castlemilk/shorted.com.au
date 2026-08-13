# Cloudflare Origin Shield POC Design

**Date:** 2026-08-13
**Status:** Approved for an offline proof of concept

## Purpose

Prove that Shorted can reduce Cloud Run cost during traffic spikes by serving cacheable public reads at Cloudflare and applying traffic-aware origin budgets only when a request would otherwise reach Cloud Run.

The proof runs entirely in local tests. It must not deploy a Worker, change production Cloudflare configuration, purge a production cache, or generate production traffic.

## Problem

The current edge Worker caches some API reads, but most normal Connect unary requests carry `connect-protocol-version` and are treated as streaming requests. They bypass the cache even when the operation is a safe public read. The existing zone-wide API rate limit is applied before Worker cache logic and cannot express the richer bot categories available inside the Worker on the current Cloudflare plan.

This means a traffic spike can produce many Cloud Run requests even when repeated responses could be cached. It also treats legitimate search crawlers, low-value automation, and ordinary users too similarly.

## Goals

- Cache lookup happens before origin rate-limit accounting.
- A hot-cache, Cache API, or KV hit never consumes an origin-budget token.
- Only a true cache miss for a supported public read is checked against an origin budget.
- Verified search crawlers receive a more permissive budget than AI crawlers, SEO crawlers, and unverified automation.
- A rejected origin miss returns HTTP 429 with a machine-readable body, `Retry-After`, and explicit limit/reset headers.
- Connect unary requests are not mistaken for streams merely because they include `connect-protocol-version`.
- The limiter fails open if its optional local/production binding is unavailable, while recording the reason in existing edge analytics.
- Existing write, authentication, health, and streaming behavior remains unchanged.

## Non-goals

- No production deployment or Cloudflare control-plane mutation.
- No live load test.
- No migration from Cloud Run to another backend.
- No global billing-grade quota. Cloudflare Workers rate-limit bindings are location-scoped and eventually consistent.
- No attempt to cache authenticated, personalized, write, chat-streaming, or register operations.
- No claim that this first POC reduces the number of Worker invocations. It reduces origin requests and proves the boundary needed for a later pre-Worker cache experiment.

## Request Pipeline

For the existing cacheable `GET /edge/v1/*` facade:

1. Validate that the facade route maps to an allowlisted public read.
2. Check the in-isolate hot cache.
3. Check Cloudflare Cache API.
4. Check the pre-warmed KV cache.
5. Classify the request and select an origin-budget policy.
6. Ask the selected Worker rate-limit binding for one token.
7. If denied, return a non-cacheable 429 response and do not call Cloud Run.
8. If allowed, fetch the origin once and populate the existing cache layers.

The cache-miss hook is part of the cache helper rather than route-specific duplicated code. It executes at most once per request, including cache-error fallback paths.

## Streaming Detection

`connect-protocol-version` is valid on unary Connect requests and is not sufficient evidence of streaming. A request is treated as streaming when one of these is true:

- its content type is `application/connect+json` or `application/connect+proto`;
- it carries gRPC-Web framing headers/content types; or
- it targets the existing chat streaming service.

Unary `application/json` and `application/proto` requests remain eligible for the existing public-read/cache rules. Non-allowlisted RPC methods still bypass caching.

## Traffic Classification

Classification uses Cloudflare request metadata when present and conservative fallbacks in local development.

| Class | Detection | Initial POC policy |
|---|---|---|
| Search crawler | `request.cf.verifiedBotCategory` identifies search-engine crawling | Search binding; 300 origin misses per 60 seconds per bot category and route family in a Cloudflare location |
| Low-value verified automation | Category identifies AI crawler, SEO crawler, monitoring, scraping, or other non-search automation | Automation binding; 30 origin misses per 60 seconds per bot category and route family in a location |
| Known application traffic | An authenticated application identity is available to the Worker | General binding; 120 origin misses per 60 seconds per identity and route family in a location |
| Unknown traffic | No trustworthy application identity or verified-bot category | General binding; 120 origin misses per 60 seconds per coarse actor and route family in a location |

The POC does not trust `User-Agent` as an identity or bypass signal. Where no stable authenticated identity exists, the classifier may use a privacy-reduced actor key derived from Cloudflare metadata. That fallback is deliberately less strict than the automation budget to reduce shared-IP false positives.

The numeric limits are configuration defaults for proving policy selection, not final production tuning. Production values require a shadow-observation period using real cache-miss counts.

## Limiter Interface

The Worker receives optional bindings with this minimal interface:

```js
await binding.limit({ key }) // => { success: boolean }
```

The origin guard owns:

- traffic classification;
- binding selection;
- stable key construction;
- policy metadata;
- the 429 response; and
- analytics fields describing allow, deny, or fail-open decisions.

Cache code owns only when the guard is invoked. Origin-routing code owns the actual fetch.

## Rejection Contract

A denied request returns:

- status `429 Too Many Requests`;
- `Content-Type: application/json`;
- `Cache-Control: no-store`;
- `Retry-After: 60` for the POC's minute window;
- `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` compatibility headers;
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` compatibility headers; and
- a JSON body containing `code`, a short explanation, `trafficClass`, and `retryAfterSeconds`.

The response explains that the origin budget is temporarily exhausted and that the client should retry later. It must not expose Cloudflare namespace IDs, secrets, exact internal classification inputs, or client IP data.

## Failure Handling

- Missing binding: allow the miss to continue and record `origin_limit_unavailable`.
- Binding exception: allow the miss to continue and record `origin_limit_error`.
- Cache-layer exception: retain the current origin fallback, but invoke the origin guard exactly once before fetching.
- Denied request: do not write the 429 to hot cache, Cache API, or KV.
- Origin error: retain current stale-if-error behavior where available.

Fail-open is appropriate for this POC because the limiter is an optimization guard, not an authentication or authorization boundary. Cloud Run's existing maximum-instance cap remains the final spend ceiling.

## Worker Invocation Cost

The first POC intentionally keeps the current Worker route, so every API request still invokes the gateway Worker. It avoids Cloud Run work on hits and denied misses, which is the larger immediate cost lever identified in the spike.

After the POC passes, a separate experiment may move only the cacheable `GET /edge/v1/*` facade behind Cloudflare's pre-entrypoint cache or an inner cacheable Worker entrypoint. The gateway entrypoint itself must not be cached because it also handles writes, auth, streaming, and multiple origins. That experiment requires provider support verification and production cache-key/purge design before rollout.

## Configuration Scope

The POC adds local Wrangler rate-limit binding declarations with unique, non-secret namespace IDs and matching optional Terraform Worker binding definitions only if the installed provider schema supports them. Terraform changes must validate locally and must not be applied.

If provider support is absent, the Worker code and local binding contract still constitute a complete POC; production binding plumbing is documented as a follow-up rather than emulated with another paid service.

## Test Strategy

Local Worker tests must prove:

1. A hot-cache hit does not call the rate limiter or origin.
2. A Cache API hit does not call the rate limiter or origin.
3. A KV hit does not call the rate limiter or origin.
4. A true miss calls the selected limiter once and then the origin once.
5. A denied miss returns the rejection contract and never calls the origin.
6. Search and low-value automation select different bindings and keys.
7. A missing or throwing binding fails open and records the reason.
8. A unary Connect request is not classified as streaming solely due to `connect-protocol-version`.
9. A framed Connect/gRPC stream still bypasses caching and limiting.
10. Existing public-read allowlisting prevents writes or personalized operations from entering the cache path.

Regression validation includes the existing Worker test suite, Terraform expression tests, Wrangler dry-run validation, and relevant web action tests. All commands run locally and must not contact the production Worker.

## Rollout After the POC

Any later production rollout is staged:

1. deploy analytics-only classification with origin budgets disabled;
2. observe cache-miss volumes by route and traffic class;
3. tune limits from observed legitimate peaks;
4. enable the automation budget first;
5. enable the general budget with a generous threshold;
6. verify Cloud Run request count, latency, 429 rate, search indexing, and cache-hit rate;
7. only then evaluate pre-Worker caching to reduce Worker invocations.

Rollback is a Worker deployment rollback or disabling the optional limiter bindings/configuration. No DNS change is required.

## Acceptance Criteria

- All POC behavior is demonstrated by deterministic local tests.
- No production request or deployment is made.
- Cache hits demonstrably consume zero limiter calls.
- Denied cache misses demonstrably consume zero origin calls.
- Streaming and write paths remain uncached.
- The implementation clearly separates POC-proven origin shielding from the later Worker-invocation reduction experiment.
