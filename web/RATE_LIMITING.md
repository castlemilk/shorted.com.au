# Rate Limiting Implementation

## Overview

This application implements rate limiting to protect API endpoints from abuse while providing a better experience for authenticated users. Anonymous users have lower rate limits to encourage sign-ups, while authenticated users enjoy higher limits.

## Rate Limit Configuration

### API Endpoints

| Endpoint                           | Anonymous Users | Authenticated Users | Window |
| ---------------------------------- | --------------- | ------------------- | ------ |
| `/api/search/stocks`               | 50 req/min      | 500 req/min         | 60s    |
| `/api/market-data/multiple-quotes` | 30 req/min      | 300 req/min         | 60s    |
| `/api/market-data/historical`      | 20 req/min      | 200 req/min         | 60s    |
| `/api/market-data/correlations`    | 10 req/min      | 100 req/min         | 60s    |

## How It Works

### Authentication Detection

- **Authenticated users**: Identified by their user ID from the NextAuth session
- **Anonymous users**: Identified by their IP address (from `x-forwarded-for` or `x-real-ip` headers)

### Rate Limit Storage

- Uses an in-memory Map for storing request counts
- Automatic cleanup every 5 minutes to prevent memory leaks
- For production with multiple instances, consider using Redis or a distributed cache

### Response Headers

When rate limits are exceeded, the API returns a `429 Too Many Requests` response with:

- `X-RateLimit-Limit`: The rate limit ceiling
- `X-RateLimit-Remaining`: Number of requests remaining (0 when exceeded)
- `X-RateLimit-Reset`: Timestamp when the rate limit resets
- `Retry-After`: Seconds until the limit resets

### Error Response Format

```json
{
  "error": "Rate limit exceeded",
  "message": "Rate limit exceeded. Sign in for higher limits, or try again in 45 seconds.",
  "retryAfter": 45,
  "limit": 10,
  "authenticated": false
}
```

## Implementation Details

### Core Rate Limiter (`@/lib/rate-limit.ts`)

The `rateLimit()` function:

1. Checks if the user is authenticated via NextAuth session
2. Determines the appropriate rate limit (authenticated vs anonymous)
3. Tracks requests using a unique identifier (user ID or IP address)
4. Returns a success/failure result with an optional error response

### Usage Example

```typescript
import { rateLimit } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 10, // 10 requests per minute for anonymous
    authenticatedLimit: 100, // 100 requests per minute for authenticated
    windowSeconds: 60, // 1 minute window
  });

  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }

  // Process the request...
}
```

## Benefits

### For Anonymous Users

- Fair usage policy prevents abuse
- Clear messaging encourages sign-up for higher limits
- Transparent error messages with retry timing

### For Authenticated Users

- 10x higher rate limits than anonymous users
- Better experience for legitimate usage
- No degradation during normal usage

### For the Application

- Protection against API abuse and DoS attacks
- Encourages user registration
- Reduces load on backend services
- Easy to tune limits per endpoint

## Future Enhancements

### Recommended for Production

1. **Distributed Rate Limiting**: Use Redis or similar for multi-instance deployments
2. **Persistent Storage**: Track rate limits across server restarts
3. **Analytics**: Monitor rate limit hits to tune thresholds
4. **Tier-based Limits**: Different limits for free vs. premium users
5. **IP Reputation**: Use services like Cloudflare or AWS WAF
6. **Graceful Degradation**: Queue requests instead of rejecting them

### Monitoring

Consider adding:

- Metrics for rate limit hits (per endpoint, per user type)
- Alerts when rate limits are frequently exceeded
- Dashboard to visualize API usage patterns

## Testing

### Testing Anonymous Limits

```bash
# Make rapid requests without authentication
for i in {1..15}; do
  curl http://localhost:3000/api/search/stocks?q=CBA
done
# Should see 429 after 50 requests within 60 seconds
```

### Testing Authenticated Limits

```bash
# Make requests with authentication token
for i in {1..110}; do
  curl -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
    http://localhost:3000/api/search/stocks?q=CBA
done
# Should see 429 after 500 requests within 60 seconds
```

## Configuration

Rate limits can be adjusted by modifying the configuration in each API route file. The default configuration is defined in `/web/src/@/lib/rate-limit.ts`:

```typescript
const DEFAULT_CONFIG: RateLimitConfig = {
  anonymousLimit: 10,
  authenticatedLimit: 100,
  windowSeconds: 60,
};
```

## Security Considerations

1. **IP Spoofing**: Trust proxy headers only in production behind a trusted reverse proxy
2. **Session Hijacking**: Ensure proper session security with NextAuth
3. **Memory Limits**: The in-memory store has a cleanup mechanism, but consider external storage for high-traffic scenarios
4. **DDoS Protection**: This is application-level rate limiting; use CDN/WAF for network-level protection
