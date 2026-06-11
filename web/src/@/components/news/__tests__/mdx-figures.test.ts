import {
  injectLayoutFigures,
  type LayoutImageLike,
} from "../mdx-figures";

const SOURCE = [
  "Block zero opens the article.",
  "Block one continues the argument.",
  "Block two adds evidence.",
  "Block three wraps up.",
].join("\n\n");

describe("injectLayoutFigures", () => {
  it("injects figures at their anchors in order with stable indices", () => {
    const images: LayoutImageLike[] = [
      {
        url: "https://storage.googleapis.com/x/a.png",
        placement: "right",
        anchorAfterBlock: 0,
        caption: "First image",
      },
      {
        url: "https://storage.googleapis.com/x/b.png",
        placement: "full",
        anchorAfterBlock: 2,
        caption: "Second image",
      },
    ];

    const out = injectLayoutFigures(SOURCE, images);
    const blocks = out.split(/\n\n+/);

    // 4 original blocks + 2 figures
    expect(blocks).toHaveLength(6);
    // First figure directly after block 0; original block 1 follows.
    expect(blocks[1]).toBe(
      '<Figure src="https://storage.googleapis.com/x/a.png" placement="right" caption="First image" credit="AI-generated illustration" />',
    );
    expect(blocks[2]).toBe("Block one continues the argument.");
    // Second figure after original block 2 (anchor refers to ORIGINAL block
    // indices — the earlier insertion must not shift it).
    expect(blocks[3]).toBe("Block two adds evidence.");
    expect(blocks[4]).toContain('src="https://storage.googleapis.com/x/b.png"');
    expect(blocks[4]).toContain('placement="full"');
    expect(blocks[5]).toBe("Block three wraps up.");
  });

  it("clamps out-of-range anchors to the last block", () => {
    const out = injectLayoutFigures(SOURCE, [
      { url: "https://x/a.png", anchorAfterBlock: 99 },
    ]);
    const blocks = out.split(/\n\n+/);
    expect(blocks[blocks.length - 1]).toContain('<Figure src="https://x/a.png"');
  });

  it("is a no-op when the source already contains a <Figure", () => {
    const authored = `${SOURCE}\n\n<Figure src="https://x/writer.png" placement="full" />`;
    const out = injectLayoutFigures(authored, [
      { url: "https://x/a.png", anchorAfterBlock: 1 },
    ]);
    expect(out).toBe(authored);
  });

  it("skips hero-role images and images without a url", () => {
    const out = injectLayoutFigures(SOURCE, [
      { url: "https://x/hero.png", role: "hero", anchorAfterBlock: 0 },
      { url: "", anchorAfterBlock: 1 },
      { anchorAfterBlock: 2 },
    ]);
    expect(out).toBe(SOURCE);
    expect(out).not.toContain("<Figure");
  });

  it("sanitises captions: double quotes become apostrophes, whitespace collapses", () => {
    const out = injectLayoutFigures(SOURCE, [
      {
        url: "https://x/a.png",
        anchorAfterBlock: 0,
        caption: 'The "smart money"\n  is   short',
      },
    ]);
    expect(out).toContain(`caption="The 'smart money' is short"`);
    expect(out).not.toContain('caption="The "');
  });

  it("defaults placement to full and omits empty captions", () => {
    const out = injectLayoutFigures(SOURCE, [
      { url: "https://x/a.png", anchorAfterBlock: 0, caption: "   " },
    ]);
    expect(out).toContain('placement="full"');
    expect(out).not.toContain("caption=");
  });

  it("returns the source unchanged when there are no images", () => {
    expect(injectLayoutFigures(SOURCE, [])).toBe(SOURCE);
  });
});
