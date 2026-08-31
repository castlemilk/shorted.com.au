import type { ParsedEndpoint } from './types';

export interface PublicSurfaceSummary {
  /** Distinct methods documented in this reference. All of them are public. */
  publicCount: number;
  /** Method names, sorted, for illustrating the surface in prose. */
  examples: string[];
}

/**
 * Summarises the public API surface from the generated OpenAPI document.
 *
 * There is deliberately no "private" half to this. `openapi-postprocess`
 * prunes every path whose proto method is not annotated VISIBILITY_PUBLIC
 * (services/cmd/openapi-postprocess, using services/pkg/protovisibility — the
 * same source the auth middleware enforces), so the spec this reads *is* the
 * public set. A private method cannot appear here, and so cannot be listed
 * wrongly.
 *
 * The page previously stated "Private: GetStockData, MintToken" as hand-written
 * prose. GetStockData is VISIBILITY_PUBLIC and answers anonymously in
 * production, so an integrator built a token-minting flow to reach an endpoint
 * that was already open to them, and only found out by trying it (issue #536).
 * Prose that restates a generated fact will drift from it; deriving it cannot.
 */
export function summarizePublicSurface(
  endpoints: ParsedEndpoint[],
): PublicSurfaceSummary {
  const methods = new Set<string>();

  for (const endpoint of endpoints) {
    // Connect paths are "/<fully.qualified.Service>/<Method>".
    const method = endpoint.path.split('/').filter(Boolean).pop();
    if (method) methods.add(method);
  }

  const examples = [...methods].sort((a, b) => a.localeCompare(b));

  return { publicCount: methods.size, examples };
}
