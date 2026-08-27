#!/usr/bin/env node
// Renders web/public/openapi.json into a JS-free markdown reference at
// web/public/docs/api-markdown.md. An agent fetching /docs/api gets a React shell;
// this is what it can actually read.
//
// Regenerate with `npm run docs:api-markdown` (from web/) after `make openapi`.
//
// NAMING: the artifact is public/docs/api-markdown.md, NOT public/docs/api.md.
// It is served at /docs/api.md by src/app/docs/api.md/route.ts, and Next.js
// hard-errors ("conflicting public file and page file") if a public file sits
// at the same path as a route. The route is what carries the markdown
// Content-Type, cache and Link/X-LLM-Friendly headers, so the file moves, not
// the URL.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const spec = JSON.parse(
  readFileSync(path.join(root, "public/openapi.json"), "utf8"),
);

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

const defaultBaseUrl = spec.servers?.[0]?.url ?? "";

/** Resolve a local $ref against the spec, returning undefined if unresolvable. */
function deref(schema) {
  let node = schema;
  const seen = new Set();
  while (node && typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    if (!node.$ref.startsWith("#/")) return undefined;
    node = node.$ref
      .slice(2)
      .split("/")
      .reduce((acc, part) => acc?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  }
  return node;
}

/** Short, human-readable type label for a schema node. */
function typeLabel(schema) {
  if (!schema) return "unknown";
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop();
    const resolved = deref(schema);
    // Well-known wrappers read better as their scalar meaning.
    if (name === "google.protobuf.Timestamp") return "string (RFC 3339 timestamp)";
    if (resolved?.enum) return `enum (${resolved.enum.join(" \\| ")})`;
    return `object (${name})`;
  }
  if (schema.enum) return `enum (${schema.enum.join(" \\| ")})`;
  if (schema.type === "array") {
    return `array of ${typeLabel(schema.items)}`;
  }
  if (schema.format) return `${schema.type} (${schema.format})`;
  return schema.type ?? "unknown";
}

function escapeCell(text) {
  return String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** Sorted [name, schema] entries for a request-body schema, or []. */
function bodyFields(op) {
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  const resolved = deref(bodySchema);
  if (!resolved?.properties) return { fields: [], required: [] };
  return {
    fields: Object.entries(resolved.properties).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    required: Array.isArray(resolved.required) ? resolved.required : [],
  };
}

/**
 * Build a request-body example.
 *
 * The generated spec is protobuf-derived, and proto3 has no required fields —
 * NOT ONE of the 68 request schemas declares a `required` array. Inventing
 * plausible values would document requests we have not verified, so when there
 * is nothing declared-required to fill in we emit `{}` (every Connect method
 * accepts it) and list the accepted fields in a table instead.
 */
function requestBodyExample(op) {
  const { fields, required } = bodyFields(op);
  if (required.length === 0) return "{}";
  const obj = {};
  for (const name of required) {
    const schema = fields.find(([f]) => f === name)?.[1];
    obj[name] = placeholderFor(schema, name);
  }
  return JSON.stringify(obj);
}

function placeholderFor(schema, name) {
  const resolved = deref(schema) ?? schema ?? {};
  if (resolved.enum?.length) return resolved.enum[0];
  switch (resolved.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${name}>`;
  }
}

/** Query/path parameters declared on an operation (header params excluded). */
function visibleParams(item, op) {
  return [...(item.parameters ?? []), ...(op.parameters ?? [])].filter(
    (p) => p.in === "query" || p.in === "path",
  );
}

function baseUrlFor(item, op) {
  return op.servers?.[0]?.url ?? item.servers?.[0]?.url ?? defaultBaseUrl;
}

const lines = [];
lines.push(`# ${spec.info.title}`, "");
if (spec.info.description) lines.push(spec.info.description.trim(), "");
if (spec.info.version) lines.push(`Version \`${spec.info.version}\`.`, "");
if (spec.info.license?.name) {
  lines.push(
    spec.info.license.url
      ? `Licence: [${spec.info.license.name}](${spec.info.license.url}).`
      : `Licence: ${spec.info.license.name}.`,
    "",
  );
}
lines.push(
  "This file is the JS-free twin of the HTML API reference at",
  "https://shorted.com.au/docs/api. The machine-readable source is",
  "https://shorted.com.au/openapi.json — this document is generated from it.",
  "",
);

lines.push("## Base URL", "");
lines.push("```");
lines.push(defaultBaseUrl);
lines.push("```", "");
lines.push(
  "Most endpoints are Connect-RPC methods on the API host above. A few endpoints",
  "live on the web app instead; those state their own base URL below.",
  "",
);

// ---- Rate limits -----------------------------------------------------------
// Source of truth: DefaultConfig in services/pkg/ratelimit/config.go.
// API and BROWSER limits are different columns of the same tier and must never
// be conflated: paid BROWSER access is unlimited, paid API access is not.
lines.push("## Rate limits", "");
lines.push(
  "Every tier has two independent budgets: **API** (programmatic, via an API",
  "token) and **browser** (the web app, via Firebase auth). They are different",
  "numbers — a paid *browser* session is unlimited, a paid *API* key is not.",
  "",
);
lines.push("| Tier | API per minute | API per month | Browser per minute | Browser per month |");
lines.push("| --- | --- | --- | --- | --- |");
lines.push("| anonymous | 30 | 500 | 60 | 5,000 |");
lines.push("| free | 60 | 1,000 | 120 | 10,000 |");
lines.push("| pro / premium (paid) | 120 | 10,000 | unlimited | unlimited |");
lines.push("| enterprise | 300 | 50,000 | unlimited | unlimited |");
lines.push("");
lines.push(
  "Per-minute limits are enforced in process, per API instance; monthly quotas",
  "are accounted centrally. An unlimited window emits no `X-RateLimit-*` headers",
  "for that window at all (a limit of `0` would read as \"zero requests allowed\").",
  "",
);
lines.push(
  "Successful responses carry `X-RateLimit-Limit` / `-Remaining` / `-Reset` and",
  "the `X-RateLimit-Monthly-*` equivalents. A 429 from the API carries",
  "`X-RateLimit-Detail`: compact JSON naming which limit fired (`kind`), the",
  "ceiling, consumption, `reset_at`, `retry_after_seconds`, `tier`, `access`",
  "(`api` or `browser`) and an absolute `upgrade_url`. A 429 from the CDN edge",
  "has no `X-RateLimit-Detail` — branch on its presence to tell the two apart.",
  "",
);

// ---- Endpoints -------------------------------------------------------------
lines.push("## Endpoints", "");

const byTag = new Map();
let operationCount = 0;
for (const [route, item] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const op = item[method];
    if (!op) continue;
    operationCount += 1;
    const tag = (op.tags ?? ["Other"])[0];
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ route, method, item, op });
  }
}

