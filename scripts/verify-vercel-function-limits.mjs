import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_LIMITS = {
  'api/about/statistics': 15,
  'api/about/warm-cache': 15,
  'api/homepage/warm-cache': 15,
  'api/static-pages/warm-cache': 120,
  'api/pages/warm-cache': 300,
};

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
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const verified = await verifyFunctionLimits(resolve(process.argv[2] ?? '.vercel/output'));
    console.log(JSON.stringify({ verifiedFunctionLimits: verified }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
