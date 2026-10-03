import assert from "node:assert/strict";
import crypto from "node:crypto";
import { classifyAuthEndpoint, inspectAuthConsole, recordAuthNetwork } from "./auth-bootstrap-diagnostics.mjs";

export async function checkFirebaseGoogleAuthBootstrap({
  browser,
  baseUrl,
  bypassSecret = "",
  userAgent,
  timeoutMs = 15_000,
  fetchImpl = fetch,
}) {
  const normalizedBaseUrl = baseUrl || "https://shorted.com.au";
  const appOrigin = new URL(normalizedBaseUrl).origin;
  const observedApiKeys = new Set();
  const summary = {
    firebaseInitialized: false,
    apiKeyHashes: new Set(),
    escapedNewlineKey: false,
    apiKeyInvalid: false,
    corsPolicyError: false,
    identityToolkitOk: 0,
    authUriCreated: false,
    authUriProbeOk: false,
    googleOAuthSeen: false,
    popupOpened: false,
    cspPolicyError: false,
    sdkErrorCodes: [],
    authNetwork: [],
    authUriProbeAttempts: 0,
    authUriProbeSkipped: null,
  };

  const context = await browser.newContext({
    ...(userAgent ? { userAgent } : {}),
  });

  if (bypassSecret) {
    await context.route(originRoutePattern(appOrigin), async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-shorted-testing-bypass": bypassSecret,
        },
      });
    });
  }

  const page = await context.newPage();
  page.on("popup", () => { summary.popupOpened = true; });
  page.on("console", (message) => {
    const text = message.text();
    summary.firebaseInitialized ||= text.includes("Firebase initialized successfully");
    summary.apiKeyInvalid ||= text.includes("API_KEY_INVALID");
    summary.corsPolicyError ||= text.includes("CORS policy");
    inspectAuthConsole(text, summary);
  });

  context.on("request", (request) => {
    inspectUrlForFirebaseKey(request.url(), appOrigin, summary, observedApiKeys);
    try {
      const url = new URL(request.url());
      summary.googleOAuthSeen ||= url.origin === "https://accounts.google.com" &&
        ["/o/oauth2/auth", "/v3/signin/identifier"].includes(url.pathname);
    } catch { /* Browser-internal URLs do not represent OAuth navigation. */ }
  });
  context.on("requestfailed", (request) => {
    recordAuthNetwork(summary, classifyAuthEndpoint(request.url(), appOrigin), {
      errorText: request.failure()?.errorText,
    });
  });

  context.on("response", async (response) => {
    const url = response.url();
    inspectUrlForFirebaseKey(url, appOrigin, summary, observedApiKeys);
    recordAuthNetwork(summary, classifyAuthEndpoint(url, appOrigin), {
      status: response.status(),
      challenge: response.headers()["cf-mitigated"] === "challenge",
    });

    if (isIdentityToolkitUrl(url)) {
      try {
        const body = await response.json();
        summary.apiKeyInvalid ||= Boolean(
          body?.error?.details?.some?.((item) => item?.reason === "API_KEY_INVALID"),
        );
      } catch {
        // Some Firebase endpoints return JSONP or empty responses; status checks still cover them.
      }
      if (response.status() === 200) {
        summary.identityToolkitOk += 1;
        summary.authUriCreated ||= classifyAuthEndpoint(url, appOrigin)?.endpoint === "create_auth_uri";
      }
    }
  });

  try {
    await page.goto(new URL("/signin", normalizedBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /continue with google/i }).click({
      timeout: timeoutMs,
    });
    await waitForAuthBootstrap(summary, timeoutMs);
    if (!summary.authUriCreated && !summary.googleOAuthSeen && !summary.apiKeyInvalid) {
      await probeGoogleAuthUri({
        apiKeys: observedApiKeys,
        continueUri: new URL("/signin", appOrigin).toString(),
        summary,
        fetchImpl,
      });
    }
  } finally {
    await context.close();
  }

  const result = {
    ...summary,
    apiKeyHashes: [...summary.apiKeyHashes],
  };

  assert.equal(result.firebaseInitialized, true, failureMessage("Firebase did not initialize", result));
  assert.equal(result.escapedNewlineKey, false, failureMessage("Firebase API key contains escaped newline", result));
  assert.equal(result.apiKeyInvalid, false, failureMessage("Google rejected Firebase API key", result));
  assert.equal(result.corsPolicyError, false, failureMessage("Firebase/Google auth saw CORS policy errors", result));
  assert(
    result.identityToolkitOk >= 2,
    failureMessage("Identity Toolkit did not return enough successful config responses", result),
  );
  assert.equal(
    result.authUriCreated || result.authUriProbeOk || result.googleOAuthSeen,
    true,
    failureMessage("Firebase Google auth URI was not created", result),
  );

  return result;
}

function inspectUrlForFirebaseKey(rawUrl, appOrigin, summary, observedApiKeys) {
  if (!classifyAuthEndpoint(rawUrl, appOrigin)) {
    return;
  }

  try {
    const url = new URL(rawUrl);
    for (const param of ["key", "apiKey"]) {
      const key = url.searchParams.get(param);
      if (!key) {
        continue;
      }

      summary.escapedNewlineKey ||= /(?:\\n|\n|\\r|\r)$/.test(key);
      const normalizedKey = key.replace(/\\[nr]/g, "").trim();
      if (observedApiKeys.size < 3) {
        summary.apiKeyHashes.add(hashFirebaseKey(normalizedKey));
        observedApiKeys.add(normalizedKey);
      }
    }
  } catch {
    // Ignore non-URL inputs from browser internals.
  }
}

async function probeGoogleAuthUri({ apiKeys, continueUri, summary, fetchImpl }) {
  if (!apiKeys.size) {
    summary.authUriProbeSkipped = "no_observed_key";
    return;
  }
  for (const apiKey of apiKeys) {
    summary.authUriProbeAttempts += 1;
    try {
      const response = await fetchImpl(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "google.com",
            continueUri,
          }),
        },
      );
      recordAuthNetwork(summary, { surface: "identity_toolkit", endpoint: "create_auth_uri" }, { status: response.status });
      const body = await response.json().catch(() => ({}));
      summary.apiKeyInvalid ||= Boolean(
        body?.error?.details?.some?.((item) => item?.reason === "API_KEY_INVALID"),
      );
      summary.authUriProbeOk ||= response.ok && Boolean(body?.authUri);
      if (summary.authUriProbeOk || summary.apiKeyInvalid) {
        return;
      }
    } catch {
      recordAuthNetwork(summary, { surface: "identity_toolkit", endpoint: "create_auth_uri" }, { errorText: "NETWORK_ERROR" });
      // The browser-observed Identity Toolkit checks still cover API-key validity.
    }
  }
}

function isIdentityToolkitUrl(url) {
  return classifyAuthEndpoint(url, "")?.surface === "identity_toolkit";
}

function hashFirebaseKey(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function waitForAuthBootstrap(summary, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (summary.apiKeyInvalid || summary.corsPolicyError || summary.escapedNewlineKey ||
      (summary.firebaseInitialized && summary.identityToolkitOk >= 2 &&
        (summary.authUriCreated || summary.googleOAuthSeen))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function originRoutePattern(origin) {
  return new RegExp(`^${escapeRegExp(origin)}/`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failureMessage(reason, result) {
  return `${reason}: ${JSON.stringify(result)}`;
}
