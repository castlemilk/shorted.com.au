/// <reference types="jest" />

import React from "react";
import { render } from "@testing-library/react";
import Avatar from "../avatar";

describe("Avatar", () => {
  // `fill` + `sizes` made next/image list every configured width: 16
  // candidates up to 3840w for a 36px circle.
  it("emits a 1x/2x srcset at its fixed size", () => {
    const { container } = render(
      <Avatar
        name="Ada Lovelace"
        picture="https://lh3.googleusercontent.com/a/photo"
        size={36}
      />,
    );
    const img = container.querySelector("img")!;

    expect(img).not.toHaveAttribute("sizes");
    const candidates = (img.getAttribute("srcset") ?? "").split(", ");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/&w=48&q=75 1x$/);
    expect(candidates[1]).toMatch(/&w=96&q=75 2x$/);
    expect(img).toHaveAttribute("width", "36");
    expect(img).toHaveAttribute("height", "36");
    expect(img).toHaveAttribute("alt", "Ada Lovelace");
    // Still fills the circle and crops a non-square photo.
    expect(img).toHaveClass("h-full", "w-full", "object-cover");
  });
});
