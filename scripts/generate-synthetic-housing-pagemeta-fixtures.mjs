#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePaths = {
  rea: [
    "services/house-price-collector/testdata/rea-pagemeta.html",
    "services/jobs/internal/jobs/houseprices/testdata/rea-pagemeta.html",
  ],
  domain: [
    "services/house-price-collector/testdata/domain-pagemeta.html",
    "services/jobs/internal/jobs/houseprices/testdata/domain-pagemeta.html",
  ],
};

function parseRoot(argv) {
  if (argv.length === 0) {
    return defaultRoot;
  }
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }
  throw new Error("usage: node scripts/generate-synthetic-housing-pagemeta-fixtures.mjs [--root <path>]");
}

function reaFixture() {
  const savedSearchQuery = {
    channel: "synthetic-housing",
    page: 1,
    pageSize: 20,
    localities: [{ searchLocation: "Synthetic Suburb, ZZ 0000" }],
    filters: { surroundingSuburbs: true },
  };
  const searchData = {
    buySearch: {
      results: {
        totalResultsCount: 47,
        listings_total: 7,
        pagination: { moreResultsAvailable: true, maxPageNumberAvailable: 5, page: 1 },
        exact: { items: [] },
        surrounding: { items: [] },
      },
      resolvedQuery: {
        metadata: { savedSearchQuery: JSON.stringify(savedSearchQuery) },
      },
    },
  };
  const cache = {
    syntheticQuery: { hasNext: false, data: JSON.stringify(searchData) },
  };
  const assignment = {
    syntheticHousing: {
      fixtureProvenance: "synthetic",
      sourceUrl: "https://housing.example.test/search/synthetic-suburb",
      urqlClientCache: JSON.stringify(cache),
    },
  };
  return `<html><body><script>window.SyntheticHousingPageMeta = ${JSON.stringify(assignment)};</script></body></html>\n`;
}

function domainFixture() {
  const bootstrap = {
    fixtureProvenance: "synthetic",
    props: {
      pageProps: {
        componentProps: {
          sourceUrl: "https://housing.example.test/search/synthetic-suburb",
          currentPage: 1,
          totalPages: 3,
          totalListings: 61,
          initialSurroundingSuburbs: true,
          pageViewMetadata: {
            searchRequest: {
              page: 1,
              pageSize: 20,
              locations: [{
                suburb: "Synthetic Suburb",
                postCode: "0000",
                includeSurroundingSuburbs: true,
                state: "ZZ",
              }],
            },
            searchResponse: {
              SearchResults: {
                results: [],
                totalResults: 61,
                totalPages: 3,
                page: 1,
                actualTotalResults: 61,
                actualTotalResultsExceedsMaximum: false,
              },
            },
          },
        },
      },
    },
  };
  return `<html><body><script id="__SYNTHETIC_DOMAIN_PAGE_META__" type="application/json">${JSON.stringify(bootstrap)}</script></body></html>\n`;
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const contents = { rea: reaFixture(), domain: domainFixture() };

  for (const [kind, paths] of Object.entries(fixturePaths)) {
    for (const path of paths) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents[kind], "utf8");
      console.log(path);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
