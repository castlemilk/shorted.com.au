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
  initialsFor,
} from "../politician-avatar";

const FULL = {
  photoUrl: "https://upload.wikimedia.org/thumb/x/400px-x.jpg",
  photoLicence: "CC BY-SA 4.0",
  photoAuthor: "A Photographer",
  photoSourceUrl: "https://commons.wikimedia.org/wiki/File:x.jpg",
};

describe("politician avatar", () => {
  it("renders the portrait when it is fully attributable", () => {
    render(<PoliticianAvatar displayName="Susan Templeman" partyAb="ALP" photo={FULL} />);
    const img = screen.getByRole("img", { name: "Susan Templeman" });
    expect(img).toHaveAttribute("src", FULL.photoUrl);
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
