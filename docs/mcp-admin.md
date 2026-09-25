# Admin MCP server — `/mcp/admin`

A second MCP server for **administrators**, served by the shorts API at
`https://api.shorted.com.au/mcp/admin`. Today it does one thing: publish a merged
`content/news` article to `/news` (the `shorted-news-publish` Cloud Run job).

## Connect it (once)

claude.ai → Settings → Connectors → **Add custom connector** →
`https://api.shorted.com.au/mcp/admin`. Claude discovers the OAuth server,
sends you to the Shorted consent screen, you sign in with your normal account
and approve **news:publish**. The connector then appears in every Claude
session (including Claude Code on the web) with two tools:

| Tool | What it does |
|---|---|
| `publish_news_article` `{slug, images?, force?}` | Starts the publish job for a merged article; returns `execution_name` |
| `news_publish_status` `{execution_name}` | `running` / `succeeded` / `failed`, log link, failure reason |

Only merged articles can be published — the job image bakes `content/news` in
at build time, and the tool takes a slug, never a body.

## Who can use it

An administrator is a Shorted account whose **verified** email is on the web
app's `ADMIN_EMAILS` allowlist (the same list that gates `/admin`). It is
checked:

1. by the consent screen (clear message for non-admins),
2. when the API mints the consent ticket,
3. at the code grant,
4. at the code → token exchange,
5. on **every refresh** (so a removed admin cannot keep rotating a 30-day family),
6. on **every MCP request** (`RequireAdmin`, cached ~5 min per user).

The API asks the web app (`POST /api/internal/admin-check`, behind
`INTERNAL_SERVICE_SECRET`) because OAuth tokens carry only a user id and
turning a uid into an email needs Firebase Admin `getUser` — a project-level
IAM grant the CI deploy account cannot make. `ADMIN_CHECK_URL` overrides the
default (`https://shorted-com-au-document-analyser.vercel.app/api/internal/admin-check`,
the Vercel origin, because Cloudflare challenges non-browser POSTs to the apex).

## How it is kept apart from the public server

- **Separate OAuth resource.** Tokens are audience-bound to exactly one
  resource: a `/mcp` token is refused on `/mcp/admin` and vice versa.
- **Separate scope vocabulary.** `news:publish` is not in `mcp.Scopes`; an empty
  scope request on `/mcp` still gets only the `:read` scopes, and an absent
  `resource` still defaults to `/mcp` — nothing ever defaults to the admin
  resource (`oauth/resources.go`).
- **No anonymous path.** `/mcp/admin` requires a token (401 + RFC 9728
  challenge naming `/.well-known/oauth-protected-resource/mcp/admin`), and 403s
  a token without `news:publish`.
- **Separate registry.** The admin tools are not in `mcp.Registry()`, so the
  public catalog, read-only annotations and payload budgets are untouched.

Files: `services/shorts/internal/mcp/admin.go`, `internal/oauth/resources.go`,
`internal/services/shorts/admin_check.go`, `web/src/app/api/internal/admin-check/`.

## Failure modes

- **"forbidden: administrator access required"** on every call — the admin
  check is failing (web endpoint unreachable, `INTERNAL_SERVICE_SECRET`
  mismatch between Vercel and Cloud Run, or the email is unverified / not on
  `ADMIN_EMAILS`). Look for `admin check:` in the shorts API logs.
- **`invalid_target`** from the consent screen — the API was deployed without
  `INTERNAL_SERVICE_SECRET`, so no admin checker exists and the admin resource
  is not grantable (fail closed).
