import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import AboutClient from "../about-client";
import { type AboutPageStatistics } from "~/lib/statistics";

// Mock next/link
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mock UI components
jest.mock("~/@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    size,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
    size?: string;
    variant?: string;
  }) => (
    <button onClick={onClick} className={className} data-size={size} data-variant={variant}>
      {children}
    </button>
  ),
}));

// Mock marketing components
jest.mock("~/@/components/marketing/finance-grid-background", () => ({
  FinanceGridBackground: ({ className }: { className?: string }) => (
    <div data-testid="finance-grid-background" className={className}>
      Finance Grid Background
    </div>
  ),
}));

jest.mock("~/@/components/marketing/animated-chart-display", () => ({
  AnimatedChartDisplay: ({ className }: { className?: string }) => (
    <div data-testid="animated-chart-display" className={className}>
      Animated Chart Display
    </div>
  ),
}));

// Mock Lucide icons
jest.mock("lucide-react", () => ({
  Activity: () => <span data-testid="icon-activity" />,
  BarChart3: () => <span data-testid="icon-barchart3" />,
  Bell: () => <span data-testid="icon-bell" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Database: () => <span data-testid="icon-database" />,
  LineChart: () => <span data-testid="icon-linechart" />,
  Lock: () => <span data-testid="icon-lock" />,
  Search: () => <span data-testid="icon-search" />,
  Shield: () => <span data-testid="icon-shield" />,
  TrendingDown: () => <span data-testid="icon-trending-down" />,
  Zap: () => <span data-testid="icon-zap" />,
}));

