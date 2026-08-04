"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '~/@/lib/utils';

interface SchemaViewerProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  name?: string;
  required?: boolean;
  depth?: number;
}

export function SchemaViewer({ schema, name, required, depth = 0 }: SchemaViewerProps) {
  const [isOpen, setIsOpen] = useState(depth < 2);

  if (!schema) return null;

  // Handle allOf, anyOf, oneOf
  if (schema.allOf) {
    return (
      <div className="space-y-2">
        <span className="text-[10px] font-bold text-muted-foreground uppercase">All Of:</span>
        {schema.allOf.map((s: any, i: number) => (
          <SchemaViewer key={i} schema={s} depth={depth} />
        ))}
      </div>
    );
  }

  if (schema.oneOf || schema.anyOf) {
    const list = schema.oneOf || schema.anyOf;
    return (
      <div className="space-y-2 border border-dashed border-border rounded-md p-2">
        <span className="text-[10px] font-bold text-primary uppercase">{schema.oneOf ? 'One Of' : 'Any Of'}:</span>
        {list.map((s: any, i: number) => (
          <SchemaViewer key={i} schema={s} depth={depth + 1} />
        ))}
      </div>
    );
  }

  const isObject = schema.type === 'object' || schema.properties;
  const isArray = schema.type === 'array' || schema.items;
  const hasChildren = isObject || isArray;

  const toggle = () => setIsOpen(!isOpen);

  return (
    <div className={cn("text-sm", depth > 0 && "ml-4 border-l border-border pl-4 my-2")}>
      <div
        className={cn(
          "flex items-start gap-2 py-1 group rounded px-1 transition-colors",
          hasChildren && "cursor-pointer hover:bg-muted/60"
        )}
        onClick={hasChildren ? toggle : undefined}
        onKeyDown={hasChildren ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        } : undefined}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? isOpen : undefined}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-4 w-4 mt-0.5 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground" />
        ) : (
          <div className="w-4" />
        )}
        
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {name && <span className="font-mono font-semibold text-primary">{name}</span>}
            <span className="text-xs text-muted-foreground font-mono">
              {schema.type || (schema.properties ? 'object' : 'any')}
              {schema.format && ` <${schema.format}>`}
              {schema.enum && ` [${schema.enum.join(', ')}]`}
              {required && <span className="text-destructive ml-1 font-bold" title="Required">*</span>}
            </span>
            {schema.default !== undefined && (
              <span className="text-[10px] bg-muted text-muted-foreground px-1 rounded">
                default: {JSON.stringify(schema.default)}
              </span>
            )}
          </div>
          {schema.description && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{schema.description}</p>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="mt-1">
          {isObject && schema.properties && Object.keys(schema.properties).map((propName) => (
            <SchemaViewer
              key={propName}
              name={propName}
              schema={schema.properties[propName]}
              required={schema.required?.includes(propName)}
              depth={depth + 1}
            />
          ))}
          {isArray && schema.items && (
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-muted-foreground uppercase ml-4">Array Items:</span>
              <SchemaViewer
                schema={schema.items}
                depth={depth + 1}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

