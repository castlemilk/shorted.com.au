import { TwitterApi } from "twitter-api-v2";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertEnv } from "./oauth2-bootstrap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoEnvPath = resolve(__dirname, "..", "..", "..", ".env");

/**
 * Persist a refreshed OAuth 2.0 refresh_token back to the repo-root
 * .env so the NEXT run uses the latest token. X rotates refresh
 * tokens on every use — losing the new one means we'd be locked out
 * the next time the access token expires.
 */
function persistRefreshToken(token: string): void {
  // In CI we can't easily write to a repo file — instead the workflow
  // sets TWITTER_REFRESH_TOKEN_OUT to a tmpfile path and a follow-up
  // step re-stores it as a GH Actions secret via the `gh` CLI.
  const outPath = process.env.TWITTER_REFRESH_TOKEN_OUT;
  if (outPath) {
    try {
      writeFileSync(outPath, token, { mode: 0o600 });
      console.log(`[twitter] wrote rotated refresh token to ${outPath}`);
    } catch (err) {
      console.warn(`[twitter] could not write refresh token: ${String(err)}`);
    }
    return;
  }
  if (!existsSync(repoEnvPath)) return;
  try {
    const body = readFileSync(repoEnvPath, "utf8");
    writeFileSync(repoEnvPath, upsertEnv(body, "TWITTER_REFRESH_TOKEN", token), {
      mode: 0o600,
    });
  } catch (err) {
    console.warn(`[twitter] could not persist refresh token: ${String(err)}`);
  }
}

export interface PostedTweet {
  id: string;
  text: string;
}

export interface TwitterClient {
  postTweet(text: string): Promise<PostedTweet>;
  postThread(items: string[]): Promise<PostedTweet[]>;
}

class LiveTwitterClient implements TwitterClient {
  private client: TwitterApi;

  constructor(client: TwitterApi) {
    this.client = client;
  }

  async postTweet(text: string): Promise<PostedTweet> {
    if (text.length > 280) {
      throw new Error(`Tweet too long (${text.length} chars). Trim before posting.`);
    }
    const { data } = await this.client.v2.tweet(text);
    return { id: data.id, text: data.text };
  }

  async postThread(items: string[]): Promise<PostedTweet[]> {
    const posted: PostedTweet[] = [];
    let inReplyTo: string | undefined;
    for (const item of items) {
      if (item.length > 280) {
        throw new Error(`Thread item too long (${item.length} chars).`);
      }
      const result = inReplyTo
        ? await this.client.v2.reply(item, inReplyTo)
        : await this.client.v2.tweet(item);
      posted.push({ id: result.data.id, text: result.data.text });
      inReplyTo = result.data.id;
    }
    return posted;
  }
}

class DryRunTwitterClient implements TwitterClient {
  postTweet(text: string): Promise<PostedTweet> {
    const id = `dryrun-${Date.now()}`;
    console.log("\n──── [DRY RUN] would tweet ────");
    console.log(text);
    console.log(`(${text.length}/280 chars)`);
    console.log("───────────────────────────────\n");
    return Promise.resolve({ id, text });
  }

  async postThread(items: string[]): Promise<PostedTweet[]> {
    console.log(`\n──── [DRY RUN] would post a thread of ${items.length} tweets ────`);
    const posted: PostedTweet[] = [];
    for (const [i, item] of items.entries()) {
      console.log(`\n[${i + 1}/${items.length}] (${item.length}/280 chars)`);
      console.log(item);
      posted.push({ id: `dryrun-${Date.now()}-${i}`, text: item });
    }
    console.log("\n───────────────────────────────\n");
    return posted;
  }
}

export function createClient(opts: { dryRun: boolean }): TwitterClient {
  if (opts.dryRun) {
    return new DryRunTwitterClient();
  }

  // ── OAuth 2.0 (preferred): client_id + client_secret + refresh_token.
  //    On every run we mint a fresh access token from the refresh token,
  //    use it once, and persist the rotated refresh token back to .env.
  //    Run `bootstrap-oauth2` once to obtain the initial refresh token.
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const refreshToken = process.env.TWITTER_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    return new OAuth2TwitterClient(clientId, clientSecret, refreshToken);
  }

  // ── OAuth 1.0a fallback: API key/secret + access token/secret.
  //    Accepts the X Developer Portal default labels OR older
  //    tweepy-style names (CONSUMER_KEY, SECRET_KEY) without renaming.
  const apiKey =
    process.env.TWITTER_API_KEY ?? process.env.TWITTER_CONSUMER_KEY;
  const apiSecret =
    process.env.TWITTER_API_SECRET ??
    process.env.TWITTER_CONSUMER_SECRET ??
    process.env.TWITTER_SECRET_KEY;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessTokenSecret =
    process.env.TWITTER_ACCESS_TOKEN_SECRET ??
    process.env.TWITTER_ACCESS_SECRET;

  if (apiKey && apiSecret && accessToken && accessTokenSecret) {
    return new LiveTwitterClient(
      new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken,
        accessSecret: accessTokenSecret,
      }),
    );
  }

  throw new Error(
    "No Twitter credentials found. For OAuth 2.0 run `bootstrap-oauth2` " +
      "to mint a refresh token, or populate the 4 OAuth 1.0a vars in .env. " +
      "Or pass --dry-run to preview without posting.",
  );
}

class OAuth2TwitterClient implements TwitterClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  private async authedClient(): Promise<TwitterApi> {
    const app = new TwitterApi({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
    const { client, refreshToken: newRefresh } = await app.refreshOAuth2Token(
      this.refreshToken,
    );
    if (newRefresh && newRefresh !== this.refreshToken) {
      this.refreshToken = newRefresh;
      persistRefreshToken(newRefresh);
    }
    return client;
  }

  async postTweet(text: string): Promise<PostedTweet> {
    if (text.length > 280) {
      throw new Error(`Tweet too long (${text.length} chars). Trim before posting.`);
    }
    const client = await this.authedClient();
    const { data } = await client.v2.tweet(text);
    return { id: data.id, text: data.text };
  }

  async postThread(items: string[]): Promise<PostedTweet[]> {
    const client = await this.authedClient();
    const posted: PostedTweet[] = [];
    let inReplyTo: string | undefined;
    for (const item of items) {
      if (item.length > 280) {
        throw new Error(`Thread item too long (${item.length} chars).`);
      }
      const result = inReplyTo
        ? await client.v2.reply(item, inReplyTo)
        : await client.v2.tweet(item);
      posted.push({ id: result.data.id, text: result.data.text });
      inReplyTo = result.data.id;
    }
    return posted;
  }
}
