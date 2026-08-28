-- OAuth 2.1 authorization-server storage: registered clients, authorization
-- codes and refresh tokens.
--
-- The Go API is BOTH the resource server (MCP at https://api.shorted.com.au/mcp)
-- and the authorization server. These three tables are the only durable state
-- the AS needs; access tokens stay stateless JWTs signed by TokenService.
--
-- WHAT IS STORED HERE, AND WHAT DELIBERATELY IS NOT
--
-- No bearer material is stored in a usable form. An authorization code is kept
-- as sha256(code); a refresh token as sha256(token); a confidential client's
-- secret as sha256(secret). That mirrors api_tokens.token_hash (000015): a dump
-- of this schema lets an attacker recognise a credential they already hold, and
-- nothing else. PKCE `code_challenge` IS stored raw, and that is correct — it is
-- already a public S256 digest of the verifier, and the verifier never touches
-- the database.
--
-- THREE SECURITY PROPERTIES THE COLUMN SHAPES EXIST TO SUPPORT
--
-- 1. An authorization code is single-use. `consumed_at` is nullable so the
--    redemption path can be ONE conditional statement:
--      UPDATE oauth_authorization_codes SET consumed_at = now()
--      WHERE code_hash = $1 AND consumed_at IS NULL RETURNING ...
--    Two concurrent replays contend on the same row; exactly one sees a row
--    back. A read-then-write would let both win.
-- 2. Refresh tokens rotate, and reuse is detectable. `family_id` groups every
--    token descended from one authorization grant, and `rotated_at` marks a
--    token that has already been exchanged. Presenting a rotated token means
--    the token was stolen, so Task 4 revokes the WHOLE family — the difference
--    between a stolen refresh token being useful once and useful forever.
-- 3. `redirect_uris` is a text[] compared by EXACT STRING EQUALITY, never a
--    prefix or pattern. Prefix matching on a redirect URI is an open redirect.
--
-- IDEMPOTENCY IS MANDATORY, NOT DEFENSIVE STYLE
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml applies
-- a hardcoded `-f /migrations/...` allowlist and RE-RUNS IT ON EVERY DEPLOY.
-- This file is in that allowlist, so it executes several times a week against
-- live tables holding live grants. Every statement below is therefore
-- re-runnable and touches no existing row: no ALTER, no INSERT, no DROP.

-- Clients that may ask for a token. Two registration paths land here: RFC 7591
-- dynamic client registration ('dcr'), and Client ID Metadata Documents
-- ('cimd'), where the client_id is itself an HTTPS URL we fetched and cached.
CREATE TABLE IF NOT EXISTS oauth_clients (
    -- Opaque for DCR, an HTTPS URL for CIMD. TEXT rather than a bounded VARCHAR
    -- because a CIMD client_id is a URL supplied by the client.
    client_id TEXT PRIMARY KEY,

    -- RFC 7591 reports client_id_issued_at as epoch seconds; stored as a real
    -- timestamp and converted at the edge so retention sweeps are date maths.
    client_id_issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    client_name TEXT,

    -- Exact-match set. Empty is not useful but is not a schema error: a client
    -- with no redirect URI simply cannot complete an authorization request.
    redirect_uris TEXT[] NOT NULL DEFAULT '{}',
    grant_types TEXT[] NOT NULL DEFAULT '{}',

    -- Space-delimited, as it appears on the wire (RFC 6749 §3.3).
    scope TEXT,
    client_uri TEXT,

    registration_source TEXT NOT NULL
        CHECK (registration_source IN ('dcr', 'cimd')),

    -- NULL for public clients, which is the normal case for MCP: a desktop or
    -- browser client cannot keep a secret, so it proves itself with PKCE only.
    client_secret_hash TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Drives the "expire unused clients" sweep an open registration endpoint
    -- needs; NULL means registered but never used.
    last_used_at TIMESTAMPTZ
);

-- Authorization codes. 60-second TTL, single use, bound to one client, one
-- redirect_uri, one resource and one PKCE challenge.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    -- sha256(code), hex. The code itself is never written down: it exists only
    -- in the redirect that carries it and in the token request that spends it.
    code_hash TEXT PRIMARY KEY,

    -- ON DELETE CASCADE so pruning a junk registration cannot leave codes
    -- pointing at a client that no longer exists.
    client_id TEXT NOT NULL
        REFERENCES oauth_clients (client_id) ON DELETE CASCADE,

    -- Firebase UID, matching api_tokens.user_id / api_subscriptions.user_id.
    user_id TEXT NOT NULL,

    -- The exact URI presented at /authorize. RFC 6749 §4.1.3 requires the token
    -- request to present the same value, so it is stored to be compared, not to
    -- be redirected to.
    redirect_uri TEXT NOT NULL,

    -- Public S256 digest of the client's verifier. Not a secret.
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256'
        CHECK (code_challenge_method = 'S256'),

    -- RFC 8707 resource indicator; becomes the minted token's audience.
    resource TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',

    expires_at TIMESTAMPTZ NOT NULL,

    -- NULL until redeemed. See the consume-once note in the header.
    consumed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rotating refresh tokens.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    -- sha256(token), hex. Same rule as the code: the token is never stored.
    token_hash TEXT PRIMARY KEY,

    -- Every token descended from one authorization grant shares this. Reuse
    -- detection revokes by family, not by token.
    family_id UUID NOT NULL,

    client_id TEXT NOT NULL
        REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,

    resource TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',

    expires_at TIMESTAMPTZ NOT NULL,

    -- Set when this token has been exchanged for a successor. A token with
    -- rotated_at IS NOT NULL that is presented again is a REUSE signal.
    rotated_at TIMESTAMPTZ,

    -- Set when the token is dead — either individually, or as collateral of a
    -- family revocation triggered by reuse.
    revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Family revocation walks every sibling of a reused token. Without this it is a
-- sequential scan on the hot path of a compromise.
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
    ON oauth_refresh_tokens (family_id);

-- Expired codes are swept by expiry, and the primary key is a hash so it can
-- serve no range scan at all.
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_expires
    ON oauth_authorization_codes (expires_at);

-- Both child tables cascade from oauth_clients; Postgres does not index the
-- referencing side automatically, so a client delete would scan without these.
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_client
    ON oauth_authorization_codes (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client
    ON oauth_refresh_tokens (client_id);

COMMENT ON TABLE oauth_clients IS
    'OAuth 2.1 clients permitted to request tokens for the MCP resource. Registered via RFC 7591 DCR or cached from a Client ID Metadata Document. redirect_uris is matched by exact string equality — never by prefix.';

COMMENT ON TABLE oauth_authorization_codes IS
    'Single-use, 60-second authorization codes stored only as sha256 hashes. Redeem with a conditional UPDATE ... WHERE consumed_at IS NULL so a replayed code loses the race.';

COMMENT ON TABLE oauth_refresh_tokens IS
    'Rotating refresh tokens stored only as sha256 hashes. Presenting a token whose rotated_at is set is reuse: revoke the entire family_id.';

COMMENT ON COLUMN oauth_authorization_codes.code_challenge IS
    'PKCE S256 challenge. Public by construction (it is a digest of the verifier); the verifier is never stored.';
