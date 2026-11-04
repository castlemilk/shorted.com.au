import { act, render, screen } from "@testing-library/react";

import type { NoticeFeedPage } from "~/app/actions/ownershipExplorer";
import type { NoticeFeedRow } from "~/@/components/ownership/notice-feed-explorer";
import { defaultNoticeQuery } from "~/@/lib/ownership/query";

import NoticesPage, { metadata, revalidate } from "./page";

const loadNoticeFeed = jest.fn();
const listInstitutions = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getOwnership", () => ({
  listInstitutions: (...args: unknown[]) => listInstitutions(...args),
}));
jest.mock("~/app/actions/ownershipExplorer", () => ({
  loadNoticeFeed: (...args: unknown[]) => loadNoticeFeed(...args),
}));

const LEDE =
  "Substantial holding notices we could read, newest release first: who became substantial, whose holding changed by a percentage point or more, and who ceased. A fall is reported as a fall, not as a disposal: share counts change too.";
const TABLE_NAME = "Substantial holding notices, newest release first";

const row = (over: Partial<NoticeFeedRow> = {}): NoticeFeedRow => ({
  released: "2026-10-16",
  event: "became",
  code: "BHP",
  companyName: "BHP Group",
  holder: "Vanguard Group",
  holderHref: "/ownership/vanguard",
  votingPower: "5.12%",
  change: "",
  changePp: null,
  holderKind: "",
  url: "https://www.asx.com.au/notices/bhp-1.pdf",
  ...over,
});

const NO_ACTIVITY = {
  became: 0,
  increased: 0,
  decreased: 0,
  changed: 0,
  ceased: 0,
  nz: 0,
  largestRises: [],
  largestFalls: [],
};

/** The default view as the action answers it: the 30-day window with its activity. */
const feed = (over: Partial<NoticeFeedPage> = {}): NoticeFeedPage => ({
  ok: true,
  activityOk: true,
  error: "",
  query: defaultNoticeQuery(),
  rows: [row()],
  total: 1,
  asOf: "2026-10-16",
  nextCursor: "",
  weeks: [{ weekStart: "2026-10-12", count: 1 }],
  activity: { ...NO_ACTIVITY, became: 1 },
  ...over,
});

