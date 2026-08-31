#!/usr/bin/env node
// Rate-limit sentinel.
//
// WHAT THIS IS FOR
//
// App-layer rate limiting is unconditionally fail-open by design: a sick quota
// database never 429s or 500s a caller, it silently stops enforcing. That is
// the right behaviour and it is invisible — a request that succeeded because
// the caller was under quota and one that succeeded because nothing was
// counting look identical from outside.
//
// Everything here is instrumented into Grafana already. That was also true of
// the August 2026 edge failure that produced 7,045 self-inflicted 429s over two
// days with nothing alerting. Metrics nobody watches are not monitoring, so
// this reads the contract directly and files a GitHub issue.
//
// WHAT IT CHECKS, and why each one is a thing that has actually gone wrong:
//
//  1. ENFORCEMENT IS ON. A prod response carries X-RateLimit-* headers. If the
//     flag is unset — a bad merge, a Terraform revert — everything still works
//     and nothing is limited. This is a silent regression by construction.
//
//  2. WE ARE NOT METERING OURSELVES AS ANONYMOUS. A request carrying the
//     first-party marker must land in a first-party class, not the 30/min
//     anonymous one. Getting this wrong is precisely the 7,045-429 incident,
//     and it can return via a renamed marker, a middleware regression, or a
//     dropped env var.
//
//  3. ANONYMOUS FIRST CONTACT ON /mcp IS FREE. Anonymous MCP access is the
//     adoption path. A challenge on first contact would break every client that
//     has not authenticated, which is all of them initially.
//
//  4. QUOTA ACCOUNTING IS HEALTHY. The gated health endpoint reports whether
//     the circuit breaker is open (quotas not being enforced), how many
//     increments are buffered and at risk, and how close the identifier map is
//     to the cap beyond which callers go unmetered.
//
// Check 4 needs INTERNAL_SERVICE_SECRET; 1-3 do not. A missing secret degrades
// to running 1-3 rather than failing, because a sentinel that cannot run is
// worse than a partial one.

const API = process.env.SHORTED_API_URL ?? "https://api.shorted.com.au";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";
const SSR_SECRET = process.env.SHORTED_SSR_BYPASS_SECRET ?? "";

// Kept in step with services/pkg/ratelimit/interceptor.go and
// web/src/middleware.ts. If these three names drift apart the layers stop
// agreeing about what our own traffic looks like — which is the failure this
// sentinel exists to catch, so it must use the same strings.
const SSR_MARKER = "shorted-web-ssr";
const SSR_HEADER = "x-shorted-ssr-bypass";

// A browser-ish UA, because api.shorted.com.au fingerprints clients and a bare
// agent is refused by Cloudflare before it reaches the origin.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// A first-party caller must never be handed a SMALL per-minute ceiling. Both
// first-party classes are per-minute unlimited, so the healthy signal is the
// ABSENCE of a per-minute limit header; the failure signal is the presence of a
// small one, which means our own traffic fell through to the anonymous tier.
//
// Not asserted as an exact value — that is config, and pinning it would make a
// deliberate tuning change look like an incident.
const FIRST_PARTY_MIN_LIMIT = 1000;

// The monthly meter on the UNVERIFIED class. The sentinel probes without the
// secret, so seeing this is positive proof the request was classified
// first-party rather than merely lacking headers for some other reason.
const UNVERIFIED_MONTHLY_LIMIT = 200000;

const RPC_PATH = "/shorts.v1alpha1.MarketService/GetTopShorts";
const RPC_BODY = JSON.stringify({ period: "3m", limit: 1 });

