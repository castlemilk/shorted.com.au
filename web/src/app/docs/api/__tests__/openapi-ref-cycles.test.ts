/**
 * `$ref` resolution must survive a recursive schema.
 *
 * `resolveRefs` inlines every `$ref` in the generated OpenAPI document so the
 * docs pages can render a fully expanded request/response shape. It used to
 * carry a cycle guard that never worked: it checked `visited.has(obj)` but
 * never called `visited.add(obj)`, so the set stayed empty forever.
 *
 * Nothing broke, purely by luck — the 265 protobuf-derived schemas we generate
 * today happen to be acyclic. The first proto that introduces a self- or
 * mutually-recursive message (any tree or nested-node shape) would blow the
 * stack during `next build`, with nothing in the failure pointing back at the
 * proto that caused it.
 *
 * These tests pin the guard with genuinely cyclic fixtures. They must fail
 * (stack overflow / hang) against the unguarded implementation.
 */
import { resolveRefs } from "~/lib/openapi/resolve-refs";

describe("resolveRefs cycle handling", () => {
  it("terminates on a mutually recursive pair (A -> B -> A)", () => {
    const schemas = {
      A: {
        type: "object",
        properties: { b: { $ref: "#/components/schemas/B" } },
      },
      B: {
        type: "object",
        properties: { a: { $ref: "#/components/schemas/A" } },
      },
    };

    let result: unknown;
    expect(() => {
      result = resolveRefs({ $ref: "#/components/schemas/A" }, schemas);
    }).not.toThrow();

    // The outer levels still expand; the cycle resolves to something inert
    // rather than recursing, so the value is finite and JSON-serialisable.
    expect(() => JSON.stringify(result)).not.toThrow();
    const json = JSON.stringify(result);
    expect(json).toContain('"type":"object"');
    // The point where the cycle closes keeps its unexpanded $ref marker.
    expect(json).toContain("#/components/schemas/A");
  });

  it("terminates on a self-referential schema (a tree node)", () => {
    const schemas = {
      Node: {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    };

    let result: any;
    expect(() => {
      result = resolveRefs({ $ref: "#/components/schemas/Node" }, schemas);
    }).not.toThrow();

    expect(result.type).toBe("object");
    expect(result.properties.name).toEqual({ type: "string" });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("still fully expands a diamond that is not a cycle", () => {
    // The guard is scoped to the CURRENT resolution path, not to every ref
    // ever seen — otherwise a schema legitimately referenced twice under one
    // parent would render expanded once and stubbed once.
    const schemas = {
      Leaf: { type: "string", description: "leaf" },
      Mid: {
        type: "object",
        properties: { leaf: { $ref: "#/components/schemas/Leaf" } },
      },
      Top: {
        type: "object",
        properties: {
          left: { $ref: "#/components/schemas/Mid" },
          right: { $ref: "#/components/schemas/Mid" },
        },
      },
    };

    const result = resolveRefs({ $ref: "#/components/schemas/Top" }, schemas);

    expect(result.properties.left.properties.leaf).toEqual({
      type: "string",
      description: "leaf",
    });
    expect(result.properties.right.properties.leaf).toEqual({
      type: "string",
      description: "leaf",
    });
  });

  it("leaves an unresolvable $ref untouched", () => {
    const result = resolveRefs({ $ref: "#/components/schemas/Missing" }, {});
    expect(result).toEqual({ $ref: "#/components/schemas/Missing" });
  });

  it("preserves sibling keys that override the resolved schema", () => {
    const schemas = { Thing: { type: "object", description: "base" } };
    const result = resolveRefs(
      { $ref: "#/components/schemas/Thing", description: "override" },
      schemas,
    );
    expect(result).toEqual({ type: "object", description: "override" });
  });
});
