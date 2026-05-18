import { TwitterApi } from "twitter-api-v2";

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

  // Accept either of the common naming conventions for OAuth 1.0a:
  //   API Key / API Key Secret  (X Developer Portal default labels)
  //   Consumer Key / Consumer Secret  (older tweepy-style naming)
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

  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const refreshToken = process.env.TWITTER_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    throw new Error(
      "OAuth 2.0 flow not yet wired in this script. " +
        "Use OAuth 1.0a credentials (TWITTER_API_KEY/SECRET + TWITTER_ACCESS_TOKEN/SECRET) " +
        "or extend createClient() to call twitter-api-v2's refreshOAuth2Token().",
    );
  }

  throw new Error(
    "No Twitter credentials found. Populate scripts/twitter/.env from .env.example, " +
      "or pass --dry-run to preview without posting.",
  );
}
