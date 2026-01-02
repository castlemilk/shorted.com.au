"use client";

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/@/components/ui/tabs';
import { CodeBlock } from './code-block';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import { 
  generateCurl, 
  generateJavascript, 
  generatePython, 
  generateTypescript 
} from '~/lib/openapi/code-samples';
import { TryItPanel } from './try-it-panel';

interface CodePanelProps {
  endpoint: ParsedEndpoint;
}

export function CodePanel({ endpoint }: CodePanelProps) {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://api.shorted.com.au';
  
  const samples = [
    { label: 'cURL', lang: 'bash', code: generateCurl(endpoint, baseUrl) },
    { label: 'JavaScript', lang: 'javascript', code: generateJavascript(endpoint, baseUrl) },
    { label: 'Python', lang: 'python', code: generatePython(endpoint, baseUrl) },
    { label: 'TypeScript', lang: 'typescript', code: generateTypescript(endpoint, baseUrl) },
  ];

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-l border-zinc-800">
      <Tabs defaultValue="cURL" className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <TabsList className="bg-transparent border-0 h-auto p-0 gap-4">
            {samples.map((sample) => (
              <TabsTrigger
                key={sample.label}
                value={sample.label}
                className="data-[state=active]:bg-transparent data-[state=active]:text-zinc-100 text-zinc-500 text-xs font-medium px-0 py-2 border-b-2 border-transparent data-[state=active]:border-blue-500 rounded-none h-auto shadow-none"
              >
                {sample.label}
              </TabsTrigger>
            ))}
            <TabsTrigger
              value="TryIt"
              className="data-[state=active]:bg-transparent data-[state=active]:text-zinc-100 text-zinc-500 text-xs font-medium px-0 py-2 border-b-2 border-transparent data-[state=active]:border-blue-500 rounded-none h-auto shadow-none ml-auto"
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
          <TryItPanel endpoint={endpoint} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

