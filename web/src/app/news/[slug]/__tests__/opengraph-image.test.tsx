/**
 * @jest-environment node
 */

/**
 * A take's OG card fetches its stored hero or OG image from our servers to
 * draw the backdrop, and fetched whatever URL the row held. A stored URL could
 * point our server at any address (security review SEC-07), so only two kinds
 * are fetched: Cloud Storage, where the take-writer uploads its images, and the
 * static files under /assets/ on our own host, where a take imported from
 * content/news keeps its art (import-mdx.ts stores the frontmatter URL as
 * written, absolute or root-relative).
 */

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: unknown;
    constructor(element: unknown) {
      this.element = element;
    }
  },
}));

const getEditorialTake = jest.fn();
jest.mock("~/app/actions/getEditorialTake", () => ({
  getEditorialTake: (...args: unknown[]) => getEditorialTake(...args),
}));

import Image from "../opengraph-image";

const HERO = "https://storage.googleapis.com/shorted-news-images/takes/a-take-hero.png";

function take(images: { ogImageUrl?: string; heroImageUrl?: string }) {
  getEditorialTake.mockResolvedValue({
    take: {
      headline: "A take",
      stockCode: "BHP",
      sentiment: "neutral",
      citations: [],
      ogImageUrl: "",
      heroImageUrl: "",
      ...images,
    },
  });
}

/** Every img src in the rendered card. */
function imageSources(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => imageSources(child, found));
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as { type: unknown; props: { src?: unknown; children?: unknown } };
    if (element.type === "img" && typeof element.props.src === "string") found.push(element.props.src);
    imageSources(element.props.children, found);
  }
  return found;
}

async function renderCard() {
  const response = (await Image({ params: Promise.resolve({ slug: "a-take" }) })) as unknown as {
    element: unknown;
  };
  return response.element;
}

describe("the take OG card's backdrop", () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array(2048).buffer,
    } as unknown as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    getEditorialTake.mockReset();
  });

  it("fetches a Cloud Storage hero, refusing redirects, and draws it", async () => {
    take({ heroImageUrl: HERO });

    const card = await renderCard();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(HERO);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ redirect: "error" }));
    expect(imageSources(card).some((src) => src.startsWith("data:image/png;base64,"))).toBe(true);
  });

  // content/news frontmatter, as two takes there carry it.
  it.each([
    [
      "https://shorted.com.au/assets/news/tlx-bipass-fast-track-and-short-baseline/cover.png",
      "https://shorted.com.au/assets/news/tlx-bipass-fast-track-and-short-baseline/cover.png",
    ],
    [
      "/assets/news/droneshield-dro-short-interest/cover.png",
      "https://shorted.com.au/assets/news/droneshield-dro-short-interest/cover.png",
    ],
  ])("fetches a content/news take's art at %s, refusing redirects, and draws it", async (stored, fetched) => {
    take({ ogImageUrl: stored });

    const card = await renderCard();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(fetched);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ redirect: "error" }));
    expect(imageSources(card).some((src) => src.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["http://metadata.google.internal/computeMetadata/v1/"],
    ["https://10.0.0.5/internal.png"],
    ["https://evil.example/hero.png"],
    ["https://shorted.com.au/api/internal/admin-check"],
    ["/api/internal/admin-check"],
    ["https://shorted.com.au/assets/../api/internal/admin-check"],
  ])("never fetches %s, and draws no backdrop", async (url) => {
    take({ ogImageUrl: url, heroImageUrl: HERO });

    await renderCard();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
