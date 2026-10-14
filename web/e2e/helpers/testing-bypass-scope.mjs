// Where the trusted-test header may go. It clears Cloudflare's bot and rate
// limit rules for our zone, so it is a secret. playwright.config.ts used to
// send it with every request a page made, and a stock page also asks Google
// (Analytics, Tag Manager, google.com, the logo bucket) and Cloudflare's beacon
// for things, so every run with the secret set sent it to them too. It now goes
// to our own origins and to this machine (a local server forwards it to the API
// through the Next rewrites), and nowhere else. helpers/test.ts applies it.
import { trustedOrigin } from "./scoped-release-headers.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_METHODS = new Set(["delete", "fetch", "get", "head", "patch", "post", "put"]);

/**
 * Our app, its www, our API or a Vercel preview of the app over HTTPS, or a
 * server on this machine.
 * @param {string} rawUrl
 */
export function isTestingBypassOrigin(rawUrl) {
  if (trustedOrigin(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Adds `bypass` (the header, or {} without a secret) to a browser context's
 * requests to our own origins. A route a test puts on the page runs first, and
 * one that fetches or continues a request itself sends only what it is given.
 * @param {import("@playwright/test").BrowserContext} context
 * @param {Record<string, string>} bypass
 */
export async function routeTestingBypass(context, bypass) {
  if (Object.keys(bypass).length === 0) return;
  await context.route(
    (url) => isTestingBypassOrigin(url.href),
    (route) => route.fallback({ headers: { ...route.request().headers(), ...bypass } }),
  );
}

/**
 * An APIRequestContext whose calls to our own URLs carry `bypass` and whose
 * calls anywhere else do not. A relative URL is resolved against `baseURL`.
 * @template {object} T
 * @param {T} request
 * @param {string | undefined} baseURL
 * @param {Record<string, string>} bypass
 * @returns {T}
 */
export function scopeTestingBypassRequests(request, baseURL, bypass) {
  if (Object.keys(bypass).length === 0) return request;
  /** @param {string | { url(): string }} urlOrRequest */
  const urlOf = (urlOrRequest) => {
    if (typeof urlOrRequest !== "string") return urlOrRequest.url();
    try {
      return new URL(urlOrRequest, baseURL).href;
    } catch {
      return "";
    }
  };
  return new Proxy(request, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !REQUEST_METHODS.has(property)) return value.bind(target);
      /**
       * @param {string | { url(): string }} urlOrRequest
       * @param {{ headers?: Record<string, string> }} [options]
       */
      const call = (urlOrRequest, options = {}) =>
        isTestingBypassOrigin(urlOf(urlOrRequest))
          ? value.call(target, urlOrRequest, { ...options, headers: { ...bypass, ...options.headers } })
          : value.call(target, urlOrRequest, options);
      return call;
    },
  });
}
