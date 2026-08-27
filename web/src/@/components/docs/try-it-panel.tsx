"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import React, { useState } from 'react';
import { Button } from '~/@/components/ui/button';
import { Input } from '~/@/components/ui/input';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import { CodeBlock } from './code-block';
import { Loader2, Play } from 'lucide-react';
import { FALLBACK_API_BASE_URL } from '~/lib/openapi/api-base-url';

interface TryItPanelProps {
  endpoint: ParsedEndpoint;
  /** The host to call. Supplied by CodePanel from the spec's `servers[0].url`. */
  baseUrl?: string;
}

export function TryItPanel({ endpoint, baseUrl: baseUrlProp }: TryItPanelProps) {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  
  // Try to load saved token from localStorage
  const getSavedToken = () => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('shorted_api_token') ?? '';
    }
    return '';
  };

  const [token, setToken] = useState(() => getSavedToken());

  const handleSend = async () => {
    setLoading(true);
    setError(null);
    setResponse(null);

    // Same rule as the code samples: the public, Cloudflare-fronted host, never
    // the raw Cloud Run origin.
    const baseUrl = baseUrlProp ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? FALLBACK_API_BASE_URL;
    const url = `${baseUrl}${endpoint.path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const res = await fetch(url, {
        method: endpoint.method,
        headers,
        body: endpoint.method !== 'GET' && body ? body : undefined,
      });

      const data = await res.json();
      setResponse({
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        data,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 h-full bg-muted/30 overflow-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Test Request</h3>
        <Button 
          size="sm" 
          onClick={handleSend} 
          disabled={loading}
          className="gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
          Send
        </Button>
      </div>

      <div className="space-y-2">
        <label htmlFor="auth-token" className="text-xs font-medium text-muted-foreground">Authentication Token (Optional)</label>
        <div className="flex gap-2">
          <Input
            id="auth-token"
            className="h-8 text-xs font-mono"
            placeholder="Bearer token..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {token && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={() => setToken('')}
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          Generate a token on the <a href="/docs/api#authentication" className="text-primary hover:underline">main page</a>.
        </p>
      </div>

      {endpoint.method !== 'GET' && (
        <div className="space-y-2">
          <label htmlFor="request-body" className="text-xs font-medium text-muted-foreground">Request Body (JSON)</label>
          <textarea
            id="request-body"
            className="w-full h-40 bg-background border border-input rounded-md p-2 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='{ "key": "value" }'
          />
        </div>
      )}

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/40 rounded-md text-xs text-destructive">
          {error}
        </div>
      )}

      {response && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Response</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              response.status >= 200 && response.status < 300 ? 'bg-lime-600/15 text-lime-700 dark:text-lime-300' : 'bg-destructive/15 text-destructive'
            }`}>
              {response.status} {response.statusText}
            </span>
          </div>
          <CodeBlock code={JSON.stringify(response.data, null, 2)} language="json" />
        </div>
      )}
    </div>
  );
}

