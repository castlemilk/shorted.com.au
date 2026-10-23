/**
 * The non-production E2E test identity.
 *
 * The account's hard-coded password, and any admin standing it has, exist only in a
 * development or test process (NODE_ENV development or test). ALLOW_E2E_AUTH is a
 * switch, and a Vercel preview build can have it set too, so it is not the gate for
 * either. A preview can still run the suite with an explicit E2E_TEST_PASSWORD. That
 * signs the account in, but it does not make the account an admin.
 */

const HARD_CODED_E2E_PASSWORD = "E2ETestPassword123!";
const DEFAULT_E2E_TEST_EMAIL = "e2e-test@shorted.com.au";
const DEV_AND_TEST_NODE_ENVS: ReadonlySet<string> = new Set([
  "development",
  "test",
]);

/** True only in a process started by `next dev` or the unit-test runner. */
export function isDevOrTestRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return DEV_AND_TEST_NODE_ENVS.has(env.NODE_ENV ?? "");
}

export function e2eTestEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.E2E_TEST_EMAIL ?? DEFAULT_E2E_TEST_EMAIL;
}

/** Whether an email is the E2E test account. Case and surrounding space are ignored. */
export function isE2eTestEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalised = email?.trim().toLowerCase();
  return !!normalised && normalised === e2eTestEmail(env).toLowerCase();
}

/**
 * The password the E2E account signs in with. An explicit E2E_TEST_PASSWORD always
 * wins. The hard-coded default is used only in a development or test runtime, and
 * anywhere else there is no password, so the account cannot sign in.
 */
export function e2eTestPassword(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.E2E_TEST_PASSWORD;
  if (explicit) return explicit;
  return isDevOrTestRuntime(env) ? HARD_CODED_E2E_PASSWORD : undefined;
}
