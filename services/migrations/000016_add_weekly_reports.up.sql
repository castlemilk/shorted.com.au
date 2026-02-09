CREATE TABLE weekly_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_slug VARCHAR(10) NOT NULL UNIQUE,  -- "2026-W06"
    report_date DATE NOT NULL,
    previous_date DATE NOT NULL,
    headline TEXT NOT NULL,
    summary TEXT NOT NULL,
    narrative JSONB NOT NULL,      -- {opening_hook, top_analysis, movers_analysis, industry_analysis, outlook}
    top_shorted JSONB NOT NULL,    -- [{rank, code, name, short_pct, wow_change}]
    risers JSONB NOT NULL,         -- [{code, name, current_pct, previous_pct, change}]
    fallers JSONB NOT NULL,        -- [{code, name, current_pct, previous_pct, change}]
    industry_breakdown JSONB,
    market_stats JSONB,
    faqs JSONB,                    -- [{question, answer}]
    quality_score FLOAT,
    llm_model VARCHAR(50),
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_weekly_reports_week ON weekly_reports(week_slug);
CREATE INDEX idx_weekly_reports_published ON weekly_reports(published_at DESC) WHERE published_at IS NOT NULL;
