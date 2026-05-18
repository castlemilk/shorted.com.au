// GCS upload helper.
//
// Uploads generated PNGs to gs://shorted-company-logos/takes/{slug}-{type}.png
// and returns the public HTTPS URL. The bucket is shared with company-logo
// storage; takes/ prefix keeps editorial assets separate.
//
// Auth: prefers GOOGLE_APPLICATION_CREDENTIALS (path to service-account
// JSON). Falls back to ADC (gcloud auth application-default login).

import { Storage } from "@google-cloud/storage";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
const TAKES_PREFIX = "takes";

// Service-account JSON files committed under services/ from earlier dev
// setup. Used when GOOGLE_APPLICATION_CREDENTIALS isn't explicitly set.
const SA_JSON_CANDIDATES = [
  "services/shorted-dev-aba5688f-4a322ff163b9.json",
  "services/shorted-dev-aba5688f-05053ea36fe7.json",
];

function resolveCredentials(): Storage {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit && existsSync(explicit)) {
    return new Storage({ keyFilename: explicit });
  }
  // Search repo-root for a SA JSON if env isn't set.
  for (const rel of SA_JSON_CANDIDATES) {
    const abs = resolve(process.cwd(), "..", "..", rel);
    if (existsSync(abs)) {
      return new Storage({ keyFilename: abs });
    }
    const abs2 = resolve(process.cwd(), rel);
    if (existsSync(abs2)) {
      return new Storage({ keyFilename: abs2 });
    }
  }
  // Fall through to ADC.
  return new Storage();
}

export type AssetType = "hero" | "thumbnail" | "inline";

export interface UploadInput {
  filePath?: string;
  buffer?: Buffer;
  slug: string;
  type: AssetType;
  inlineIndex?: number; // for inline-N
  bucket?: string;
  cacheMaxAge?: number; // seconds
}

export interface UploadResult {
  bucket: string;
  objectPath: string;
  publicUrl: string;
  bytes: number;
}

function objectNameFor(input: UploadInput): string {
  const safeSlug = input.slug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  if (input.type === "inline") {
    const i = input.inlineIndex ?? 0;
    return `${TAKES_PREFIX}/${safeSlug}-inline-${i}.png`;
  }
  return `${TAKES_PREFIX}/${safeSlug}-${input.type}.png`;
}

export async function uploadPng(input: UploadInput): Promise<UploadResult> {
  const storage = resolveCredentials();
  const bucketName = input.bucket ?? DEFAULT_BUCKET;
  const bucket = storage.bucket(bucketName);

  const data = input.buffer ?? (input.filePath ? readFileSync(input.filePath) : null);
  if (!data) {
    throw new Error("uploadPng: provide --file or buffer");
  }

  const objectPath = objectNameFor(input);
  const maxAge = input.cacheMaxAge ?? 86400; // 1 day default

  const file = bucket.file(objectPath);
  await file.save(data, {
    contentType: "image/png",
    resumable: false,
    metadata: {
      cacheControl: `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });

  return {
    bucket: bucketName,
    objectPath,
    publicUrl: `https://storage.googleapis.com/${bucketName}/${objectPath}`,
    bytes: data.length,
  };
}
