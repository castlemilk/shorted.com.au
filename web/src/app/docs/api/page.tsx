import React from 'react';
import { parseOpenAPISpec } from '~/lib/openapi/parser';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '~/@/components/ui/card';
import Image from 'next/image';
import { ArrowRight, Book, Terminal, Shield, Lock, AlertTriangle } from 'lucide-react';
import { ApiAccessSection } from '~/@/components/docs/api-access-section';

export default async function ApiDocsIndex() {
  const spec = await parseOpenAPISpec();

  return (
    <div className="container max-w-4xl py-10 space-y-16">
      <div className="space-y-4">
        <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl">
          {spec.info.title}
        </h1>
        <p className="text-xl text-muted-foreground">
          {spec.info.description ?? 'Reference documentation for the Shorted API.'}
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card className="relative overflow-hidden group">
          <CardHeader>
            <Image src="/assets/api-access-small.png" alt="" width={40} height={40} className="h-10 w-10 mb-2" />
            <CardTitle>Quick Start</CardTitle>
            <CardDescription>
              Get up and running with our API in minutes with our cURL and SDK examples.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link 
              href={`/docs/api/${spec.endpoints[0]?.id}`}
              className="flex items-center text-sm font-medium text-primary hover:underline"
            >
              View first endpoint
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden group">
          <CardHeader>
            <div className="p-2 w-fit rounded-lg bg-primary/10 text-primary mb-2">
              <Book className="h-6 w-6" />
            </div>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>
              Learn how to authenticate your requests using Bearer tokens or Session cookies.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a 
              href="#authentication"
              className="flex items-center text-sm font-medium text-primary hover:underline"
            >
              Read auth guide
              <ArrowRight className="ml-1 h-4 w-4" />
            </a>
          </CardContent>
        </Card>
      </div>

      <section id="authentication" className="space-y-8 scroll-mt-20">
        <div className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Authentication</h2>
          <p className="text-muted-foreground">
            The Shorted API uses Bearer Tokens to authenticate requests. You can generate a personal access token 
            directly from this dashboard if you are signed in.
          </p>
        </div>

        <div className="grid gap-8 md:grid-cols-[1fr_300px]">
          <div className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-xl font-semibold flex items-center gap-2">
                <Shield className="h-5 w-5 text-primary" />
                Bearer Token
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Include your API key in the <code>Authorization</code> header of your requests. 
                All private endpoints require this header.
              </p>
              <div className="bg-muted rounded-lg p-4 font-mono text-xs text-foreground border border-border">
                Authorization: Bearer YOUR_API_KEY
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5 text-primary" />
                Public vs Private
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Most metadata and summary endpoints are <strong>Public</strong> and do not require authentication. 
                However, detailed time-series data and user-specific resources are <strong>Private</strong>.
              </p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 ml-2">
                <li>Public: GetStock, SearchStocks, GetTopShorts</li>
                <li>Private: GetStockData, MintToken</li>
              </ul>
            </div>
          </div>

          <div>
            <ApiAccessSection checkoutTier="api_access" />
          </div>
        </div>
      </section>

      <section id="rate-limits" className="space-y-8 scroll-mt-20">
        <div className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Rate Limits &amp; Usage Policy</h2>
          <p className="text-muted-foreground">
            All API requests are subject to rate limiting. Limits vary by subscription tier and are enforced
            using a sliding window algorithm.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Image src="/assets/premium-icon-small.png" alt="" width={24} height={24} className="h-6 w-6" />
              <CardTitle className="text-xl">Rate Limit Tiers</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              These limits apply to <strong>programmatic API access</strong> (requests with API tokens).
              Browser access via shorted.com.au has more relaxed limits and is not subject to these caps.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 pr-4 font-semibold">Tier</th>
                    <th className="text-left py-3 pr-4 font-semibold">Per Minute</th>
                    <th className="text-left py-3 pr-4 font-semibold">Per Month</th>
                    <th className="text-left py-3 font-semibold">Access</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  <tr className="border-b">
                    <td className="py-3 pr-4 font-medium text-foreground">Anonymous</td>
                    <td className="py-3 pr-4">10</td>
                    <td className="py-3 pr-4">500</td>
                    <td className="py-3">Public endpoints only, limited</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-3 pr-4 font-medium text-foreground">Free (signed in)</td>
                    <td className="py-3 pr-4">30</td>
                    <td className="py-3 pr-4">1,000</td>
                    <td className="py-3">All endpoints, requires API token</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-3 pr-4 font-medium text-foreground">Pro ($29/mo)</td>
                    <td className="py-3 pr-4">120</td>
                    <td className="py-3 pr-4">10,000</td>
                    <td className="py-3">All endpoints, priority</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-foreground">Enterprise</td>
                    <td className="py-3 pr-4">300</td>
                    <td className="py-3 pr-4">50,000</td>
                    <td className="py-3">All endpoints, dedicated support</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <CardTitle className="text-xl">Usage Policy</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                Automated access requires a valid API token.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                Scraping without authentication is prohibited.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                Requests without valid <code className="text-xs bg-muted px-1 py-0.5 rounded">User-Agent</code> headers may be blocked.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                Browser-tier rate limits only apply to requests originating from shorted.com.au.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                Abuse results in IP-level blocking.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                For bulk data access, contact{' '}
                <a href="mailto:support@shorted.com.au" className="text-primary hover:underline">
                  support@shorted.com.au
                </a>.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle className="text-xl">Response Headers</CardTitle>
            </div>
            <CardDescription>
              All API responses include rate limit headers so you can monitor your usage programmatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-muted rounded-lg p-4 font-mono text-xs text-foreground border border-border space-y-1">
              <div><code>X-RateLimit-Limit</code>: 120 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-muted-foreground"># Per-minute limit (0 = unlimited)</span></div>
              <div><code>X-RateLimit-Remaining</code>: 115 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-muted-foreground"># Requests remaining this minute</span></div>
              <div><code>X-RateLimit-Reset</code>: 1706918400 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-muted-foreground"># Unix timestamp when minute window resets</span></div>
              <div><code>X-RateLimit-Monthly-Limit</code>: 10000 &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-muted-foreground"># Monthly request cap</span></div>
              <div><code>X-RateLimit-Monthly-Used</code>: 150 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-muted-foreground"># Requests used this month</span></div>
              <div><code>X-RateLimit-Monthly-Reset</code>: 1709251200 <span className="text-muted-foreground"># Start of next billing month</span></div>
            </div>
            <p className="text-sm text-muted-foreground mt-4">
              When rate limited, the API returns HTTP <code className="text-xs bg-muted px-1 py-0.5 rounded">429 Too Many Requests</code> with
              a <code className="text-xs bg-muted px-1 py-0.5 rounded">Retry-After</code> header indicating how many seconds to wait.
            </p>
          </CardContent>
        </Card>
      </section>

      <section id="client-guides" className="space-y-8 scroll-mt-20">
        <div className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Client Guides</h2>
          <p className="text-muted-foreground">
            Detailed guides for calling the Shorted API from your preferred language. All examples use
            standard HTTP — no SDK installation required.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { slug: 'curl', name: 'cURL', description: 'Command-line HTTP requests', color: 'text-muted-foreground', bg: 'bg-muted' },
            { slug: 'javascript', name: 'JavaScript', description: 'Browser and Node.js with fetch', color: 'text-primary', bg: 'bg-primary/10' },
            { slug: 'python', name: 'Python', description: 'HTTP requests with the requests library', color: 'text-accent', bg: 'bg-accent/10' },
            { slug: 'typescript', name: 'TypeScript', description: 'Type-safe fetch with interfaces', color: 'text-primary', bg: 'bg-primary/10' },
            { slug: 'go', name: 'Go', description: 'HTTP examples using net/http', color: 'text-accent', bg: 'bg-accent/10' },
            { slug: 'java', name: 'Java', description: 'HttpURLConnection for JVM apps', color: 'text-primary', bg: 'bg-primary/10' },
          ].map((lang) => (
            <Link key={lang.slug} href={`/docs/api/clients/${lang.slug}`}>
              <Card className="h-full hover:bg-accent/50 transition-colors group">
                <CardHeader className="pb-3">
                  <div className={`p-2 w-fit rounded-lg ${lang.bg} ${lang.color} mb-2`}>
                    <Terminal className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    {lang.name}
                    <ArrowRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </CardTitle>
                  <CardDescription>{lang.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <div className="space-y-6">
        <h2 className="text-3xl font-bold tracking-tight border-b pb-2">API Resources</h2>
        <div className="grid gap-4">
          {spec.groups.map((group, i) => (
            <div key={i} className="space-y-3">
              <h3 className="text-lg font-semibold text-muted-foreground">{group.title}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.endpoints.slice(0, 4).map((endpoint, j) => (
                  <Link 
                    key={j} 
                    href={`/docs/api/${endpoint.id}`}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent hover:text-accent-foreground transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold uppercase text-primary">{endpoint.method}</span>
                      <span className="text-sm font-medium truncate max-w-[150px]">{endpoint.summary ?? endpoint.path}</span>
                    </div>
                    <ArrowRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </Link>
                ))}
                {group.endpoints.length > 4 && (
                  <Link 
                    href={`/docs/api/${group.endpoints[4]?.id ?? ''}`}
                    className="flex items-center justify-center p-3 rounded-lg border border-dashed text-xs text-muted-foreground hover:bg-accent transition-colors"
                  >
                    View {group.endpoints.length - 4} more...
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
