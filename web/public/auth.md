# Authentication — Shorted API

> Machine-readable summary for agents: how to authenticate with the
> Shorted.com.au public API. See https://shorted.com.au/docs/api for the
> full documentation and https://shorted.com.au/openapi.json for the
> OpenAPI 3.1 description.

## Anonymous access

Most read-only data endpoints work without authentication, rate limited by IP:

- 30 requests/minute, 1,000 requests/month

No registration is required for evaluation or light usage.

## API keys (Bearer tokens)

Higher limits require a personal access token, sent as a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

| Tier | Per minute | Per month |
|------|-----------|-----------|
| Anonymous | 30 | 1,000 |
| Free account | 60 | 2,000 |
| Paid subscription | unlimited | 10,000 |

## Registration

1. Create an account at https://shorted.com.au (Google sign-in).
2. Generate a personal access token from your account settings.
3. Optional: subscribe to a paid plan for higher limits — see
   https://shorted.com.au/docs/api for pricing.

Agent registration is human-in-the-loop: there is currently no programmatic
client registration endpoint, and OAuth 2.0 / OpenID Connect flows are not
supported. Do not expect /.well-known/openid-configuration or
/.well-known/oauth-authorization-server to exist.

## Rate limit headers

All API responses include:

```
X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset,
X-RateLimit-Monthly-Limit, X-RateLimit-Monthly-Used, X-RateLimit-Monthly-Reset
```

HTTP 429 responses include a `Retry-After` header.

## Contact

support@shorted.com.au
