# Firebase Auth Validation

Shorted uses Firebase browser auth for email/password and Google sign-in, then exchanges the Firebase ID token through NextAuth credentials. A malformed public Firebase config breaks login before the server sees a request.

## Incident Signature

The July 2026 production regression showed this browser console error from Firebase's auth iframe:

```text
API key not valid. Please pass a valid API key.
reason: API_KEY_INVALID
service: identitytoolkit.googleapis.com
```

The deployed value looked valid after normal trimming, but the browser sent the Firebase API key to Google with a literal escaped newline suffix (`\n`, encoded as `%5Cn`). That made `identitytoolkit.googleapis.com` reject the key.

Related symptoms:

- `iframe.js` logs `API_KEY_INVALID`.
- Firebase throws `auth/invalid-api-key` or the UI shows "Failed to login with Google".
- Vercel server logs may be empty because the failure happens before the app calls `/api/auth`.
- A probe can show `identitytoolkit.googleapis.com` or `www.googleapis.com/identitytoolkit` returning non-200 responses.

## Config Sources

Production browser Firebase config comes from these GitHub/Vercel environment variables:

- `NEXT_PUBLIC_FIREBASE_API_KEY_PROD`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN_PROD`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID_PROD`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_PROD`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID_PROD`
- `NEXT_PUBLIC_FIREBASE_APP_ID_PROD`

The app normalizes these values through `web/src/@/lib/firebase-public-config.ts` before initializing Firebase. Keep that normalization in place; `.trim()` alone does not remove a literal escaped newline.

## Required Gates

### 1. Firebase client preflight

`npm --prefix web run firebase:preflight` is mandatory before Vercel build/deploy in:

- `scripts/release-web.sh`
- `.github/workflows/release-preview-smoke.yml`
- `.github/workflows/terraform-deploy.yml`

The preflight validates required public Firebase values and calls `identitytoolkit.googleapis.com` with the normalized API key. It logs only a short hash of the key.

### 2. Firebase Google sign-in bootstrap smoke

Release smoke must run the Firebase Google sign-in bootstrap check in both entry points:

- `web/e2e/release-smoke.spec.ts`
- `web/e2e/release-smoke-ci.mjs`

The check opens `/signin`, clicks "Continue with Google", and verifies:

- Firebase initialized in the browser.
- No Firebase API key request contains an escaped newline.
- No `API_KEY_INVALID` appears in console or Identity Toolkit responses.
- No Google/Firebase CORS policy error appears.
- Identity Toolkit config endpoints return 200.
- Firebase can create a Google auth URI. The helper records browser-created auth URI and `accounts.google.com` OAuth navigation when they occur, and falls back to a direct Identity Toolkit `accounts:createAuthUri` probe because popup/OAuth timing can vary in CI.

The check does not complete a Google login. It only proves the Firebase browser config and Google OAuth bootstrap are valid.

When running through Cloudflare, apply `x-shorted-testing-bypass` only to the Shorted app origin. Do not send that header to Google/Firebase origins, because it causes unrelated cross-origin preflight failures. The helper `web/e2e/helpers/firebase-google-auth-bootstrap.mjs` handles this by routing only the app origin.

### 3. Release-process guard test

`node --test scripts/release-pipeline.test.mjs` asserts that the Firebase preflight, Google auth bootstrap smoke, and this documentation remain wired into the release path.

## Local Verification

Run the preflight from a production-like env:

```bash
cd /Users/benebsworth/projects/shorted
TMP_ENV="$(mktemp)"
vercel env pull "$TMP_ENV" --environment=production --scope document-analyser --yes
set -a; source "$TMP_ENV"; set +a
npm --prefix web run firebase:preflight
rm -f "$TMP_ENV"
```

Run the full production smoke:

```bash
cd /Users/benebsworth/projects/shorted/web
set -a; source ../.env; set +a
export CLOUDFLARE_TESTING_BYPASS_SECRET="${CLOUDFLARE_TESTING_BYPASS_SECRET:-$TF_VAR_rate_limit_testing_bypass_secret}"
BASE_URL=https://shorted.com.au \
RELEASE_API_BASE_URL=https://api.shorted.com.au \
node e2e/release-smoke-ci.mjs
```

## Regression Checklist

If Google login fails:

1. Run `npm --prefix web run firebase:preflight` against the same env used for the deployment.
2. Run `node e2e/release-smoke-ci.mjs` with `BASE_URL` set to the exact preview or production URL.
3. Inspect the smoke output for `API_KEY_INVALID`, escaped newline, CORS policy, Identity Toolkit status failures, and failed Google `createAuthUri` browser/probe checks.
4. Confirm the Vercel deployment ID that was smoked is the deployment promoted to production.
5. Search Vercel logs for `/api/auth` only after the browser bootstrap passes; this failure class often never reaches the server.
