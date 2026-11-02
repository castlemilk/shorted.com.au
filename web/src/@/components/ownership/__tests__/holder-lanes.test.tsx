import { render, screen, within } from "@testing-library/react";
import type { SubstantialHolding, SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { buildHolderLanes } from "~/@/lib/ownership/trace";
import { HolderLanes, type HolderLanesProps } from "../holder-lanes";

const holding = (over: Partial<SubstantialHolding> = {}): SubstantialHolding =>
  ({
    stockCode: "ZIP",
    companyName: "Zip Co",
    industry: "",
    holderKey: "australian-retirement-trust",
    holderName: "Australian Retirement Trust Pty Ltd",
    institutionSlug: "australian-retirement-trust",
    kind: "super_fund",
    form: "604",
    votingPowerPct: 6.2,
    previousPct: 5.045,
    hasPrevious: true,
    hasVotes: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: "https://www.asx.com.au/holder.pdf",
    ...over,
  }) as unknown as SubstantialHolding;

const notice = (over: Partial<SubstantialNotice> = {}): SubstantialNotice =>
  ({
    stockCode: "ZIP",
    companyName: "Zip Co",
    holderKey: "australian-retirement-trust",
    holderName: "Australian Retirement Trust Pty Ltd",
    institutionSlug: "australian-retirement-trust",
    kind: "super_fund",
    form: "604",
    presentPct: 6.2,
    hasPresent: true,
    previousPct: 5.045,
    hasPrevious: true,
    ceased: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: "https://www.asx.com.au/notice.pdf",
    ...over,
  }) as unknown as SubstantialNotice;

/** The props the register page passes, built from the geometry the page reads. */
function lanesProps(
  holders: SubstantialHolding[],
  history: SubstantialNotice[] = [],
  over: Partial<HolderLanesProps> = {},
): HolderLanesProps {
  const geometry = buildHolderLanes({
    holders,
    history,
    asOf: "2026-10-19",
    historyTotal: history.length,
  });
  return {
    lanes: geometry.lanes,
    from: geometry.from,
    to: geometry.to,
    yearLabels: geometry.yearLabels,
    truncated: geometry.truncated,
    code: "ZIP",
    historyTotal: history.length,
    withheldListed: 0,
    ...over,
  };
}

const fourteen = Array.from({ length: 14 }, (_, i) =>
  holding({
    holderKey: `k${i}`,
    holderName: `Holder ${i}`,
    institutionSlug: "",
    votingPowerPct: 5 + i,
    previousPct: 4 + i,
  }),
);

describe("HolderLanes", () => {
  it("draws twelve holders in the list and holds the rest behind a disclosure that continues the numbering", () => {
    const { container } = render(<HolderLanes {...lanesProps(fourteen)} />);
    const figure = container.querySelector("figure")!;
    const [list] = Array.from(figure.children).filter((el) => el.tagName === "OL");
    expect(within(list as HTMLElement).getAllByRole("listitem")).toHaveLength(12);

    const details = container.querySelector("details")!;
    expect(details).toHaveTextContent("2 more holders");
    const rest = details.querySelector("ol")!;
    expect(rest).toHaveAttribute("start", "13");
    expect(within(rest).getAllByRole("listitem")).toHaveLength(2);
  });

  it("is labelled by the heading that carries the holders id, and described by its method", () => {
    render(
      <>
        <h2 id="holders">Substantial holders</h2>
        <HolderLanes {...lanesProps([holding()])} />
      </>,
    );
    const figure = screen.getByRole("figure", { name: "Substantial holders" });
    expect(figure).toHaveAccessibleDescription(/One line per holder/);
  });

  it("draws each lane as an svg with no text, rect or circle inside it, and no red or green", () => {
    const { container } = render(<HolderLanes {...lanesProps(fourteen)} />);
    const lanes = container.querySelectorAll("svg[viewBox]");
    expect(lanes).toHaveLength(14);
    expect(container.querySelectorAll("svg text, svg rect, svg circle")).toHaveLength(0);
    for (const svg of Array.from(lanes)) {
      expect(svg).toHaveAttribute("viewBox", "0 0 1000 28");
      expect(svg).toHaveAttribute("preserveAspectRatio", "none");
      expect(svg).toHaveAttribute("aria-hidden", "true");
    }
    const figure = container.querySelector("figure")!.outerHTML;
    expect(figure).not.toMatch(/\b(?:red|green|emerald|rose|destructive)-?\d*|#(?:ef4444|22c55e|f87171|4ade80)/i);
  });

  it("draws the threshold at the band's bottom edge, and the solid line in the primary token", () => {
    const { container } = render(<HolderLanes {...lanesProps([holding()])} />);
    const threshold = container.querySelector('path[d="M0 23H1000"]')!;
    expect(threshold).toHaveAttribute("vector-effect", "non-scaling-stroke");
    expect(threshold).toHaveAttribute("stroke-dasharray", "4 6");
    expect(container.querySelector('path[stroke="hsl(var(--primary))"][stroke-width="1.5"]')).not.toBeNull();
  });

  it("names the scale of each lane on hover, from 5% to its own top", () => {
    const { container } = render(<HolderLanes {...lanesProps([holding()])} />);
    expect(container.querySelector('[title="Lane scale 5% to 8%"]')).not.toBeNull();
  });

  it("says in the method what a line ending at the 5% edge means, and the dates it covers", () => {
    const props = lanesProps([holding()]);
    const { container } = render(<HolderLanes {...props} />);
    const caption = container.querySelector("figcaption")!;
    expect(caption).toHaveTextContent("under 5%, not zero");
    expect(caption).toHaveTextContent(`From ${props.from} to ${props.to}.`);
    expect(caption).toHaveAttribute("id", "lanes-method");
  });

  it("points a screen reader at the Notices table, where the data behind the lanes is", () => {
    render(<HolderLanes {...lanesProps([holding()])} />);
    expect(
      screen.getByText("The notices behind each line are listed in the Notices table below."),
    ).toHaveClass("sr-only");
  });

  it("says the history is the latest slice when it is truncated, and names the total", () => {
    const { container } = render(
      <HolderLanes {...lanesProps([holding()], [], { truncated: true, historyTotal: 1117 })} />,
    );
    expect(container.querySelector("figcaption")).toHaveTextContent(
      "The latest 100 of 1,117 notices; earlier notices are not drawn.",
    );
  });

  it("sentences the withheld notices for this stock, and only when there are some", () => {
    const { container, rerender } = render(
      <HolderLanes {...lanesProps([holding()], [], { withheldListed: 3 })} />,
    );
    expect(container.querySelector("figcaption")).toHaveTextContent(
      "3 notices listed under ZIP were withheld: not read or not reconcilable, never estimated.",
    );

    rerender(<HolderLanes {...lanesProps([holding()])} />);
    expect(container.querySelector("figcaption")).not.toHaveTextContent("were withheld");
  });

  it("links a named holder to its page and its notice to ASX, and never more than two links a row", () => {
    const { container } = render(<HolderLanes {...lanesProps([holding()])} />);
    const row = container.querySelector("li")!;
    expect(within(row).getByRole("link", { name: "Australian Retirement Trust Pty Ltd" })).toHaveAttribute(
      "href",
      "/ownership/australian-retirement-trust",
    );
    const asx = within(row).getByRole("link", { name: "Australian Retirement Trust Pty Ltd's notice on ASX" });
    expect(asx).toHaveAttribute("href", "https://www.asx.com.au/holder.pdf");
    expect(asx).toHaveAttribute("target", "_blank");
    expect(asx).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(row.querySelectorAll("a")).toHaveLength(2);
  });

  it("prints an unclassified holder's name as text, and draws no ASX link for a notice URL it cannot trust", () => {
    const { container } = render(
      <HolderLanes
        {...lanesProps([
          holding({
            holderKey: "name:wesley jon maas",
            holderName: "Wesley Jon Maas",
            institutionSlug: "",
            announcementUrl: "javascript:alert(1)",
          }),
        ])}
      />,
    );
    expect(screen.getByText("Wesley Jon Maas")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Wesley Jon Maas" })).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /on ASX/ })).toBeNull();
  });

  it("draws a holder that ceased as a lane ending under 5%, with no current holder beside it", () => {
    const { container } = render(
      <HolderLanes
        {...lanesProps(
          [],
          [
            notice({
              holderKey: "gone",
              holderName: "Gone Fund",
              institutionSlug: "",
              kind: "hedge_fund",
              form: "605",
              ceased: true,
              hasPresent: false,
              hasPrevious: false,
              presentPct: 0,
              previousPct: 0,
              eventDate: "2026-10-01",
              announcedOn: "2026-10-02",
              announcementUrl: "https://www.asx.com.au/gone.pdf",
            }),
          ],
        )}
      />,
    );
    const row = container.querySelector("li")!;
    expect(within(row).getByText("under 5%")).toBeInTheDocument();
    expect(within(row).getByText("Ceased")).toBeInTheDocument();
    // On this 180-day axis the cessation sits at x 900: an end-stop on the 5% edge, a
    // 12-unit stub of threshold before it, and no solid line, since no figure opened one.
    expect(row.querySelector('path[d="M900 20V26"]')).not.toBeNull();
    expect(row.querySelector('path[d="M888 23H900"]')).not.toBeNull();
    expect(row.querySelector('path[stroke-linejoin="miter"]')).toBeNull();
  });

  it("hangs a year label at the axis's right edge to the left of its tick, so it stays on the page", () => {
    const geometry = buildHolderLanes({
      holders: [holding({ eventDate: "2026-12-01", announcedOn: "2026-12-03" })],
      history: [],
      asOf: "2027-01-05",
      historyTotal: 0,
    });
    render(
      <HolderLanes
        lanes={geometry.lanes}
        from={geometry.from}
        to={geometry.to}
        yearLabels={geometry.yearLabels}
        truncated={geometry.truncated}
        code="ZIP"
        historyTotal={0}
        withheldListed={0}
      />,
    );
    expect(screen.getByText("2027")).toHaveClass("-translate-x-full");
  });

  it("prints the age of a reading that is over 90 days old, with its months as data", () => {
    render(<HolderLanes {...lanesProps([holding({ eventDate: "2026-01-01", announcedOn: "2026-01-03" })])} />);
    const age = screen.getByText("10 mo");
    expect(age).toHaveAttribute("data-age-months", "10");
    expect(age).toHaveAttribute("title");
  });

  it("draws nothing when there are no lanes", () => {
    const { container } = render(<HolderLanes {...lanesProps([])} />);
    expect(container.firstChild).toBeNull();
  });
});
