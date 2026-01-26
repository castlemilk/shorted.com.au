"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import React, { useState } from 'react';
import { Button } from '~/@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/@/components/ui/card';
import { Key, Loader2, Copy, Check, ShieldCheck } from 'lucide-react';
import { mintApiTokenAction } from '~/app/actions/mintToken';
import { useSession } from 'next-auth/react';
import { cn } from '~/@/lib/utils';

export function TokenGenerator() {
  const { data: session, status } = useSession();
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await mintApiTokenAction();
      setToken(result.token);
      // Save to localStorage for Try It panel
      localStorage.setItem('shorted_api_token', result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy token:', err);
    }
  };

  if (status === 'loading') return null;

  if (!session) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="h-5 w-5 text-zinc-400" />
            API Keys
          </CardTitle>
          <CardDescription>
            You must be signed in to generate an API key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild className="w-full">
            <a href="/signin">Sign In to Generate API Key</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("transition-all duration-300", token && "border-blue-500/50 shadow-lg shadow-blue-500/10")}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Key className="h-5 w-5 text-blue-500" />
          API Keys
        </CardTitle>
        <CardDescription>
          Generate a personal access token to use the Shorted API programmatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!token ? (
          <Button 
            onClick={handleGenerate} 
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Generate New API Key
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <div className="bg-zinc-950 border border-zinc-800 rounded-md p-3 pr-12 font-mono text-xs text-blue-400 break-all overflow-hidden max-h-32 overflow-y-auto">
                {token}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-2 top-2 h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                onClick={copyToClipboard}
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-[10px] text-zinc-500 bg-zinc-100 dark:bg-zinc-900 p-2 rounded border border-zinc-200 dark:border-zinc-800">
                <strong>Important:</strong> Copy this key now. For your security, it won't be shown again.
              </p>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setToken(null)}
                className="text-xs"
              >
                Generate another
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p className="text-xs text-red-500 mt-2">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}



