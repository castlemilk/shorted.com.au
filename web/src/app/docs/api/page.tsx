import React from 'react';
import { parseOpenAPISpec } from '~/lib/openapi/parser';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '~/@/components/ui/card';
import { ArrowRight, Book, Terminal, Shield, Lock } from 'lucide-react';
import { TokenGenerator } from '~/@/components/docs/token-generator';

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
            <div className="p-2 w-fit rounded-lg bg-blue-500/10 text-blue-500 mb-2">
              <Terminal className="h-6 w-6" />
            </div>
            <CardTitle>Quick Start</CardTitle>
            <CardDescription>
              Get up and running with our API in minutes with our cURL and SDK examples.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link 
              href={`/docs/api/${spec.endpoints[0]?.id}`}
              className="flex items-center text-sm font-medium text-blue-500 hover:underline"
            >
              View first endpoint
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden group">
          <CardHeader>
            <div className="p-2 w-fit rounded-lg bg-green-500/10 text-green-500 mb-2">
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
              className="flex items-center text-sm font-medium text-green-500 hover:underline"
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
                <Shield className="h-5 w-5 text-blue-500" />
                Bearer Token
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Include your API key in the <code>Authorization</code> header of your requests. 
                All private endpoints require this header.
              </p>
              <div className="bg-zinc-950 rounded-lg p-4 font-mono text-xs text-zinc-300 border border-zinc-800">
                Authorization: Bearer YOUR_API_KEY
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5 text-blue-500" />
                Public vs Private
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Most metadata and summary endpoints are <strong>Public</strong> and do not require authentication. 
                However, detailed time-series data and user-specific resources are <strong>Private</strong>.
              </p>
              <ul className="list-disc list-inside text-sm text-zinc-500 space-y-1 ml-2">
                <li>Public: GetStock, SearchStocks, GetTopShorts</li>
                <li>Private: GetStockData, MintToken</li>
              </ul>
            </div>
          </div>

          <div>
            <TokenGenerator />
          </div>
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
                      <span className="text-[10px] font-bold uppercase text-blue-500">{endpoint.method}</span>
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

