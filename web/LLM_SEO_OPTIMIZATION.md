# LLM and SEO Optimization Guide

## Overview

This document outlines the comprehensive strategy implemented to optimize Shorted.com.au for both traditional search engines and modern LLM/AI crawlers like GPT, Claude, Perplexity, and Gemini.

## Why LLM Optimization Matters

1. **AI-Powered Search**: Users increasingly ask ChatGPT, Claude, and Perplexity instead of Google
2. **Training Data**: Your content may be included in LLM training datasets
3. **Better Answers**: Well-structured data helps LLMs provide accurate information about your platform
4. **Future-Proofing**: Prepares for the AI-first web

## Implementation Summary

### 1. Enhanced robots.txt

**Location**: `/public/robots.txt`

**Features**:

- Separate rules for traditional search bots (Googlebot, Bingbot)
- Specific rules for LLM crawlers (GPTBot, Claude-Web, PerplexityBot, etc.)
- Granular control over what each bot can access
- Protection of private/authenticated content

**LLM Bots Configured**:

- `GPTBot` - OpenAI GPT training
- `ChatGPT-User` - ChatGPT user queries
- `Claude-Web` - Anthropic Claude
- `Google-Extended` - Bard/Gemini training
- `PerplexityBot` - Perplexity AI
- `FacebookBot` - Meta AI
- `CCBot` / `Omgilibot` - Common Crawl

### 2. ai.txt File

**Location**: `/public/ai.txt`

**Purpose**: New emerging standard for AI/LLM-specific instructions (similar to robots.txt for AI)

**Contents**:

- **Training Permissions**: Explicitly allow/disallow content use in LLM training
- **Data Attribution**: How to credit data sources
- **API Information**: Endpoints and rate limits for programmatic access
- **Content Categories**: What type of content is available
- **Domain Context**: Key concepts, definitions, terminology
- **Usage Guidelines**: How LLMs should reference your data

**Key Sections**:

```txt
ai-training: allowed
data-source: ASIC
attribution-required: yes
api-endpoint: https://shorted.com.au/api
content-quality: high
fact-checked: yes
```

### 3. Markdown Documentation

#### llm-context.md

**Location**: `/public/docs/llm-context.md`
**URL**: `https://shorted.com.au/docs/llm-context`

**Purpose**: Comprehensive markdown document that LLMs can easily parse to understand your platform

**Contents**:

- Platform overview and purpose
- Key concepts and definitions
- Feature descriptions
- Data models and structures
- Australian market context
- Common use cases
- Terminology glossary
- Technical implementation details
- Contact information
- Attribution guidelines

**Why Markdown**:

- LLMs excel at understanding markdown structure
- Easy to parse headings, lists, and code blocks
- Human-readable and machine-readable
- No HTML parsing complexity

#### api-reference.md

**Location**: `/public/docs/api-reference.md`
**URL**: `https://shorted.com.au/docs/api-reference`

**Purpose**: Complete API documentation in markdown format

**Contents**:

- All API endpoints with examples
- Request/response formats
- Data models with TypeScript interfaces
- Rate limiting information
- Error handling
- Best practices
- Code examples in multiple languages
- gRPC service definitions

### 4. LLM-Specific Meta Tags

**Component**: `@/components/seo/llm-meta.tsx`

**Features**:

#### Custom Meta Tags

```html
<meta name="ai:content-type" content="financial-data" />
<meta name="ai:data-source" content="ASIC" />
<meta name="ai:update-frequency" content="daily" />
<meta name="ai:language" content="en-AU" />
<meta name="ai:domain" content="finance" />
```

#### Enhanced Structured Data

```json
{
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "ASX Short Positions",
  "provider": {
    "@type": "GovernmentOrganization",
    "name": "ASIC"
  },
  "temporalCoverage": "2010/..",
  "spatialCoverage": {
    "@type": "Place",
    "name": "Australia"
  }
}
```

#### Stock-Specific Meta Tags

```html
<meta name="stock:ticker" content="CBA" />
<meta name="stock:exchange" content="ASX" />
<meta name="stock:industry" content="Banks" />
<meta name="ai:entity-type" content="stock" />
```

### 5. HTTP Headers for LLMs

**Custom Headers on Documentation Routes**:

```
X-LLM-Friendly: true
X-AI-Indexable: true
X-Robots-Tag: index, follow
Content-Type: text/markdown; charset=utf-8
```

### 6. Sitemap Enhancement

**File**: `web/src/app/sitemap.ts`

**Added**:

- All stock pages (`/shorts/[stockCode]`)
- Documentation pages (`/docs/*`)
- Blog articles with proper metadata
- Priority and change frequency hints

### 7. Structured Data (JSON-LD)

**Already Implemented**:

- `WebSite` schema with SearchAction
- `Organization` schema
- `FinancialService` schema
- `Article` schema for blog posts
- `BreadcrumbList` schema
- `FinancialProduct` schema for stocks

**Enhanced For LLMs**:

- Added data provenance information
- Temporal coverage
- Geographic coverage
- Content quality indicators
- Usage rights

## How LLMs Will Use This

### 1. Training Phase

- Crawlers use `robots.txt` and `ai.txt` to understand permissions
- Download markdown documentation for semantic understanding
- Parse structured data for factual information
- Index metadata for categorization

### 2. Inference Phase (User Queries)

- When users ask "What is Shorted.com.au?"
  - LLM references `/docs/llm-context.md`
  - Provides accurate platform description
