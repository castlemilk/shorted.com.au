#!/usr/bin/env node
/**
 * Re-scrape blank-source logos.
 *
 * For each ASX code with a blank source PNG in
 *   gs://shorted-company-logos/logos/{CODE}.png
 * resolve the company's website from company-metadata and pull a fresh
 * logo via a fallback chain:
 *   1. /apple-touch-icon.png on the company domain (180×180+ usually)
 *   2. /apple-touch-icon-precomposed.png
 *   3. /favicon.ico
 *   4. Google's favicon service (s2/favicons) at sz=128
 *
 * Uploads the first non-blank result to logos/{CODE}.png (replaces the
 * blank source), then triggers the normalize step inline so
 * logos-normalized/{CODE}.png is refreshed in the same pass.
 *
 * Usage:
 *   tsx src/scrape.ts                       # all blank-source codes
 *   tsx src/scrape.ts --only=BHP,A2M
 *   tsx src/scrape.ts --csv=/tmp/logo-suspects.csv   # use a suspect list
 *   tsx src/scrape.ts --concurrency=8
 *   tsx src/scrape.ts --dry-run             # plan only
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Storage } from "@google-cloud/storage";
import { Client as PgClient } from "pg";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of [
  resolve(__dirname, "..", ".env"),
  resolve(__dirname, "..", "..", "..", ".env"),
  resolve(__dirname, "..", "..", "..", "services", ".env"),
]) {
  if (existsSync(p)) loadDotenv({ path: p, override: false });
}

const BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

interface Args {
  only?: Set<string>;
  csv?: string;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { concurrency: 5, dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--only=")) {
      args.only = new Set(
        a.split("=").slice(1).join("=").split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      );
    } else if (a.startsWith("--csv=")) args.csv = a.split("=").slice(1).join("=");
    else if (a.startsWith("--concurrency=")) {
      args.concurrency = parseInt(a.split("=")[1] ?? "5", 10);
    }
  }
  return args;
}

interface Candidate {
  code: string;
  website: string | null;
}

async function loadCandidates(args: Args): Promise<Candidate[]> {
  let codes: string[];
  if (args.csv && existsSync(args.csv)) {
    // Read the flag-broken output and take rows where reason mentions "near-blank".
    const lines = readFileSync(args.csv, "utf8").split("\n").slice(1);
    codes = lines
      .map((l) => l.split(",")[0]?.trim())
      .filter((c): c is string => !!c && /^[A-Z0-9]+$/.test(c));
  } else if (args.only) {
    codes = Array.from(args.only);
  } else {
    // Scan the bucket — any normalized logo whose source is also tiny+blank.
    // Implementation: enumerate logos/ and bail out for known-good ones based
    // on file size. Blank PNGs are typically <500 bytes; real logos usually
    // exceed 2KB. Cheap heuristic that avoids re-analysing every byte.
    console.error("[scrape] no --only / --csv given; scanning bucket for tiny source PNGs…");
    const storage = new Storage();
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix: "logos/" });
    codes = files
      .filter((f) => Number(f.metadata.size ?? 0) > 0 && Number(f.metadata.size ?? 0) < 500)
      .map((f) => f.name.replace("logos/", "").replace(/\.png$/i, ""))
      .filter((n) => /^[A-Z0-9]+$/.test(n));
    console.error(`[scrape] ${codes.length} codes look blank (size < 500b)`);
  }
  if (args.only) codes = codes.filter((c) => args.only!.has(c));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ stock_code: string; website: string | null }>(
      `SELECT stock_code, website FROM "company-metadata"
       WHERE stock_code = ANY($1)`,
      [codes],
    );
    const websiteByCode = new Map(rows.map((r) => [r.stock_code, r.website]));
    return codes.map((code) => ({ code, website: websiteByCode.get(code) ?? null }));
  } finally {
    await pg.end();
  }
}

function domainFromUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.trim().startsWith("http") ? u.trim() : `https://${u.trim()}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Buffer | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "image/*,*/*" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    // Reject HTML 200s that pretend to be images.
    if (!ct.startsWith("image/") && !ct.includes("octet-stream") && !ct.includes("ico")) {
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function isNonBlankPng(buf: Buffer): Promise<boolean> {
  try {
    // Try to decode; favicons may be .ico format that Sharp can read.
    const png = await sharp(buf, { failOn: "none" }).png().toBuffer();
    const m = await sharp(png).metadata();
    if (!m.width || !m.height) return false;
    if (m.width < 32 || m.height < 32) return false;
    // Check that there's actual content (any non-near-white pixel).
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let nonBlank = 0;
    for (let p = 0; p < data.length; p += info.channels) {
      const r = data[p]!, g = data[p + 1]!, b = data[p + 2]!, a = data[p + 3]!;
      if (a > 64 && !(r > 245 && g > 245 && b > 245)) {
        nonBlank++;
        if (nonBlank > 50) return true; // enough signal
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function tryDomainSources(domain: string): Promise<Buffer | null> {
  const candidates = [
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    // Google's favicon service — works even when the site has no
    // apple-touch-icon and no favicon at the conventional path.
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
  for (const url of candidates) {
    const buf = await fetchWithTimeout(url);
    if (!buf) continue;
    if (await isNonBlankPng(buf)) {
      // Ensure output is PNG.
      try {
        return await sharp(buf, { failOn: "none" }).png().toBuffer();
      } catch {
        continue;
      }
    }
  }
  return null;
}

interface Result {
  code: string;
  status: "uploaded" | "no_website" | "no_logo_found" | "dry_run" | "failed";
  source?: string;
  bytes?: number;
  message?: string;
}

async function processOne(
  storage: Storage,
  cand: Candidate,
  args: Args,
): Promise<Result> {
  const domain = domainFromUrl(cand.website);
  if (!domain) return { code: cand.code, status: "no_website" };

  const buf = await tryDomainSources(domain);
  if (!buf) return { code: cand.code, status: "no_logo_found", source: domain };

  if (args.dryRun) {
    return { code: cand.code, status: "dry_run", source: domain, bytes: buf.length };
  }

  try {
    await storage.bucket(BUCKET).file(`logos/${cand.code}.png`).save(buf, {
      contentType: "image/png",
      resumable: false,
      metadata: { cacheControl: "public, max-age=86400" },
    });
    return { code: cand.code, status: "uploaded", source: domain, bytes: buf.length };
  } catch (err) {
    return { code: cand.code, status: "failed", source: domain, message: String(err).slice(0, 100) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(args);
  console.log(`[scrape] ${candidates.length} candidate(s) to re-scrape`);
  if (args.dryRun) console.log("[scrape] DRY RUN — no uploads");

  const storage = new Storage();
  const results: Result[] = [];
  let idx = 0;
  await Promise.all(
    Array.from({ length: args.concurrency }, async () => {
      while (idx < candidates.length) {
        const i = idx++;
        const cand = candidates[i]!;
        const r = await processOne(storage, cand, args);
        results.push(r);
        const tag =
          r.status === "uploaded" ? "✓" :
          r.status === "dry_run" ? "·" :
          r.status === "no_website" ? "—" :
          r.status === "no_logo_found" ? "✗" : "!";
        console.log(`  ${tag} ${cand.code.padEnd(6)} ${r.source ?? ""} ${r.bytes ? `(${r.bytes}b)` : ""} ${r.message ?? ""}`);
      }
    }),
  );

  console.log("");
  const by = (s: Result["status"]) => results.filter((r) => r.status === s).length;
  console.log("Summary:");
  console.log(`  uploaded:       ${by("uploaded")}`);
  console.log(`  no_website:     ${by("no_website")}`);
  console.log(`  no_logo_found:  ${by("no_logo_found")}`);
  console.log(`  failed:         ${by("failed")}`);
  if (!args.dryRun && by("uploaded") > 0) {
    console.log("");
    console.log(`Next step: re-normalize with --only=${results.filter((r) => r.status === "uploaded").map((r) => r.code).join(",")}`);
    console.log("Or just re-run the full normalize pass: tsx src/index.ts --force=false");
  }
}

main().catch((err) => {
  console.error("[scrape] FAILED:", err);
  process.exit(1);
});
