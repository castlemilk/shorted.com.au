/// <reference types="jest" />

import { render, screen } from "@testing-library/react";

import { METHOD_PARAGRAPHS } from "../../ownership-parts";
import { MethodDisclosure, leadSentence } from "../method-disclosure";

const FUND_LINE = "A fund's position at a date is its newest file on or before that date.";

describe("MethodDisclosure", () => {
  it("is closed by default, under the one line 'How these figures are read'", () => {
    const { container } = render(<MethodDisclosure />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveAttribute("id", "method");
    expect(details).toHaveClass("scroll-mt-20");
    const summary = screen.getByText("How these figures are read");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary).toHaveClass("cursor-pointer", "text-primary");
  });

  it("keeps every shared paragraph in the HTML, so a closed disclosure still carries the full method", () => {
    const { container } = render(<MethodDisclosure />);
    expect(METHOD_PARAGRAPHS).toHaveLength(3);
    for (const paragraph of METHOD_PARAGRAPHS) {
      expect(container.textContent).toContain(paragraph);
    }
    expect(container.querySelectorAll("details > div > p")).toHaveLength(METHOD_PARAGRAPHS.length);
  });

  it("draws the page's own paragraphs first, then the shared ones", () => {
    const { container } = render(
      <MethodDisclosure
        extra={[
          <p key="fund">{FUND_LINE}</p>,
          <p key="notice">A notice&apos;s change is its present less its previous voting power.</p>,
        ]}
      />,
    );
    const paragraphs = Array.from(container.querySelectorAll("details > div > p"));
    expect(paragraphs).toHaveLength(2 + METHOD_PARAGRAPHS.length);
    expect(paragraphs[0]?.textContent).toBe(FUND_LINE);
    expect(paragraphs[1]?.textContent).toMatch(/^A notice's change/);
    expect(paragraphs[2]?.textContent).toBe(METHOD_PARAGRAPHS[0]);
  });

  it("draws each shared paragraph's lead sentence in the foreground and the rest muted", () => {
    const { container } = render(<MethodDisclosure />);
    const first = container.querySelector("details > div > p");
    const lead = first?.querySelector("span.text-foreground");
    const rest = first?.querySelector("span.text-muted-foreground");
    expect(lead?.textContent).toBe(leadSentence(METHOD_PARAGRAPHS[0]!).lead);
    expect(rest?.textContent).toBe(leadSentence(METHOD_PARAGRAPHS[0]!).rest);
  });

  it("takes a caller's class onto the disclosure", () => {
    const { container } = render(<MethodDisclosure className="max-w-prose" />);
    expect(container.querySelector("details")).toHaveClass("scroll-mt-20", "max-w-prose");
  });
});

describe("leadSentence", () => {
  it("splits after the first sentence, and keeps the rest whole", () => {
    expect(leadSentence("One thing holds. Another thing follows here.")).toEqual({
      lead: "One thing holds.",
      rest: "Another thing follows here.",
    });
  });

  it("rejoins to the original text with a single space", () => {
    for (const paragraph of METHOD_PARAGRAPHS) {
      const { lead, rest } = leadSentence(paragraph);
      expect(rest).not.toBe("");
      expect(`${lead} ${rest}`).toBe(paragraph);
    }
  });

  it("does not break inside a figure with a decimal point", () => {
    expect(leadSentence("The fund holds 2.5 per cent of the register. It is read monthly.")).toEqual({
      lead: "The fund holds 2.5 per cent of the register.",
      rest: "It is read monthly.",
    });
  });

  it("breaks after a sentence that ends in a number", () => {
    expect(leadSentence("Read the notice in Form 605. A holding is shown until a later read.")).toEqual({
      lead: "Read the notice in Form 605.",
      rest: "A holding is shown until a later read.",
    });
    expect(leadSentence("Forms 603, 604 and 605. 2 more forms follow.")).toEqual({
      lead: "Forms 603, 604 and 605.",
      rest: "2 more forms follow.",
    });
  });

  it("does not break after a known abbreviation", () => {
    expect(leadSentence("Vanguard Australia Pty. Ltd. runs the funds. Their files are read.")).toEqual({
      lead: "Vanguard Australia Pty. Ltd. runs the funds.",
      rest: "Their files are read.",
    });
    expect(leadSentence("Weights are shown, e.g. Vanguard and iShares. Each is read in turn.")).toEqual({
      lead: "Weights are shown, e.g. Vanguard and iShares.",
      rest: "Each is read in turn.",
    });
  });

  it("does not break before a lowercase word", () => {
    expect(leadSentence("The figure is stated in full. but no break comes after a lowercase word.")).toEqual({
      lead: "The figure is stated in full. but no break comes after a lowercase word.",
      rest: "",
    });
  });

  it("breaks after a sentence that ends in a closing quote or a bracket", () => {
    expect(leadSentence('It says "read." A notice follows.')).toEqual({
      lead: 'It says "read."',
      rest: "A notice follows.",
    });
    expect(leadSentence("Forms are listed (Forms 603 to 605). Sums follow.")).toEqual({
      lead: "Forms are listed (Forms 603 to 605).",
      rest: "Sums follow.",
    });
  });

  it("is the whole text as the lead when there is no sentence break", () => {
    expect(leadSentence("No second sentence here")).toEqual({ lead: "No second sentence here", rest: "" });
    expect(leadSentence("Ends with a single stop.")).toEqual({ lead: "Ends with a single stop.", rest: "" });
    expect(leadSentence("")).toEqual({ lead: "", rest: "" });
  });
});
