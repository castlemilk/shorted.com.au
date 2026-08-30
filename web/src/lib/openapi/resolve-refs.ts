/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * Inline every `$ref` in an OpenAPI fragment against a schema dictionary.
 *
 * The docs pages render a fully expanded request/response shape, so refs are
 * substituted rather than followed at render time.
 *
 * CYCLE GUARD. The previous implementation carried a guard that never ran: it
 * checked `visited.has(obj)` but never called `visited.add(obj)`, so the set
 * stayed empty and there was no protection at all. It survived only because
 * the protobuf-derived schemas we generate today are acyclic; the first
 * self- or mutually-recursive message (any tree or nested-node shape) would
 * have stack-overflowed `next build` with nothing tying the failure back to
 * the proto change.
 *
 * The guard is keyed by **ref name along the current resolution path**, not by
 * object identity. Object identity misses the case where the same logical
 * schema is reached via two distinct decoded objects (each `{ ...resolved,
 * ...rest }` spread creates a fresh object, so identity would never match a
 * previously-seen node anyway). A name-keyed path set states the condition
 * exactly: "this ref is already being expanded somewhere above me".
 *
 * It is scoped to the path — the name is removed again on the way out — so a
 * schema referenced twice under one parent (a diamond, which is not a cycle)
 * still expands fully in both places. Only a genuine cycle is cut, and it is
 * cut by leaving the `$ref` node as-is: inert, still informative to a reader,
 * and JSON-serialisable.
 */
export function resolveRefs(
  obj: any,
  schemas: Record<string, any>,
  refPath: Set<string> = new Set<string>(),
): any {
  if (!obj || typeof obj !== 'object') return obj;

  if (obj.$ref) {
    const refName = String(obj.$ref).split('/').pop()!;
    const resolved = schemas[refName];
    if (resolved) {
      // Already expanding this ref higher up the path: cutting here is the
      // only way to terminate. Return the node untouched.
      if (refPath.has(refName)) return obj;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { $ref: _, ...rest } = obj;
      refPath.add(refName);
      try {
        return resolveRefs({ ...resolved, ...rest }, schemas, refPath);
      } finally {
        refPath.delete(refName);
      }
    }
    // Unresolvable ref: leave it as-is rather than silently dropping it.
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, schemas, refPath));
  }

  const newObj: any = {};
  Object.keys(obj).forEach((key) => {
    newObj[key] = resolveRefs(obj[key], schemas, refPath);
  });
  return newObj;
}
