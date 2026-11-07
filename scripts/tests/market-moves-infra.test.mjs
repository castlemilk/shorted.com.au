// node --test scripts/tests/market-moves-infra.test.mjs
//
// Market moves (docs/feature/market-moves/README.md): the workflow posts to
// POST /v1/market-moves with a token an administrator created in the admin
// console, and the API pings the web's /api/revalidate after each change. These pin the infrastructure half of
// that contract, the half a refactor of main.tf or serve.go could silently break.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const api = read("../../terraform/modules/shorts-api/main.tf");
const apiVars = read("../../terraform/modules/shorts-api/variables.tf");
const prodMain = read("../../terraform/environments/prod/main.tf");
const serve = read("../../services/shorts/internal/services/shorts/serve.go");
const http = read("../../services/shorts/internal/services/shorts/market_moves_http.go");
const revalidate = read("../../services/shorts/internal/services/shorts/market_moves_revalidate.go");

test("market-moves tokens come from the admin console, not from Terraform or the environment", () => {
  assert.doesNotMatch(api, /MARKET_MOVES_PUBLISH_TOKEN|market_moves_publish_token/);
  const tokens = read("../../services/shorts/internal/services/shorts/market_moves_tokens.go");
  assert.doesNotMatch(http + tokens, /os\.Getenv\("MARKET_MOVES/, "no token is read from the environment");
  // The token routes are behind the internal secret, the posting routes behind a token.
  assert.match(tokens, /func \(s \*ShortsServer\) MarketMovesTokensHandler\(\) http\.HandlerFunc \{\n\treturn adminAuthMiddleware\(/);
  assert.match(tokens, /func \(s \*ShortsServer\) MarketMovesTokenRevokeHandler\(\) http\.HandlerFunc \{\n\treturn adminAuthMiddleware\(/);
  assert.match(serve, /mux\.HandleFunc\(MarketMovesTokensPath, s\.MarketMovesTokensHandler\(\)\)/);
  assert.match(serve, /mux\.HandleFunc\(MarketMovesTokenRevokePath, s\.MarketMovesTokenRevokeHandler\(\)\)/);
});

test("only the two market-moves routes accept a token", () => {
  const uses = (http.match(/marketMovesAuth\(/g) ?? []).length;
  // The definition plus the two handlers.
  assert.equal(uses, 3);
  assert.match(serve, /mux\.HandleFunc\(MarketMovesPath, s\.MarketMovesPublishHandler\(\)\)/);
  assert.match(serve, /mux\.HandleFunc\(MarketMovesRetractPath, s\.MarketMovesRetractHandler\(\)\)/);
  assert.doesNotMatch(serve, /withCORS\(s\.MarketMoves/, "no browser posts a move");
  for (const file of ["news_publish_auth.go", "middleware_connect.go", "serve.go"]) {
    assert.doesNotMatch(
      read(`../../services/shorts/internal/services/shorts/${file}`),
      /marketMovesTokens\.verify|MarketMovesTokenByHash/,
      `${file} must not accept a market-moves token`,
    );
  }
});

test("prod hands the API the web's revalidation endpoint and secret", () => {
  assert.match(apiVars, /variable "revalidation_secret_exists"/);
  assert.match(apiVars, /variable "revalidation_url"/);
  assert.match(api, /count\s+= var\.revalidation_secret_exists \? 1 : 0/);
  assert.match(api, /name = "REVALIDATION_SECRET"/);
  assert.match(api, /name\s+= "REVALIDATION_URL"/);
  const start = prodMain.indexOf('module "shorts_api"');
  const block = prodMain.slice(start, prodMain.indexOf("\n}\n", start));
  assert.match(block, /revalidation_secret_exists = true/);
  assert.match(block, /revalidation_url\s+= "https:\/\/shorted\.com\.au\/api\/revalidate"/);
  assert.match(revalidate, /os\.Getenv\("REVALIDATION_URL"\)/);
  assert.match(revalidate, /os\.Getenv\("REVALIDATION_SECRET"\)/);
});

test("the revalidation tags are the ones the web reads under", () => {
  for (const tag of ['"market-moves"', '"market-moves:home"', '"market-moves:stock:"']) {
    assert.ok(revalidate.includes(tag), `the API pings ${tag}`);
  }
});
