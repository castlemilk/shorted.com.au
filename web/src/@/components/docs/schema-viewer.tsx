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
        <span className="text-[10px] font-bold text-zinc-500 uppercase">All Of:</span>
        {schema.allOf.map((s: any, i: number) => (
          <SchemaViewer key={i} schema={s} depth={depth} />
        ))}
      </div>
    );
  }

  if (schema.oneOf || schema.anyOf) {
    const list = schema.oneOf || schema.anyOf;
    return (
      <div className="space-y-2 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-md p-2">
        <span className="text-[10px] font-bold text-blue-500 uppercase">{schema.oneOf ? 'One Of' : 'Any Of'}:</span>
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
    <div className={cn("text-sm", depth > 0 && "ml-4 border-l border-zinc-200 dark:border-zinc-800 pl-4 my-2")}>
      <div
        className={cn(
          "flex items-start gap-2 py-1 group rounded px-1 transition-colors",
          hasChildren && "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
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
          isOpen ? <ChevronDown className="h-4 w-4 mt-0.5 text-zinc-400" /> : <ChevronRight className="h-4 w-4 mt-0.5 text-zinc-400" />
        ) : (
          <div className="w-4" />
        )}
        
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {name && <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">{name}</span>}
            <span className="text-xs text-zinc-500 font-mono">
              {schema.type || (schema.properties ? 'object' : 'any')}
              {schema.format && ` <${schema.format}>`}
              {schema.enum && ` [${schema.enum.join(', ')}]`}
              {required && <span className="text-red-500 ml-1 font-bold" title="Required">*</span>}
            </span>
            {schema.default !== undefined && (
              <span className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1 rounded">
                default: {JSON.stringify(schema.default)}
              </span>
            )}
          </div>
          {schema.description && (
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{schema.description}</p>
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
              <span className="text-[10px] font-bold text-zinc-400 uppercase ml-4">Array Items:</span>
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

