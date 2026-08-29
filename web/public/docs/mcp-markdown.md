# Shorted MCP Server

> Served at `/docs/mcp.md`. This file is `public/docs/mcp-markdown.md` — a
> public file at `public/docs/mcp.md` would collide with the route and make
> Next.js refuse to build ("A conflicting public file and page file was found").
> Same arrangement as `/docs/api.md`.

Shorted exposes its data to MCP-capable clients — Claude, ChatGPT, Cursor, and
anything else speaking the Model Context Protocol — over streamable HTTP.

```
https://api.shorted.com.au/mcp
```

Protocol version **2026-07-28**, negotiating back through `2025-11-25`,
`2025-06-18`, `2025-03-26` and `2024-11-05`. No install step, no account, no
token — and if your client supports OAuth, adding the URL is the whole setup:
it will discover the flow, open a browser once, and come back authorised.

## What it covers

Twenty-four read-only tools across four domains:

- **Market and stocks** — ASIC short positions for ASX-listed securities,
  rankings, industry treemaps, squeeze candidates, price and short-interest
  history, director trades, peer comparison, search, a screener, per-stock news,
  and published weekly/monthly/yearly reports.
- **Housing** — official ABS/RBA house-price series, per-suburb profiles with
  Census and electoral overlays, and derived price-drop aggregates.
- **Economy** — the ABS/RBA economic-series layer (CPI, labour, trade, state
  final demand, approvals, retail, population) and company-to-state exposure.
- **Politicians** — the federal Registers of Members' and Senators' Interests.

Three **resources** carry the context the tools cannot: how to read a short
interest figure, what each domain covers and what is deliberately excluded, and
how access and limits work. Three **prompts** compose the tools into briefings:
`short_interest_briefing`, `suburb_housing_brief`, `market_wrap`.

The live catalog — every tool, its description, its domain, its JSON input
schema — is at
[`https://api.shorted.com.au/mcp/catalog.json`](https://api.shorted.com.au/mcp/catalog.json),
and is rendered at the end of this page. It is generated from the server's own
tool registry, so it cannot drift from what the server actually serves.

## Connecting

### Claude Code

```bash
claude mcp add --transport http shorted https://api.shorted.com.au/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shorted": {
      "type": "http",
      "url": "https://api.shorted.com.au/mcp"
    }
  }
}
```

### ChatGPT

In a Developer-mode connector, add a custom MCP server with the URL
`https://api.shorted.com.au/mcp`. Authentication **None** works; **OAuth** also
works and needs nothing configured — no client id, no secret, no URLs. The
connector registers itself.

### Any other client

Point it at `https://api.shorted.com.au/mcp` as a **streamable HTTP** (not SSE,
not stdio) MCP server. Authentication is optional. The endpoint is stateless: it
does not issue session IDs, so a client that load-balances requests across
connections works without affinity.

### Checking it by hand

The catalog is a plain GET and needs no MCP client:

```bash
curl -s https://api.shorted.com.au/mcp/catalog.json | head -40
```

The MCP endpoint itself is JSON-RPC over POST and answers in
`text/event-stream`, so pipe it to a reader that tolerates SSE rather than to a
JSON parser.

## Signing in (optional)

OAuth 2.1 **identifies you**, and raises your limits wherever per-caller quotas
are applied (see below — they are not, today). It does not unlock tools: all
twenty-four work anonymously, and none is reserved for a paid plan. There is
nothing to configure — point a client at the URL and it does the rest:

1. It calls a tool, gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="…"`, or reads the server card.
2. It fetches
   [`/.well-known/oauth-protected-resource/mcp`](https://api.shorted.com.au/.well-known/oauth-protected-resource/mcp)
   and then
   [`/.well-known/oauth-authorization-server`](https://api.shorted.com.au/.well-known/oauth-authorization-server).
3. It registers itself — either by RFC 7591 dynamic registration at
   `/oauth/register`, or by handing us its Client ID Metadata Document URL.
4. It opens `https://shorted.com.au/oauth/authorize` in a browser. You sign in
   and see which client is asking, where it will receive access, and what it
   will be able to read. Nothing is issued until you approve.
5. It exchanges the code at `/oauth/token` with PKCE (S256 only).

Scopes, all read-only: `shorts:read`, `housing:read`, `economy:read`,
`politics:read`. Access tokens last an hour; refresh tokens rotate on every use,
and reusing a rotated one revokes the whole family.

## Access, limits and caveats

**Anonymous works.** No token is required.

**The limit in force today is at the edge.** The endpoint sits behind
Cloudflare, which applies a tier-blind per-IP ceiling — **60 requests per 10
seconds and 300 per minute** for anonymous MCP callers, counted per HTTP request
rather than per tool call. A normal agent turn is comfortably inside it; a tight
loop is not. On HTTP 429, honour `Retry-After`.

**Per-caller tier quotas are not currently applied.** When they are, they will
be the [API tier](https://shorted.com.au/pricing) numbers, counted **per tool
call** — the handshake, `tools/list`, `resources/list` and `prompts/list` free,
and a JSON-RPC batch charged for each call it carries:

| | Per minute | Per month |
|---|---|---|
| Anonymous (by IP) | 30 | 500 |
| Signed in, free | 60 | 1,000 |
| Signed in, paid | 120 | 10,000 |

`GET /mcp/catalog.json` reports which of these is true for the deployment you
are talking to (`authentication.rateLimits.enforced`); it is read from the
server's own configuration, so it cannot be stale. When a per-caller limit does
fire, the rejection is a JSON-RPC error whose `data` says which limit fired, its
ceiling, when it resets and where to raise it — the same facts are on the
response headers (`X-RateLimit-Detail`, `Retry-After`).

**Everything is read-only.** There are no write or mutating tools, and none are
planned.

**Short-interest data is T+4.** ASIC publishes with a four trading-day delay, so
the most recent figure any tool returns is already several days old. It is also
short *interest* — positioning — not short-sale flow.

**Some things are permanently absent.** Individual property listings, addresses
and agents are never republished (the crawl licence permits derived aggregates
only); the register of politicians' interests carries no amounts, quantities or
values; and parliamentary prose is reproduced verbatim or not at all, because
the source is CC BY-NC-ND. Read the `shorted://catalog/coverage` resource before
concluding a gap is a bug.

**Nothing here is financial advice.**

## Related

- [MCP server card (SEP-1649)](https://shorted.com.au/.well-known/mcp/server-card.json)
- [Tool catalog](https://api.shorted.com.au/mcp/catalog.json)
- [HTTP API reference](https://shorted.com.au/docs/api.md) — the same data,
  uncapped, for non-MCP clients
- [OpenAPI 3.1 description](https://shorted.com.au/openapi.json)
- [Site overview for agents](https://shorted.com.au/llms.txt)
- [Glossary](https://shorted.com.au/glossary)

Questions: support@shorted.com.au
