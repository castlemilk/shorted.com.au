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
            endpoint.method === 'GET' && "bg-lime-600/10 text-lime-700 dark:text-lime-300 border border-lime-600/25",
            endpoint.method === 'POST' && "bg-primary/10 text-primary border border-primary/25",
            endpoint.method === 'PUT' && "bg-orange-500/10 text-orange-700 dark:text-orange-300 border border-orange-500/25",
            endpoint.method === 'DELETE' && "bg-destructive/10 text-destructive border border-destructive/25",
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
              <div key={i} className="flex flex-col gap-1 border-b border-border pb-4 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-primary">{param.name}</span>
                  <span className="text-xs text-muted-foreground uppercase">{param.in}</span>
                  {param.required && <span className="text-[10px] bg-destructive/10 text-destructive px-1.5 py-0.5 rounded font-bold uppercase">Required</span>}
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
              <span className="text-xs font-mono text-muted-foreground">{contentType}</span>
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
                  code.startsWith('2') ? "bg-lime-600/10 text-lime-700 dark:text-lime-300" : "bg-destructive/10 text-destructive"
                )}>
                  {code}
                </span>
                <span className="text-sm font-medium">{response.description}</span>
              </div>
              {response.content && Object.entries(response.content).map(([contentType, content], j) => (
                <div key={j} className="space-y-2 ml-4">
                  <span className="text-xs font-mono text-muted-foreground">{contentType}</span>
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



