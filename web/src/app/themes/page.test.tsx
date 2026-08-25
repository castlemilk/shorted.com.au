import { render, screen } from "@testing-library/react";

import ThemesIndexPage from "./page";
import { THEMES } from "~/@/lib/themes/registry";

const getThemeHubStats = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: ({ items }: { items: unknown[] }) => (
    <div data-testid="itemlist">{items.length}</div>
  ),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getThemeData", () => ({
  getThemeHubStats: (...args: unknown[]) => getThemeHubStats(...args),
}));

const themes = Object.values(THEMES);

describe("ThemesIndexPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getThemeHubStats.mockResolvedValue(
      Object.fromEntries(
        themes.map((theme) => [
          theme.slug,
          {
            slug: theme.slug,
            medianShortPct: 2.5,
            constituents: theme.tickers.length,
          },
        ]),
      ),
    );
  });

  it("renders a card for every theme in the registry, linked to its page", async () => {
    render(await ThemesIndexPage());

    expect(themes).toHaveLength(10);
    for (const theme of themes) {
      expect(screen.getByRole("heading", { name: theme.h1 })).toBeInTheDocument();
      expect(screen.getByText(theme.dek)).toBeInTheDocument();
    }
    const links = screen
      .getAllByRole("link")
      .map((el) => el.getAttribute("href"));
    for (const theme of themes) {
      expect(links).toContain(`/themes/${theme.slug}`);
    }
    // Every theme is also in the ItemList structured data.
    expect(screen.getByTestId("itemlist")).toHaveTextContent(
      String(themes.length),
    );
  });

  it("shows the live median short interest per theme", async () => {
    render(await ThemesIndexPage());

    expect(screen.getAllByText("2.50%")).toHaveLength(themes.length);
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("still renders every card when the stats fetch comes back empty, and bails the render", async () => {
    getThemeHubStats.mockResolvedValue({});

    render(await ThemesIndexPage());

    for (const theme of themes) {
      expect(screen.getByRole("heading", { name: theme.h1 })).toBeInTheDocument();
    }
    expect(screen.queryByText("2.50%")).not.toBeInTheDocument();
    // A statless render must not be baked into the route cache for the hour.
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
