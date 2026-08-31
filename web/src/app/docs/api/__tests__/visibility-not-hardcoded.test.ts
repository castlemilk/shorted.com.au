import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const pageSource = fs.readFileSync(
  path.join(process.cwd(), 'src/app/docs/api/page.tsx'),
  'utf8',
);

/**
 * Comments are stripped before asserting, because these tests police what the
 * page *claims to a reader*, not what it records about its own history. The
 * comment explaining issue #536 necessarily quotes the wrong claim it replaced.
 */
const renderedSource = pageSource
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * The API reference must not restate, by hand, which methods are public.
 *
 * It used to: "Private: GetStockData, MintToken". GetStockData is annotated
 * VISIBILITY_PUBLIC in the proto and answers anonymously in production — the
 * auth middleware enforces the annotation, not the page — so an integrator
 * built a token-minting flow for an endpoint that was already open to them
 * (issue #536). The generated spec is pruned to exactly the public set, so the
 * page has a correct source available to it and no reason to keep its own.
 */
describe('/docs/api visibility claims', () => {
  it('does not hardcode a public/private method list', () => {
    expect(renderedSource).not.toMatch(/<li>\s*Private:/);
    expect(renderedSource).not.toMatch(/<li>\s*Public:/);
  });

  it('does not name any concrete method as private', () => {
    const privateClaim =
      /Get[A-Z]\w*[^\n]*\bprivate\b|\bprivate\b[^\n]*Get[A-Z]\w*/i;
    const offending = renderedSource
      .split('\n')
      .filter((line) => privateClaim.test(line));
    expect(offending).toEqual([]);
  });

  it('derives the surface summary from the parsed spec', () => {
    expect(renderedSource).toContain('summarizePublicSurface(spec.endpoints)');
  });
});

/**
 * And the generated artifact must actually contain GetStockData, since that is
 * the fact the page now depends on.
 */
describe('generated openapi spec', () => {
  const specPath = path.join(process.cwd(), 'public', 'openapi.json');

  it('publishes GetStockData as a public endpoint', () => {
    if (!fs.existsSync(specPath)) {
      // The spec is a build artifact; skip rather than fail in a bare checkout.
      return;
    }
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const hasGetStockData = Object.keys(spec.paths).some((p) =>
      p.endsWith('/GetStockData'),
    );
    expect(hasGetStockData).toBe(true);
  });

  it('does not publish MintToken', () => {
    if (!fs.existsSync(specPath)) return;
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const hasMintToken = Object.keys(spec.paths).some((p) =>
      p.endsWith('/MintToken'),
    );
    expect(hasMintToken).toBe(false);
  });
});
