import assert from "node:assert/strict";
import { test } from "node:test";

import type { BattlegroundStock } from "./shorted-api.js";
import { buildSqueezeAlertTweet } from "./templates.js";

test("buildSqueezeAlertTweet uses a single cashtag and keeps candidates sorted by caller order", () => {
  const tweet = buildSqueezeAlertTweet([
    stock("AAA", 92, 14.2, 0, 8.2),
    stock("BBB", 88, 11.7, 0, 6.1),
    stock("CCC", 81, 7.3, 0, 5.4),
  ]);

  assert.equal((tweet.match(/\$/g) ?? []).length, 1);
  assert.match(tweet, /\$AAA .*squeeze score 92/);
  assert.match(tweet, /\nBBB .*squeeze score 88/);
  assert.match(tweet, /\nCCC .*squeeze score 81/);
  assert.ok(tweet.length <= 280, `tweet was ${tweet.length} chars`);
});

test("buildSqueezeAlertTweet trims lower ranked candidates before exceeding the X limit", () => {
  const tweet = buildSqueezeAlertTweet([
    stock("EXTRALONGA", 99, 21.1),
    stock("EXTRALONGB", 98, 20.4),
    stock("EXTRALONGC", 97, 19.8),
  ]);

  assert.match(tweet, /\$EXTRALONGA/);
  assert.doesNotMatch(tweet, /EXTRALONGC/);
  assert.ok(tweet.length <= 280, `tweet was ${tweet.length} chars`);
});

function stock(
  stockCode: string,
  squeezeScore: number,
  shortPct: number,
  daysToCover = 12.345,
  priceChange1m = 34.4,
): BattlegroundStock {
  return {
    stockCode,
    shortPct,
    daysToCover,
    priceChange1m,
    squeezeScore,
  };
}
