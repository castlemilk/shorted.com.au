import type { NavigationGroup, ParsedEndpoint } from '~/lib/openapi/types';

/*
 * What the docs header and sidebar render of an endpoint, and nothing more.
 *
 * Both are client components, so their props are serialized into the RSC
 * payload of every /docs/api page. The layout used to pass the parsed spec
 * itself: every endpoint's resolved parameters, request body and response
 * schemas, twice over (the endpoint list, then again inside the groups). That
 * was 1.5 MB of JSON on each page of 1.85 to 1.96 MB (SEO review 2026-10-21,
 * F07). The endpoint page passes its one endpoint in full where it needs it.
 */

/** What the sidebar renders of an endpoint. */
export type ApiNavEndpoint = Pick<ParsedEndpoint, 'id' | 'method' | 'path' | 'summary'>;

/** The ⌘K search also matches on an endpoint's description. */
export type ApiSearchEndpoint = ApiNavEndpoint & Pick<ParsedEndpoint, 'description'>;

export interface ApiNavGroup {
  title: string;
  endpoints: ApiNavEndpoint[];
}

export function toApiNavEndpoint({ id, method, path, summary }: ParsedEndpoint): ApiNavEndpoint {
  return { id, method, path, summary };
}

export function toApiSearchEndpoint(endpoint: ParsedEndpoint): ApiSearchEndpoint {
  return { ...toApiNavEndpoint(endpoint), description: endpoint.description };
}

export function toApiNavGroups(groups: NavigationGroup[]): ApiNavGroup[] {
  return groups.map(({ title, endpoints }) => ({
    title,
    endpoints: endpoints.map(toApiNavEndpoint),
  }));
}
