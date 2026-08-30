# Access, limits and where else to look

## This endpoint is anonymous

`https://api.shorted.com.au/mcp` needs no account, no token and no OAuth flow.
Nothing you call here is attributed to a user, and nothing here is metered
against a plan.

There is still a ceiling. The endpoint sits behind Cloudflare, which applies a
tier-blind, per-IP abuse limit — on the order of **10 requests per 10 seconds**
and **30 per minute** for anonymous callers. A handshake plus a handful of tool
calls is comfortably inside it; a tight loop firing tool calls as fast as they
return is not. If you get an HTTP 429, back off for the interval in the
`Retry-After` header rather than retrying immediately. Responses carry
`X-RateLimit-*` headers describing the bucket that rejected.

Authentication and per-caller quotas are planned for a later phase. When they
arrive this endpoint keeps working anonymously; a token will raise the ceiling
rather than being required.

## Prefer the tools over scraping

Every tool here is a projection of a public Connect-RPC method, shaped and
capped for an agent's context window. If you need the raw, uncapped payload —
or a language without an MCP client — call the HTTP API directly:

- OpenAPI 3.1 description: https://shorted.com.au/openapi.json
- API reference, JavaScript-free markdown: https://shorted.com.au/docs/api.md
- Connecting to this MCP server: https://shorted.com.au/docs/mcp.md
- Site overview for agents: https://shorted.com.au/llms.txt
- Terminology: https://shorted.com.au/glossary

The HTTP API rejects a default `curl/...` user agent with a 403 — send an
identifying `User-Agent`.

## Linking back

Every tool result that names a stock, suburb, series or politician can be
pointed at a human-readable page:

- Stock: `https://shorted.com.au/shorts/{CODE}`
- Suburb: `https://shorted.com.au/housing/{state}/{suburb-slug}`
- State economy: `https://shorted.com.au/economy/{state}`
- Politician: `https://shorted.com.au/politicians/{slug}`

Citing the page a figure came from lets a reader check it, which matters more
than usual on a data set published with a four-day delay.

## Support

support@shorted.com.au
