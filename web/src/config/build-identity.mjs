// The build identity of the web artifact: what GET /api/version reports.
//
// No imports, on purpose. next.config.mjs imports this file, and so does
// scripts/tests/build-identity.test.mjs, which runs where nothing under web/ is
// installed (see stock-tab-redirects.mjs for the same arrangement).
//
// next.config.mjs passes these values to `env`. Next turns each key into a
// compile-time define (`process.env.KEY` becomes the literal string) in the
// server and client bundles, so an artifact keeps the identity it was built
// with, whatever the runtime environment says. A key whose value is undefined
// is skipped and its reference stays a runtime lookup, so every value here is
// a non-empty string.
//
// "local" means a build with no release identity, such as a developer's
// machine. A CI build reports the commit and the ref it was made from.

const RELEASE_SHA = /^[a-f0-9]{40}$/;

/**
 * The first value that is a non-empty string. An empty variable counts as unset.
 *
 * @param {...(string | undefined)} values
 * @returns {string | undefined}
 */
const firstNonEmpty = (...values) =>
  values.find((value) => typeof value === "string" && value !== "");

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   now: Date,
 *   gitVersion?: string,
 *   packageVersion: string,
 * }} input
 * @returns {Record<string, string>}
 */
export function buildIdentityEnv({ env, now, gitVersion, packageVersion }) {
  // The release SHA is supplied by CI (terraform-deploy.yml sets it to the
  // checked-out commit). Vercel's own git variable is the fallback.
  const sha = firstNonEmpty(env.SHORTED_RELEASE_SHA, env.VERCEL_GIT_COMMIT_SHA);
  const commit = sha !== undefined && RELEASE_SHA.test(sha) ? sha : "local";
  return {
    // Read by /api/version as `gitCommitFull` and by scripts/vercel-release.mjs.
    NEXT_PUBLIC_RELEASE_COMMIT: commit,
    SHORTED_BUILD_VERSION: firstNonEmpty(gitVersion, packageVersion) ?? "dev",
    SHORTED_BUILD_DATE: now.toISOString(),
    SHORTED_BUILD_COMMIT: commit === "local" ? "local" : commit.slice(0, 7),
    // The release ref comes from the deploy workflow ("main" for a push to
    // main, which is every production promotion). Vercel's variable and
    // GitHub's own come next, for builds that set neither.
    SHORTED_BUILD_BRANCH:
      firstNonEmpty(
        env.SHORTED_RELEASE_REF,
        env.VERCEL_GIT_COMMIT_REF,
        env.GITHUB_REF_NAME,
      ) ?? "local",
    SHORTED_BUILD_ENVIRONMENT:
      firstNonEmpty(env.VERCEL_ENV, env.NODE_ENV) ?? "development",
  };
}