describe("NoticesPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [{ slug: "vanguard", name: "Vanguard" }], total: 1 });
  });

  it("draws the default view under its heading and lede, and does not bail when the 30-day answer is populated", async () => {
    loadNoticeFeed.mockResolvedValue(feed());
    const { container } = render(await NoticesPage());

    expect(loadNoticeFeed).toHaveBeenCalledWith({});
    expect(listInstitutions).toHaveBeenCalledWith("", "", 200, 0);
    expect(screen.getByRole("heading", { level: 1, name: "Substantial holding notices" })).toBeInTheDocument();
    expect(screen.getByText(LEDE)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: TABLE_NAME })).toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
  });

  // The build-skip render and a failed regeneration are the same shell: the page bails,
  // and the marker names it for the post-deploy re-prime.
  it.each([
    ["the read did not answer", feed({ ok: false, rows: [], total: 0, asOf: "", weeks: [], activity: null, activityOk: false })],
    ["the weekly counts did not come back", feed({ activityOk: false, activity: null, weeks: [] })],
  ])("is a shell that bails and carries the re-prime marker when %s", async (_, page) => {
    loadNoticeFeed.mockResolvedValue(page);
    const { container } = render(await NoticesPage());
    // The island asks the server again on mount when the read failed: let that answer land inside act.
    await act(async () => {});

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  // An answered empty window is kept for a minute, not an hour, but it is not a failed
  // read: the marker stays off, as the cost doc says.
  it("bails without the re-prime marker when no notice falls in the answered window", async () => {
    loadNoticeFeed.mockResolvedValue(feed({ rows: [], total: 0, asOf: "", weeks: [], activity: NO_ACTIVITY }));
    const { container } = render(await NoticesPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
  });

  // The holder select is part of the default view's HTML: a failed read bakes in an empty one.
  it("is a shell that bails and carries the marker when the holder registry did not answer", async () => {
    listInstitutions.mockResolvedValue(undefined);
    loadNoticeFeed.mockResolvedValue(feed());
    const { container } = render(await NoticesPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  // The registry reaches the island's holder select, so a holder link has a name to show.
  it("draws the registry's holders in the holder select", async () => {
    loadNoticeFeed.mockResolvedValue(feed());
    render(await NoticesPage());

    expect(screen.getByRole("option", { name: "Vanguard" })).toHaveAttribute("value", "vanguard");
  });

  // A list that holds part of the directory is not the registry: the select would miss
  // holders, so the page passes none and the API checks a link's holder against all of them.
  it("passes no registry to the island when the list holds part of the directory", async () => {
    listInstitutions.mockResolvedValue({ institutions: [{ slug: "vanguard", name: "Vanguard" }], total: 201 });
    loadNoticeFeed.mockResolvedValue(feed());
    render(await NoticesPage());

    expect(screen.queryByRole("option", { name: "Vanguard" })).toBeNull();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  // The island asks its action again on mount when the default read did not answer, with the default view's query.
  it("hands the island its action, which it asks again on mount when the read did not answer", async () => {
    loadNoticeFeed.mockResolvedValue(feed({ ok: false, rows: [], total: 0, asOf: "", weeks: [], activity: null, activityOk: false }));
    render(await NoticesPage());
    await act(async () => {});

    expect(loadNoticeFeed).toHaveBeenCalledTimes(2);
    expect(loadNoticeFeed).toHaveBeenLastCalledWith(expect.objectContaining({ windowDays: 30 }));
  });

  it("draws the external-link symbol once, and ends its method with the error report for the feed", async () => {
    loadNoticeFeed.mockResolvedValue(feed());
    const { container } = render(await NoticesPage());

    expect(container.querySelectorAll("symbol#ownership-external-link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20notices%20feed",
    );
  });

  it("dates its plate and its source line by the newest notice read", async () => {
    loadNoticeFeed.mockResolvedValue(feed());
    const { container } = render(await NoticesPage());

    expect(screen.getByText(/Notices read to/)).toHaveTextContent("Notices read to 2026-10-16");
    const method = container.querySelector("section[aria-labelledby='method']") as HTMLElement;
    expect(method).toHaveTextContent(
      "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF; read to 2026-10-16.",
    );
  });

  it("describes its trail as a BreadcrumbList from the hub, and dates the Dataset by the newest notice", async () => {
    loadNoticeFeed.mockResolvedValue(feed());
    const { container } = render(await NoticesPage());

    const blocks = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
      JSON.parse(s.textContent ?? "{}"),
    );
    const trail = blocks.find((b) => b["@type"] === "BreadcrumbList");
    expect(
      trail.itemListElement.map((i: { position: number; name: string; item: string }) => [i.position, i.name, i.item]),
    ).toEqual([
      [1, "Home", "https://shorted.com.au/"],
      [2, "Ownership", "https://shorted.com.au/ownership"],
      [3, "Notices", "https://shorted.com.au/ownership/notices"],
    ]);
    const dataset = blocks.find((b) => b["@type"] === "Dataset");
    expect(dataset.dateModified).toBe("2026-10-16");
  });
});

describe("NoticesPage metadata", () => {
  it("is indexable and self-canonical, its title fits 60 characters, and the social card is the segment's own", () => {
    expect(revalidate).toBe(3600);
    expect(Object.keys(metadata)).not.toContain("robots");
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/ownership/notices");
    expect(String(metadata.title).length).toBeLessThan(60);
    expect(Object.keys(metadata.openGraph ?? {})).not.toContain("images");
    expect(metadata.twitter).toMatchObject({ site: "@shorted___", creator: "@shorted___" });
  });
});
