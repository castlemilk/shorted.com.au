/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { OpenAPISpec, ParsedEndpoint, NavigationGroup, HTTPMethod } from './types';

export async function parseOpenAPISpec(): Promise<OpenAPISpec> {
  const specPath = path.join(process.cwd(), '../api/schema/openapi.yaml');
  const fileContents = fs.readFileSync(specPath, 'utf8');
  const rawSpec = yaml.load(fileContents) as any;

  const schemas = rawSpec.components?.schemas || {};

  function resolveRefs(obj: any, visited = new Set()): any {
    if (!obj || typeof obj !== 'object') return obj;
    if (visited.has(obj)) return obj; // Prevent infinite recursion

    if (obj.$ref) {
      const refName = obj.$ref.split('/').pop();
      const resolved = schemas[refName];
      if (resolved) {
        // Create a new object combining resolved schema and existing properties
        // but excluding the $ref itself
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { $ref: _, ...rest } = obj;
        return resolveRefs({ ...resolved, ...rest }, visited);
      }
    }

    if (Array.isArray(obj)) {
      return obj.map(item => resolveRefs(item, visited));
    }

    const newObj: any = {};
    Object.keys(obj).forEach(key => {
      newObj[key] = resolveRefs(obj[key], visited);
    });
    return newObj;
  }

  const endpoints: ParsedEndpoint[] = [];
  const paths = rawSpec.paths || {};

  Object.keys(paths).forEach((pathKey) => {
    const methods = paths[pathKey];
    Object.keys(methods).forEach((method) => {
      const operation = methods[method];
      if (typeof operation !== 'object') return;

      // Skip internal endpoints like GetSyncStatus from the bespoke docs
      if (pathKey.includes('GetSyncStatus')) return;

      const endpoint: ParsedEndpoint = {
        id: `${method}-${pathKey.replace(/\//g, '-').replace(/[{}]/g, '')}`.toLowerCase(),
        method: method.toUpperCase() as HTTPMethod,
        path: pathKey,
        summary: operation.summary,
        description: operation.description,
        operationId: operation.operationId,
        tags: operation.tags || ['default'],
        parameters: resolveRefs(operation.parameters || []),
        requestBody: resolveRefs(operation.requestBody),
        responses: resolveRefs(operation.responses || {}),
      };
      endpoints.push(endpoint);
    });
  });

  // Group endpoints by tags
  const groupsMap = new Map<string, ParsedEndpoint[]>();
  endpoints.forEach((endpoint) => {
    endpoint.tags.forEach((tag) => {
      if (!groupsMap.has(tag)) {
        groupsMap.set(tag, []);
      }
      groupsMap.get(tag)?.push(endpoint);
    });
  });

  const groups: NavigationGroup[] = Array.from(groupsMap.entries()).map(([tag, tagEndpoints]) => ({
    tag,
    title: tag.split('.').pop() || tag, // Clean up tag name for title
    endpoints: tagEndpoints,
  }));

  return {
    info: {
      title: rawSpec.info?.title || 'API Documentation',
      description: rawSpec.info?.description,
      version: rawSpec.info?.version || '1.0.0',
    },
    endpoints,
    groups,
    components: rawSpec.components || { schemas: {} },
  };
}

export async function getEndpoint(id: string): Promise<ParsedEndpoint | undefined> {
  const spec = await parseOpenAPISpec();
  return spec.endpoints.find((e) => e.id === id);
}

