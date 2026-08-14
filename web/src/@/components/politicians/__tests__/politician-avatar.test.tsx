/**
 * The avatar's rules are licence obligations, not preferences.
 *
 * Every portrait is a Wikimedia Commons file under CC BY / CC BY-SA / CC0 /
 * public domain. The BY family permits publication only WITH the credit and a
 * link to the terms — so rendering the image while dropping either is the one
 * thing the licence does not allow. That makes "refuse to render what we cannot
 * attribute" a correctness property worth pinning, not a nicety.
 *
 * The fallback matters for the same editorial reasons as everything else here:
 * roughly one member in four has no freely-licensed portrait, and what we show
 * for them must not imply anything about the person.
 */

import { render, screen } from "@testing-library/react";

import {
  PoliticianAvatar,
  PortraitCredit,
  commonsThumb,
  initialsFor,
} from "../politician-avatar";

const FULL = {
  photoUrl:
    "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Ged_Kearney_2022.jpg/500px-Ged_Kearney_2022.jpg",
  photoLicence: "CC BY-SA 4.0",
  photoAuthor: "A Photographer",
  photoSourceUrl: "https://commons.wikimedia.org/wiki/File:x.jpg",
};

describe("politician avatar", () => {
  it("renders the portrait when it is fully attributable", () => {
    render(<PoliticianAvatar displayName="Susan Templeman" partyAb="ALP" photo={FULL} />);
    // RE-PINNED 2026-08-02. This used to assert the src was the stored URL
    // byte-for-byte, which pinned the very thing that was wrong: 3,411 KB of
    // full-size Commons originals rendered into 32 px boxes. The property that
    // actually matters is that the portrait we render is THE ATTRIBUTED FILE —
    // the same Commons file, at a size this box can use — so the assertion is
    // now about the file identity, not about the exact bytes of the URL.
    const img = screen.getByRole("img", { name: "Susan Templeman" });
    const src = img.getAttribute("src") ?? "";
    expect(decodeURIComponent(src)).toContain("Ged_Kearney_2022.jpg");
    // …and never the 500 px variant the ingest happened to store.
    expect(decodeURIComponent(src)).not.toContain("500px-");
  });

  it("asks Commons for a thumbnail rather than the stored original", () => {
    render(
      <PoliticianAvatar
        displayName="Jim Chalmers"
        partyAb="ALP"
        size="sm"
        photo={{
          ...FULL,
          photoUrl:
            "https://upload.wikimedia.org/wikipedia/commons/9/9c/Jim_Chalmers_2020.jpg",
        }}
      />,
    );
    const src = decodeURIComponent(
      screen.getByRole("img", { name: "Jim Chalmers" }).getAttribute("src") ?? "",
    );
    // 97 of the 241 portraits in the corpus are raw originals with no /thumb/
    // segment at all — the worst of them was 212 KB into a 48 px box. Those must
    // get a thumbnail path too, not just the ones already thumbnailed.
    expect(src).toContain("/thumb/");
    expect(src).toContain("px-Jim_Chalmers_2020.jpg");
  });

  it.each([
    ["no licence", { ...FULL, photoLicence: "" }],
    ["no source link", { ...FULL, photoSourceUrl: "" }],
  ])("refuses to render a portrait with %s", (_label, photo) => {
    const { container } = render(
      <PoliticianAvatar displayName="Susan Templeman" partyAb="ALP" photo={photo} />,
    );
    // Publishing a CC BY-SA image without its credit is a breach, so the
    // monogram is shown instead of the image.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("ST")).toBeInTheDocument();
  });

  it("falls back to a monogram that names the person, not a blank silhouette", () => {
    render(<PoliticianAvatar displayName="Llew O'Brien" partyAb="LNP" />);
    // A generic silhouette reads as "person unknown" about someone we have
    // named. The monogram carries who and which party.
    const el = screen.getByRole("img", { name: /Llew O'Brien.*no portrait available/ });
    expect(el).toHaveTextContent("LO");
  });

  it("never substitutes another person's photograph", () => {
    const { container } = render(<PoliticianAvatar displayName="Nobody Known" />);
    expect(container.querySelector("img")).toBeNull();
  });

  describe("initials", () => {
    it.each([
      ["Julie-Ann Campbell", "JC"],
      ["Llew O'Brien", "LO"],
      ["Anne Aly", "AA"],
      ["Cher", "C"],
      // Hyphens and apostrophes are common in this corpus and a naive split
      // turns them into junk.
      ["Máire Ní Bhriain", "MB"],
    ])("%s -> %s", (name, want) => {
      expect(initialsFor(name)).toBe(want);
    });

    it("does not throw on an empty name", () => {
      expect(initialsFor("")).toBe("?");
    });
  });

  /**
   * The thumbnail rule is a pure function of the URL, so it is pinned directly.
   * A wrong guess here 404s a portrait we have permission to publish, which is
   * why the last two cases matter as much as the first three: anything the rule
   * does not recognise must come back UNCHANGED, never mangled.
   */
  describe("commonsThumb", () => {
    it.each([
      [
        "inserts /thumb/ and the px- leaf for a raw original",
        "https://upload.wikimedia.org/wikipedia/commons/9/9c/Jim_Chalmers_2020.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Jim_Chalmers_2020.jpg/250px-Jim_Chalmers_2020.jpg",
      ],
      [
        "re-sizes an existing thumb in place",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Ged_Kearney_2022.jpg/500px-Ged_Kearney_2022.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Ged_Kearney_2022.jpg/250px-Ged_Kearney_2022.jpg",
      ],
      [
        "keeps percent-encoding in the file name intact",
        "https://upload.wikimedia.org/wikipedia/commons/e/e7/Phillip_Thompson_%28cropped%29.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Phillip_Thompson_%28cropped%29.jpg/250px-Phillip_Thompson_%28cropped%29.jpg",
      ],
      [
        "renders a vector original as a raster thumb",
        "https://upload.wikimedia.org/wikipedia/commons/a/ab/Some_Crest.svg",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Some_Crest.svg/250px-Some_Crest.svg.png",
      ],
      [
        "leaves a host it does not understand alone",
        "https://example.org/portrait.jpg",
        "https://example.org/portrait.jpg",
      ],
      [
        "leaves an unrecognised Wikimedia path alone rather than guessing",
        "https://upload.wikimedia.org/some/other/shape.jpg",
        "https://upload.wikimedia.org/some/other/shape.jpg",
      ],
      ["survives a value that is not a URL at all", "not a url", "not a url"],
    ])("%s", (_label, input, want) => {
      expect(commonsThumb(input, 250)).toBe(want);
    });

    /*
     * THE BUCKET RULE, PINNED, because breaking it does not make portraits
     * bigger — it makes them GONE. Wikimedia serves thumbnails only at its
     * configured widths and answers anything else with HTTP 400 plus an HTML
     * error page, which is also fatal through the Next optimizer. Probed
     * against upload.wikimedia.org on 2026-08-02: 120/250/330/500/960/1280/1920
     * answer 200; 256, 320, 384, 400 and 512 answer 400.
     */
    it.each([
      [1, 120],
      [64, 120],
      [120, 120],
      [121, 250],
      [192, 250],
      [250, 250],
      [400, 500],
      [99_999, 1920],
    ])("snaps a requested %ipx up to the %ipx bucket Commons serves", (want, bucket) => {
      const url = commonsThumb(
        "https://upload.wikimedia.org/wikipedia/commons/9/9c/Jim_Chalmers_2020.jpg",
        want,
      );
      expect(url).toContain(`/${bucket}px-Jim_Chalmers_2020.jpg`);
    });

    it.each([
      ["sm", 32, 120],
      ["md", 48, 120],
      ["lg", 96, 250],
    ])(
      "renders a %s avatar from the %ipx box at the %ipx bucket",
      (size, _px, bucket) => {
        render(
          <PoliticianAvatar
            displayName="Susan Templeman"
            size={size as "sm" | "md" | "lg"}
            photo={FULL}
          />,
        );
        const src = decodeURIComponent(
          screen.getByRole("img", { name: "Susan Templeman" }).getAttribute("src") ?? "",
        );
        expect(src).toContain(`/${bucket}px-`);
      },
    );
  });
});

describe("portrait credit", () => {
  it("names the licence, the author and links the source", () => {
    render(<PortraitCredit photo={FULL} />);
    expect(screen.getByText(/CC BY-SA 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/A Photographer/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Wikimedia Commons/ })).toHaveAttribute(
      "href",
      FULL.photoSourceUrl,
    );
  });

  it("says the portrait is not a Parliament image", () => {
    render(<PortraitCredit photo={FULL} />);
    // Readers on a register-of-interests page will assume an official portrait
    // unless told otherwise, and we deliberately do not use those.
    expect(screen.getByText(/Not a Parliament of Australia image/i)).toBeInTheDocument();
  });

  it("renders nothing when there is no portrait", () => {
    const { container } = render(<PortraitCredit photo={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
