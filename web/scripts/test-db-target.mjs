// test-db-target.mjs: which Supabase project web/scripts/test-db-setup.ts may seed.
//
// test-db-setup.ts (`npm run test:seed`, which scripts/run-e2e-tests.sh runs in
// CI mode) goes through the Supabase Data API and DELETEs the stock_prices and
// shorts rows of five stock codes before it inserts random fixtures. It used to
// fall back to the prod project's URL. It must only ever reach a local or test
// project, so it refuses to start unless SUPABASE_URL is set and is not prod.
// No dependencies, so scripts/tests/test-db-target.test.mjs can load it without
// the web app's packages.

/** The prod Supabase project's ref: supabase/config.toml's project_id. */
export const PROD_PROJECT_REF = "xivfykscsdagwsreyqgf";

const WHY = "test-db-setup deletes and re-seeds the stock_prices and shorts rows of CBA, BHP, CSL, WOW and RIO";
const HOW =
  "Point it at a local or test project, for example SUPABASE_URL=http://127.0.0.1:54321 " +
  "SUPABASE_ANON_KEY=<the anon key `supabase status` prints> npm run test:seed";

/** The `ref` claim of a legacy (JWT) Supabase key, or undefined: new-style keys are not JWTs. */
function keyRef(key) {
  const payload = key.split(".")[1];
  if (!payload) return undefined;
  try {
    const { ref } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof ref === "string" ? ref.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Supabase URL and key test-db-setup.ts may seed, from the environment.
 * Throws an Error that says what to set when SUPABASE_URL or SUPABASE_ANON_KEY
 * is unset, when SUPABASE_URL is not an http(s) URL, or when either one names
 * the prod project. Nothing has been sent anywhere when it throws.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, key: string }}
 */
export function resolveSeedTarget(env) {
  const url = (env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_ANON_KEY ?? "").trim();
  if (!url) {
    throw new Error(`SUPABASE_URL is not set, and there is no default project any more: ${WHY}. ${HOW}.`);
  }
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`SUPABASE_URL is not an http(s) URL. ${HOW}.`);
  }
  if (url.toLowerCase().includes(PROD_PROJECT_REF)) {
    throw new Error(`SUPABASE_URL is the prod Supabase project (${PROD_PROJECT_REF}), and ${WHY}, so it refuses to run. ${HOW}.`);
  }
  if (!key) {
    throw new Error(`SUPABASE_ANON_KEY is not set. ${HOW}.`);
  }
  if (keyRef(key) === PROD_PROJECT_REF) {
    throw new Error(
      `SUPABASE_ANON_KEY is a key of the prod Supabase project (its ref is ${PROD_PROJECT_REF}), and ${WHY}, so it refuses to run, whatever SUPABASE_URL says. ${HOW}.`,
    );
  }
  return { url, key };
}
