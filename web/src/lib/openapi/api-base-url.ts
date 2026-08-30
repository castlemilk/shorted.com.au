/**
 * The host every published code sample must point at.
 *
 * `https://api.shorted.com.au` is the Cloudflare-fronted public API. Samples
 * previously fell back to the raw Cloud Run origin
 * (`https://shorts-…-km.a.run.app`), which bypasses the edge cache, the WAF and
 * rate limiting — and is a hostname that changes when the service is
 * redeployed, so it is not something third parties or LLM agents should be
 * copy-pasting into their clients.
 *
 * The generated OpenAPI document already states the correct host in
 * `servers[0].url`; that is the source of truth (see `getApiBaseUrl` in
 * ./parser). This constant is only the fallback for when the spec is missing
 * (Docker builds return an empty spec) and for client components, which cannot
 * import the fs-backed parser.
 */
export const FALLBACK_API_BASE_URL = 'https://api.shorted.com.au';