- When users ask "What are CBA's short positions?"
  - LLM can direct to `/shorts/CBA`
  - Or use structured data to answer directly
- When users ask "How do I use the Shorted API?"
  - LLM references `/docs/api-reference.md`
  - Provides code examples and endpoints

### 3. Attribution

LLMs will know to attribute data:

```
"According to Shorted.com.au (data from ASIC),
Commonwealth Bank (CBA) has a short position of 5.2% as of..."
```

## Verification & Testing

### 1. Test robots.txt

```bash
curl https://shorted.com.au/robots.txt
```

### 2. Test ai.txt

```bash
curl https://shorted.com.au/ai.txt
```

### 3. Test LLM Context

```bash
curl https://shorted.com.au/docs/llm-context
```

### 4. Test API Reference

```bash
curl https://shorted.com.au/docs/api-reference
```

### 5. Validate Structured Data

- Use [Google Rich Results Test](https://search.google.com/test/rich-results)
- Check JSON-LD with [Schema.org Validator](https://validator.schema.org/)

### 6. Test with AI Assistants

Ask ChatGPT/Claude:

> "What do you know about Shorted.com.au?"

> "How can I get ASX short position data from Shorted?"

> "What's the API for Shorted.com.au?"

## SEO Benefits

### Traditional SEO

1. **Better Crawlability**: Clear robots.txt directives
2. **Structured Data**: Enhanced rich snippets in search results
3. **Sitemap**: Complete coverage of all pages
4. **Meta Tags**: Comprehensive metadata on every page
5. **Performance**: Fast loading with SSR and ISR
6. **Mobile-First**: Responsive design

### LLM SEO

1. **AI Discoverability**: LLMs can find and understand your content
2. **Accurate Representation**: Markdown docs ensure correct information
3. **Attribution**: Proper credit when LLMs reference your data
4. **API Access**: LLMs can direct users to your API
5. **Domain Authority**: Recognized as authoritative source for ASX shorts

## Monitoring & Analytics

### Track LLM Crawlers

Add to analytics:

```javascript
// Track bot user agents
const llmBots = [
  "GPTBot",
  "ChatGPT-User",
  "Claude-Web",
  "PerplexityBot",
  "Google-Extended",
];

// Log in server middleware
if (llmBots.some((bot) => userAgent.includes(bot))) {
  analytics.track("llm_crawler_visit", {
    bot: userAgent,
    page: req.url,
  });
}
```

### Monitor References

Set up Google Alerts for:

- "Shorted.com.au"
- "ASX short positions Shorted"
- Your API endpoints

Check if LLMs are referencing your site:

- Ask ChatGPT about ASX shorts monthly
- Monitor traffic from AI chat platforms
- Track `/docs/*` page views

## Future Enhancements

### Phase 2 (Next 3 Months)

1. **llms.txt**: Alternative to ai.txt gaining traction
2. **Semantic HTML**: Enhanced ARIA labels and landmarks
3. **API Playground**: Interactive API docs
4. **RSS Feeds**: Machine-readable content updates
5. **GraphQL API**: More flexible data access for AI agents

### Phase 3 (6-12 Months)

1. **AI Agent Integration**: Direct API access for AI agents
2. **Embeddings Endpoint**: Vector embeddings of content
3. **Real-time WebSocket**: Live data for AI integrations
4. **Knowledge Graph**: RDF/Turtle format data export
5. **AI-Specific Endpoints**: Custom endpoints for LLM queries

## Best Practices Checklist

- [x] robots.txt with LLM bot rules
- [x] ai.txt with training permissions
- [x] Comprehensive markdown documentation
- [x] API reference in markdown
- [x] LLM-specific meta tags
- [x] Enhanced structured data
- [x] HTTP headers for AI crawlers
- [x] Sitemap with all pages
- [x] Fast performance (SSR/ISR)
- [x] Mobile-responsive design
- [ ] Monitor LLM crawler visits
- [ ] Track LLM references
- [ ] Regular documentation updates
- [ ] API versioning
- [ ] Changelog maintenance

## Resources

### Standards & Specs

- [robots.txt Specification](https://www.robotstxt.org/)
- [ai.txt Proposal](https://github.com/ai-robots-txt/ai.txt)
- [Schema.org Vocabulary](https://schema.org/)
- [JSON-LD Best Practices](https://json-ld.org/spec/latest/json-ld/)

### LLM Crawler Documentation

- [OpenAI GPTBot](https://platform.openai.com/docs/gptbot)
- [Google-Extended](https://developers.google.com/search/docs/crawling-indexing/google-extended)
- [Common Crawl](https://commoncrawl.org/)

### Tools

- [Google Rich Results Test](https://search.google.com/test/rich-results)
- [Schema Markup Validator](https://validator.schema.org/)
- [Robots.txt Tester](https://support.google.com/webmasters/answer/6062598)

## Summary

Your application is now optimized for both traditional search engines and modern LLM/AI crawlers:

1. **Clear Permissions**: robots.txt and ai.txt tell bots what they can access
2. **Rich Context**: Markdown docs help LLMs understand your platform
3. **Structured Data**: JSON-LD provides factual, parseable information
4. **API Documentation**: LLMs can direct users to your API
5. **Attribution Ready**: LLMs know how to credit your data
6. **Performance**: Fast SSR/ISR benefits both bots and users
7. **Future-Proof**: Ready for AI-first web

This positions Shorted.com.au as an authoritative, AI-friendly source for ASX short position data.
