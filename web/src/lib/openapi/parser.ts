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
import { resolveRefs as resolveRefsWithSchemas } from './resolve-refs';

export async function parseOpenAPISpec(): Promise<OpenAPISpec> {
  // The canonical generated artifact — see docs/superpowers/plans/
  // 2026-08-27-phase1-generated-openapi-and-llm-docs.md. Previously this read
  // api/schema/openapi.yaml, a hand-written 8-path document that had drifted
  // years behind the 64-method API.
  const specPath = path.join(process.cwd(), 'public', 'openapi.json');

  // Handle a missing spec gracefully (e.g. in Docker builds)
  if (!fs.existsSync(specPath)) {
    return {
      info: { title: 'API Documentation', version: '1.0.0' },
      endpoints: [],
      groups: [],
      components: { schemas: {} },
    };
  }

  const fileContents = fs.readFileSync(specPath, 'utf8');
  const rawSpec = yaml.load(fileContents) as any;

  const schemas = rawSpec.components?.schemas || {};

  // Ref resolution (and its cycle guard) lives in ./resolve-refs so it can be
  // tested against recursive fixtures without a spec file on disk.
  const resolveRefs = (obj: any): any => resolveRefsWithSchemas(obj, schemas);

  const endpoints: ParsedEndpoint[] = [];
  const paths = rawSpec.paths || {};

  Object.keys(paths).forEach((pathKey) => {
    const methods = paths[pathKey];
    Object.keys(methods).forEach((method) => {
      const operation = methods[method];
      if (typeof operation !== 'object') return;

      // Skip internal endpoints from the public docs
      if (pathKey.includes('GetSyncStatus')) return;
      if (pathKey.includes('RegisterService') || pathKey.includes('RegisterEmail')) return;

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

