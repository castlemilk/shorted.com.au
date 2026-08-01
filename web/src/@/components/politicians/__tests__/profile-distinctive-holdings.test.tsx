/**
 * The "Declared by no other member" rail.
 *
 * The assertions that matter here are editorial and structural rather than
 * visual:
 *
 *   - the (company, holder) GRAIN. The rpc serves one row per pair on purpose,
 *     so a member declaring the same code for themselves and via a spouse must
 *     render ONE company with TWO badges — never two rows, and never one row
 *     that silently picks a holder and attributes a spouse's declaration to the
 *     member.
 *   - SILENCE IS THE EMPTY STATE. No sole-declared company renders no section.
 *     An empty frame under this heading is an absence claim about a named
 *     person, and the register cannot support one.
 *   - THE CAVEAT PAIRS WITH THE CHIPS THAT RENDER. A disclosure note under a
 *     section with no percentages caveats nothing; a percentage with no note is
 *     the thing the disclosure exists to prevent.
 *   - the vocabulary. "Distinctive", "unusual", "rare" and the rest characterise
 *     a named member's holdings; the count does not support them and the rules
 *     forbid them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";

import {
  DistinctiveHoldings,
  groupHoldingsByCompany,
} from "../profile/distinctive-holdings";
import { RegisterHolder } from "~/gen/shorts/v1alpha1/politicians_pb";

const holding = (
  stockCode: string,
  corpusDeclarerCount: number,
  overrides: Partial<{
    companyName: string;
    industry: string;
    holder: RegisterHolder;
    shortPercent: number;
  }> = {},
) => ({
  stockCode,
  companyName: overrides.companyName ?? `${stockCode} Limited`,
  industry: overrides.industry ?? "Materials",
  holder: overrides.holder ?? RegisterHolder.SELF,
  corpusDeclarerCount,
  shortPercent: overrides.shortPercent ?? 0,
});

describe("grouping (company, holder) rows", () => {
  it("collapses one company declared under two holders into one row with both", () => {
    const grouped = groupHoldingsByCompany([
      holding("BHP", 1, { holder: RegisterHolder.SELF }),
      holding("BHP", 1, { holder: RegisterHolder.SPOUSE_PARTNER }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.holders).toEqual([
      RegisterHolder.SELF,
      RegisterHolder.SPOUSE_PARTNER,
    ]);
  });

  it("orders by declarer count, then by code", () => {
    const grouped = groupHoldingsByCompany([
      holding("ZZZ", 3),
      holding("BBB", 1),
      holding("AAA", 1),
    ]);
    expect(grouped.map((row) => row.stockCode)).toEqual(["AAA", "BBB", "ZZZ"]);
  });

  it("keeps the company's short percentage and drops a row with no code", () => {
    const grouped = groupHoldingsByCompany([
      holding("CBA", 2, { shortPercent: 1.2 }),
      holding("CBA", 2, { holder: RegisterHolder.DEPENDENT_CHILDREN, shortPercent: 1.2 }),
      holding("", 1),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.shortPercent).toBe(1.2);
  });
});

describe("declared by no other member", () => {
  it("lists each sole-declared company once, linked to its stock page", () => {
    render(
      <DistinctiveHoldings
        holdings={[
          holding("VGN", 1, { companyName: "Vagabond Ltd", industry: "Software" }),
          holding("BHP", 1, { holder: RegisterHolder.SPOUSE_PARTNER }),
        ]}
      />,
    );
    const section = screen.getByRole("region", { name: "Declared by no other member" });
    expect(within(section).getByRole("link", { name: "VGN" })).toHaveAttribute(
      "href",
      "/shorts/VGN",
    );
    expect(within(section).getByText("Vagabond Ltd")).toBeInTheDocument();
    expect(within(section).getByText("Software")).toBeInTheDocument();
    // The holder of each declaration, from the frozen kit.
    expect(within(section).getByText("Self")).toBeInTheDocument();
    expect(within(section).getByText("Spouse/partner")).toBeInTheDocument();
  });

  it("renders one row with two badges for a code declared for self and a spouse", () => {
    render(
      <DistinctiveHoldings
        holdings={[
          holding("BHP", 1, { holder: RegisterHolder.SELF }),
          holding("BHP", 1, { holder: RegisterHolder.SPOUSE_PARTNER }),
        ]}
      />,
    );
    expect(screen.getAllByRole("link", { name: "BHP" })).toHaveLength(1);
    expect(screen.getByText("Self")).toBeInTheDocument();
    expect(screen.getByText("Spouse/partner")).toBeInTheDocument();
  });

  it("renders nothing at all when no company is declared by this member alone", () => {
    const { container } = render(
      <DistinctiveHoldings holdings={[holding("BHP", 12), holding("CBA", 4)]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty response, rather than an empty frame", () => {
    const { container } = render(<DistinctiveHoldings holdings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the section with exactly its visible heading", () => {
    render(<DistinctiveHoldings holdings={[holding("VGN", 1)]} />);
    const section = screen.getByRole("region", { name: "Declared by no other member" });
    expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Declared by no other member",
    );
  });
});

describe("the two-or-three-member long tail", () => {
  it("states each company's declarer count", () => {
    render(
      <DistinctiveHoldings holdings={[holding("VGN", 1), holding("CBA", 2), holding("RIO", 3)]} />,
    );
    expect(screen.getByText("Declared by two or three members")).toBeInTheDocument();
    expect(screen.getByText(/— declared by 2 members/)).toBeInTheDocument();
    expect(screen.getByText(/— declared by 3 members/)).toBeInTheDocument();
  });

  it("excludes counts of four and above from the tail entirely", () => {
    render(<DistinctiveHoldings holdings={[holding("VGN", 1), holding("WES", 9)]} />);
    expect(screen.queryByRole("link", { name: "WES" })).toBeNull();
  });

  it("says how many tail companies it is not showing", () => {
    const tail = Array.from({ length: 9 }, (_, i) =>
      holding(`T${String(i).padStart(2, "0")}`, 2),
    );
    render(<DistinctiveHoldings holdings={[holding("VGN", 1), ...tail]} />);
    // Six shown, three stated as hidden — never silently dropped.
    expect(screen.getByText(/^\+3 more$/)).toBeInTheDocument();
    expect(screen.getAllByText(/— declared by 2 members/)).toHaveLength(6);
  });

  it("reports the rpc's own cap overflow as a plain count, not as sole declarations", () => {
    const { container } = render(
      <DistinctiveHoldings holdings={[holding("VGN", 1)]} moreCount={4} />,
    );
    expect(screen.getByText(/4 further declared companies are not shown/)).toBeInTheDocument();
    // It must never be phrased as more companies declared by nobody else.
    expect(container.textContent).not.toMatch(/4 further.{0,40}no other member/i);
  });
});

describe("short-interest juxtaposition", () => {
  const NOTE =
    "Short interest is the company's own market-wide ASIC figure and says nothing about any member's holding.";

  it("shows the chip and the served caveat together", () => {
    const { container } = render(
      <DistinctiveHoldings
        holdings={[holding("VGN", 1, { shortPercent: 3.42 })]}
        disclosureNote={NOTE}
      />,
    );
    expect(screen.getByText("3.4% short interest")).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    // The chip is muted, never a warning colour.
    expect(container.innerHTML).not.toMatch(/text-red|text-amber|bg-red|text-destructive/);
  });

  it("shows no caveat when no row carries a percentage", () => {
    render(<DistinctiveHoldings holdings={[holding("VGN", 1)]} disclosureNote={NOTE} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.queryByText(/short interest/)).toBeNull();
  });

  it("shows no chip for a zero percentage", () => {
    render(
      <DistinctiveHoldings
        holdings={[holding("VGN", 1, { shortPercent: 0 })]}
        disclosureNote={NOTE}
      />,
    );
    expect(screen.queryByText(/short interest/)).toBeNull();
  });

  it("caveats a chip that appears only in the long tail", () => {
    render(
      <DistinctiveHoldings
        holdings={[holding("VGN", 1), holding("CBA", 2, { shortPercent: 2.5 })]}
        disclosureNote={NOTE}
      />,
    );
    expect(screen.getByText("2.5% short interest")).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("states no causation and no member-level claim", () => {
    const { container } = render(
      <DistinctiveHoldings
        holdings={[holding("VGN", 1, { shortPercent: 3.4 })]}
        disclosureNote={NOTE}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/coincid|because|after (?:the )?member|led to|as a result/i);
    expect(text).not.toMatch(/\$\s*\d/);
  });
});

describe("the vocabulary of this rail", () => {
  const SOURCE = readFileSync(
    join(__dirname, "..", "profile", "distinctive-holdings.tsx"),
    "utf8",
  );

  /** Prose only: the comments in this file explain the very words they name. */
  const prose = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never characterises the member's holdings", () => {
    // The rpc and the file are called "distinctive"; the COPY may not be. The
    // identifiers are checked separately below so a rename cannot hide behind
    // this rule.
    const banned =
      /(unusual|anomal\w*|rare(?:ly)?|red[- ]flag|suspicious|notable|outlier|watch(?:list)?|spike)/i;
    const match = prose.match(banned);
    expect(match?.[0] ?? null).toBeNull();
  });

  it("keeps the word 'distinctive' out of anything a reader sees", () => {
    // Every occurrence must be an identifier or an import path — never JSX text.
    const jsxText = prose.match(/>[^<>{}]*[A-Za-z][^<>{}]*</g) ?? [];
    for (const chunk of jsxText) {
      expect(chunk.toLowerCase()).not.toContain("distinctive");
    }
  });

  it("renders the count as members, never as a score or a percentile", () => {
    expect(prose).toContain("declared by {row.declarerCount} members");
    expect(prose).not.toMatch(/percentile|score|rank(?:ing)?\b/i);
  });
});
