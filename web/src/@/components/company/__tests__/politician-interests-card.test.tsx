import { fireEvent, render, screen } from "@testing-library/react";

// The query is the card's only collaborator. It is answered here, so the card
// can be held in each state; the client that feeds it, the register's kit and
// the router's link are stand-ins that show what the card handed them.
const mockUseQuery = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
jest.mock("~/app/actions/client/getPoliticiansClient", () => ({
  listStockPoliticiansClient: jest.fn(),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
jest.mock("@/components/politicians/compliance", () => ({
  DeclaredPeriod: () => <span data-testid="period" />,
  HolderBadge: () => <span data-testid="holder" />,
  PartyChip: ({ partyAb }: { partyAb?: string }) => <span data-testid="party">{partyAb}</span>,
  SourceLine: ({ surface }: { surface: string }) => <span data-testid="source">{surface}</span>,
}));

import { PoliticianInterestsCard } from "../politician-interests-card";

const row = (slug: string, displayName: string) => ({
  politician: { slug, displayName, partyAb: "ALP" },
  interest: { holder: 1, declaredFromKnown: false, currentlyDeclared: true },
});

const declared = (count: number) => ({
  politicianCount: count,
  partyCounts: [{ partyAb: "ALP", party: "Australian Labor Party", politicianCount: count }],
  interests: Array.from({ length: count }, (_, i) => row(`member-${i + 1}`, `Member ${i + 1}`)),
});

describe("PoliticianInterestsCard", () => {
  beforeEach(() => mockUseQuery.mockReset());

  // Most stocks have no declared interests, and the card sits below the fold on
  // the Company tab. A skeleton that resolved to nothing opened a gap of about
  // 134px and closed it again, moving every card beneath it.
  it("renders nothing while it loads: no card, no skeleton, no gap", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<PoliticianInterestsCard stockCode="BHP" />);
    expect(container.innerHTML).toBe("");
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("renders nothing for a stock no parliamentarian declares", () => {
    mockUseQuery.mockReturnValue({ data: declared(0), isLoading: false });
    const { container } = render(<PoliticianInterestsCard stockCode="SPLR" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the read fails, which says nothing either way", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    const { container } = render(<PoliticianInterestsCard stockCode="BHP" />);
    expect(container.innerHTML).toBe("");
  });

  it("draws the card once there are interests: the count, the party and each member's profile link", () => {
    mockUseQuery.mockReturnValue({ data: declared(2), isLoading: false });
    render(<PoliticianInterestsCard stockCode="BHP" />);
    expect(screen.getByRole("heading", { name: "Declared political interests" })).toBeInTheDocument();
    // The headline count, beside its unit (the party chip carries a count too).
    expect(screen.getByText("members").previousElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Australian Labor Party")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Member 1" })).toHaveAttribute("href", "/politicians/member-1");
    expect(screen.getByRole("link", { name: "Member 2" })).toHaveAttribute("href", "/politicians/member-2");
    expect(screen.getByTestId("source")).toHaveTextContent("stock BHP");
  });

  it("asks for the stock's declarations by its code", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true });
    render(<PoliticianInterestsCard stockCode="BHP" />);
    expect(mockUseQuery.mock.calls[0]![0].queryKey).toEqual(["politician-interests", "BHP"]);
  });

  it("shows eight rows and opens the rest in place, with no second read", () => {
    mockUseQuery.mockReturnValue({ data: declared(10), isLoading: false });
    render(<PoliticianInterestsCard stockCode="BHP" />);
    expect(screen.getAllByRole("listitem").filter((li) => li.className.includes("py-2"))).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 declarations" }));
    expect(screen.getAllByRole("listitem").filter((li) => li.className.includes("py-2"))).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
    expect(mockUseQuery).toHaveBeenCalled();
  });
});
