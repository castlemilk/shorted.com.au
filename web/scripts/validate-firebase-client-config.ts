import crypto from "node:crypto";
import { normalizeFirebasePublicConfigValue } from "../src/@/lib/firebase-public-config";

const requiredPublicEnvNames = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const values = new Map<string, string>();
let failed = false;

for (const name of requiredPublicEnvNames) {
  const rawValue = process.env[name];
  const normalizedValue = normalizeFirebasePublicConfigValue(rawValue);

  if (!normalizedValue) {
    failed = true;
    console.error(`Firebase client config preflight failed: ${name} is not configured.`);
    continue;
  }

  values.set(name, normalizedValue);

  if (rawValue !== normalizedValue) {
    console.warn(`Firebase client config preflight normalized escaped line breaks or whitespace in ${name}.`);
  }
}

const apiKey = values.get("NEXT_PUBLIC_FIREBASE_API_KEY");
if (apiKey) {
  const result = await validateIdentityToolkitApiKey(apiKey);
  if (!result.ok) {
    failed = true;
    console.error(
      `Firebase client config preflight failed: NEXT_PUBLIC_FIREBASE_API_KEY sha256:${digest(
        apiKey,
      )} returned ${result.status}${result.reason ? ` (${result.reason})` : ""}.`,
    );
  } else {
    console.log(
      `Firebase client config preflight passed: NEXT_PUBLIC_FIREBASE_API_KEY sha256:${digest(
        apiKey,
      )}`,
    );
  }
}

if (failed) {
  process.exit(1);
}

async function validateIdentityToolkitApiKey(apiKey: string) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
  );
  if (response.ok) {
    return { ok: true as const };
  }

  const body = await response.json().catch(() => undefined);
  const reason =
    body?.error?.details?.find?.((item: { reason?: string }) => item.reason)
      ?.reason ??
    body?.error?.status ??
    body?.error?.message;

  return {
    ok: false as const,
    status: response.status,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
