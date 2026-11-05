/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// The shell is the page's own markup: it must sit inside the strategies' dashboard
// layout (the sidebar and <main>), like every other /strategies page, and it is
// private (noindex, follow). The island is replaced: its session reads are not
// this test's concern.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));
jest.mock("./my-strategies-island", () => ({
  MyStrategiesIsland: () => <div data-testid="island" />,
}));

import MyStrategiesPage, { metadata } from "./page";

describe("My strategies page", () => {
  it("renders its heading and island inside the dashboard layout", () => {
    render(<MyStrategiesPage />);
    const layout = screen.getByTestId("dashboard-layout");
    expect(layout).toContainElement(screen.getByRole("heading", { level: 1, name: "My strategies" }));
    expect(layout).toContainElement(screen.getByTestId("island"));
  });

  it("is noindex and follows its links, as a private page does", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
