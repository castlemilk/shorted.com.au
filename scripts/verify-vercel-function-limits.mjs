import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_LIMITS = {
  'api/about/statistics': 15,
  'api/about/warm-cache': 15,
  'api/homepage/warm-cache': 15,
  'api/static-pages/warm-cache': 120,
  'api/pages/warm-cache': 300,
  'opengraph-image': 15,
  'industry/[slug]/twitter-image': 15,
  'price-drops': 60,
  'price-drops.rsc': 60,
};

async function* builtFunctions(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.endsWith('.func')) yield relative.slice(0, -5);
    else if (entry.isDirectory()) yield* builtFunctions(join(directory, entry.name), relative);
  }
}

// Inspect the artifact that --prebuilt actually uploads. Source JSON alone
// cannot establish which limits survived the Next builder's grouping/overrides.
export async function verifyFunctionLimits(outputDirectory) {
  const verified = [];
  for (const [route, expected] of Object.entries(EXPECTED_LIMITS)) {
    let file;
    for (const name of [route, `app/${route}`]) {
      const candidate = join(outputDirectory, 'functions', `${name}.func`, '.vc-config.json');
      try { await stat(candidate); file = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!file) throw new Error(`Missing built function metadata for /${route}`);
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (!/^nodejs/.test(config.runtime ?? '') || config.maxDuration !== expected) {
      throw new Error(`/${route}: expected Node.js maxDuration ${expected}s, got ${config.runtime ?? 'missing runtime'} / ${config.maxDuration ?? 'unset'}s`);
    }
    // Do not emit the raw config: function env/bindings stay private.
    verified.push({ route: `/${route}`, runtime: config.runtime, maxDuration: config.maxDuration });
  }
  // Next generates metadata handlers with no matching source /route file.
  // Their literal source exports must survive into every generated artifact,
  // including dynamic routes and the builder's .rsc aliases.
  for await (const route of builtFunctions(join(outputDirectory, 'functions'))) {
    if (!/(^|\/)(opengraph-image|twitter-image)(\.rsc)?$/.test(route) || EXPECTED_LIMITS[route]) continue;
    const config = JSON.parse(await readFile(join(outputDirectory, 'functions', `${route}.func`, '.vc-config.json'), 'utf8'));
    if (!/^nodejs/.test(config.runtime ?? '') || config.maxDuration !== 15) {
      throw new Error(`/${route}: expected Node.js maxDuration 15s, got ${config.runtime ?? 'missing runtime'} / ${config.maxDuration ?? 'unset'}s`);
    }
    verified.push({ route: `/${route}`, runtime: config.runtime, maxDuration: config.maxDuration });
  }
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const verified = await verifyFunctionLimits(resolve(process.argv[2] ?? '.vercel/output'));
    console.log(JSON.stringify({
      verifiedFunctionLimits: verified.filter(({ route }) => EXPECTED_LIMITS[route.slice(1)]),
      verifiedImageFunctionCount: verified.filter(({ route }) => /\/(opengraph-image|twitter-image)(\.rsc)?$/.test(route)).length,
    }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
