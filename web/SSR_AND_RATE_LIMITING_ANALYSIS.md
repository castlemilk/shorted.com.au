# SSR & Rate Limiting Analysis

## Current Rendering Status

### ✅ Server-Side Rendered (SSR/ISR)

- `/` (home page) - SSR with ISR (`revalidate: 60`)
- `/blog` - SSR
- `/blog/[slug]` - SSR with static generation
- `/shorts/[stockCode]` - SSR with metadata generation

### ❌ Client-Side Rendered (CSR)

- `/stocks` - **Client-side only** (`"use client"`)
- `/shorts` - **Client-side only** (`"use client"`)
- `/portfolio` - **Client-side only** (`"use client"`)
- `/dashboards` - **Client-side only** (`"use client"`)

## Issues with Current Approach

### Performance Problems

1. **Slow Initial Load**: CSR pages require JavaScript to load before rendering
2. **Poor SEO**: Search engines can't properly index client-only content
3. **No Caching**: Can't leverage ISR/SSG for static content
4. **API Waterfall**: Each page makes multiple API calls from the client

### Rate Limiting Challenges

1. **In-Memory Limitations**: Current rate limiter doesn't work across Vercel serverless instances
2. **No Edge Protection**: Rate limiting happens at API route level, not at the edge
3. **Client Bypass**: Users can bypass client-side rate limiting

## Recommended Solutions

### 1. Vercel Edge Middleware with KV Rate Limiting

Vercel offers built-in rate limiting through:

- **Vercel KV** (Redis-based, recommended)
- **Vercel Edge Config** (for configuration)
- **Edge Middleware** (runs at CDN edge)

#### Benefits:

- ✅ Runs at the edge (closest to user)
- ✅ Works across all serverless instances
- ✅ Persistent across deployments
- ✅ Sub-millisecond latency
- ✅ DDoS protection

### 2. Convert Key Pages to SSR

Convert public pages to SSR for better performance and SEO:

#### `/shorts` Page

**Current**: Client-side with loading states
**Should be**: SSR with initial data

```typescript
// Convert to:
export default async function TopShortsPage() {
  const initialData = await getTopShortsData("3m", 50, 0);

  return <TopShortsClient initialData={initialData} />;
}
```

#### `/stocks` Page

**Current**: Client-side search only
**Should be**: SSR with popular stocks pre-rendered

```typescript
// Convert to:
export default async function StocksPage() {
  const popularStocks = await getMultipleStockQuotes(POPULAR_CODES);

  return <StocksClient initialStocks={popularStocks} />;
}
```

### 3. Hybrid Approach (Recommended)

Use SSR + Client Hydration:

1. **Server**: Render initial page with data
2. **Client**: Hydrate for interactivity
3. **Result**: Fast first paint + rich interactions

## Implementation Plan

### Phase 1: Vercel Edge Rate Limiting (Priority)

#### Install Vercel KV

```bash
npm install @vercel/kv
```

#### Update Middleware

```typescript
// middleware.ts
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(10, "60 s"),
});

export async function middleware(request: NextRequest) {
  // Check if user is authenticated
  const session = await getToken({ req: request });

  // Different limits for auth vs anon
  const identifier = session?.sub || request.ip || "anonymous";
  const limit = session ? 100 : 10;

  const {
    success,
    limit: _limit,
    remaining,
    reset,
  } = await ratelimit.limit(identifier);

  if (!success) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: {
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": reset.toString(),
      },
    });
  }

  return NextResponse.next();
}
```

### Phase 2: Convert Pages to SSR

#### Priority Order:

1. `/shorts` - High traffic, mostly static content
2. `/stocks` - Popular stocks can be pre-rendered
3. Keep `/portfolio` and `/dashboards` as CSR (user-specific, requires auth)

### Phase 3: Vercel-Specific Optimizations

#### Use Vercel Edge Config for Feature Flags

```typescript
import { get } from "@vercel/edge-config";

export async function middleware(request: NextRequest) {
  const rateLimitEnabled = await get("rateLimitEnabled");
  const limitsConfig = await get("rateLimits");

  // Dynamic configuration without redeployment
}
```

#### Use Vercel Analytics

```typescript
import { track } from "@vercel/analytics";

track("api_rate_limited", {
  endpoint: request.url,
  user: identifier,
});
```

## Vercel-Specific Rate Limiting Options

### Option 1: @upstash/ratelimit (Recommended)

```bash
npm install @upstash/ratelimit
```

**Pros:**

- Built for Vercel Edge
- Supports multiple algorithms (sliding window, token bucket)
- Works with Vercel KV
- Very fast (<10ms overhead)

**Cons:**

- Requires Vercel KV subscription (paid)

### Option 2: Vercel's Built-in Protection

Vercel automatically provides:

- DDoS protection at CDN level
- Automatic scaling
- Per-function timeout limits

**Pros:**

- Free
- No setup required
- Handles large attacks

**Cons:**

- Less granular control
- Can't differentiate auth vs anon users

### Option 3: Hybrid (Current + Vercel Edge)

Keep current in-memory rate limiting as fallback:

1. **Edge Middleware**: Coarse-grained rate limiting (blocks obvious abuse)
2. **API Routes**: Fine-grained rate limiting (specific per endpoint)

## Performance Benefits of SSR

### Current (CSR):

```
User Request → HTML Shell → JS Download → JS Parse → API Calls → Render
Time: ~2-3 seconds
```

### With SSR:

```
User Request → Fully Rendered HTML → Hydration
Time: ~500ms-1s
```

### SEO Benefits:

- Google sees full content immediately
- Better Core Web Vitals scores
- Improved search rankings

## Cost Considerations

### Vercel KV Pricing:

- **Hobby**: $0.20/100k requests
- **Pro**: Included up to 1M requests
- **Enterprise**: Custom pricing

### Recommendation:

Start with in-memory (current) + Edge middleware hybrid, then upgrade to Vercel KV when traffic justifies it.

## Migration Strategy

### Week 1: Edge Middleware

- [ ] Set up Edge middleware with basic rate limiting
- [ ] Add IP-based tracking
- [ ] Test with current pages

### Week 2: SSR Conversion

- [ ] Convert `/shorts` to SSR
- [ ] Measure performance improvements
- [ ] Monitor for issues

### Week 3: Optimize

- [ ] Add ISR caching where appropriate
- [ ] Fine-tune rate limits based on real data
- [ ] Add monitoring/alerting

### Week 4: Vercel KV (if needed)

- [ ] Evaluate traffic patterns
- [ ] Decide on Vercel KV adoption
- [ ] Migrate if justified

## Monitoring & Metrics

Track:

1. **Rate Limit Hits**: How often are limits hit?
2. **Page Load Times**: Before/after SSR conversion
3. **API Usage**: Which endpoints are most used?
4. **Bounce Rate**: Are users leaving due to slow loads?

Use:

- Vercel Analytics
- Custom logging in middleware
- Application monitoring (Sentry, DataDog, etc.)
