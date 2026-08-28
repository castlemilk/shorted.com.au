/**
 * Published code samples must not point at a raw Cloud Run origin.
 *
 * They did. Every endpoint page, every client guide, and the "Try it" panel's
 * live browser requests were aimed at `shorts-uiekqxovma-km.a.run.app`, a
 * hardcoded fallback that ignored the spec's own `servers[0].url`. That URL
 * bypasses Cloudflare entirely — and with it the edge cache, the WAF and the
 * rate limiting — and it changes whenever the service is redeployed. Going
 * from 8 documented endpoints to 70 turned that from a small wart into ~72
 * copy-pasteable snippets teaching third parties and LLM agents to hammer the
 * unprotected origin.
 *
 * The published host is `api.shorted.com.au`. This test greps the source
 * rather than the rendered output so it fails at the moment someone reaches
 * for a `.a.run.app` literal, not months later in production traffic.
 *
 * Local dev env files (`web/.env*`) legitimately point at direct origins and
 * are deliberately out of scope — those are a different decision from a
 * published sample.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(process.cwd(), "src");

/** Surfaces whose output we publish as copy-pasteable examples. */
const PUBLISHED_SAMPLE_DIRS = [
  join(WEB_SRC, "@", "components", "docs"),
  join(WEB_SRC, "app", "docs"),
  join(WEB_SRC, "lib", "openapi"),
];

const CLOUD_RUN_HOST = /[a-z0-9-]+\.a\.run\.app/gi;

/**
 * Comments are stripped before matching. The modules that were fixed carry
 * comments naming the forbidden host to explain why it is forbidden, and a
 * test that punished writing that explanation down would push people to delete
 * the explanation rather than keep the fix.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFilesUnder(full));
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("published API code samples", () => {
  it("never hardcode a Cloud Run origin", () => {
    const offenders: string[] = [];

    for (const dir of PUBLISHED_SAMPLE_DIRS) {
      for (const file of sourceFilesUnder(dir)) {
        // This test names the host it forbids, so exempt itself.
        if (file.endsWith("published-samples-host.test.ts")) continue;

        const matches = stripComments(readFileSync(file, "utf8")).match(CLOUD_RUN_HOST);
        if (matches) {
          offenders.push(`${file.replace(WEB_SRC, "src")}: ${Array.from(new Set(matches)).join(", ")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
