/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetThread = jest.fn();
const mockUnavailable = jest.fn();
const mockWarn = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("~/@/lib/community/community-activity-cache", () => ({
  getCachedCommunityThread: (...a: unknown[]) => mockGetThread(...a),
}));
jest.mock("~/@/lib/community/public-read-fallback", () => ({
  isFirestoreReadUnavailable: (...a: unknown[]) => mockUnavailable(...a),
  warnCommunityReadFallback: (...a: unknown[]) => mockWarn(...a),
}));
jest.mock("~/@/components/company/community/community-thread-detail", () => ({
  CommunityThreadDetail: ({ thread }: { thread: { id: string; title: string } }) => (
    <article data-testid="thread-detail" data-thread-id={thread.id}>
      {thread.title}
    </article>
  ),
}));
// The stock layout renders the dashboard shell and the breadcrumb trail
// (Stocks > CODE > Community on this path). A thread page that wrapped itself
// again would nest a second shell and a second trail inside it.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => <nav aria-label="Breadcrumb" data-testid="visible-breadcrumbs" />,
}));

import Page from "../page";

const thread = { id: "t1", title: "Bull case for BHP" };
const params = (stockCode: string, threadId = "t1") => ({ params: Promise.resolve({ stockCode, threadId }) });

describe("/shorts/[stockCode]/community/[threadId]", () => {
  beforeEach(() => {
    mockGetThread.mockReset();
    mockGetThread.mockResolvedValue(thread);
    mockUnavailable.mockReset();
    mockUnavailable.mockReturnValue(false);
    mockWarn.mockReset();
  });

  it("renders the thread and nothing around it: the stock layout owns the chrome", async () => {
    const { container } = render(await Page(params("bhp")));
    expect(mockGetThread).toHaveBeenCalledWith("BHP", "t1");
    expect(screen.getByTestId("thread-detail")).toHaveAttribute("data-thread-id", "t1");
    expect(container.children).toHaveLength(1);
    expect(screen.queryByTestId("dashboard-layout")).toBeNull();
    expect(screen.queryByTestId("visible-breadcrumbs")).toBeNull();
  });

  it("404s a malformed code before any read", async () => {
    await expect(Page(params("nope!"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetThread).not.toHaveBeenCalled();
  });

  it("404s a thread that does not exist", async () => {
    mockGetThread.mockResolvedValue(null);
    await expect(Page(params("bhp", "missing"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s, and says why, when the community store is unreachable", async () => {
    const outage = new Error("firestore unavailable");
    mockGetThread.mockRejectedValue(outage);
    mockUnavailable.mockReturnValue(true);
    await expect(Page(params("bhp"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockWarn).toHaveBeenCalledWith({ route: "thread_page", stockCode: "BHP", error: outage });
  });

  it("rethrows any other read failure", async () => {
    mockGetThread.mockRejectedValue(new Error("boom"));
    await expect(Page(params("bhp"))).rejects.toThrow("boom");
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