for (const [tag, entries] of [...byTag.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  lines.push(`### ${tag}`, "");
  entries.sort(
    (a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
  );
  for (const { route, method, item, op } of entries) {
    const verb = method.toUpperCase();
    const baseUrl = baseUrlFor(item, op);
    lines.push(`#### \`${verb} ${route}\``, "");
    // Connect-generated summaries are just the method name, which the heading
    // already carries — don't repeat it.
    const summary = op.summary?.trim();
    if (summary && summary !== route.split("/").pop()) lines.push(summary, "");
    if (op.description && op.description.trim() !== summary) {
      lines.push(op.description.trim(), "");
    }
    if (baseUrl !== defaultBaseUrl) {
      lines.push(`Base URL: \`${baseUrl}\` (not the API host).`, "");
    }

    const params = visibleParams(item, op);
    if (params.length > 0) {
      lines.push("| Parameter | In | Required | Type | Description |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const p of params) {
        lines.push(
          `| \`${p.name}\` | ${p.in} | ${p.required ? "yes" : "no"} | ${escapeCell(
            typeLabel(p.schema),
          )} | ${escapeCell(p.description)} |`,
        );
      }
      lines.push("");
    }

    const hasBody = Boolean(op.requestBody);
    if (hasBody) {
      const { fields, required } = bodyFields(op);
      if (fields.length > 0) {
        lines.push("Request body fields:", "");
        lines.push("| Field | Type | Required | Description |");
        lines.push("| --- | --- | --- | --- |");
        for (const [name, schema] of fields) {
          lines.push(
            `| \`${name}\` | ${escapeCell(typeLabel(schema))} | ${
              required.includes(name) ? "yes" : "no"
            } | ${escapeCell(schema.description)} |`,
          );
        }
        lines.push("");
      } else {
        lines.push("Request body: an empty JSON object, `{}`.", "");
      }
    }

    lines.push("```bash");
    if (hasBody) {
      lines.push(`curl -X ${verb} '${baseUrl}${route}' \\`);
      lines.push("  -H 'Content-Type: application/json' \\");
      lines.push("  -H 'Connect-Protocol-Version: 1' \\");
      lines.push(`  -d '${requestBodyExample(op)}'`);
    } else {
      const query = params
        .filter((p) => p.in === "query" && p.required)
        .map((p) => `${p.name}=VALUE`)
        .join("&");
      const suffix = query ? `?${query}` : "";
      lines.push(
        verb === "GET"
          ? `curl '${baseUrl}${route}${suffix}'`
          : `curl -X ${verb} '${baseUrl}${route}${suffix}'`,
      );
    }
    lines.push("```", "");
  }
}

lines.push("## Model Context Protocol", "");
lines.push(
  "A hosted MCP server exposes this data to MCP-capable clients over streamable",
  "HTTP at `https://shorted.com.au/api/mcp/mcp`. Point an MCP client at that URL;",
  "no separate install step is required.",
  "",
);

const outDir = path.join(root, "public/docs");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "api-markdown.md"), `${lines.join("\n").trimEnd()}\n`);
console.log(
  `wrote public/docs/api-markdown.md (${operationCount} endpoints across ${Object.keys(spec.paths).length} paths)`,
);
