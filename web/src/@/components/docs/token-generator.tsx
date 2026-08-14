"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import React, { useState } from 'react';
import { Button } from '~/@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/@/components/ui/card';
import { Loader2, Copy, Check, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
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
            <Image src="/assets/api-access-small.png" alt="" width={20} height={20} className="h-5 w-5" />
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
    <Card className={cn("transition-[border-color,box-shadow] duration-200 ease-out", token && "border-primary/50 shadow-amber")}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Image src="/assets/api-access-small.png" alt="" width={20} height={20} className="h-5 w-5" />
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
            className="w-full gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Generate New API Key
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <div className="bg-muted border border-border rounded-md p-3 pr-12 font-mono text-xs text-primary break-all overflow-hidden max-h-32 overflow-y-auto">
                {token}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-2 top-2 h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={copyToClipboard}
              >
                {copied ? <Check className="h-4 w-4 text-lime-700 dark:text-lime-300" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-[10px] text-muted-foreground bg-muted p-2 rounded border border-border">
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
          <p className="text-xs text-destructive mt-2">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}



