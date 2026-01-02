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

interface TryItPanelProps {
  endpoint: ParsedEndpoint;
}

export function TryItPanel({ endpoint }: TryItPanelProps) {
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

  const [token, setToken] = useState(getSavedToken());

  const handleSend = async () => {
    setLoading(true);
    setError(null);
    setResponse(null);

    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://api.shorted.com.au';
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
    <div className="flex flex-col gap-4 p-4 h-full bg-zinc-950 overflow-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100 uppercase tracking-wider">Test Request</h3>
        <Button 
          size="sm" 
          onClick={handleSend} 
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
          Send
        </Button>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Authentication Token (Optional)</label>
        <div className="flex gap-2">
          <Input 
            className="h-8 bg-zinc-900 border-zinc-800 text-xs font-mono text-blue-400"
            placeholder="Bearer token..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {token && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 text-[10px] text-zinc-500 hover:text-red-400"
              onClick={() => setToken('')}
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-[10px] text-zinc-500">
          Generate a token on the <a href="/docs/api#authentication" className="text-blue-500 hover:underline">main page</a>.
        </p>
      </div>

      {endpoint.method !== 'GET' && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Request Body (JSON)</label>
          <textarea
            className="w-full h-40 bg-zinc-900 border border-zinc-800 rounded-md p-2 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='{ "key": "value" }'
          />
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-md text-xs text-red-400">
          {error}
        </div>
      )}

      {response && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-zinc-400">Response</label>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              response.status >= 200 && response.status < 300 ? 'bg-green-900/20 text-green-500' : 'bg-red-900/20 text-red-500'
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

