import { render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommunityOverviewTeaser } from "../community-overview-teaser";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// The teaser now fetches its summary through TanStack Query.
function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("CommunityOverviewTeaser", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: null }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("renders a populated teaser with an open community CTA", () => {
    render(
      <CommunityOverviewTeaser
        stockCode="BHP"
        summary={{
          headline: "The capex debate is tightening",
          subheadline: "6 threads and 14 pulse updates live now",
          ctaLabel: "Open community",
          threadCount: 6,
          pulseCount: 14,
          latestActivityAt: new Date("2026-04-11T08:00:00Z"),
        }}
      />,
    );

    expect(
      screen.getByText("The capex debate is tightening"),
    ).toBeInTheDocument();
    // Compact strip shows the activity label
    expect(screen.getByText(/last active/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open community/i }),
    ).toBeInTheDocument();
  });

  it("renders the compact empty teaser state", () => {
    render(
      <CommunityOverviewTeaser
        stockCode="BHP"
        summary={{
          headline: "Be the first to discuss BHP",
          subheadline:
            "Start the research thread, post a catalyst, or add the first pulse update.",
          ctaLabel: "Open community",
          threadCount: 0,
          pulseCount: 0,
        }}
      />,
    );

    expect(
      screen.getByText(/be the first to discuss bhp/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/start a research thread/i)).toBeInTheDocument();
  });

  it("hydrates summary data from the community API", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: {
          headline: "Fresh community read",
          subheadline: "2 threads and 4 pulse updates live now",
          ctaLabel: "Join the discussion",
          threadCount: 2,
          pulseCount: 4,
          latestActivityAt: "2026-07-05T05:00:00.000Z",
        },
      }),
    });

    render(<CommunityOverviewTeaser stockCode="LOT" />);

    expect(await screen.findByText("Fresh community read")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/community/LOT/summary",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });
});
