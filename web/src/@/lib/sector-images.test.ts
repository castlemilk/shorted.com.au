import fs from "node:fs";
import path from "node:path";

import {
  getKnownIndustries,
  getSectorImagePath,
  getSectorImagePathPng,
} from "./sector-images";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function publicFilePath(publicPath: string): string {
  return path.join(PUBLIC_DIR, publicPath.replace(/^\//, ""));
}

function sectorAssetDir(): string {
  return path.dirname(publicFilePath(getSectorImagePathPng("other")));
}

function readPngSize(filePath: string): { width: number; height: number } {
  const buffer = fs.readFileSync(filePath);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readWebpSize(filePath: string): { width: number; height: number } {
  const buffer = fs.readFileSync(filePath);
  const chunk = buffer.toString("ascii", 12, 16);

  if (chunk !== "VP8X") {
    throw new Error(`Unsupported WebP chunk ${chunk} in ${filePath}`);
  }

  return {
    width: 1 + buffer.readUIntLE(24, 3),
    height: 1 + buffer.readUIntLE(27, 3),
  };
}

describe("sector image assets", () => {
  const aliasIndustries = [
    "mining",
    "healthcare",
    "retail",
    "technology",
    "property",
    "telecom",
    "industrials",
    "food & bev",
    "class pend",
    "not applic",
    "not applicable",
    "",
  ];

  it("resolves every known industry and alias to existing PNG and WebP files", () => {
    const industries = [...getKnownIndustries(), ...aliasIndustries];

    for (const industry of industries) {
      const pngPath = publicFilePath(getSectorImagePathPng(industry));
      const webpPath = publicFilePath(getSectorImagePath(industry));

      expect(fs.existsSync(pngPath)).toBe(true);
      expect(fs.existsSync(webpPath)).toBe(true);
    }
  });

  it("keeps every sector source image at 256x256 with a matching WebP variant", () => {
    const sectorDir = sectorAssetDir();
    const pngFiles = fs
      .readdirSync(sectorDir)
      .filter((name) => name.endsWith(".png"))
      .sort();

    expect(pngFiles.length).toBeGreaterThan(0);

    for (const pngFile of pngFiles) {
      const pngPath = path.join(sectorDir, pngFile);
      const webpPath = path.join(sectorDir, pngFile.replace(/\.png$/, ".webp"));

      expect(readPngSize(pngPath)).toEqual({ width: 256, height: 256 });
      expect(fs.existsSync(webpPath)).toBe(true);
      expect(readWebpSize(webpPath)).toEqual({ width: 256, height: 256 });
    }
  });
});
