import fs from "node:fs";
import path from "node:path";
import { editorialThumbnailUrl, NEWS_ART_THUMBNAILS } from "../editorial-art";

describe("reviewed newsroom image variants", () => {
  it("routes each reviewed header to its real separate thumbnail", () => {
    expect(Object.keys(NEWS_ART_THUMBNAILS)).toHaveLength(7);
    for (const [cover, thumbnail] of Object.entries(NEWS_ART_THUMBNAILS)) {
      expect(editorialThumbnailUrl(cover)).toBe(thumbnail);
      for (const url of [cover, thumbnail]) {
        expect(fs.existsSync(path.join(process.cwd(), "public", new URL(url).pathname))).toBe(true);
      }
    }
  });
  it("leaves external, unknown, relative and query-bearing artwork unchanged", () => {
    const known = Object.keys(NEWS_ART_THUMBNAILS)[0]!;
    for (const url of ["", "__proto__", "constructor", "toString", "https://publisher.example/image.png", "/assets/news/other.webp", `${known}?version=other`, known.replace("shorted.com.au", "other.example")]) {
      expect(editorialThumbnailUrl(url)).toBe(url);
    }
  });
});
