import { describe, expect, it } from '@jest/globals';
import { summarizePublicSurface } from '../public-surface';
import type { ParsedEndpoint } from '../types';

const endpoint = (path: string): ParsedEndpoint => ({
  id: path,
  method: 'POST',
  path,
  tags: ['default'],
  parameters: [],
  responses: {},
});

describe('summarizePublicSurface', () => {
  // The /docs/api page used to carry a hand-written list that said
  // "Private: GetStockData, MintToken". GetStockData is annotated
  // VISIBILITY_PUBLIC in the proto and answers anonymously in production; the
  // middleware enforces the proto, not the prose. An integrator spent real
  // effort minting a token to reach an endpoint that was already open to them
  // (issue #536). Deriving the summary from the generated spec — which
  // openapi-postprocess prunes to exactly the VISIBILITY_PUBLIC set — makes
  // that drift impossible rather than merely corrected.
  it('treats every documented endpoint as public, because the spec is the public set', () => {
    const summary = summarizePublicSurface([
      endpoint('/shorts.v1alpha1.StockService/GetStockData'),
      endpoint('/shorts.v1alpha1.StockService/GetStock'),
      endpoint('/shorts.v1alpha1.SearchService/SearchStocks'),
    ]);

    expect(summary.publicCount).toBe(3);
    expect(summary.examples).toContain('GetStockData');
  });

  it('never reports a documented method as private', () => {
    const summary = summarizePublicSurface([
      endpoint('/shorts.v1alpha1.StockService/GetStockData'),
    ]);
    expect(summary.examples).not.toHaveLength(0);
    // There is no "private" list to get wrong: private methods are absent from
    // the spec entirely, so they cannot be enumerated here.
    expect(summary).not.toHaveProperty('privateExamples');
  });

  it('derives method names from the Connect path, not from a hardcoded table', () => {
    const summary = summarizePublicSurface([
      endpoint('/shorts.v1alpha1.MarketService/GetTopShorts'),
      endpoint('/shorts.v1alpha1.MarketService/GetAvailableDates'),
    ]);
    expect(summary.examples).toEqual(
      expect.arrayContaining(['GetAvailableDates', 'GetTopShorts']),
    );
  });

  it('de-duplicates methods documented under more than one path', () => {
    const summary = summarizePublicSurface([
      endpoint('/shorts.v1alpha1.MarketService/GetTopShorts'),
      endpoint('/shorts.v1alpha1.ShortedStocksService/GetTopShorts'),
    ]);
    expect(summary.publicCount).toBe(1);
    expect(summary.examples).toEqual(['GetTopShorts']);
  });

  it('survives an empty spec without claiming anything', () => {
    const summary = summarizePublicSurface([]);
    expect(summary.publicCount).toBe(0);
    expect(summary.examples).toEqual([]);
  });
});
