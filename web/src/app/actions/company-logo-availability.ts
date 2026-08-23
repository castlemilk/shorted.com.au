"use server";

import { unstable_cache } from "next/cache";

import { normalizedLogoUrl } from "~/@/lib/logo";

const LOGO_BUCKET = "shorted-company-logos-prod";
const NORMALIZED_PREFIX = "logos-normalized/";
const LOGO_LIST_REVALIDATE_SECONDS = 60 * 60 * 24;

interface GcsObjectListResponse {
  items?: Array<{ name?: string }>;
  nextPageToken?: string;
}

function extractStockCodeFromObjectName(name: string): string | null {
  const match = /^logos-normalized\/([A-Z0-9.-]+)\.png$/u.exec(name);
  return match?.[1] ?? null;
}

async function fetchAvailableNormalizedLogoCodes(): Promise<string[]> {
  const codes = new Set<string>();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      prefix: NORMALIZED_PREFIX,
      fields: "items(name),nextPageToken",
      maxResults: "1000",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${LOGO_BUCKET}/o?${params.toString()}`,
      {
        next: { revalidate: LOGO_LIST_REVALIDATE_SECONDS },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Logo availability list returned HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as GcsObjectListResponse;
    for (const item of payload.items ?? []) {
      const code = item.name ? extractStockCodeFromObjectName(item.name) : null;
      if (code) {
        codes.add(code);
      }
    }
    pageToken = payload.nextPageToken;
  } while (pageToken);

  return [...codes];
}

const getAvailableNormalizedLogoCodes = unstable_cache(
  fetchAvailableNormalizedLogoCodes,
  ["company-logo-normalized-codes"],
  { revalidate: LOGO_LIST_REVALIDATE_SECONDS },
);

export async function getVerifiedCompanyLogoUrls(
  stockCodes: string[],
): Promise<Map<string, string>> {
  const requestedCodes = new Set(
    stockCodes
      .map((stockCode) => stockCode.trim().toUpperCase())
      .filter((stockCode) => stockCode.length > 0),
  );

  if (requestedCodes.size === 0) {
    return new Map();
  }

  try {
    const availableCodes = new Set(await getAvailableNormalizedLogoCodes());
    return new Map(
      [...requestedCodes]
        .filter((stockCode) => availableCodes.has(stockCode))
        .map((stockCode) => [stockCode, normalizedLogoUrl(stockCode)] as const),
    );
  } catch (error) {
    console.warn("Logo availability lookup failed:", error);
    return new Map();
  }
}
