"use client";

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/@/components/ui/tabs';
import { CodeBlock } from './code-block';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import {
  generateCurl,
  generateJavascript,
  generatePython,
  generateTypescript,
  generateGo,
  generateJava,
} from '~/lib/openapi/code-samples';
import { TryItPanel } from './try-it-panel';
import { FALLBACK_API_BASE_URL } from '~/lib/openapi/api-base-url';

interface CodePanelProps {
  endpoint: ParsedEndpoint;
  /**
   * The host the samples target. Pass the generated spec's `servers[0].url`
   * (see `getApiBaseUrl`) so the docs and the spec cannot disagree.
   */
  baseUrl?: string;
}

export function CodePanel({ endpoint, baseUrl: baseUrlProp }: CodePanelProps) {
  // Never the raw Cloud Run origin: it bypasses Cloudflare's edge cache, WAF
  // and rate limiting, and its hostname changes on redeploy — not something we
  // want third parties or LLM agents copy-pasting into their clients.
  const baseUrl = baseUrlProp ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? FALLBACK_API_BASE_URL;


  const samples = [
    { label: 'cURL', lang: 'bash', code: generateCurl(endpoint, baseUrl) },
    { label: 'JavaScript', lang: 'javascript', code: generateJavascript(endpoint, baseUrl) },
    { label: 'Python', lang: 'python', code: generatePython(endpoint, baseUrl) },
    { label: 'TypeScript', lang: 'typescript', code: generateTypescript(endpoint, baseUrl) },
    { label: 'Go', lang: 'go', code: generateGo(endpoint, baseUrl) },
    { label: 'Java', lang: 'java', code: generateJava(endpoint, baseUrl) },
  ];

  return (
    <div className="flex flex-col h-full bg-muted/30 border-l border-border">
      <Tabs defaultValue="cURL" className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <TabsList className="bg-transparent border-0 h-auto p-0 gap-4">
            {samples.map((sample) => (
              <TabsTrigger
                key={sample.label}
                value={sample.label}
                className="data-[state=active]:bg-transparent data-[state=active]:text-foreground text-muted-foreground text-xs font-medium px-0 py-2 border-b-2 border-transparent data-[state=active]:border-primary rounded-none h-auto shadow-none"
              >
                {sample.label}
              </TabsTrigger>
            ))}
            <TabsTrigger
              value="TryIt"
              className="data-[state=active]:bg-transparent data-[state=active]:text-foreground text-muted-foreground text-xs font-medium px-0 py-2 border-b-2 border-transparent data-[state=active]:border-primary rounded-none h-auto shadow-none ml-auto"
            >
              Try It
            </TabsTrigger>
          </TabsList>
        </div>
        {samples.map((sample) => (
          <TabsContent 
            key={sample.label} 
            value={sample.label} 
            className="flex-1 mt-0 focus-visible:ring-0 overflow-auto"
          >
            <CodeBlock code={sample.code} language={sample.lang} />
          </TabsContent>
        ))}
        <TabsContent value="TryIt" className="flex-1 mt-0 focus-visible:ring-0 overflow-hidden">
          <TryItPanel endpoint={endpoint} baseUrl={baseUrl} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

