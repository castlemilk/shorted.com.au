import React from "react";
import { render, screen, within } from "@testing-library/react";
import {
  CitationPill,
  CitationSources,
  prettySource,
  preprocessCitationMarkers,
  resolveCitation,
  type TakeCitation,
} from "../citations";

const CITATIONS: TakeCitation[] = [
  {
    refId: "ref-1",
    url: "https://stockhead.com.au/article",
    source: "stockhead",
    headline: "Lithium shorts pile up",
    date: "2026-06-01",
    type: "news",
  },
  {
    refId: "report-2",
    url: "https://example.com/half-year",
    source: "half_year_results",
    headline: "H1 FY26 results",
    date: "2026-02-20",
    type: "report",
  },
];

describe("preprocessCitationMarkers", () => {
  it("replaces [ref-N] and [report-N] markers with <Cite /> elements", () => {
    expect(preprocessCitationMarkers("Shorts rose 2pp [ref-1] before results [report-2].")).toBe(
      'Shorts rose 2pp <Cite refId="ref-1" /> before results <Cite refId="report-2" />.',
    );
  });

  it("replaces multiple markers in the same paragraph", () => {
    expect(preprocessCitationMarkers("[ref-1][ref-2] and [ref-10]")).toBe(
      '<Cite refId="ref-1" /><Cite refId="ref-2" /> and <Cite refId="ref-10" />',
    );
  });

  it("leaves unknown bracket text untouched", () => {
    const src = "An array [1, 2] and [foo-1] and [ref-] stay as-is.";
    expect(preprocessCitationMarkers(src)).toBe(src);
  });

  it("does not rewrite markers inside fenced code blocks", () => {
    const src = "Before [ref-1]\n\n```\ncode [ref-2] stays\n```\n\nAfter [ref-1]";
    expect(preprocessCitationMarkers(src)).toBe(
      'Before <Cite refId="ref-1" />\n\n```\ncode [ref-2] stays\n```\n\nAfter <Cite refId="ref-1" />',
    );
  });

  it("does not rewrite markers inside inline code spans", () => {
    expect(preprocessCitationMarkers("Use `[ref-1]` markers [ref-1]")).toBe(
      'Use `[ref-1]` markers <Cite refId="ref-1" />',
    );
  });
});

describe("resolveCitation", () => {
  it("maps a refId to its citation and display index", () => {
    const resolved = resolveCitation("ref-1", CITATIONS);
    expect(resolved).not.toBeNull();
    expect(resolved!.citation.headline).toBe("Lithium shorts pile up");
    expect(resolved!.displayIndex).toBe(1);
    expect(resolved!.isReport).toBe(false);
    expect(resolved!.label).toBe("1");
  });

  it("flags report citations and prefixes the label with R", () => {
    const resolved = resolveCitation("report-2", CITATIONS);
    expect(resolved!.isReport).toBe(true);
    expect(resolved!.label).toBe("R2");
    expect(resolved!.displayIndex).toBe(2);
  });

  it("returns null for unknown or malformed ids", () => {
    expect(resolveCitation("ref-99", CITATIONS)).toBeNull();
    expect(resolveCitation("banana", CITATIONS)).toBeNull();
  });
});

describe("CitationPill", () => {
  it("renders a numbered anchor linking to the source entry", () => {
    render(<CitationPill refId="ref-1" citation={CITATIONS[0]} />);
    const pill = screen.getByRole("link", { name: /^Source 1: Stockhead/ });
    expect(pill).toHaveTextContent("1");
    expect(pill).toHaveAttribute("href", "#ref-1");
    expect(pill.className).toContain("text-primary");
  });

  it("renders report pills amber with an R label", () => {
    render(<CitationPill refId="report-2" citation={CITATIONS[1]} />);
    const pill = screen.getByRole("link", { name: /^Source R2: Half-year results/ });
    expect(pill).toHaveTextContent("R2");
    expect(pill).toHaveAttribute("href", "#report-2");
    expect(pill.className).toContain("text-amber-300");
  });

  it("falls back to literal marker text when the citation is missing", () => {
    render(<CitationPill refId="ref-9" citation={undefined} />);
    expect(screen.getByText("[ref-9]")).toBeInTheDocument();
  });
});

describe("citation source identity and matching badges", () => {
  it.each([
    ["ref-3", "report", "ASIC", "R3", "ASIC"],
    ["ref-4", "report", "FDA", "R4", "FDA"],
    ["ref-5", "report", "SEC / Telix Form 6-K", "R5", "SEC / Telix Form 6-K"],
    ["ref-6", "report", "Shorted (ASIC-derived republication)", "R6", "Shorted (ASIC-derived republication)"],
    ["report-7", "news", "quarterly_report", "R7", "Quarterly report"],
    ["ref-8", "news", "stockhead", "8", "Stockhead"],
    ["ref-9", "news", "DroneShield", "9", "DroneShield"],
    ["ref-10", "data", "ASIC", "10", "ASIC"],
    ["ref-11", "trade", "ASX", "11", "ASX"],
    ["ref-12", "other", "  Company filing  ", "12", "Company filing"],
  ])("keeps %s (%s) labelled, accessible and linked to its source", (refId, type, source, label, sourceLabel) => {
    const citation: TakeCitation = {
      refId, type, source,
      url: "https://example.com/primary-source",
      headline: "Primary source document",
      date: "2026-09-28",
    };
    render(<><CitationPill refId={refId} citation={citation} /><CitationSources citations={[citation]} /></>);
    const pill = screen.getByRole("link", { name: `Source ${label}: ${sourceLabel} (2026-09-28) [${type}]` });
    expect(pill).toHaveTextContent(label);
    expect(pill).toHaveAttribute("href", `#${refId}`);
    expect(pill).toHaveAttribute("title", `${sourceLabel} (2026-09-28) [${type}]`);
    const entry = document.getElementById(refId)!;
    expect(entry).toBeInTheDocument();
    expect(entry.firstElementChild).toHaveTextContent(label);
    expect(within(entry).getByText(sourceLabel)).toBeInTheDocument();
    expect(within(entry).getByRole("link", { name: citation.headline })).toHaveAttribute("href", citation.url);
    expect(screen.queryByText("Financial report")).not.toBeInTheDocument();
    expect(resolveCitation(refId, [citation])!.label).toBe(label);
  });

  it("preserves known financial-report names and uses neutral empty-source fallbacks", () => {
    expect(prettySource("annual_results", true)).toBe("Annual report");
    expect(prettySource("half_year_results", true)).toBe("Half-year results");
    expect(prettySource("quarterly_report", true)).toBe("Quarterly report");
    expect(prettySource("  ", true)).toBe("Report");
    expect(prettySource("", false)).toBe("Source");
  });

  it("keeps unresolved/malformed citation fallbacks visible without inventing a link", () => {
    render(<CitationPill refId="bad-id" citation={CITATIONS[0]} />);
    expect(screen.getByText("[bad-id]")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(resolveCitation("bad-id", [{ ...CITATIONS[0]!, refId: "bad-id" }])).toBeNull();
  });
});
