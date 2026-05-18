/**
 * One-time OAuth 2.0 PKCE bootstrap.
 *
 * Walks the operator through getting a refresh_token from X for the
 * @shorted___ account. Run once locally:
 *
 *   npx tsx src/index.ts bootstrap-oauth2
 *
 * It:
 *  1. Starts a tiny local HTTP server on 127.0.0.1:8787
 *  2. Prints an X auth URL — open in browser, click "Authorize"
 *  3. X redirects back to localhost with a code
 *  4. We exchange the code for an access_token + refresh_token
 *  5. Print the refresh_token and append to .env automatically
 *
 * After this, the regular posting commands can run unattended —
 * twitter-api-v2 uses the refresh_token to mint fresh access tokens
 * on every post, and writes the new refresh_token back to .env.
 *
 * Required X Developer Portal config:
 *  - User authentication settings → OAuth 2.0 enabled
 *  - Callback URI / Redirect URL includes: http://127.0.0.1:8787/callback
 *  - Type of App: Confidential client (so client_secret is required)
 *  - App permissions: Read and write
 *  - Scopes used: tweet.read, tweet.write, users.read, offline.access, media.write
 */

import { TwitterApi } from "twitter-api-v2";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
  "media.write",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoEnv = resolve(__dirname, "..", "..", "..", ".env");

export async function bootstrapOAuth2(): Promise<void> {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET in .env before running bootstrap-oauth2.",
    );
  }

  const client = new TwitterApi({ clientId, clientSecret });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
    REDIRECT_URI,
    { scope: SCOPES },
  );

  console.log("\n────────────────────────────────────────────────");
  console.log("X OAuth 2.0 bootstrap — STEP 1 of 2");
  console.log("────────────────────────────────────────────────");
  console.log("\n1. In X Developer Portal → App → User authentication");
  console.log("   settings, add this Callback URI:");
  console.log(`\n   ${REDIRECT_URI}`);
  console.log("\n2. Then open the URL below in your browser, sign in as");
  console.log("   the bot account (@shorted___), and click 'Authorize app':\n");
  console.log(`   ${url}`);
  console.log("\nWaiting for the redirect on", REDIRECT_URI, "…\n");

  // Spin up a one-shot HTTP server to catch the redirect.
  const result = await new Promise<{ code: string; receivedState: string }>(
    (resolveP, rejectP) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const code = url.searchParams.get("code");
        const receivedState = url.searchParams.get("state") ?? "";
        const error = url.searchParams.get("error");

        if (error) {
          res.statusCode = 400;
          res.end(`X returned an error: ${error}`);
          server.close();
          rejectP(new Error(`OAuth2 error from X: ${error}`));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end("Missing code");
          server.close();
          rejectP(new Error("Missing code in callback"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(
          "<h1>X auth complete</h1><p>You can close this tab and return to the terminal.</p>",
        );
        server.close();
        resolveP({ code, receivedState });
      });
      server.listen(PORT, "127.0.0.1");
      server.on("error", rejectP);
    },
  );

  if (result.receivedState !== state) {
    throw new Error("OAuth2 state mismatch — possible CSRF, aborting.");
  }

  console.log("\n────────────────────────────────────────────────");
  console.log("STEP 2 of 2 — exchanging code for tokens");
  console.log("────────────────────────────────────────────────\n");

  const tokens = await client.loginWithOAuth2({
    code: result.code,
    codeVerifier,
    redirectUri: REDIRECT_URI,
  });

  if (!tokens.refreshToken) {
    throw new Error(
      "Did not receive a refresh_token — confirm 'offline.access' is in the requested scopes.",
    );
  }

  console.log("✓ Got refresh_token (expires:", tokens.expiresIn, "seconds for the access token)");
  console.log("\nNew env values to save:");
  console.log("");
  console.log(`TWITTER_REFRESH_TOKEN=${tokens.refreshToken}`);

  // Persist refresh token to repo-root .env if present, else print and bail.
  if (existsSync(repoEnv)) {
    const current = readFileSync(repoEnv, "utf8");
    const updated = upsertEnv(current, "TWITTER_REFRESH_TOKEN", tokens.refreshToken);
    writeFileSync(repoEnv, updated, { mode: 0o600 });
    console.log(`\n✓ Wrote TWITTER_REFRESH_TOKEN to ${repoEnv}`);
  } else {
    console.log(
      `\nNo .env found at ${repoEnv}; copy the line above into your .env manually.`,
    );
  }

  // Test the token by fetching the authenticated user.
  const authClient = new TwitterApi(tokens.accessToken);
  const me = await authClient.v2.me();
  console.log(
    `\n✓ Authenticated as @${me.data.username} (${me.data.name}, id ${me.data.id})`,
  );
  console.log(
    "\nDone. You can now run `npx tsx src/index.ts daily-shorts --live` to post.",
  );
}

/**
 * Upsert a KEY=VALUE line in a .env file body. Adds if missing,
 * replaces in place if present.
 */
export function upsertEnv(body: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) {
    return body.replace(re, line);
  }
  return body.endsWith("\n") ? body + line + "\n" : body + "\n" + line + "\n";
}