// Mock cn utility
jest.mock("~/@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("About Page", () => {
  const mockStatistics: AboutPageStatistics = {
    companyCount: 500,
    industryCount: 25,
    latestUpdateDate: new Date("2024-01-15"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Hero Section", () => {
    it("renders the hero section with main headline", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Decode Market")).toBeInTheDocument();
      expect(screen.getByText("Sentiment")).toBeInTheDocument();
    });

    it("renders the ASX Short Position Intelligence badge", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("ASX Short Position Intelligence")).toBeInTheDocument();
    });

    it("renders the description text", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(
        screen.getByText(/Track short positions across the ASX with data sourced directly from ASIC/i)
      ).toBeInTheDocument();
    });

    it("renders the CTA buttons", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Explore Short Positions")).toBeInTheDocument();
      expect(screen.getByText("Search Stocks")).toBeInTheDocument();
    });

    it("renders statistics from props", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      // Company count
      expect(screen.getByText("500+")).toBeInTheDocument();
      expect(screen.getByText("Companies Tracked")).toBeInTheDocument();

      // Industry count
      expect(screen.getByText("25+")).toBeInTheDocument();
      expect(screen.getByText("Industries Covered")).toBeInTheDocument();

      // Daily updates
      expect(screen.getAllByText("Daily").length).toBeGreaterThan(0);
    });
  });

  describe("Value Proposition Section", () => {
    it("renders the value proposition heading", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Why Short Position Data Matters")).toBeInTheDocument();
    });

    it("renders the three value cards", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Sentiment Indicator")).toBeInTheDocument();
      expect(screen.getByText("ASIC-Sourced Data")).toBeInTheDocument();
      expect(screen.getByText("Real-Time Tracking")).toBeInTheDocument();
    });
  });

  describe("Features Section", () => {
    it("renders the features section heading", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Powerful Analysis Tools")).toBeInTheDocument();
    });

    it("renders all feature cards", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Historical Charts")).toBeInTheDocument();
      expect(screen.getByText("Industry Heatmaps")).toBeInTheDocument();
      expect(screen.getByText("Smart Search")).toBeInTheDocument();
      expect(screen.getByText("Position Alerts")).toBeInTheDocument();
      expect(screen.getByText("Comprehensive Data")).toBeInTheDocument();
      expect(screen.getByText("Fast Performance")).toBeInTheDocument();
      expect(screen.getByText("Secure Platform")).toBeInTheDocument();
      expect(screen.getByText("Live Updates")).toBeInTheDocument();
    });
  });

  describe("Data Trust Section", () => {
    it("renders the data trust section heading", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Data You Can Trust")).toBeInTheDocument();
    });

    it("renders trust metrics", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      // There are two 99.9% values (Data Accuracy and API Uptime)
      const accuracyValues = screen.getAllByText("99.9%");
      expect(accuracyValues.length).toBe(2);
      expect(screen.getByText("Data Accuracy")).toBeInTheDocument();
      expect(screen.getByText("API Uptime")).toBeInTheDocument();
      expect(screen.getByText("5+ Years")).toBeInTheDocument();
      expect(screen.getByText("Historical Data")).toBeInTheDocument();
    });

    it("renders ASIC data pipeline explanation", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Regulatory-Grade Data Pipeline")).toBeInTheDocument();
      expect(
        screen.getByText(/Short positions above 0.5% of issued capital are required to be reported to ASIC/i)
      ).toBeInTheDocument();
    });
  });

  describe("CTA Section", () => {
    it("renders the final CTA section", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("Ready to Gain the Edge?")).toBeInTheDocument();
    });

    it("renders CTA buttons", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByText("View Top Shorts")).toBeInTheDocument();
      expect(screen.getByText("Search All Stocks")).toBeInTheDocument();
    });

    it("renders the free to use message", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(
        screen.getByText(/Free to use. No sign-up required to explore short position data/i)
      ).toBeInTheDocument();
    });
  });

  describe("Background Components", () => {
    it("renders the finance grid background", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByTestId("finance-grid-background")).toBeInTheDocument();
    });

    it("renders the animated chart display", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      expect(screen.getByTestId("animated-chart-display")).toBeInTheDocument();
    });
  });

  describe("Navigation Links", () => {
    it("renders links to the home page", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      const homeLinks = screen.getAllByRole("link", { name: /Explore Short Positions|View Top Shorts/i });
      expect(homeLinks.length).toBeGreaterThan(0);

      // Check that links point to home
      homeLinks.forEach((link) => {
        expect(link).toHaveAttribute("href", "/");
      });
    });

    it("renders links to the stocks page", () => {
      render(<AboutClient initialStatistics={mockStatistics} />);

      const stocksLinks = screen.getAllByRole("link", { name: /Search Stocks|Search All Stocks/i });
      expect(stocksLinks.length).toBeGreaterThan(0);

      // Check that links point to stocks page
      stocksLinks.forEach((link) => {
        expect(link).toHaveAttribute("href", "/stocks");
      });
    });
  });

  describe("Responsive Layout", () => {
    it("renders with proper section structure", () => {
      const { container } = render(<AboutClient initialStatistics={mockStatistics} />);

      // Check for 5 sections
      const sections = container.querySelectorAll("section");
      expect(sections.length).toBe(5);
    });

    it("renders container with proper classes", () => {
      const { container } = render(<AboutClient initialStatistics={mockStatistics} />);

      // Check for container class
      const containers = container.querySelectorAll(".container");
      expect(containers.length).toBeGreaterThan(0);
    });
  });

  describe("Fallback Statistics", () => {
    it("renders with zero statistics gracefully", () => {
      const zeroStats: AboutPageStatistics = {
        companyCount: 0,
        industryCount: 0,
        latestUpdateDate: null,
      };

      render(<AboutClient initialStatistics={zeroStats} />);

      // Should still render the page structure
      expect(screen.getByText("Decode Market")).toBeInTheDocument();
      
      // Multiple "0+" values exist for company and industry counts
      const zeroValues = screen.getAllByText("0+");
      expect(zeroValues.length).toBeGreaterThan(0);
    });

    it("renders with large statistics numbers", () => {
      const largeStats: AboutPageStatistics = {
        companyCount: 1500,
        industryCount: 50,
        latestUpdateDate: new Date(),
      };

      render(<AboutClient initialStatistics={largeStats} />);

      // Should format large numbers with locale string
      expect(screen.getByText("1,500+")).toBeInTheDocument();
      expect(screen.getByText("50+")).toBeInTheDocument();
    });
  });
});

