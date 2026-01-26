-- API Subscriptions table for tracking paid API access
CREATE TABLE IF NOT EXISTS api_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    user_email VARCHAR(255) NOT NULL,
    stripe_customer_id VARCHAR(255) UNIQUE,
    stripe_subscription_id VARCHAR(255) UNIQUE,
    status VARCHAR(50) DEFAULT 'inactive',  -- active, canceled, past_due, inactive, trialing
    tier VARCHAR(50) DEFAULT 'free',  -- free, pro, enterprise
    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- API Tokens table for storing hashed tokens (enables revocation)
CREATE TABLE IF NOT EXISTS api_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) DEFAULT 'Default',
    token_hash VARCHAR(255) NOT NULL,  -- SHA-256 hash of the token
    token_prefix VARCHAR(20) NOT NULL,  -- First 8 chars for display (e.g., "shrt_abc1...")
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_api_subscriptions_user_id ON api_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_api_subscriptions_stripe_customer ON api_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_api_subscriptions_status ON api_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix ON api_tokens(token_prefix);

-- Trigger to update updated_at
CREATE TRIGGER update_api_subscriptions_updated_at 
    BEFORE UPDATE ON api_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
