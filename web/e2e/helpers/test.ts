/**
 * The `test` the specs playwright.config.ts runs import, in place of
 * @playwright/test's own (everything else is re-exported unchanged).
 *
 * It carries the Cloudflare trusted-test header, when a secret is set, to our
 * own origins and to this machine only (testing-bypass-scope.mjs): the
 * browser's requests through a context route, and the `request` fixture's per
 * call. The config no longer sets it in extraHTTPHeaders, which go to every
 * host a page contacts, Google's included.
 *
 * Not carried: `page.request` (use the `request` fixture for an API check
 * that needs it), a context a test makes itself with browser.newContext(), and
 * a request a page route fetches or continues on its own (pass the header with
 * cloudflareTestingBypassHeadersFor).
 */
import { test as base } from "@playwright/test";
import { cloudflareTestingBypassHeaders } from "./cloudflare-testing-bypass";
import { routeTestingBypass, scopeTestingBypassRequests } from "./testing-bypass-scope.mjs";

export * from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    await routeTestingBypass(context, cloudflareTestingBypassHeaders());
    await use(context);
  },
  request: async ({ request, baseURL }, use) => {
    await use(scopeTestingBypassRequests(request, baseURL, cloudflareTestingBypassHeaders()));
  },
});