/** A finding is something a human should act on. */
export function evaluate({ anon, firstParty, mcp, health }) {
  const findings = [];

  // 1. Enforcement is on.
  if (!anon || !anon.hasRateLimitHeaders) {
    findings.push({
      code: "ENFORCEMENT_OFF",
      detail:
        "A prod response carried no X-RateLimit-* headers. App-layer rate " +
        "limiting is not running: check RATE_LIMIT_ENABLED on the shorts " +
        "Cloud Run service and terraform/environments/prod/main.tf.",
    });
  }

  // 2. Our own traffic is not anonymous.
  //
  // Both first-party classes are per-minute UNLIMITED, so no per-minute header
  // is the healthy case. A small one means we fell through to the anonymous
  // tier — every reader behind that egress address rejected at once.
  if (firstParty) {
    if (!firstParty.hasRateLimitHeaders) {
      // Unlimited per-minute. Confirm it really was classified first-party
      // rather than silently unmetered for some other reason: probing without
      // the secret must land in the unverified class, which IS monthly-metered.
      if (
        firstParty.monthlyLimit &&
        firstParty.monthlyLimit !== UNVERIFIED_MONTHLY_LIMIT
      ) {
        findings.push({
          code: "FIRST_PARTY_UNEXPECTED_CLASS",
          detail:
            `A marker-carrying request without the secret reported a monthly ` +
            `limit of ${firstParty.monthlyLimit}, not the expected ` +
            `${UNVERIFIED_MONTHLY_LIMIT} for the unverified first-party class.`,
        });
      }
    } else if (firstParty.limit < FIRST_PARTY_MIN_LIMIT) {
      findings.push({
        code: "SELF_METERED_AS_ANONYMOUS",
        detail:
          `A request carrying the '${SSR_MARKER}' marker was limited to ` +
          `${firstParty.limit}/min, below the ${FIRST_PARTY_MIN_LIMIT} floor ` +
          "for a first-party class. Our own SSR and all anonymous browser RPC " +
          "traffic share this class; at an anonymous ceiling the site starts " +
          "returning 429s under normal load. This is the August 2026 failure " +
          "mode (7,045 self-inflicted 429s). Check classifyFirstParty in " +
          "services/pkg/ratelimit/interceptor.go and the marker in " +
          "web/src/middleware.ts — they must agree.",
      });
    }
  }

  // 3. Anonymous MCP first contact is free.
  if (mcp) {
    if (mcp.status === 401) {
      findings.push({
        code: "MCP_FIRST_CONTACT_CHALLENGED",
        detail:
          "An anonymous MCP initialize was challenged with 401. Anonymous " +
          "access is the adoption path and must stay free; only quota " +
          "exhaustion may challenge. Check the bearer middleware ordering.",
      });
    } else if (mcp.status >= 500) {
      findings.push({
        code: "MCP_UNAVAILABLE",
        detail: `An anonymous MCP initialize returned ${mcp.status}.`,
      });
    }
  }

  // 4. Quota accounting health (only when the secret let us look).
  if (health && health.checked) {
    if (health.enabled === false) {
      findings.push({
        code: "ENFORCEMENT_OFF",
        detail: "The service reports rate limiting is disabled.",
      });
    }
    if (health.degraded) {
      findings.push({
        code: "QUOTA_STORE_DEGRADED",
        detail:
          "The quota circuit breaker is OPEN: api_usage_monthly writes are " +
          "failing, so MONTHLY quotas are not being enforced. Requests are " +
          "unaffected (the limiter fails open). Per-minute limiting and the " +
          `Cloudflare edge ceiling still apply. Retained deltas: ${health.retainedDeltas}.`,
      });
    }
    if (
      health.maxIdentifiers > 0 &&
      health.trackedIdentifiers > health.maxIdentifiers * 0.9
    ) {
      findings.push({
        code: "IDENTIFIER_MAP_NEAR_CAP",
        detail:
          `Tracked identifiers ${health.trackedIdentifiers} of ` +
          `${health.maxIdentifiers}. At the cap, new callers go UNMETERED ` +
          "rather than rejected, so enforcement degrades silently.",
      });
    }
  }

  return findings;
}

async function probe(url, { headers = {}, body, method = "POST" } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "User-Agent": BROWSER_UA, ...headers },
    body,
  });
  const limitHeader = res.headers.get("x-ratelimit-limit");
  const monthlyHeader = res.headers.get("x-ratelimit-monthly-limit");
  return {
    status: res.status,
    hasRateLimitHeaders: limitHeader !== null,
    limit: limitHeader ? Number(limitHeader) : 0,
    monthlyLimit: monthlyHeader ? Number(monthlyHeader) : 0,
    res,
  };
}

async function main() {
  const rpcHeaders = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };

  const anon = await probe(API + RPC_PATH, {
    headers: rpcHeaders,
    body: RPC_BODY,
  });

  const firstParty = await probe(API + RPC_PATH, {
    headers: {
      ...rpcHeaders,
      "User-Agent": `${BROWSER_UA} ${SSR_MARKER}/1.0`,
      ...(SSR_SECRET ? { [SSR_HEADER]: SSR_SECRET } : {}),
    },
    body: RPC_BODY,
  });

  const mcp = await probe(API + "/mcp", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "shorted-rate-limit-sentinel/1.0",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "sentinel", version: "1" },
      },
    }),
  });

  let health = { checked: false };
  if (INTERNAL_SECRET) {
    try {
      const res = await fetch(API + "/api/admin/rate-limit-health", {
        headers: {
          "User-Agent": BROWSER_UA,
          Authorization: `Bearer ${INTERNAL_SECRET}`,
        },
      });
      if (res.ok) {
        const body = await res.json();
        health = {
          checked: true,
          enabled: body.enabled,
          degraded: body.health?.degraded ?? false,
          retainedDeltas: body.health?.retained_deltas ?? 0,
          trackedIdentifiers: body.health?.tracked_identifiers ?? 0,
          maxIdentifiers: body.health?.max_identifiers ?? 0,
        };
      } else {
        console.log(`health endpoint returned ${res.status}; skipping check 4`);
      }
    } catch (err) {
      console.log(`health endpoint unreachable (${err.message}); skipping check 4`);
    }
  } else {
    console.log("INTERNAL_SERVICE_SECRET not set; running checks 1-3 only");
  }

  console.log(`anonymous       : status=${anon.status} limit=${anon.limit || "(none)"}`);
  console.log(
    `first-party     : status=${firstParty.status} ` +
      `limit=${firstParty.limit || "(unlimited)"} ` +
      `monthly=${firstParty.monthlyLimit || "(unmetered)"}` +
      (SSR_SECRET ? " (secret presented)" : " (no secret; unverified class expected)"),
  );
  console.log(`mcp initialize  : status=${mcp.status}`);
  if (health.checked) {
    console.log(
      `quota accounting: enabled=${health.enabled} degraded=${health.degraded} ` +
        `retained=${health.retainedDeltas} identifiers=${health.trackedIdentifiers}/${health.maxIdentifiers}`,
    );
  }

  const findings = evaluate({ anon, firstParty, mcp, health });
  if (findings.length === 0) {
    console.log("\nOK: rate limiting is on, our own traffic is not metered as anonymous.");
    return 0;
  }

  console.log("");
  for (const f of findings) {
    console.log(`[${f.code}] ${f.detail}`);
  }
  return 1;
}

// Only run when executed directly, so the test can import evaluate().
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`sentinel failed: ${err.stack ?? err}`);
      // A sentinel that cannot reach the API is itself a finding.
      process.exit(1);
    });
}
