/// <reference types="jest" />

import { fireEvent, render, screen } from "@testing-library/react";
import { HolderLogo, holderHost, holderMonogram, monogramInkClass } from "../holder-logo";
import { KIND_INFO, KIND_ORDER } from "~/@/lib/ownership/kinds";

describe("holder logo (spec 14.2)", () => {
  it("takes only the host of a registry website", () => {
    expect(holderHost("https://www.vanguard.com.au/path?q=1")).toBe("www.vanguard.com.au");
    expect(holderHost("ftp://example.com")).toBeNull();
    expect(holderHost("not a url")).toBeNull();
    expect(holderHost(null)).toBeNull();
  });

  it("draws the favicon with no referrer and lazily, in a fixed box", () => {
    const { container } = render(
      <HolderLogo name="Vanguard" kind="index_manager" website="https://vanguard.com.au" size={20} />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(
      "https://www.google.com/s2/favicons?sz=64&domain=vanguard.com.au",
    );
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img.parentElement!.style.width).toBe("20px");
  });

  it("falls back to a kind-tinted monogram when the icon fails", () => {
    const { container } = render(
      <HolderLogo name="Vanguard Investments" kind="index_manager" website="https://vanguard.com.au" />,
    );
    fireEvent.error(container.querySelector("img")!);
    const mono = container.querySelector('[data-holder-logo="monogram"]') as HTMLElement;
    expect(mono).toHaveTextContent("VI");
    expect(mono.style.width).toBe("20px");
  });

  it("draws the monogram with no website", () => {
    render(<HolderLogo name="Jane Smith" kind="unclassified" size={28} />);
    expect(screen.getByText("JS")).toBeInTheDocument();
  });

  it("builds at most two letters for a monogram", () => {
    expect(holderMonogram("Vanguard")).toBe("VA");
    expect(holderMonogram("Bank of New York Mellon")).toBe("BO");
    expect(holderMonogram("   ")).toBe("?");
  });

  it("draws a listed holder's company logo, with no favicon request, and the monogram behind it", () => {
    const { container } = render(
      <HolderLogo name="BHP Group" kind="corporate" holderKey="asx:BHP" website="https://bhp.com" size={28} />,
    );
    expect(container.querySelector('[data-stock-logo="normalized"]')).not.toBeNull();
    expect(container.querySelector('img[src*="google.com"]')).toBeNull();
  });

  it("never requests a favicon for a name: holder, even with a website", () => {
    const { container } = render(
      <HolderLogo name="Jane Smith" kind="unclassified" holderKey="name:jane smith" website="https://example.com" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-holder-logo="monogram"]')).toHaveTextContent("JS");
  });

  it("keeps the monogram's ink readable on every kind's swatch, in both themes", () => {
    const hex = (text: string) => /#([0-9A-Fa-f]{6})/.exec(text)?.[1] ?? "";
    const luminance = (h: string) => {
      const channel = (i: number) => {
        const c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const kind of KIND_ORDER) {
      const swatch = KIND_INFO[kind].swatch;
      const lightSwatch = hex(swatch);
      const darkPart = swatch.includes("dark:") ? swatch.slice(swatch.indexOf("dark:")) : swatch;
      const darkSwatch = hex(darkPart) || lightSwatch;
      const ink = monogramInkClass(kind);
      const lightInk = ink.includes("text-white") ? "FFFFFF" : hex(ink);
      const darkMatch = /dark:text-\[(#[0-9A-Fa-f]{6})\]/.exec(ink);
      const darkInk = darkMatch ? hex(darkMatch[1]!) : lightInk;
      expect(contrast(lightInk, lightSwatch)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(darkInk, darkSwatch)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
