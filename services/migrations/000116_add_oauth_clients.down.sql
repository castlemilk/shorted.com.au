-- Reverting drops every live OAuth grant: connected MCP clients must
-- re-authorize. Nothing here is a ledger, so that is recoverable by asking the
-- user to reconnect — but it is not silent, which is why it is not automatic.
--
-- Children first: all three reference oauth_clients.
DROP INDEX IF EXISTS idx_oauth_consent_tickets_client;
DROP INDEX IF EXISTS idx_oauth_consent_tickets_expires;
DROP INDEX IF EXISTS idx_oauth_refresh_tokens_client;
DROP INDEX IF EXISTS idx_oauth_authorization_codes_client;
DROP INDEX IF EXISTS idx_oauth_authorization_codes_expires;
DROP INDEX IF EXISTS idx_oauth_refresh_tokens_family;

DROP TABLE IF EXISTS oauth_consent_tickets;
DROP TABLE IF EXISTS oauth_refresh_tokens;
DROP TABLE IF EXISTS oauth_authorization_codes;
DROP TABLE IF EXISTS oauth_clients;
