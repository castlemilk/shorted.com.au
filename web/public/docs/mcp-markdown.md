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
token.

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
`https://api.shorted.com.au/mcp` and authentication set to **None**.

### Any other client

Point it at `https://api.shorted.com.au/mcp` as a **streamable HTTP** (not SSE,
not stdio) MCP server with no authentication. The endpoint is stateless: it
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

## Access, limits and caveats

**It is anonymous.** No token is required and no per-caller quota is applied.
Nothing you call is attributed to a user.

**There is still a ceiling.** The endpoint sits behind Cloudflare, which applies
a tier-blind per-IP abuse limit — roughly 10 requests per 10 seconds and 30 per
minute for anonymous callers. A handshake plus a handful of tool calls is
comfortably inside that; a tight loop is not. On HTTP 429, honour `Retry-After`.

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

## Phase 3

Planned, not shipped:

- **OAuth 2.1** with protected-resource metadata and audience-bound tokens, so a
  client can identify itself.
- **Per-caller rate limiting and quota accounting**, matching the tiers the HTTP
  API already enforces.

Both are additive. This endpoint keeps working anonymously; a token will raise
the ceiling rather than becoming a requirement.

## Related

- [MCP server card (SEP-1649)](https://shorted.com.au/.well-known/mcp/server-card.json)
- [Tool catalog](https://api.shorted.com.au/mcp/catalog.json)
- [HTTP API reference](https://shorted.com.au/docs/api.md) — the same data,
  uncapped, for non-MCP clients
- [OpenAPI 3.1 description](https://shorted.com.au/openapi.json)
- [Site overview for agents](https://shorted.com.au/llms.txt)
- [Glossary](https://shorted.com.au/glossary)

Questions: support@shorted.com.au
