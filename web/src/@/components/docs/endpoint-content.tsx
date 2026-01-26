/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import React from 'react';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import { SchemaViewer } from './schema-viewer';
import { cn } from '~/@/lib/utils';

interface EndpointContentProps {
  endpoint: ParsedEndpoint;
}

export function EndpointContent({ endpoint }: EndpointContentProps) {
  return (
    <div className="space-y-8 pb-16">
      <div className="space-y-2">
        <div className="flex items-center gap-4">
          <span className={cn(
            "px-2 py-1 rounded text-xs font-bold uppercase",
            endpoint.method === 'GET' && "bg-green-500/10 text-green-500 border border-green-500/20",
            endpoint.method === 'POST' && "bg-blue-500/10 text-blue-500 border border-blue-500/20",
            endpoint.method === 'PUT' && "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20",
            endpoint.method === 'DELETE' && "bg-red-500/10 text-red-500 border border-red-500/20",
          )}>
            {endpoint.method}
          </span>
          <code className="text-sm font-mono text-muted-foreground">{endpoint.path}</code>
        </div>
        <h1 className="text-4xl font-bold tracking-tight">{endpoint.summary ?? endpoint.path}</h1>
        {endpoint.description && (
          <p className="text-lg text-muted-foreground">{endpoint.description}</p>
        )}
      </div>

      {endpoint.parameters.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold border-b pb-2">Parameters</h2>
          <div className="space-y-6">
            {endpoint.parameters.map((param, i) => (
              <div key={i} className="flex flex-col gap-1 border-b border-zinc-100 dark:border-zinc-800 pb-4 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">{param.name}</span>
                  <span className="text-xs text-zinc-500 uppercase">{param.in}</span>
                  {param.required && <span className="text-[10px] bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded font-bold uppercase">Required</span>}
                </div>
                {param.description && <p className="text-sm text-muted-foreground">{param.description}</p>}
                <SchemaViewer schema={param.schema} depth={1} />
              </div>
            ))}
          </div>
        </div>
      )}

      {endpoint.requestBody && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold border-b pb-2">Request Body</h2>
          {endpoint.requestBody.description && (
            <p className="text-sm text-muted-foreground">{endpoint.requestBody.description}</p>
          )}
          {Object.entries(endpoint.requestBody.content).map(([contentType, content], i) => (
            <div key={i} className="space-y-2">
              <span className="text-xs font-mono text-zinc-500">{contentType}</span>
              <SchemaViewer schema={content.schema} />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-2xl font-semibold border-b pb-2">Responses</h2>
        <div className="space-y-8">
          {Object.entries(endpoint.responses).map(([code, response], i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-xs font-bold px-1.5 py-0.5 rounded",
                  code.startsWith('2') ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400" : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"
                )}>
                  {code}
                </span>
                <span className="text-sm font-medium">{response.description}</span>
              </div>
              {response.content && Object.entries(response.content).map(([contentType, content], j) => (
                <div key={j} className="space-y-2 ml-4">
                  <span className="text-xs font-mono text-zinc-500">{contentType}</span>
                  <SchemaViewer schema={content.schema} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}



