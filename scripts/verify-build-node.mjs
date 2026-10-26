import { pathToFileURL } from 'node:url';

export const requiredBuildNode = '24.22.1';
export function assertBuildNode(version) {
  if (version !== `v${requiredBuildNode}`) {
    throw new Error(`Use Node ${requiredBuildNode} for this build; found ${version}.`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertBuildNode(process.version);
    console.info(JSON.stringify({ type: 'build_runtime_identity', node: process.version, openssl: process.versions.openssl }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
