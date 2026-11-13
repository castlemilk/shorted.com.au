import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Each build, including a retry of the same commit, needs a fresh identity.
export function newDeploymentIdentity() {
  return `shorted-${randomBytes(12).toString("hex")}`;
}

export function bindDeploymentIdentity(config, nextManifest, expected) {
  if (typeof expected !== "string" || !/^shorted-[a-f0-9]{24}$/.test(expected)) {
    throw new Error("The build needs a valid, unique NEXT_DEPLOYMENT_ID.");
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.version !== 3) {
    throw new Error("Vercel's build output must have a version 3 configuration.");
  }
  if (nextManifest?.config?.deploymentId !== expected) {
    throw new Error("The Next.js build does not contain the expected deployment ID.");
  }
  if (config?.deploymentId != null && config.deploymentId !== expected) {
    throw new Error("Vercel's build output contains a different deployment ID.");
  }
  return { ...config, deploymentId: expected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "new") {
      console.log(newDeploymentIdentity());
    } else if (process.argv[2] === "bind" && process.argv[3] && process.argv[4]) {
      const configPath = resolve(process.argv[3], "config.json");
      const nextPath = resolve(process.argv[4], "required-server-files.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const nextManifest = JSON.parse(readFileSync(nextPath, "utf8"));
      const bound = bindDeploymentIdentity(config, nextManifest, process.env.NEXT_DEPLOYMENT_ID);
      // Next 15.5 doesn't put deploymentId in routes-manifest.json, so the
      // prebuilt adapter cannot copy it. Build Output API accepts it directly.
      const temporaryPath = `${configPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(bound, null, 2)}\n`);
      renameSync(temporaryPath, configPath);
      console.log("Vercel output is bound to the verified Next.js deployment ID.");
    } else {
      throw new Error("Usage: node scripts/vercel-deployment-identity.mjs new | bind <output-directory> <next-directory>");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
