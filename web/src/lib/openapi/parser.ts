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
import type { OpenAPISpec, ParsedEndpoint, NavigationGroup, HTTPMethod, Server } from './types';
import { resolveRefs as resolveRefsWithSchemas } from './resolve-refs';
import { FALLBACK_API_BASE_URL } from './api-base-url';

/**
 * The keys of an OpenAPI 3 Path Item that hold an operation. Every other key
 * on a path (`servers`, `parameters`, `summary`, `description`, `$ref`) is
 * path-level data, not an endpoint. The spec gives /api/search/stocks and
 * /feed.xml a path-level `servers` array; an array passes `typeof === 'object'`,
 * so walking every key minted two 'SERVERS' endpoints, each with a docs page,
 * a sidebar entry and a sitemap URL (/docs/api/servers--api-search-stocks,
 * /docs/api/servers--feed.xml).
 */
const OPERATION_METHODS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/** A `servers` value with at least one usable URL, else undefined. */
function declaredServers(value: unknown): Server[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers = value.filter(
    (server): server is Server =>
      !!server && typeof server.url === 'string' && server.url !== '',
  );
  return servers.length > 0 ? servers : undefined;
}

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
      servers: [{ url: FALLBACK_API_BASE_URL, description: 'Production' }],
      endpoints: [],
      groups: [],
      components: { schemas: {} },
    };
  }

  const fileContents = fs.readFileSync(specPath, 'utf8');
  return buildOpenAPISpec(yaml.load(fileContents));
}

/** Builds the docs' view of a loaded OpenAPI document (no file access). */
export function buildOpenAPISpec(document: unknown): OpenAPISpec {
  const rawSpec = (document ?? {}) as any;

  const schemas = rawSpec.components?.schemas || {};

  // Ref resolution (and its cycle guard) lives in ./resolve-refs so it can be
  // tested against recursive fixtures without a spec file on disk.
  const resolveRefs = (obj: any): any => resolveRefsWithSchemas(obj, schemas);

  const endpoints: ParsedEndpoint[] = [];
  const paths = rawSpec.paths || {};

  Object.keys(paths).forEach((pathKey) => {
    const methods = paths[pathKey];
    Object.keys(methods).forEach((method) => {
      if (!OPERATION_METHODS.has(method)) return;
      const operation = methods[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return;

      // Skip internal endpoints from the public docs
      if (pathKey.includes('GetSyncStatus')) return;
      if (pathKey.includes('RegisterService') || pathKey.includes('RegisterEmail')) return;

      const servers = declaredServers(operation.servers) ?? declaredServers(methods.servers);

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
        ...(servers ? { servers } : {}),
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
    servers: Array.isArray(rawSpec.servers) && rawSpec.servers.length > 0
      ? rawSpec.servers
      : [{ url: FALLBACK_API_BASE_URL, description: 'Production' }],
    endpoints,
    groups,
    components: rawSpec.components || { schemas: {} },
  };
}

/**
 * The host published code samples should target.
 *
 * Taken from the generated document's `servers[0].url` so the docs and the spec
 * can never disagree, falling back to the public API host. Never the raw Cloud
 * Run origin: that bypasses Cloudflare (edge cache, WAF, rate limiting) and
 * changes on redeploy.
 */
export async function getApiBaseUrl(): Promise<string> {
  const spec = await parseOpenAPISpec();
  return spec.servers[0]?.url ?? FALLBACK_API_BASE_URL;
}

export async function getEndpoint(id: string): Promise<ParsedEndpoint | undefined> {
  const spec = await parseOpenAPISpec();
  return spec.endpoints.find((e) => e.id === id);
}

