import test from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "./rate-limit-sentinel.mjs";

// The sentinel's own logic, tested so a broken threshold fails here rather than
// as a silent false negative at 21:10 UTC. A monitor that cannot fail is
// indistinguishable from one that is passing.

const healthy = {
  anon: { status: 200, hasRateLimitHeaders: true, limit: 30 },
  // Per-minute unlimited (no header); monthly-metered because the sentinel
  // probes without the secret.
  firstParty: {
    status: 200,
    hasRateLimitHeaders: false,
    limit: 0,
    monthlyLimit: 200000,
  },
  mcp: { status: 200 },
  health: {
    checked: true,
    enabled: true,
    degraded: false,
    retainedDeltas: 0,
    trackedIdentifiers: 120,
    maxIdentifiers: 50000,
  },
};

const codes = (input) => evaluate(input).map((f) => f.code);

test("a healthy system produces no findings", () => {
  assert.deepEqual(evaluate(healthy), []);
});

test("silence is not health: missing headers mean nothing is enforcing", () => {
  assert.ok(
    codes({
      ...healthy,
      anon: { status: 200, hasRateLimitHeaders: false, limit: 0 },
    }).includes("ENFORCEMENT_OFF"),
  );
});

// The failure this whole sentinel exists for.
test("our own traffic metered at an anonymous ceiling is caught", () => {
  const found = codes({
    ...healthy,
    firstParty: { status: 200, hasRateLimitHeaders: true, limit: 30, monthlyLimit: 500 },
  });
  assert.ok(
    found.includes("SELF_METERED_AS_ANONYMOUS"),
    `expected SELF_METERED_AS_ANONYMOUS, got ${found.join(",")}`,
  );
});

test("a first-party class at or above the floor is fine", () => {
  for (const limit of [1000, 3000, 10000]) {
    assert.deepEqual(
      evaluate({
        ...healthy,
        firstParty: { status: 200, hasRateLimitHeaders: true, limit, monthlyLimit: 0 },
      }),
      [],
      `limit ${limit} should not alert`,
    );
  }
});

// The healthy production shape: per-minute unlimited, so NO per-minute header.
// Absence must read as "unlimited", never as "cannot tell" — otherwise the
// sentinel alerts every day on a correctly configured system and gets muted.
test("no per-minute header is unlimited, not a fault", () => {
  assert.deepEqual(
    evaluate({
      ...healthy,
      firstParty: {
        status: 200,
        hasRateLimitHeaders: false,
        limit: 0,
        monthlyLimit: 200000,
      },
    }),
    [],
  );
});

// But absence must still be CONFIRMED as first-party. Probing without the
// secret has to land in the unverified class, which is monthly-metered; a
// different monthly number means it was classified as something else.
test("an unexpected monthly limit on the unverified probe is reported", () => {
  assert.ok(
    codes({
      ...healthy,
      firstParty: {
        status: 200,
        hasRateLimitHeaders: false,
        limit: 0,
        monthlyLimit: 5000,
      },
    }).includes("FIRST_PARTY_UNEXPECTED_CLASS"),
  );
});

// Anonymous access is the adoption path. Challenging first contact breaks every
// client that has not authenticated yet, which is all of them initially.
test("a challenge on anonymous MCP first contact is a finding", () => {
  assert.ok(
    codes({ ...healthy, mcp: { status: 401 } }).includes(
      "MCP_FIRST_CONTACT_CHALLENGED",
    ),
  );
});

test("a healthy MCP 200 is not a finding", () => {
  assert.deepEqual(evaluate({ ...healthy, mcp: { status: 200 } }), []);
});

// Fail-open means a degraded quota store is invisible in the responses
// themselves. This is the only way it surfaces.
test("an open circuit breaker is reported even though requests still succeed", () => {
  const found = codes({
    ...healthy,
    health: { ...healthy.health, degraded: true, retainedDeltas: 4210 },
  });
  assert.ok(found.includes("QUOTA_STORE_DEGRADED"));
});

test("the identifier map approaching its cap is reported", () => {
  assert.ok(
    codes({
      ...healthy,
      health: {
        ...healthy.health,
        trackedIdentifiers: 47000,
        maxIdentifiers: 50000,
      },
    }).includes("IDENTIFIER_MAP_NEAR_CAP"),
  );
});

test("a comfortably sized identifier map is not reported", () => {
  assert.deepEqual(
    evaluate({
      ...healthy,
      health: {
        ...healthy.health,
        trackedIdentifiers: 20000,
        maxIdentifiers: 50000,
      },
    }),
    [],
  );
});

// Without the internal secret checks 1-3 must still run and still be able to
// fail. A partial sentinel beats one that refuses to start.
test("checks 1-3 still work when the health endpoint was not consulted", () => {
  const found = codes({
    anon: { status: 200, hasRateLimitHeaders: false, limit: 0 },
    firstParty: {
      status: 200,
      hasRateLimitHeaders: false,
      limit: 0,
      monthlyLimit: 200000,
    },
    mcp: { status: 200 },
    health: { checked: false },
  });
  assert.deepEqual(found, ["ENFORCEMENT_OFF"]);
});

test("an unconsulted health endpoint is never itself a finding", () => {
  assert.deepEqual(
    evaluate({ ...healthy, health: { checked: false } }),
    [],
  );
});

test("the service reporting rate limiting disabled is a finding", () => {
  assert.ok(
    codes({
      ...healthy,
      health: { ...healthy.health, enabled: false },
    }).includes("ENFORCEMENT_OFF"),
  );
});
